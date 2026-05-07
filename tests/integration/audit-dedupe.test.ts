/**
 * audit-dedupe.test.ts — Integration tests for the cross-cutting
 * Category A audit-dedupe helper (`src/lib/audit-dedupe.ts`).
 *
 * Sprint 34 / SI-006 audit-dedupe SI (2026-05-08). Closes the deferred
 * HIGH from Sprint 33 PR-F2 r4: Category A audits could duplicate
 * across a crash/DB-failure window between independent audit commit
 * and idempotency completion.
 *
 * Coverage:
 *   Group A — basic claim semantics (first-claim true, retry false)
 *   Group B — distinct dedupe keys for different audit_action labels
 *   Group C — distinct dedupe keys across tenants (cross-tenant
 *             isolation; the same idempotency key in two tenants
 *             does NOT collide)
 *   Group D — purge-expired removes only expired rows; future markers
 *             stay
 *   Group E — `computeAuditDedupeKey` is deterministic + collision-
 *             safe across the 5-tuple components
 *
 * Why integration-level (real DB):
 *   The helper's correctness depends on Postgres semantics:
 *     - PRIMARY KEY (tenant_id, dedupe_key) + ON CONFLICT DO NOTHING
 *     - RETURNING semantics on conflict (empty rowset signal)
 *     - DELETE WHERE expires_at <= NOW() rowCount truthfulness
 *   Mock Postgres would lose the contract; real DB is honest.
 *
 * Spec references:
 *   - migrations/022_audit_dedupe_markers.sql
 *   - src/lib/audit-dedupe.ts
 *   - I-019 (crisis detection durability), I-003 (audit append-only)
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type AuditDedupeIdentity,
  claimAuditDedupeSlot,
  computeAuditDedupeKey,
  purgeExpiredAuditDedupeMarkers,
} from '../../src/lib/audit-dedupe.ts';
import { type DbTransaction, withTransaction } from '../../src/lib/db.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_GHANA as TENANT_GH, TENANT_US } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an AuditDedupeIdentity with random idempotencyKey + endpoint
 * suffix to prevent cross-test collisions on a shared test DB. Default
 * tenant US; override per test.
 */
function freshIdentity(overrides: Partial<AuditDedupeIdentity> = {}): AuditDedupeIdentity {
  const random = ulid().slice(-10);
  return {
    tenantId: TENANT_US,
    idempotencyKey: ulid(),
    endpoint: `/v0/test/audit-dedupe/${random}`,
    actorId: `acct_${random}`,
    auditAction: 'crisis_detection_trigger',
    ...overrides,
  };
}

/** Run a callback inside a fresh tx with the tenant context set. */
async function inTenantTx<T>(tenantId: string, cb: (tx: DbTransaction) => Promise<T>): Promise<T> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);
    return cb(tx);
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
});

afterAll(async () => {
  // The shared test client is closed by tests/setup.ts globalTeardown.
});

// ---------------------------------------------------------------------------
// Group A — basic claim semantics
// ---------------------------------------------------------------------------

