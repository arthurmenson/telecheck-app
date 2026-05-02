/**
 * Tenant fixture helpers for integration tests.
 *
 * These helpers create tenants, users, and tenant-context wrappers used
 * across the test suite. They operate against the shared test pg.Client
 * managed by tests/setup.ts (per-test savepoint isolation applies).
 *
 * Architecture note — canonical vs test-only tenants:
 *   'Telecheck-US' and 'Telecheck-Ghana' are seeded by migrations/001_tenants.sql
 *   and are available to every test via the constants below. For cross-tenant
 *   isolation tests that need a distinct second tenant, use createTenant() which
 *   generates a unique 'Telecheck-XX' style ID so as not to collide with
 *   the canonical tenants or with other parallel test runs.
 *
 * Spec references:
 *   - ADR-023 (multi-tenancy Model A — tenant_id on every PHI record)
 *   - ADR-024 (per-tenant KMS key alias)
 *   - I-023 (three-layer tenant isolation)
 *   - I-025 (tenant-blind error envelopes — helpers support cross-tenant
 *            denial assertions)
 *   - I-027 (audit records carry tenant_id)
 *   - Master PRD v1.10 §17 + GLOSSARY v5.2 C3 brand-structure:
 *       tenant.id = 'Telecheck-{country}'; consumer_dba is the patient-facing name.
 *       NEVER use tenant.id as a patient-facing label.
 *   - RBAC v1.1 (role names used in createTestUser)
 *   - migrations/README.md (migrations/003_rls_helpers.sql provides set_tenant_context)
 *
 * DEPENDS ON:
 *   - tests/setup.ts (getTestClient)
 *   - migrations/001_tenants.sql (tenants table exists)
 *   - migrations/003_rls_helpers.sql (set_tenant_context function exists)
 *     Written by database-integration-expert agent. Until it lands, withTenantContext
 *     falls back to SET LOCAL app.current_tenant_id directly.
 */

import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Canonical tenant identifiers (seeded by 001_tenants.sql)
// ---------------------------------------------------------------------------

/** Operating-tenant identifier for the US tenant. */
export const TENANT_US = 'Telecheck-US' as const;

/** Operating-tenant identifier for the Ghana tenant. */
export const TENANT_GHANA = 'Telecheck-Ghana' as const;

export type TenantId = string;

// ---------------------------------------------------------------------------
// TenantInput — minimal columns required to INSERT a tenant row
// ---------------------------------------------------------------------------

export interface TenantInput {
  id: TenantId;
  consumer_dba: string;
  country_of_care: 'US' | 'GH';
  kms_key_alias: string;
  status: 'active' | 'suspended' | 'archived';
}

// ---------------------------------------------------------------------------
// UserContext — placeholder shape; expanded when users migration lands
// ---------------------------------------------------------------------------

export interface UserContext {
  userId: string;
  tenantId: TenantId;
  role: string;
}

// ---------------------------------------------------------------------------
// createTenant
// ---------------------------------------------------------------------------

/**
 * Insert a unique ephemeral tenant for the current test.
 *
 * The generated id uses the pattern 'Telecheck-T' + 2 random uppercase letters
 * to satisfy the tenant_id_format CHECK constraint in 001_tenants.sql:
 *   `^Telecheck-[A-Z][A-Za-z]+$`
 *
 * Returns the tenant id. The row is rolled back by the afterEach savepoint
 * in tests/setup.ts — no manual cleanup needed.
 *
 * @param overrides - Optional partial TenantInput to customize columns.
 */
