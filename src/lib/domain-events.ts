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
 *   - Migration 004 (`domain_events_outbox` table schema) is not yet authored.
 *     This INSERT will fail until that migration is applied.
 *   - Outbox processor (reads outbox and publishes to event bus) is a separate
 *     concern — deferred to the infrastructure slice.
 *   - `event_id` generation: currently uses `crypto.randomUUID()` as a placeholder.
 *     Spec uses ULID format (`dom_<ULID>`); add `ulid` dependency when available.
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

  // Build the full envelope
  const eventId = `dom_${crypto.randomUUID().replace(/-/g, '')}`; // STUB: replace with ULID
  const partitionKey = `${input.tenant_id}:${input.aggregate_id}`;

  const envelope: DomainEventEnvelope = {
    event_id: eventId,
    partition_key: partitionKey,
    ...input,
  };

  // Insert into the outbox within the provided transaction.
  // STUB: migration 004 (`domain_events_outbox` table) not yet authored.
  //       This query will fail until that migration is applied.
  await tx.query(
    `INSERT INTO domain_events_outbox
       (event_id, tenant_id, aggregate_type, aggregate_id, event_type,
        payload, partition_key, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      envelope.event_id,
      envelope.tenant_id,
      envelope.aggregate_type,
      envelope.aggregate_id,
      envelope.event_type,
      JSON.stringify(envelope.payload),
      envelope.partition_key,
      envelope.occurred_at,
    ],
  );

  return envelope;
}
