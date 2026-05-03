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

import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createTenant,
  expectCrossTenantDenial,
  TENANT_GHANA,
  TENANT_US,
  withTenantContext,
} from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

// Schema-mapping note (CI fix 2026-05-03): the audit_records table stores the
// AUDIT_EVENTS envelope across discrete columns (`recorded_at`, `payload`,
// `prev_hash`/`record_hash`/`sequence_number`). The BEFORE INSERT trigger
// computes the hash chain — callers MUST NOT supply hash columns. The
// domain_events_outbox table uses `created_at` (not `occurred_at` /
// `emitted_at` from earlier draft tests). The idempotency_keys table requires
// non-null `endpoint` and `actor_id` and stores `request_hash` as BYTEA.
// See tests/helpers/audit-assertions.ts for the audit-envelope mapping.

// ---------------------------------------------------------------------------
// audit_records — cross-tenant isolation
// ---------------------------------------------------------------------------

describe('audit_records — cross-tenant isolation (I-023, I-027)', () => {
  it('should deny Tenant B read access to Tenant A audit records via RLS', async () => {
    const client = getTestClient();
    const auditId = randomUUID();

    // Insert a minimal audit record under TENANT_US.
    // Using a direct INSERT here (not via the audit emitter in src/lib/audit.ts)
    // because the emitter takes a `tx` handle and these tests don't manage one;
    // the emitter is exercised by its own tests alongside src/lib/audit.ts.
    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `INSERT INTO audit_records
           (audit_id, tenant_id, actor_type, actor_id,
            target_patient_id, action, category, audit_sensitivity_level,
            resource_type, resource_id, payload)
         VALUES
           ($1, $2, 'system', 'sys_xtenant_001',
            'pat_xtenant_001', 'prescribing.initiated', 'A', 'standard',
            'medication_request', 'mr_xtenant_001', '{}'::jsonb)`,
        [auditId, TENANT_US],
      );
    });

    // TENANT_GHANA should see 0 rows for TENANT_US's audit_id.
    await expectCrossTenantDenial(TENANT_US, TENANT_GHANA, async () => {
      const result = await client.query(`SELECT * FROM audit_records WHERE audit_id = $1`, [
        auditId,
      ]);
      return result.rows as unknown[];
    });
  });

  it('should deny dynamically created Tenant C read access to Tenant A audit records', async () => {
    const client = getTestClient();
    const tenantC = await createTenant({ country_of_care: 'US' });
    const auditId = randomUUID();

    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `INSERT INTO audit_records
           (audit_id, tenant_id, actor_type, actor_id,
            target_patient_id, action, category, audit_sensitivity_level,
            resource_type, resource_id, payload)
         VALUES
           ($1, $2, 'clinician', 'clin_xtenant_001',
            'pat_xtenant_002', 'prescribing.approved', 'A', 'standard',
            'medication_request', 'mr_xtenant_002', '{}'::jsonb)`,
        [auditId, TENANT_US],
      );
    });

    await expectCrossTenantDenial(TENANT_US, tenantC, async () => {
      const result = await client.query(`SELECT * FROM audit_records WHERE audit_id = $1`, [
        auditId,
      ]);
      return result.rows as unknown[];
    });
  });
});

// ---------------------------------------------------------------------------
// domain_events_outbox — cross-tenant isolation
// ---------------------------------------------------------------------------