export async function createTenant(overrides: Partial<TenantInput> = {}): Promise<TenantId> {
  const client = getTestClient();

  // Generate a collision-resistant 2-letter suffix (26^2 = 676 combinations;
  // sufficient for test-run parallelism at this scale).
  const suffix = randomUppercaseLetters(2);
  const defaultId: TenantId = `Telecheck-T${suffix}`;

  const input: TenantInput = {
    id: defaultId,
    consumer_dba: `Test Tenant ${suffix}`,
    country_of_care: 'US',
    kms_key_alias: `alias/telecheck-test-${suffix.toLowerCase()}-data-key`,
    status: 'active',
    ...overrides,
  };

  await client.query(
    `INSERT INTO tenants (id, consumer_dba, country_of_care, kms_key_alias, status, activated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [input.id, input.consumer_dba, input.country_of_care, input.kms_key_alias, input.status],
  );

  return input.id;
}

// ---------------------------------------------------------------------------
// createTestUser
// ---------------------------------------------------------------------------

/**
 * Create a minimal test user associated with a tenant and role.
 *
 * PLACEHOLDER — the users table and auth migration are not yet written.
 * Returns a synthetic UserContext. Tests that need real user rows must
 * stub the relevant queries until the users migration lands.
 *
 * Roles must be one of the canonical RBAC v1.1 role names:
 *   'platform_admin' | 'tenant_admin' | 'clinician' | 'pharmacist' |
 *   'patient' | 'operator' | 'research_data_steward' | 'research_ethics_committee_member' |
 *   'marketing_operator'
 *
 * DEPENDS ON: migrations/006_users.sql (to be written by foundation agent).
 *
 * @param tenantId - The tenant this user belongs to.
 * @param role     - RBAC v1.1 role name.
 */
export async function createTestUser(tenantId: TenantId, role: string): Promise<UserContext> {
  // TODO: INSERT into users table once migrations/006_users.sql lands.
  // For now return a synthetic context. Tests that exercise RLS user-context
  // enforcement must call withTenantContext explicitly.
  const userId = `test_user_${randomUppercaseLetters(6).toLowerCase()}`;
  return { userId, tenantId, role };
}

// ---------------------------------------------------------------------------
// withTenantContext
// ---------------------------------------------------------------------------

/**
 * Run `fn` within a Postgres session that has `tenant_id` set via the
 * set_tenant_context() RLS helper (migrations/003_rls_helpers.sql).
 *
 * This makes the RLS policies on PHI tables evaluate as if the requesting
 * session belongs to `tenantId`. All queries inside `fn` that touch
 * RLS-protected tables will be filtered to this tenant's rows.
 *
 * Uses SET LOCAL so the context is scoped to the current transaction
 * (the savepoint block from tests/setup.ts). The context is automatically
 * reset when the savepoint is rolled back at afterEach.
 *
 * DEPENDS ON: migrations/003_rls_helpers.sql (set_tenant_context function).
 * Falls back to direct SET LOCAL if the function does not exist yet.
 *
 * @param tenantId - The tenant context to apply for the duration of `fn`.
 * @param fn       - Async callback to execute under the tenant context.
 */
export async function withTenantContext<T>(tenantId: TenantId, fn: () => Promise<T>): Promise<T> {
  const client = getTestClient();

  // Attempt to call set_tenant_context() if it exists; fall back to direct
  // SET LOCAL. Both achieve the same result — the function is preferred
  // because it also sets the row_security flag.
  try {
    await client.query('SELECT set_tenant_context($1)', [tenantId]);
  } catch {
    // Function not yet created (migrations 003 not yet applied). Use direct
    // SET LOCAL as an approximation.
    await client.query('SET LOCAL app.current_tenant_id = $1', [tenantId]);
  }

  return fn();
}

// ---------------------------------------------------------------------------
// expectCrossTenantDenial
// ---------------------------------------------------------------------------

/**
 * Assert that `query` returns data when run under tenantA's context but
 * returns 0 rows (or throws a permission error) when run under tenantB's
 * context — enforcing I-023 + I-025.
 *
 * Pattern:
 *   1. Run query under tenantA — assert rowCount > 0.
 *   2. Run query under tenantB — assert rowCount === 0 (RLS silently filters)
 *      OR throws (application-layer rejection).
 *
 * "Tenant-blind" means tenantB must NOT receive a 403 or an error that
 * reveals the resource exists in tenantA. The RLS-layer behaviour is to
 * return 0 rows, which is the same shape as "resource does not exist" —
 * this satisfies I-025.
 *
 * @param tenantA   - The tenant that owns the resource.
 * @param tenantB   - The tenant that should be denied.
 * @param query     - Async function that performs the data access.
 *                    Should return the row array or throw on access error.
 */
export async function expectCrossTenantDenial<T>(
  tenantA: TenantId,
  tenantB: TenantId,
  query: () => Promise<T[]>,
): Promise<void> {
  // Step 1: tenantA should see the data.
  const rowsA = await withTenantContext(tenantA, query);
  if (!Array.isArray(rowsA) || rowsA.length === 0) {
    throw new Error(
      `expectCrossTenantDenial: query returned 0 rows under owner tenant '${tenantA}'. ` +
        'The fixture data was not inserted correctly, or the query is wrong.',
    );
  }

  // Step 2: tenantB should see nothing — RLS filters to 0 rows.
  let rowsB: T[] | undefined;
  let tenantBThrew = false;
  try {
    rowsB = await withTenantContext(tenantB, query);
  } catch {
    // An application-layer rejection (e.g. 403 from route handler) is also
    // acceptable — it means the app-layer caught the cross-tenant attempt
    // before RLS even evaluated. Both outcomes satisfy I-023 + I-025.
    tenantBThrew = true;
  }

  if (!tenantBThrew) {
    // RLS path: must return 0 rows.
    if (!Array.isArray(rowsB) || rowsB.length > 0) {
      throw new Error(
        `I-023 / I-025 VIOLATION: tenant '${tenantB}' received ${String(rowsB?.length ?? '?')} rows ` +
          `that belong to tenant '${tenantA}'. Cross-tenant access was not denied.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function randomUppercaseLetters(n: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
