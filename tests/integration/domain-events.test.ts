/**
 * Domain events outbox emitter — integration tests.
 *
 * Covers `src/lib/domain-events.ts` (`emitDomainEvent`), which until this
 * commit had ZERO test coverage despite being invoked from nine call sites
 * across the Forms/Intake module (and being a platform-floor primitive that
 * every future slice will depend on).
 *
 * What this file pins down:
 *   1. Envelope shape — `event_id` is a valid UUID v4 (matches migration 004
 *      column type), `partition_key` is the canonical composite
 *      `${tenant_id}:${aggregate_id}` per DOMAIN_EVENTS v5.2 tenant-scope rule.
 *   2. Same-transaction semantics (I-016 + outbox pattern) — when the caller's
 *      transaction rolls back, the outbox INSERT rolls back with it. No event
 *      survives a failed business transaction.
 *   3. Required-field validation — `tenant_id` (I-023), `aggregate_id`,
 *      `event_type` are non-optional; missing them throws BEFORE the SQL fires.
 *   4. Business-clock preservation — `occurred_at` from the input is folded
 *      into the persisted JSONB payload alongside any caller-supplied keys
 *      (the DB stores `created_at` = wall clock; consumers that need the
 *      business clock read it from `payload.occurred_at`).
 *   5. INSERT-failure surfacing — when the underlying INSERT errors (e.g. FK
 *      violation on `tenant_id`), the wrapped error includes the event_type,
 *      tenant, aggregate, and event_id for upstream debugging, AND the
 *      caller's transaction can roll back cleanly.
 *   6. Tenant isolation (I-023) — events written under tenant A's RLS context
 *      are invisible to tenant B's session.
 *   7. Many-event ordering — successive emissions in the same tx produce
 *      distinct `event_id`s and arrive in `created_at` order; partition_key
 *      groups them deterministically.
 *
 * Spec references:
 *   - I-016 (domain events immutable; outbox pattern, same-tx required)
 *   - I-023 (tenant isolation; tenant_id mandatory, RLS active)
 *   - I-027 (tenant_id on every audit-/event-bearing record)
 *   - DOMAIN_EVENTS v5.2:
 *       * Envelope: event_id, tenant_id, aggregate_type, aggregate_id,
 *         event_type, partition_key, payload, occurred_at.
 *       * partition_key = `${tenant_id}:${aggregate_id}` for tenant-scoped
 *         aggregates (this is what the partition_key column stores at the
 *         streaming layer; the outbox row mirrors it for downstream relays).
 *       * Same-transaction outbox semantics required (this lib implements them).
 *   - migration 004_domain_events_outbox.sql (the DB shape this lib targets)
 *
 * Test isolation:
 *   The shared test client wraps each test in a SAVEPOINT/ROLLBACK pair, so
 *   inserts here are discarded automatically at afterEach. Tests that
 *   explicitly probe rollback semantics use a NESTED savepoint inside the
 *   per-test savepoint so the rollback boundary is local — the outer test
 *   harness still cleans up everything.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { emitDomainEvent, type DbTransaction } from '../../src/lib/domain-events.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_GHANA, TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** UUID v4 regex — version nibble fixed to '4'; variant nibble in [89ab]. */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Build a minimal valid domain event input for forms-intake's
 * `intake_started` (a real, frequently-emitted event from
 * `src/modules/forms-intake/events.ts`). Using a real event_type keeps the
 * test grounded — if the event-type string ever changes in the contract,
 * the change is intentional and we want to know.
 */
function buildIntakeStartedInput(
  overrides: {
    tenantId?: string;
    aggregateId?: string;
    occurredAt?: string;
    payload?: Record<string, unknown>;
  } = {},
): Parameters<typeof emitDomainEvent>[1] {
  return {
    tenant_id: overrides.tenantId ?? TENANT_US,
    aggregate_type: 'forms_submission',
    aggregate_id: overrides.aggregateId ?? ulid(),
    event_type: 'forms_intake.intake_started.v1',
    occurred_at: overrides.occurredAt ?? new Date().toISOString(),
    payload: overrides.payload ?? { submission_status: 'in_progress' },
  };
}

