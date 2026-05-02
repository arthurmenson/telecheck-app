/**
 * Tenant isolation integration tests.
 *
 * Invariants under test: I-023, I-025, I-027, I-028.
 *
 * Spec references:
 *   - I-023: Three-layer tenant isolation (RLS + app-layer + KMS).
 *   - I-025: Error responses do not differentiate "doesn't exist" from
 *            "exists in another tenant" — both yield the same not-found envelope.
 *   - I-027: Every audit record carries tenant_id.
 *   - I-028: Single DB / single schema; isolation is logical, not physical.
 *   - ADR-023: Model A multi-tenancy — tenant_id on every PHI record.
 *   - Tenant Threading Addendum v1.0: per-slice tenant threading rules.
 *   - migrations/002_audit_chain.sql: audit_records table (tenant-scoped).
 *   - migrations/004_domain_events_outbox.sql: domain_events_outbox (tenant-scoped).
 *   - migrations/005_idempotency_keys.sql: idempotency_keys (tenant-scoped).
 *
 * Pattern (copy-paste template for slice tests):
 *   1. Insert a row under Tenant A using withTenantContext(TENANT_A).
 *   2. Query under Tenant B using withTenantContext(TENANT_B).
 *   3. Assert 0 rows — RLS silently filters cross-tenant rows.
 *   4. Assert error envelope (when hitting the HTTP layer) is tenant-blind.
 *
 * DEPENDS ON:
 *   - tests/setup.ts (beforeEach/afterEach savepoint wrapping)
 *   - tests/helpers/tenant-fixtures.ts (createTenant, withTenantContext, expectCrossTenantDenial)
 *   - tests/helpers/audit-assertions.ts (assertAuditChainIntact)
 *   - tests/helpers/invariant-assertions.ts (assertInvariants)
 *   - migrations/002_audit_chain.sql (audit_records table; database-integration-expert)
 *   - migrations/003_rls_helpers.sql (set_tenant_context; database-integration-expert)
 *   - migrations/004_domain_events_outbox.sql (domain_events_outbox; database-integration-expert)
 *   - migrations/005_idempotency_keys.sql (idempotency_keys; database-integration-expert)
 */

import { describe, expect, it } from 'vitest';
import { assertInvariants } from '../helpers/invariant-assertions.ts';
import {
  createTenant,
  expectCrossTenantDenial,
  TENANT_GHANA,
  TENANT_US,
  withTenantContext,
} from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// audit_records — cross-tenant isolation
// ---------------------------------------------------------------------------

describe('audit_records — cross-tenant isolation (I-023, I-027)', () => {
  it('should deny Tenant B read access to Tenant A audit records via RLS', async () => {
    const client = getTestClient();

    // Insert a minimal audit record under TENANT_US.
    // The actual audit_records schema comes from migrations/002_audit_chain.sql.
    // Using a direct INSERT here (not via the audit emitter in src/lib/audit.ts)
    // because the emitter is not yet implemented. This is intentional:
    //   - Tests verify the RLS policy, not the emitter.
    //   - The emitter's tests live alongside src/lib/audit.ts per CLAUDE.md.
    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `INSERT INTO audit_records
           (audit_id, timestamp, tenant_id, actor_type, actor_id, action, category,
            audit_sensitivity_level, resource_type, resource_id, detail, hash_chain)
         VALUES
           ('aud_test_us_001', NOW(), $1, 'system', 'sys_001',
            'prescribing.initiated', 'A', 'standard',
            'medication_request', 'mr_001', '{}',
            '{"partition": "pat_001", "sequence_number": 1, "previous_hash": "0000", "record_hash": "abcd"}')`,
        [TENANT_US],
      );
    });

    // TENANT_GHANA should see 0 rows for TENANT_US's audit_id.
    await expectCrossTenantDenial(TENANT_US, TENANT_GHANA, async () => {
      const result = await client.query(
        `SELECT * FROM audit_records WHERE audit_id = 'aud_test_us_001'`,
      );
      return result.rows as unknown[];
    });

    await assertInvariants(['I-023', 'I-027'], { tenantId: TENANT_US });
  });

  it('should deny dynamically created Tenant C read access to Tenant A audit records', async () => {
    const client = getTestClient();
    const tenantC = await createTenant({ country_of_care: 'US' });

    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `INSERT INTO audit_records
           (audit_id, timestamp, tenant_id, actor_type, actor_id, action, category,
            audit_sensitivity_level, resource_type, resource_id, detail, hash_chain)
         VALUES
           ('aud_test_us_002', NOW(), $1, 'clinician', 'clin_001',
            'prescribing.approved', 'A', 'standard',
            'medication_request', 'mr_002', '{}',
            '{"partition": "pat_002", "sequence_number": 1, "previous_hash": "0000", "record_hash": "efgh"}')`,
        [TENANT_US],
      );
    });

    await expectCrossTenantDenial(TENANT_US, tenantC, async () => {
      const result = await client.query(
        `SELECT * FROM audit_records WHERE audit_id = 'aud_test_us_002'`,
      );
      return result.rows as unknown[];
    });

    await assertInvariants(['I-023'], { tenantA: TENANT_US, tenantB: tenantC });
  });
});