describe('domain_events_outbox — cross-tenant isolation (I-023)', () => {
  it('should deny Tenant B read access to Tenant A domain events via RLS', async () => {
    const client = getTestClient();
    const eventId = randomUUID();
    const aggregateId = `mr_gh_${randomUUID().slice(0, 8)}`;

    // Insert a domain event under TENANT_GHANA.
    // domain_events_outbox schema from migrations/004_domain_events_outbox.sql:
    // event_id (UUID), tenant_id, event_type, aggregate_type, aggregate_id,
    // partition_key, payload, published_at (NULL ok), created_at (default NOW()).
    // partition_key format: tenant_id:aggregate_id per DOMAIN_EVENTS v5.2.
    await withTenantContext(TENANT_GHANA, async () => {
      await client.query(
        `INSERT INTO domain_events_outbox
           (event_id, tenant_id, event_type, aggregate_type, aggregate_id,
            partition_key, payload)
         VALUES
           ($1, $2, 'medication_request.initiated',
            'MedicationRequest', $3,
            $4, '{}'::jsonb)`,
        [eventId, TENANT_GHANA, aggregateId, `${TENANT_GHANA}:${aggregateId}`],
      );
    });

    await expectCrossTenantDenial(TENANT_GHANA, TENANT_US, async () => {
      const result = await client.query(`SELECT * FROM domain_events_outbox WHERE event_id = $1`, [
        eventId,
      ]);
      return result.rows as unknown[];
    });
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
    //
    // Schema (migrations/005_idempotency_keys.sql) requires non-null
    // request_hash (BYTEA), response_status (INTEGER), endpoint, actor_id.
    // PK is (tenant_id, key, endpoint, actor_id) so the same key reused with
    // different (endpoint, actor) tuples is intentionally allowed.
    const client = getTestClient();
    const sharedKey = `idem_xtenant_${randomUUID().slice(0, 8)}`;
    const endpoint = '/v0/medication-requests';
    const actorId = 'sys_idempotency_test';

    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `INSERT INTO idempotency_keys
           (tenant_id, key, request_hash, response_status, response_body,
            endpoint, actor_id, expires_at)
         VALUES
           ($1, $2, decode($3, 'hex'), 201, '{"status": "ok"}'::jsonb,
            $4, $5, NOW() + INTERVAL '1 hour')`,
        [TENANT_US, sharedKey, 'aa'.repeat(32), endpoint, actorId],
      );
    });

    await withTenantContext(TENANT_GHANA, async () => {
      await client.query(
        `INSERT INTO idempotency_keys
           (tenant_id, key, request_hash, response_status, response_body,
            endpoint, actor_id, expires_at)
         VALUES
           ($1, $2, decode($3, 'hex'), 201, '{"status": "ok"}'::jsonb,
            $4, $5, NOW() + INTERVAL '1 hour')`,
        [TENANT_GHANA, sharedKey, 'bb'.repeat(32), endpoint, actorId],
      );
    });

    // TENANT_US should see only their row.
    const usRows = await withTenantContext(TENANT_US, async () => {
      const r = await client.query(`SELECT * FROM idempotency_keys WHERE key = $1`, [sharedKey]);
      return r.rows as unknown[];
    });
    expect(usRows).toHaveLength(1);
    expect((usRows[0] as { tenant_id: string }).tenant_id).toBe(TENANT_US);

    // TENANT_GHANA should see only their row.
    const ghRows = await withTenantContext(TENANT_GHANA, async () => {
      const r = await client.query(`SELECT * FROM idempotency_keys WHERE key = $1`, [sharedKey]);
      return r.rows as unknown[];
    });
    expect(ghRows).toHaveLength(1);
    expect((ghRows[0] as { tenant_id: string }).tenant_id).toBe(TENANT_GHANA);
  });

  it('should deny Tenant B read access to Tenant A idempotency key', async () => {
    const client = getTestClient();
    const key = `idem_isolation_${randomUUID().slice(0, 8)}`;

    await withTenantContext(TENANT_US, async () => {
      await client.query(
        `INSERT INTO idempotency_keys
           (tenant_id, key, request_hash, response_status, response_body,
            endpoint, actor_id, expires_at)
         VALUES
           ($1, $2, decode($3, 'hex'), 201, '{"status": "ok"}'::jsonb,
            '/v0/medication-requests', 'sys_idem_isolation', NOW() + INTERVAL '1 hour')`,
        [TENANT_US, key, 'cc'.repeat(32)],
      );
    });

    await expectCrossTenantDenial(TENANT_US, TENANT_GHANA, async () => {
      const result = await client.query(`SELECT * FROM idempotency_keys WHERE key = $1`, [key]);
      return result.rows as unknown[];
    });
  });
});
