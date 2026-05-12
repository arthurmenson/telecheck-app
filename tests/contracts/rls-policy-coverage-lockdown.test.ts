/**
 * RLS policy coverage lockdown — DB-backed structural test.
 *
 * Sprint 6 / TLC-016. Closes ORT items OR-112 ("Test strategy
 * specification — multi-tenant isolation testing — RLS policy
 * validation") and OR-236 ("Multi-tenant isolation security review —
 * PostgreSQL RLS policies"). Both are Tier 1 launch-blocking per
 * `Telecheck_Operational_Readiness_Todo_v1_5.md`.
 *
 * Sibling pattern to:
 *   - tests/contracts/canonical-glossary.test.ts (static source-grep
 *     contract; I-014 Canonical vocabulary lockdown)
 *   - tests/contracts/crisis-detection-coverage-lockdown.test.ts (static
 *     source-grep contract; I-019 Crisis detection wiring lockdown)
 *
 * Difference: this test is DB-backed because pg_class + pg_policies
 * are runtime catalog tables, not source-grep-able. Otherwise the
 * shape — "static structural assertions covering an invariant's
 * cross-cutting wiring" — is identical.
 *
 * What this lockdown asserts:
 *   §1 Per-table assertions for each of the 21 tenant-scoped tables:
 *     - relrowsecurity = true (RLS is enabled)
 *     - relforcerowsecurity = true (RLS bypasses are forbidden — even
 *       superusers / table owners must satisfy policy)
 *     - ≥1 row in pg_policies (at least one policy is attached)
 *   §2 Count assertion: exactly 21 tenant-scoped tables have RLS
 *     POLICY entries; if a future migration drops a policy without
 *     updating the count, the test fires.
 *   §3 Platform-level table exclusion: `tenants` table is platform-
 *     level (carries `id` as tenant identifier; no `tenant_id` column
 *     on itself); MUST NOT appear in tenant-scoped enumeration.
 *
 * What this lockdown does NOT assert:
 *   - Specific policy names (`tenant_isolation` is the default but
 *     `audit_records` uses `audit_tenant_isolation` and `tenant_users`
 *     uses `tenant_users_visibility` per the migration history;
 *     asserting a fixed name would silently pass-for-wrong-reason on
 *     the exceptions OR fail when those exceptions are correct).
 *   - Policy USING / WITH CHECK expressions (covered by the per-tenant
 *     functional tests in `i023-tenant-isolation.test.ts` and the
 *     per-slice cross-tenant tests).
 *   - Encryption-at-rest / KMS key isolation (covered by ADR-024
 *     wiring tests when the Admin Backend slice v1.1 lands).
 *
 * Spec references:
 *   - I-023 Tenant isolation is enforced at three layers
 *   - ADR-023 Model A multi-tenancy
 *   - migrations/003_rls_helpers.sql (set_tenant_context; default RLS policies)
 *   - migrations/002_audit_chain.sql (audit_records + audit_tenant_isolation policy)
 *   - migrations/019_adapter_configs_tenant_users.sql (tenant_users_visibility policy)
 *   - PM Sprint 6 brief verification gate findings (file:line citations)
 *
 * Sprint reference: Sprint 6 / TLC-016. Codex FIRE per Sprint 6 plan
 * (real new-coverage; novel test class warrants adversarial scrutiny).
 */

import { describe, expect, it } from 'vitest';