// ---------------------------------------------------------------------------
// domain_events_outbox — cross-tenant isolation
// ---------------------------------------------------------------------------

describe('domain_events_outbox — cross-tenant isolation (I-023)', () => {
  it('should deny Tenant B read access to Tenant A domain events via RLS', async () => {
    const client = getTestClient();

    // Insert a domain event under TENANT_GHANA.
    // domain_events_outbox schema from migrations/004_domain_events_outbox.sql.
    // partition_key format: tenant_id:aggregate_id per DOMAIN_EVENTS v5.2.
    await withTenantContext(TENANT_GHANA, async () => {
      await client.query(
        `INSERT INTO domain_events_outbox
           (event_id, tenant_id, event_type, aggregate_type, aggregate_id,
            partition_key, payload, occurred_at, emitted_at)
         VALUES
           ('evt_test_gh_001', $1, 'medication_request.initiated',
            'MedicationRequest', 'mr_gh_001',
            $2, '{}', NOW(), NOW())`,
        [TENANT_GHANA, `${TENANT_GHANA}:mr_gh_001`],
      );
    });

    await expectCrossTenantDenial(TENANT_GHANA, TENANT_US, async () => {
      const result = await client.query(
        `SELECT * FROM domain_events_outbox WHERE event_id = 'evt_test_gh_001'`,
      );
      return result.rows as unknown[];
    });

    await assertInvariants(['I-023'], { tenantA: TENANT_GHANA, tenantB: TENANT_US });
  });
});

// ---------------------------------------------------------------------------
// idempotency_keys — cross-tenant isolation
// ---------------------------------------------------------------------------

describe('idempotency_keys — cross-tenant isolation (I-023)', () => {
  it('should allow same idempotency key in different tenants without collision', async () => {
    // IDEMPOTENCY contract v5.1: keys are tenant-scoped. Same key in different
    // tenants is independent — inserting the same key for two tenants must not
    // conflict and each tenant sees only their own row.
    const client = getTestClient();
    const sharedKey = 'idem_key_cross_tenant_test_001';

    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `INSERT INTO idempotency_keys (key, tenant_id, request_hash, response_body, expires_at)
         VALUES ($1, $2, 'hash_us', '{"status": "ok"}', NOW() + INTERVAL '1 hour')`,
        [sharedKey, TENANT_US],
      );
    });

    await withTenantContext(TENANT_GHANA, async () => {
      await client.query(
        `INSERT INTO idempotency_keys (key, tenant_id, request_hash, response_body, expires_at)
         VALUES ($1, $2, 'hash_gh', '{"status": "ok"}', NOW() + INTERVAL '1 hour')`,
        [sharedKey, TENANT_GHANA],
      );
    });

    // TENANT_US should see only their row.
    const usRows = await withTenantContext(TENANT_US, async () => {
      const r = await client.query(
        `SELECT * FROM idempotency_keys WHERE key = $1`,
        [sharedKey],
      );
      return r.rows as unknown[];
    });
    expect(usRows).toHaveLength(1);
    expect((usRows[0] as { tenant_id: string }).tenant_id).toBe(TENANT_US);

    // TENANT_GHANA should see only their row.
    const ghRows = await withTenantContext(TENANT_GHANA, async () => {
      const r = await client.query(
        `SELECT * FROM idempotency_keys WHERE key = $1`,
        [sharedKey],
      );
      return r.rows as unknown[];
    });
    expect(ghRows).toHaveLength(1);
    expect((ghRows[0] as { tenant_id: string }).tenant_id).toBe(TENANT_GHANA);

    await assertInvariants(['I-023'], { tenantA: TENANT_US, tenantB: TENANT_GHANA });
  });

  it('should deny Tenant B read access to Tenant A idempotency key', async () => {
    const client = getTestClient();
    const key = 'idem_key_isolation_test_002';

    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `INSERT INTO idempotency_keys (key, tenant_id, request_hash, response_body, expires_at)
         VALUES ($1, $2, 'hash_us_only', '{"status": "ok"}', NOW() + INTERVAL '1 hour')`,
        [key, TENANT_US],
      );
    });

    await expectCrossTenantDenial(TENANT_US, TENANT_GHANA, async () => {
      const result = await client.query(
        `SELECT * FROM idempotency_keys WHERE key = $1`,
        [key],
      );
      return result.rows as unknown[];
    });
  });
});
