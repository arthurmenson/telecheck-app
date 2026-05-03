/**
 * domain-events.ts — DOMAIN_EVENTS v5.2 outbox emitter.
 *
 * Purpose:
 *   Inserts domain event rows into the `domain_events_outbox` table
 *   (migration 004, not yet authored) within the SAME DB transaction as the
 *   aggregate state change. Enforces same-tx semantics so domain events are
 *   never emitted if the business transaction rolls back.
 *
 * Spec references:
 *   - I-016 (domain events are immutable): once emitted, a domain event is
 *     never modified or deleted. Corrections are new compensating events.
 *   - I-023 (tenant isolation): domain events carry `tenant_id`; partition key
 *     is composite `tenant_id:aggregate_id` per DOMAIN_EVENTS v5.2.
 *   - DOMAIN_EVENTS v5.2:
 *       * Envelope: event_id, tenant_id, aggregate_type, aggregate_id,
 *         event_type, payload, partition_key, occurred_at.
 *       * `partition_key = '${tenantId}:${aggregateId}'` for tenant-scoped aggregates.
 *       * Same-transaction semantics required (outbox pattern).
 *
 * Design decisions:
 *   - `emitDomainEvent` takes a `tx` (transaction handle) to enforce same-tx
 *     semantics. Callers MUST pass the active transaction; using a separate
 *     connection here would break atomicity.
 *   - The `DbTransaction` interface is intentionally minimal — it only requires
 *     `query()`, compatible with both `pg.PoolClient` and Prisma `$transaction`.
 *
 * Open questions for Engineering Lead:
 *   - Outbox processor (reads outbox and publishes to event bus) is a separate
 *     concern — deferred to the infrastructure slice.
 *   - `event_id` is generated as a UUID v4 via `crypto.randomUUID()` to match
 *     the migration 004 column type (UUID PRIMARY KEY DEFAULT uuid_generate_v4()).
 *     When a ULID library is added, this can swap to ULID strings AND the
 *     migration 004 column type must change to TEXT — the two changes are
 *     coupled (same pattern as the audit_id change in audit.ts).
 *
 * Resolved (foundation wire-up patch v0.2 — 2026-05-02):
 *   - Migration 004 IS authored. The INSERT below targets the real
 *     `domain_events_outbox` table created by that migration.
 *   - `event_id` now uses crypto.randomUUID() to produce a valid UUID v4
 *     (the prior `dom_${...}` placeholder failed UUID syntax validation).
 *   - `occurred_at` (business clock) is preserved inside the payload JSONB
 *     since the migration's column set has only `created_at` (wall clock,
 *     DEFAULT NOW()). Outbox consumers reading payload see both clocks.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// DB transaction interface
// ---------------------------------------------------------------------------

export interface DbTransaction {
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Domain event envelope
// ---------------------------------------------------------------------------

export interface DomainEventEnvelope {
  /** `dom_<ULID>` — unique event ID. */
  event_id: string;
  /** Operating-tenant identifier (`Telecheck-{country}`). */
  tenant_id: string;
  /** Canonical aggregate type (e.g., `MedicationRequest`, `Refill`, `Consult`). */
  aggregate_type: string;
  /** Aggregate instance ID (e.g., `mrx_01H...`). */
  aggregate_id: string;
  /**
   * Domain event type string (e.g., `medication_request.created`,
   * `refill.approved`, `research_export.initiated`).
   * Must use canonical glossary terms (no `prescription`, no `chatbot`).
   */
  event_type: string;
  /** Event-specific payload (aggregate state snapshot or delta). */
  payload: Record<string, unknown>;
  /**
   * Composite partition key: `${tenant_id}:${aggregate_id}`.
   * Drives Kafka/EventBridge partition assignment for ordered delivery per aggregate.
   */
  partition_key: string;
  /** ISO 8601 timestamp of when the domain event occurred (business clock). */
  occurred_at: string;
}

// ---------------------------------------------------------------------------
// Domain event input (caller provides all fields; event_id + partition_key computed here)
// ---------------------------------------------------------------------------

export type DomainEventInput = Omit<DomainEventEnvelope, 'event_id' | 'partition_key'>;

// ---------------------------------------------------------------------------
// emitDomainEvent
// ---------------------------------------------------------------------------

/**
 * emitDomainEvent — inserts a domain event into the outbox within the provided
 * DB transaction.
 *
 * MUST be called within the same transaction as the aggregate state change.
 * If the transaction rolls back, the event INSERT rolls back with it — correct.
 *
 * @param tx      Active DB transaction handle.
 * @param input   Domain event fields (event_id and partition_key are computed).
 * @returns       The fully-constructed domain event envelope.
 *
 * @throws  If the INSERT fails (e.g., migration 004 not applied).
 *          Per I-016, domain events are immutable; a failed INSERT must surface.
 */
export async function emitDomainEvent(
  tx: DbTransaction,
  input: DomainEventInput,
): Promise<DomainEventEnvelope> {
  // Validate required fields
  if (!input.tenant_id) {
    throw new Error('emitDomainEvent: tenant_id is required (I-023)');
  }
  if (!input.aggregate_id) {
    throw new Error('emitDomainEvent: aggregate_id is required');
  }
  if (!input.event_type) {
    throw new Error('emitDomainEvent: event_type is required');
  }

  // Build the full envelope. event_id is a UUID v4 to match migration 004's
  // `event_id UUID PRIMARY KEY DEFAULT uuid_generate_v4()` column type.
  const eventId = crypto.randomUUID();
  const partitionKey = `${input.tenant_id}:${input.aggregate_id}`;

  const envelope: DomainEventEnvelope = {
    event_id: eventId,
    partition_key: partitionKey,
    ...input,
  };

  // Insert into the outbox within the provided transaction. Migration 004's
  // table has columns: event_id (UUID), tenant_id, aggregate_type,
  // aggregate_id, event_type, partition_key, payload (JSONB), published_at,
  // attempt_count, created_at (wall clock; DEFAULT NOW()). The full envelope
  // including occurred_at (business clock) is stored in payload so consumers
  // see both timestamps without needing to join other tables.
  const payloadWithBusinessClock = {
    ...envelope.payload,
    occurred_at: envelope.occurred_at,
  };

  try {
    await tx.query(
      `INSERT INTO domain_events_outbox (
          event_id, tenant_id, aggregate_type, aggregate_id, event_type,
          partition_key, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        envelope.event_id,
        envelope.tenant_id,
        envelope.aggregate_type,
        envelope.aggregate_id,
        envelope.event_type,
        envelope.partition_key,
        JSON.stringify(payloadWithBusinessClock),
      ],
    );
  } catch (err) {
    // Per I-016, domain events are immutable — but the INSERT itself can
    // legitimately fail (constraint violation, connection drop, etc.). Wrap
    // the error with context so the caller's transaction aborts cleanly and
    // upstream debugging is easier.
    throw new Error(
      `emitDomainEvent: INSERT failed for event_type "${envelope.event_type}" ` +
        `(tenant=${envelope.tenant_id}, aggregate=${envelope.aggregate_type}/${envelope.aggregate_id}, ` +
        `event_id=${envelope.event_id}): ${err instanceof Error ? err.message : String(err)} ` +
        `— I-016 + same-transaction-outbox semantics require the caller transaction to abort.`,
    );
  }

  return envelope;
}
