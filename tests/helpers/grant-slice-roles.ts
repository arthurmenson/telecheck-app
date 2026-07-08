/**
 * grant-slice-roles.ts — mirror the production app-role acquisition
 * topology onto the test principal for slice suites that exercise the
 * `withDbRole` SET LOCAL ROLE elevation path.
 *
 * Why this exists (pinned by CI runs 28911340820 for async-consult and
 * 28944926412 for Mode 1 chat persistence): migrations 051/061/064/068
 * grant slice-role memberships to `telecheck_app_role` (the PRODUCTION
 * login principal), but the integration suite's shared client runs as
 * `telecheck_test_app` (tests/setup.ts installTestAppRole +
 * SET SESSION AUTHORIZATION), which gets broad table grants and NO
 * slice-role memberships — so any handler's `SET LOCAL ROLE
 * <slice_role>` raises 42501 and every request that reaches the
 * elevated write path 500s.
 *
 * The fix precedent is tests/integration/async-consult-v1-http.test.ts
 * beforeAll: open a DEDICATED superuser connection from
 * TEST_DATABASE_URL (the shared client's session authorization is the
 * non-superuser test role and cannot GRANT membership) and issue plain
 * `GRANT <role> TO telecheck_test_app`. Plain GRANT because CI is
 * PG 15 — the migration 051 §2 per-membership `WITH INHERIT FALSE,
 * SET TRUE` clause is PG 16 grammar; the PG 15 posture relies on the
 * member role's attributes, exactly as migration 061's version branch
 * documents. This helper extracts that precedent so per-suite
 * beforeAll blocks don't each hand-roll the superuser client.
 *
 * IMPORTANT — do NOT rely on another suite having granted the role:
 * vitest forks run test files in nondeterministic order, so a suite
 * that happens to run after async-consult-v1-http's SLICE_ROLES-wide
 * grant loop passes while an earlier-scheduled fork 42501s. Every
 * suite that elevates into a slice role MUST call this helper for the
 * roles it needs in its own beforeAll.
 *
 * GRANT ROLE is committed DDL (session-independent, idempotent —
 * re-granting an existing membership is a no-op notice), so parallel
 * suites calling this concurrently are safe.
 */

import pg from 'pg';

import type { SliceRole } from '../../src/lib/with-db-role.ts';

/** The session role the shared test client runs as (tests/setup.ts). */
const TEST_APP_ROLE = 'telecheck_test_app';

/**
 * Grant `telecheck_test_app` membership in the given slice roles via a
 * dedicated superuser connection. Call from a suite's beforeAll BEFORE
 * any request that reaches a `withDbRole(tx, <role>, ...)` call.
 */
export async function grantSliceRolesToTestApp(roles: readonly SliceRole[]): Promise<void> {
  const superuser = new pg.Client({
    connectionString: process.env['TEST_DATABASE_URL'] as string,
  });
  await superuser.connect();
  try {
    for (const sliceRole of roles) {
      await superuser.query(`GRANT ${sliceRole} TO ${TEST_APP_ROLE}`);
    }
  } finally {
    await superuser.end();
  }
}