import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// The 23 tenant-scoped tables that MUST have RLS enabled + a tenant policy.
//
// Initial inventory (21 tables): verified at the Sprint 6 PM kickoff via
// `grep "CREATE POLICY.*ON " migrations/*.sql`.
//
// Sprint 9 / TLC-021a addition (+2 tables): `consults` + `consult_events`
// from migration 020_async_consult.sql. Per the lockdown's design, intentional
// schema additions UPDATE this list (and the count); unintentional changes
// (drops, renames, missed RLS-attachment) trigger the §2 count drift test.
//
// If a future migration adds a tenant-scoped table, it MUST be added here
// AND the migration MUST attach a tenant-isolation policy. The §2 count
// assertion catches the latter; this list catches the former at the
// per-table assertions in §1.
// ---------------------------------------------------------------------------
const TENANT_SCOPED_TABLES = [
  'accounts',
  'adapter_configs',
  'audit_records',
  'auth_devices',
  'ccr_configs',
  'consent',
  'consent_versions',
  'consult_events',
  'consults',
  'delegation_scopes',
  'delegations',
  'domain_events_outbox',
  'forms_deployment',
  'forms_resume_state',
  'forms_snapshot',
  'forms_submission',
  'forms_template',
  'forms_variant',
  'idempotency_keys',
  'otp_challenges',
  'product_catalog', // migration 024 — per CDM v1.2 §4.9 ProductCatalog
  'sessions',
  'tenant_brands',
  'tenant_users',
] as const;

const TENANT_SCOPED_TABLE_COUNT = TENANT_SCOPED_TABLES.length;

// ---------------------------------------------------------------------------
// Platform-level tables that MUST be excluded from tenant-scoped enumeration.
// `tenants` carries `id` as the tenant identifier (no `tenant_id` column on
// itself); it is the platform-level lookup table. Other platform-level tables
// (country_profiles, etc.) have no RLS by design — they're shared across
// tenants. The exclusion list here is explicit so a future migration that
// accidentally adds RLS to a platform-level table surfaces (the dynamic
// pg_class enumeration in §2 would catch it).
// ---------------------------------------------------------------------------
const PLATFORM_LEVEL_TABLES_EXCLUDED_FROM_RLS = [
  'tenants', // tenant lookup table; carries `id` as the tenant identifier
  'country_profiles', // CCR country registry; shared across tenants
] as const;

// ---------------------------------------------------------------------------
// §1 — Per-table RLS-enabled + RLS-forced + has-policy assertions
// ---------------------------------------------------------------------------