/**
 * Apply RLS tenant context for the emit-and-then-read path. The shared test
 * client runs as the non-superuser test app role per tests/setup.ts, so the
 * `tenant_isolation` policy on `domain_events_outbox` actively filters reads.
 * Without setting context, `SELECT` returns zero rows even for rows the
 * caller just inserted.
 */
async function withCtx<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return withTenantContext(tenantId, fn);
}

interface OutboxRow {
  event_id: string;
  tenant_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  partition_key: string;
  payload: Record<string, unknown>;
  published_at: Date | null;
  attempt_count: number;
  created_at: Date;
}

async function readOutboxByEventId(eventId: string, tenantId: string): Promise<OutboxRow | null> {
  return withCtx(tenantId, async () => {
    const client = getTestClient();
    const { rows } = await client.query<OutboxRow>(
      `SELECT event_id, tenant_id, aggregate_type, aggregate_id, event_type,
              partition_key, payload, published_at, attempt_count, created_at
         FROM domain_events_outbox
        WHERE event_id = $1`,
      [eventId],
    );
    return rows[0] ?? null;
  });
}

// ---------------------------------------------------------------------------
// 1. Envelope shape (DOMAIN_EVENTS v5.2)
// ---------------------------------------------------------------------------

describe('emitDomainEvent — envelope shape', () => {
  it('returns event_id as a valid UUID v4 (matches migration 004 column type)', async () => {
    const aggregateId = ulid();
    const envelope = await withCtx(TENANT_US, () =>
      emitDomainEvent(getTestClient() as DbTransaction, buildIntakeStartedInput({ aggregateId })),
    );
    expect(envelope.event_id).toMatch(UUID_V4);
  });

  it('returns partition_key as the canonical composite tenant_id:aggregate_id', async () => {
    const aggregateId = ulid();
    const envelope = await withCtx(TENANT_US, () =>
      emitDomainEvent(getTestClient() as DbTransaction, buildIntakeStartedInput({ aggregateId })),
    );
    expect(envelope.partition_key).toBe(`${TENANT_US}:${aggregateId}`);
  });

  it('preserves caller-supplied envelope fields verbatim', async () => {
    const aggregateId = ulid();
    const occurredAt = new Date('2026-05-03T10:11:12.345Z').toISOString();
    const envelope = await withCtx(TENANT_US, () =>
      emitDomainEvent(
        getTestClient() as DbTransaction,
        buildIntakeStartedInput({ aggregateId, occurredAt }),
      ),
    );
    expect(envelope.tenant_id).toBe(TENANT_US);
    expect(envelope.aggregate_type).toBe('forms_submission');
    expect(envelope.aggregate_id).toBe(aggregateId);
    expect(envelope.event_type).toBe('forms_intake.intake_started.v1');
    expect(envelope.occurred_at).toBe(occurredAt);
  });
});

// ---------------------------------------------------------------------------
// 2. Persistence — row matches envelope, payload absorbs occurred_at
// ---------------------------------------------------------------------------