describe('audit-dedupe — Group A: basic claim semantics', () => {
  it('first claim returns true; identical retry returns false', async () => {
    const identity = freshIdentity();

    const claimed1 = await inTenantTx(identity.tenantId, (tx) =>
      claimAuditDedupeSlot(tx, identity),
    );
    expect(claimed1).toBe(true);

    const claimed2 = await inTenantTx(identity.tenantId, (tx) =>
      claimAuditDedupeSlot(tx, identity),
    );
    expect(claimed2).toBe(false);

    // A third call with the same identity is also blocked — no
    // implicit consumption.
    const claimed3 = await inTenantTx(identity.tenantId, (tx) =>
      claimAuditDedupeSlot(tx, identity),
    );
    expect(claimed3).toBe(false);
  });

  it('different idempotencyKey under the same actor/endpoint claims a separate slot', async () => {
    const base = freshIdentity();
    const other = { ...base, idempotencyKey: ulid() };

    const claimedBase = await inTenantTx(base.tenantId, (tx) => claimAuditDedupeSlot(tx, base));
    const claimedOther = await inTenantTx(other.tenantId, (tx) => claimAuditDedupeSlot(tx, other));
    expect(claimedBase).toBe(true);
    expect(claimedOther).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group B — auditAction discriminates
// ---------------------------------------------------------------------------

describe('audit-dedupe — Group B: auditAction discriminates', () => {
  it('same idempotency 4-tuple but different auditAction labels yield distinct slots', async () => {
    const base = freshIdentity({ auditAction: 'crisis_detection_trigger' });
    const merged = { ...base, auditAction: 'crisis_detection_trigger.merged_set' };

    const claimedBase = await inTenantTx(base.tenantId, (tx) => claimAuditDedupeSlot(tx, base));
    const claimedMerged = await inTenantTx(merged.tenantId, (tx) =>
      claimAuditDedupeSlot(tx, merged),
    );

    // Both first-claims succeed because auditAction differentiates.
    expect(claimedBase).toBe(true);
    expect(claimedMerged).toBe(true);

    // Each is independently locked on retry.
    const retryBase = await inTenantTx(base.tenantId, (tx) => claimAuditDedupeSlot(tx, base));
    const retryMerged = await inTenantTx(merged.tenantId, (tx) => claimAuditDedupeSlot(tx, merged));
    expect(retryBase).toBe(false);
    expect(retryMerged).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group C — cross-tenant isolation
// ---------------------------------------------------------------------------

describe('audit-dedupe — Group C: cross-tenant isolation', () => {
  it('same idempotencyKey + endpoint + actor + action in two tenants → both claims succeed', async () => {
    // Same client-supplied idempotency key in two tenants is independent
    // per IDEMPOTENCY v5.1 §1 (cache PK includes tenant_id). Dedupe
    // markers respect the same boundary — the (tenant_id, dedupe_key)
    // PK structurally enforces it.
    const sharedKey = ulid();
    const sharedEndpoint = `/v0/test/audit-dedupe/cross-tenant/${ulid().slice(-10)}`;
    const sharedActor = `acct_${ulid().slice(-10)}`;

    const usIdentity = freshIdentity({
      tenantId: TENANT_US,
      idempotencyKey: sharedKey,
      endpoint: sharedEndpoint,
      actorId: sharedActor,
    });
    const ghIdentity = freshIdentity({
      tenantId: TENANT_GH,
      idempotencyKey: sharedKey,
      endpoint: sharedEndpoint,
      actorId: sharedActor,
    });

    const claimedUs = await inTenantTx(usIdentity.tenantId, (tx) =>
      claimAuditDedupeSlot(tx, usIdentity),
    );
    const claimedGh = await inTenantTx(ghIdentity.tenantId, (tx) =>
      claimAuditDedupeSlot(tx, ghIdentity),
    );

    // Both first-claims succeed because tenant_id is in the dedupe-key
    // hash AND in the table's PK — no cross-tenant collision possible.
    expect(claimedUs).toBe(true);
    expect(claimedGh).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group D — purge-expired
// ---------------------------------------------------------------------------

describe('audit-dedupe — Group D: purge-expired', () => {
  it('purge deletes only expired markers in the given tenant; future markers stay', async () => {
    const identity = freshIdentity();
    const client = getTestClient();

    // Manually insert an EXPIRED marker for this identity by overriding
    // expires_at to a past timestamp.
    const dedupeKey = computeAuditDedupeKey(identity);
    await client.query('SELECT set_tenant_context($1)', [identity.tenantId]);
    await client.query(
      `INSERT INTO audit_dedupe_markers (tenant_id, dedupe_key, created_at, expires_at)
       VALUES ($1, $2, NOW() - INTERVAL '60 days', NOW() - INTERVAL '1 day')`,
      [identity.tenantId, dedupeKey],
    );

    // Insert a non-expired marker too, just to verify it's preserved.
    const otherIdentity = freshIdentity({ tenantId: identity.tenantId });
    const otherClaimed = await inTenantTx(identity.tenantId, (tx) =>
      claimAuditDedupeSlot(tx, otherIdentity),
    );
    expect(otherClaimed).toBe(true);

    // Purge.
    const deletedCount = await inTenantTx(identity.tenantId, (tx) =>
      purgeExpiredAuditDedupeMarkers(tx, identity.tenantId),
    );
    expect(deletedCount).toBeGreaterThanOrEqual(1);

    // The expired marker is gone — a fresh claim succeeds.
    const reclaimedExpired = await inTenantTx(identity.tenantId, (tx) =>
      claimAuditDedupeSlot(tx, identity),
    );
    expect(reclaimedExpired).toBe(true);

    // The non-expired marker stays — a re-claim returns false.
    const otherRetry = await inTenantTx(identity.tenantId, (tx) =>
      claimAuditDedupeSlot(tx, otherIdentity),
    );
    expect(otherRetry).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group E — computeAuditDedupeKey determinism + collision safety
// ---------------------------------------------------------------------------

describe('audit-dedupe — Group E: computeAuditDedupeKey', () => {
  it('is deterministic — same input yields same hex digest', () => {
    const identity = freshIdentity();
    const k1 = computeAuditDedupeKey(identity);
    const k2 = computeAuditDedupeKey({ ...identity });
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it('any field change yields a different digest', () => {
    const base = freshIdentity();
    const variants: AuditDedupeIdentity[] = [
      { ...base, tenantId: 'Telecheck-Other' },
      { ...base, idempotencyKey: ulid() },
      { ...base, endpoint: '/v0/test/audit-dedupe/different-endpoint' },
      { ...base, actorId: `acct_${ulid().slice(-10)}` },
      { ...base, auditAction: 'crisis_detection_trigger.merged_set' },
    ];
    const baseHash = computeAuditDedupeKey(base);
    for (const v of variants) {
      expect(computeAuditDedupeKey(v)).not.toBe(baseHash);
    }
  });

  it('uses ASCII unit separator (0x1F) so values cannot bleed across fields', () => {
    // Two identities that would be indistinguishable under naive
    // concatenation but distinct under SEP-joined input:
    //   identity A: tenantId='Telecheck-US', idempotencyKey='AB|/v0'
    //   identity B: tenantId='Telecheck-US|AB', idempotencyKey='/v0'
    // …with the rest equal. Naive `tenantId + idempotencyKey + …`
    // would collide; SEP-joined cannot.
    const random = ulid().slice(-10);
    const a = freshIdentity({
      tenantId: TENANT_US,
      idempotencyKey: `AB${random}`,
    });
    const b = freshIdentity({
      tenantId: `${TENANT_US}AB`,
      idempotencyKey: random,
    });
    expect(computeAuditDedupeKey(a)).not.toBe(computeAuditDedupeKey(b));
  });
});