describe('I-023 RLS policy coverage lockdown — §1 per-table structural assertions', () => {
  it.each(TENANT_SCOPED_TABLES)(
    '§1.%s has RLS enabled (relrowsecurity=true) and forced (relforcerowsecurity=true)',
    async (tableName) => {
      const client = getTestClient();
      const r = await client.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relname = $1`,
        [tableName],
      );
      expect(r.rows.length).toBe(1);
      const row = r.rows[0];
      // Both must hold:
      //   relrowsecurity = true       → RLS is enabled
      //   relforcerowsecurity = true  → RLS is enforced for ALL roles
      //                                 including superuser / table owner;
      //                                 prevents accidental bypass
      // Per ADR-023 + I-023 three-layer enforcement, RLS at this layer is
      // the FIRST line of defense; if either flag is false, app-layer
      // filtering (Layer 2) becomes load-bearing alone, which is
      // explicitly NOT the design intent.
      expect(row?.relrowsecurity).toBe(true);
      expect(row?.relforcerowsecurity).toBe(true);
    },
  );

  it.each(TENANT_SCOPED_TABLES)('§1.%s has at least one RLS policy attached', async (tableName) => {
    const client = getTestClient();
    // Do NOT assert on policyname — three name conventions exist in
    // production migrations:
    //   - `tenant_isolation`        (19 tables; default convention)
    //   - `audit_tenant_isolation`  (audit_records only)
    //   - `tenant_users_visibility` (tenant_users only — special-cased
    //                                 for platform-admin cross-tenant
    //                                 visibility per TLC-005)
    // Asserting a fixed name would silently pass-for-wrong-reason on
    // the exceptions OR fail when those exceptions are correct.
    // This lockdown asserts policy PRESENCE only; functional behavior
    // (USING / WITH CHECK expressions) is covered by the per-slice
    // cross-tenant tests.
    const r = await client.query<{ policyname: string }>(
      `SELECT policyname
           FROM pg_policies
          WHERE tablename = $1`,
      [tableName],
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// §2 — Count assertion (catches policy-drop regressions)
// ---------------------------------------------------------------------------

describe('I-023 RLS policy coverage lockdown — §2 count drift detection', () => {
  it('§2a exactly TENANT_SCOPED_TABLE_COUNT tables have RLS policies (no policy-drop drift)', async () => {
    const client = getTestClient();

    // Dynamic count from pg_policies — catches drift from BOTH directions:
    //   - A migration drops a policy → count < expected → test fires
    //   - A migration adds a tenant-scoped table without updating
    //     TENANT_SCOPED_TABLES → count > expected → test fires (forces
    //     an explicit decision on whether the new table is tenant-scoped)
    //
    // We exclude platform-level tables explicitly. If a future migration
    // adds RLS to a platform-level table (e.g., adds tenant_id column to
    // country_profiles), the count would drift and the test would surface
    // the divergence.
    const r = await client.query<{ tablename: string }>(
      `SELECT DISTINCT tablename
         FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename != ALL($1::text[])
        ORDER BY tablename`,
      [PLATFORM_LEVEL_TABLES_EXCLUDED_FROM_RLS],
    );
    const actualTables = r.rows.map((row) => row.tablename).sort();
    const expectedTables = [...TENANT_SCOPED_TABLES].sort();

    // Surface the diff if the test fails so the diagnosis is immediate.
    expect(actualTables).toEqual(expectedTables);
    expect(actualTables.length).toBe(TENANT_SCOPED_TABLE_COUNT);
  });

  it('§2b every table with relrowsecurity=true is in the tenant-scoped list (no rogue platform RLS)', async () => {
    const client = getTestClient();

    // Reverse direction: every table flagged as RLS-enabled in pg_class
    // must appear in TENANT_SCOPED_TABLES. Catches the case where a
    // future migration enables RLS on a platform-level table (which
    // would be wrong by ADR-023's "tenant_id on every PHI record"
    // design — platform-level tables have no tenant_id column to scope
    // on, so RLS doesn't make sense).
    const r = await client.query<{ relname: string }>(
      `SELECT relname
         FROM pg_class
        WHERE relrowsecurity = true
          AND relkind = 'r'                  -- regular tables only
          AND relnamespace = 'public'::regnamespace
          AND relname != ALL($1::text[])     -- exclude platform-level allowlist
        ORDER BY relname`,
      [PLATFORM_LEVEL_TABLES_EXCLUDED_FROM_RLS],
    );
    const actualRlsEnabledTables = r.rows.map((row) => row.relname).sort();
    const expectedTables = [...TENANT_SCOPED_TABLES].sort();

    expect(actualRlsEnabledTables).toEqual(expectedTables);
  });
});

// ---------------------------------------------------------------------------
// §3 — Platform-level exclusion lockdown
// ---------------------------------------------------------------------------

describe('I-023 RLS policy coverage lockdown — §3 platform-level tables stay platform-level', () => {
  it.each(PLATFORM_LEVEL_TABLES_EXCLUDED_FROM_RLS)(
    '§3.%s is platform-level (no RLS — would be wrong by ADR-023 design)',
    async (tableName) => {
      const client = getTestClient();
      const r = await client.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `SELECT relrowsecurity, relforcerowsecurity
           FROM pg_class
          WHERE relname = $1`,
        [tableName],
      );
      // Platform-level tables MUST exist in any post-migration DB state
      // (they're created by migrations 001 + later). If absent, the
      // migration environment is broken — fail HARD rather than soft-skip.
      // Codex rls-policy-r1 MEDIUM closure 2026-05-05: prior version
      // returned early on `r.rows.length === 0`, which would silently
      // pass §3 against any catalog-backed contract failure where the
      // lookup table wasn't created. A "schema drift / migrations not
      // applied" CI path would have reported false-green on the whole
      // platform-level exclusion section.
      expect(r.rows.length).toBe(1);
      // Platform-level tables MUST NOT have RLS enabled. If a future
      // migration accidentally turns it on, this test fires.
      expect(r.rows[0]?.relrowsecurity).toBe(false);
      expect(r.rows[0]?.relforcerowsecurity).toBe(false);
    },
  );
});