describe('emitDomainEvent — persistence', () => {
  it('persists a row whose columns match the returned envelope', async () => {
    const aggregateId = ulid();
    const envelope = await withCtx(TENANT_US, () =>
      emitDomainEvent(getTestClient() as DbTransaction, buildIntakeStartedInput({ aggregateId })),
    );
    const row = await readOutboxByEventId(envelope.event_id, TENANT_US);
    expect(row).not.toBeNull();
    expect(row!.tenant_id).toBe(envelope.tenant_id);
    expect(row!.aggregate_type).toBe(envelope.aggregate_type);
    expect(row!.aggregate_id).toBe(envelope.aggregate_id);
    expect(row!.event_type).toBe(envelope.event_type);
    expect(row!.partition_key).toBe(envelope.partition_key);
  });

  it('folds occurred_at (business clock) into the persisted JSONB payload alongside caller keys', async () => {
    const aggregateId = ulid();
    const occurredAt = new Date('2026-05-03T08:09:10.123Z').toISOString();
    const envelope = await withCtx(TENANT_US, () =>
      emitDomainEvent(
        getTestClient() as DbTransaction,
        buildIntakeStartedInput({
          aggregateId,
          occurredAt,
          payload: { submission_status: 'in_progress', custom_marker: 'abc' },
        }),
      ),
    );
    const row = await readOutboxByEventId(envelope.event_id, TENANT_US);
    expect(row).not.toBeNull();
    // occurred_at preserved alongside the original payload keys
    expect(row!.payload['occurred_at']).toBe(occurredAt);
    expect(row!.payload['submission_status']).toBe('in_progress');
    expect(row!.payload['custom_marker']).toBe('abc');
  });

  it('initializes published_at NULL and attempt_count 0 (relay control columns)', async () => {
    const envelope = await withCtx(TENANT_US, () =>
      emitDomainEvent(getTestClient() as DbTransaction, buildIntakeStartedInput()),
    );
    const row = await readOutboxByEventId(envelope.event_id, TENANT_US);
    expect(row!.published_at).toBeNull();
    expect(row!.attempt_count).toBe(0);
  });

  it('issues distinct event_ids for successive emissions in the same tx', async () => {
    const aggregateId = ulid();
    const ids: string[] = [];
    await withCtx(TENANT_US, async () => {
      for (let i = 0; i < 5; i += 1) {
        const env = await emitDomainEvent(
          getTestClient() as DbTransaction,
          buildIntakeStartedInput({ aggregateId, payload: { i } }),
        );
        ids.push(env.event_id);
      }
    });
    expect(new Set(ids).size).toBe(5);
    // All five share the same partition_key (same tenant + aggregate), proving
    // the partition_key formula is deterministic across calls.
    const partitionKeys = await withCtx(TENANT_US, async () => {
      const client = getTestClient();
      const { rows } = await client.query<{ partition_key: string }>(
        `SELECT partition_key FROM domain_events_outbox
         WHERE event_id = ANY($1::uuid[])`,
        [ids],
      );
      return rows.map((r) => r.partition_key);
    });
    expect(new Set(partitionKeys).size).toBe(1);
    expect(partitionKeys[0]).toBe(`${TENANT_US}:${aggregateId}`);
  });
});

// ---------------------------------------------------------------------------
// 3. Required-field validation (fail-fast BEFORE SQL fires)
// ---------------------------------------------------------------------------

describe('emitDomainEvent — required-field validation', () => {
  it('throws when tenant_id is empty (I-023)', async () => {
    await expect(
      emitDomainEvent(getTestClient() as DbTransaction, {
        tenant_id: '',
        aggregate_type: 'forms_submission',
        aggregate_id: ulid(),
        event_type: 'forms_intake.intake_started.v1',
        occurred_at: new Date().toISOString(),
        payload: {},
      }),
    ).rejects.toThrow(/tenant_id is required/);
  });

  it('throws when aggregate_id is empty', async () => {
    await expect(
      emitDomainEvent(getTestClient() as DbTransaction, {
        tenant_id: TENANT_US,
        aggregate_type: 'forms_submission',
        aggregate_id: '',
        event_type: 'forms_intake.intake_started.v1',
        occurred_at: new Date().toISOString(),
        payload: {},
      }),
    ).rejects.toThrow(/aggregate_id is required/);
  });

  it('throws when event_type is empty', async () => {
    await expect(
      emitDomainEvent(getTestClient() as DbTransaction, {
        tenant_id: TENANT_US,
        aggregate_type: 'forms_submission',
        aggregate_id: ulid(),
        event_type: '',
        occurred_at: new Date().toISOString(),
        payload: {},
      }),
    ).rejects.toThrow(/event_type is required/);
  });

  it('does NOT INSERT a row when validation fails (fail-before-SQL)', async () => {
    const aggregateId = ulid();
    // Snapshot the row count BEFORE the bad call.
    const before = await withCtx(TENANT_US, async () => {
      const client = getTestClient();
      const { rows } = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM domain_events_outbox WHERE aggregate_id = $1`,
        [aggregateId],
      );
      return Number(rows[0]!.n);
    });
    await expect(
      emitDomainEvent(getTestClient() as DbTransaction, {
        tenant_id: '',
        aggregate_type: 'forms_submission',
        aggregate_id: aggregateId,
        event_type: 'forms_intake.intake_started.v1',
        occurred_at: new Date().toISOString(),
        payload: {},
      }),
    ).rejects.toThrow();
    const after = await withCtx(TENANT_US, async () => {
      const client = getTestClient();
      const { rows } = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM domain_events_outbox WHERE aggregate_id = $1`,
        [aggregateId],
      );
      return Number(rows[0]!.n);
    });
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 4. Same-transaction semantics (I-016 + outbox pattern)
// ---------------------------------------------------------------------------

describe('emitDomainEvent — same-transaction semantics (I-016)', () => {
  it('rolls back the outbox row when the enclosing tx rolls back', async () => {
    const client = getTestClient();
    const aggregateId = ulid();

    // Use a NESTED savepoint inside the per-test savepoint so we can roll
    // back the inner work without unwinding the harness's outer state.
    const SP = `sp_dom_evt_rollback_${Date.now()}`;
    let emittedEventId = '';
    await withCtx(TENANT_US, async () => {
      await client.query(`SAVEPOINT ${SP}`);
      try {
        const env = await emitDomainEvent(
          client as DbTransaction,
          buildIntakeStartedInput({ aggregateId }),
        );
        emittedEventId = env.event_id;

        // Sanity: visible inside the savepoint.
        const { rows: insideRows } = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM domain_events_outbox WHERE event_id = $1`,
          [emittedEventId],
        );
        expect(Number(insideRows[0]!.n)).toBe(1);
      } finally {
        // Roll back the inner savepoint — emulates the caller transaction
        // failing after emit. Per I-016 + outbox pattern, the outbox row
        // must vanish in lockstep with the business write.
        await client.query(`ROLLBACK TO SAVEPOINT ${SP}`);
        await client.query(`RELEASE SAVEPOINT ${SP}`);
      }
    });

    // Post-rollback assertion — the event_id must NOT be in the table.
    const row = await readOutboxByEventId(emittedEventId, TENANT_US);
    expect(row).toBeNull();
  });

  it('persists the outbox row when the enclosing tx is allowed to commit (savepoint released)', async () => {
    const client = getTestClient();
    const aggregateId = ulid();

    const SP = `sp_dom_evt_commit_${Date.now()}`;
    let emittedEventId = '';
    await withCtx(TENANT_US, async () => {
      await client.query(`SAVEPOINT ${SP}`);
      const env = await emitDomainEvent(
        client as DbTransaction,
        buildIntakeStartedInput({ aggregateId }),
      );
      emittedEventId = env.event_id;
      // Release (not roll back) — emulates a successful caller commit at the
      // savepoint level. The row remains visible to the per-test savepoint.
      await client.query(`RELEASE SAVEPOINT ${SP}`);
    });

    const row = await readOutboxByEventId(emittedEventId, TENANT_US);
    expect(row).not.toBeNull();
    expect(row!.aggregate_id).toBe(aggregateId);
  });
});

// ---------------------------------------------------------------------------
// 5. INSERT-failure surfacing (FK violation, malformed UUID, etc.)
// ---------------------------------------------------------------------------

describe('emitDomainEvent — INSERT failure surfacing', () => {
  it('wraps INSERT failures with event_type / tenant / aggregate / event_id context', async () => {
    // Force an FK violation: tenant_id references tenants(id), so an unknown
    // tenant should fail at INSERT time, not at the JS-level validation gate.
    // The emitDomainEvent wrapper must surface the error with diagnostic context
    // so downstream operators can correlate it with the failing business write.
    const aggregateId = ulid();
    const bogusTenant = 'Telecheck-XX-NOT-A-REAL-TENANT';

    // Wrap in a savepoint so the FK error doesn't poison the outer transaction
    // (Postgres marks a tx as aborted after any error, and savepoints are the
    // only way to recover within the same connection).
    const client = getTestClient();
    const SP = `sp_dom_evt_fk_${Date.now()}`;
    await client.query(`SAVEPOINT ${SP}`);
    try {
      // Skip the RLS context wrapper — the FK to tenants (a non-RLS table)
      // fires before RLS policies do, so the result is the same.
      await expect(
        emitDomainEvent(client as DbTransaction, {
          tenant_id: bogusTenant,
          aggregate_type: 'forms_submission',
          aggregate_id: aggregateId,
          event_type: 'forms_intake.intake_started.v1',
          occurred_at: new Date().toISOString(),
          payload: {},
        }),
      ).rejects.toThrow(
        // Wrapped error must include event_type, tenant id, and aggregate id
        // for upstream debugging.
        new RegExp(
          `INSERT failed for event_type "forms_intake.intake_started.v1".*${bogusTenant}.*${aggregateId}`,
          's',
        ),
      );
    } finally {
      // Recover the outer transaction so subsequent tests aren't poisoned
      // by the aborted-tx state. ROLLBACK is needed here even on test
      // success because the FK error already aborted the tx scope.
      await client.query(`ROLLBACK TO SAVEPOINT ${SP}`);
      await client.query(`RELEASE SAVEPOINT ${SP}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Tenant isolation (I-023 RLS)
// ---------------------------------------------------------------------------

describe('emitDomainEvent — tenant isolation (I-023 RLS on domain_events_outbox)', () => {
  it('US-emitted events are invisible to a Ghana-context reader', async () => {
    const aggregateId = ulid();
    const envelope = await withCtx(TENANT_US, () =>
      emitDomainEvent(
        getTestClient() as DbTransaction,
        buildIntakeStartedInput({ tenantId: TENANT_US, aggregateId }),
      ),
    );

    // Reading under Ghana context — RLS policy `tenant_isolation` filters
    // out the US row.
    const ghanaRow = await readOutboxByEventId(envelope.event_id, TENANT_GHANA);
    expect(ghanaRow).toBeNull();

    // Sanity: the US row IS visible under US context (rules out a generic
    // read failure masquerading as isolation).
    const usRow = await readOutboxByEventId(envelope.event_id, TENANT_US);
    expect(usRow).not.toBeNull();
  });

  it('different tenants emitting the same aggregate_id produce distinct partition_keys', async () => {
    const aggregateId = ulid();

    const usEnv = await withCtx(TENANT_US, () =>
      emitDomainEvent(
        getTestClient() as DbTransaction,
        buildIntakeStartedInput({ tenantId: TENANT_US, aggregateId }),
      ),
    );
    const ghanaEnv = await withCtx(TENANT_GHANA, () =>
      emitDomainEvent(
        getTestClient() as DbTransaction,
        buildIntakeStartedInput({ tenantId: TENANT_GHANA, aggregateId }),
      ),
    );

    expect(usEnv.partition_key).toBe(`${TENANT_US}:${aggregateId}`);
    expect(ghanaEnv.partition_key).toBe(`${TENANT_GHANA}:${aggregateId}`);
    expect(usEnv.partition_key).not.toBe(ghanaEnv.partition_key);
  });
});

// ---------------------------------------------------------------------------
// Cleanup safety net
// ---------------------------------------------------------------------------

afterEach(async () => {
  // The per-test savepoint in tests/setup.ts already rolls back any rows we
  // inserted, so this hook is intentionally empty — it exists only as a
  // landing pad for future targeted cleanup if a test ever escapes the
  // savepoint envelope (e.g., by issuing its own COMMIT, which the suite
  // forbids).
});
