/**
 * Global Vitest test setup — runs once per test process via `setupFiles` in
 * vitest.config.ts.
 *
 * Responsibilities:
 *   1. Connect to the ephemeral test Postgres (TEST_DATABASE_URL).
 *   2. Apply all migrations from migrations/ in sequence.
 *   3. Seed canonical tenants (Telecheck-US, Telecheck-Ghana) + minimal RBAC
 *      roles needed for I-012 three-clause tests.
 *   4. Register a beforeEach / afterEach pair that wraps every test in a
 *      SAVEPOINT → ROLLBACK TO SAVEPOINT cycle, giving test isolation without
 *      the cost of dropping and recreating tables between tests.
 *
 * Architecture decision — per-test savepoint vs ephemeral-DB-per-file:
 *   Savepoint wrapping is chosen because:
 *     - It is ~100× faster than spinning up a fresh schema per test file.
 *     - It is correct for tenant-isolation tests — each test sees a clean
 *       slate after rollback even when tests share the same process.
 *     - It is compatible with Postgres RLS because RLS policies survive the
 *       savepoint boundary (they are schema-level, not row-level state).
 *   Caveat: DDL statements inside a test (CREATE TABLE etc.) cannot be
 *   rolled back via savepoint in all Postgres versions. Tests in this repo
 *   do not issue DDL — they only DML. If a future test needs DDL, it must
 *   use the ephemeral-DB-per-file pattern and is responsible for its own
 *   teardown.
 *
 * Spec references:
 *   - ADR-023 (RLS enforcement — tests run against real Postgres with RLS on)
 *   - ADR-024 (per-tenant KMS alias seeded for both tenants)
 *   - I-023 (three-layer isolation; RLS must be live during tests)
 *   - I-027 (audit records carry tenant_id — seeds set up both tenant rows)
 *   - INVARIANTS I-012 (RBAC seed: clinician + pharmacist roles per reject-unless rule)
 *   - RBAC v1.1 (minimal role set seeded here; full RBAC migrations not yet present)
 *   - migrations/README.md (sequential, 000_extensions.sql first)
 *
 * Runtime gap to close before tests actually run:
 *   - TEST_DATABASE_URL must be set in the shell environment or .env.test.
 *   - npm install must have completed (pg is not yet in package.json — see
 *     DEPENDS ON note below).
 *   - Migrations 002–005 must exist (database-integration-expert agent writes them).
 *     The setup applies all *.sql files found in migrations/ sorted numerically,
 *     so it auto-picks up new migrations as they land.
 *
 * DEPENDS ON:
 *   - `pg` and `@types/pg` (not yet in package.json — add as devDependencies).
 *   - migrations/002_audit_chain.sql (database-integration-expert agent)
 *   - migrations/003_rls_helpers.sql (database-integration-expert agent)
 *   - migrations/004_domain_events_outbox.sql (database-integration-expert agent)
 *   - migrations/005_idempotency_keys.sql (database-integration-expert agent)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Client, type ClientConfig } from 'pg';
import { afterEach, beforeAll, beforeEach } from 'vitest';

import { setTestPool, type DbClient } from '../src/lib/db.ts';

// ---------------------------------------------------------------------------
// Re-export the shared client reference so helpers can import it.
// Tests MUST NOT create their own pg.Client — always use the shared client
// from this module so the savepoint transaction wrapping applies correctly.
// ---------------------------------------------------------------------------

let _client: Client | null = null;

/** The shared pg.Client used across all integration tests in this process. */
export function getTestClient(): Client {
  if (_client === null) {
    throw new Error(
      'Test database client is not initialized. ' +
        'Make sure this module is loaded via setupFiles in vitest.config.ts.',
    );
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(import.meta.dirname ?? __dirname, '../migrations');

async function applyMigrations(client: Client): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('rollback'))
    .sort(); // lexicographic sort → 000, 001, 002 ... is correct

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await client.query(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Idempotent: IF NOT EXISTS guards in migrations make re-runs safe.
      // Skip "already exists" errors but fail on everything else.
      if (!message.includes('already exists')) {
        throw new Error(`Migration ${file} failed: ${message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RBAC seed for I-012 tests
//
// I-012 three-clause rule requires:
//   Clause 3 — confirming actor RBAC-authorized for the action class.
// We seed a minimal roles table stub. The full RBAC migration lands with the
// Admin Backend slice; for now we insert rows directly into a test-only
// table or simulate authorization via a mock resolver.
//
// DEPENDS ON: migrations/006_rbac_roles.sql (Admin Backend agent). Until that
// migration exists, i012-prescribing.test.ts stubs the RBAC resolver.
// ---------------------------------------------------------------------------

async function seedMinimalRbac(client: Client): Promise<void> {
  // Attempt to seed; if the rbac_roles table does not exist yet, skip silently.
  // The i012-prescribing.test.ts file documents the stub workaround.
  try {
    await client.query(`
      INSERT INTO rbac_roles (role_id, role_name, tenant_id, action_classes)
      VALUES
        ('role_clinician_us',  'clinician',   'Telecheck-US',    ARRAY['prescribing','refill','medication_order']),
        ('role_clinician_gh',  'clinician',   'Telecheck-Ghana', ARRAY['prescribing','refill','medication_order']),
        ('role_pharmacist_us', 'pharmacist',  'Telecheck-US',    ARRAY['dispensing_release']),
        ('role_pharmacist_gh', 'pharmacist',  'Telecheck-Ghana', ARRAY['dispensing_release'])
      ON CONFLICT (role_id) DO NOTHING
    `);
  } catch {
    // Table not yet created — expected at bootstrap. Tests that need RBAC
    // rows will stub the resolver. See i012-prescribing.test.ts TODO.
  }
}

// ---------------------------------------------------------------------------
// Non-superuser test role for RLS enforcement
//
// Postgres SUPERUSER bypasses Row-Level Security regardless of FORCE ROW LEVEL
// SECURITY on the table — that's a hard kernel rule, not a policy choice. The
// CI workflow's `telecheck_ci` user is a superuser (default for postgres-alpine),
// so all RLS-enforcement tests would silently pass through to all rows when
// running migrations + queries as that user.
//
// Workaround: after migrations run as superuser, create a non-superuser /
// non-bypass-RLS role and SET SESSION AUTHORIZATION to it for the rest of
// the test process. Migrations run with elevated permissions; tests run with
// realistic RLS-applicable permissions.
//
// Future state: when the production RBAC role migration (006_roles.sql) lands,
// this test role can be replaced with the real `telecheck_app_role` referenced
// in 002 and 003 migration comments.
// ---------------------------------------------------------------------------

const TEST_APP_ROLE = 'telecheck_test_app';

async function installTestAppRole(client: Client): Promise<void> {
  // Idempotent across test-process restarts: DROP-then-CREATE would invalidate
  // grants from a prior run; CREATE IF NOT EXISTS uses DO block.
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_APP_ROLE}') THEN
        CREATE ROLE ${TEST_APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END
    $$;
  `);

  // Schema + table grants — broad enough for tests to INSERT / SELECT against
  // every PHI table; RLS still filters cross-tenant rows.
  await client.query(`GRANT USAGE ON SCHEMA public TO ${TEST_APP_ROLE}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TEST_APP_ROLE}`,
  );
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${TEST_APP_ROLE}`);
  await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${TEST_APP_ROLE}`);

  // Strip UPDATE / DELETE on append-only tables to mirror the production
  // privilege posture per I-003 (and the matching forms-engine snapshot
  // append-only discipline). The append-only triggers in migration 002 +
  // forms-intake snapshot migration would also block mutation, but having
  // both REVOKE + trigger is the platform-floor pattern: a privilege
  // assertion test (i003-audit-append-only.test.ts) verifies the privilege
  // layer alone is denying.
  //
  // (Patch 2026-05-03 per Codex CI-fix adversarial review MEDIUM-1: the
  //  prior broad `GRANT ... ON ALL TABLES` left audit_records mutation
  //  privileges granted to the test role, and the I-003 privilege test
  //  was using `toBeLessThanOrEqual(1)` so CI passed even with the grant
  //  active. The combination normalized a production shape where the app
  //  role can attempt audit mutation — a layer of belt that I-003 expects
  //  to be in place independently of the suspenders.)
  await client.query(`REVOKE UPDATE, DELETE ON audit_records FROM ${TEST_APP_ROLE}`);
  // forms_snapshot is also append-only per Forms/Intake slice; revoke
  // pre-emptively if the table exists. The IF EXISTS pattern via DO block
  // tolerates skeleton-state runs where forms_snapshot hasn't been created
  // by the slice migration yet.
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'forms_snapshot' AND relkind = 'r') THEN
        EXECUTE 'REVOKE UPDATE, DELETE ON forms_snapshot FROM ${TEST_APP_ROLE}';
      END IF;
    END
    $$;
  `);
}

// ---------------------------------------------------------------------------
// Global beforeAll — connect + migrate + seed
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const connectionString = process.env['TEST_DATABASE_URL'];
  if (!connectionString) {
    throw new Error(
      'TEST_DATABASE_URL environment variable is not set. ' +
        'Set it to a Postgres connection string pointing to the ephemeral test database, ' +
        'e.g. postgresql://telecheck_test:password@localhost:5432/telecheck_test',
    );
  }

  const config: ClientConfig = { connectionString };
  _client = new Client(config);
  await _client.connect();

  // Apply all migrations idempotently. Runs as superuser — required for
  // CREATE EXTENSION, CREATE FUNCTION ... SECURITY DEFINER, etc.
  await applyMigrations(_client);

  // Seed minimal RBAC stubs for I-012 tests.
  await seedMinimalRbac(_client);

  // Switch the session to a non-superuser role so RLS actually applies for
  // tests. SET SESSION AUTHORIZATION persists across savepoints and across
  // every BEGIN/COMMIT cycle on this connection.
  await installTestAppRole(_client);
  await _client.query(`SET SESSION AUTHORIZATION ${TEST_APP_ROLE}`);

  // Install the test-pool override so any code path that calls
  // `getPool()` (withConnection / withTenantBoundConnection / withTransaction
  // in src/lib/db.ts) gets back a wrapper that returns THIS shared client
  // on every connect(). Without this, integration tests that seed via the
  // test client (inside the savepoint-wrapped outer transaction) would
  // have their data invisible to HTTP requests routed through the app's
  // pool — DIFFERENT physical connection, can't see uncommitted writes.
  // The CI run on commit 37db5b3 surfaced this as
  // `forms.deployment.template_not_found` on a freshly-seeded template.
  setTestPool(_client as unknown as DbClient);
});

// ---------------------------------------------------------------------------
// Per-test transaction isolation via savepoints
//
// Using savepoints rather than full BEGIN/COMMIT because:
//   1. We maintain a single long-running connection (faster than reconnecting).
//   2. The outer connection is already in autocommit — we start a transaction
//      in beforeAll and each test uses a savepoint within that transaction.
//   3. On rollback to savepoint, all inserts/updates/deletes from the test
//      are undone, including RLS context variables (SET LOCAL session vars).
//
// IMPORTANT: SET LOCAL session variables (used by rls.ts set_tenant_context)
// are scoped to the current transaction. Savepoint rollback does NOT reset
// SET LOCAL variables set AFTER the savepoint — they are visible for the
// duration of the enclosing transaction. Tests that set tenant context must
// do so INSIDE the savepoint, and the afterEach ROLLBACK TO SAVEPOINT
// undoes the SET LOCAL as well because it resets the transaction state to
// the savepoint boundary.
//
// Actually: SET LOCAL in Postgres is reset when the enclosing transaction
// rolls back to a savepoint only if the SET LOCAL was issued after the
// savepoint. This is correct for our pattern since withTenantContext() calls
// SET LOCAL inside the test body, which runs after SAVEPOINT.
// ---------------------------------------------------------------------------

let _savepointCounter = 0;
let _currentSavepoint: string | null = null;
let _transactionOpen = false;

beforeEach(async () => {
  const client = getTestClient();
  if (!_transactionOpen) {
    await client.query('BEGIN');
    _transactionOpen = true;
  }
  _savepointCounter += 1;
  _currentSavepoint = `sp_${_savepointCounter}`;
  await client.query(`SAVEPOINT ${_currentSavepoint}`);

  // Defensive tx-health probe: if the outer transaction is in an aborted
  // state, every subsequent statement except ROLLBACK/SAVEPOINT/RELEASE
  // fails with `current transaction is aborted, commands ignored ...`.
  // The savepoint we just created is INSIDE the aborted region, so
  // ROLLBACK TO SAVEPOINT to it doesn't recover state — we need a full
  // ROLLBACK + BEGIN to restart the outer tx from clean. Cross-test
  // seeded data (file beforeAll INSERTs that ran in autocommit BEFORE
  // any BEGIN) is unaffected by ROLLBACK; in-savepoint inserts from
  // prior tests have already been rolled back at afterEach.
  //
  // Closes the rls.test.ts §6 "real DB round-trip" cascade where the
  // FIRST §6 test's beforeEach left the outer tx aborted and tests 2-5
  // all failed with `current transaction is aborted`. (Codex setup-r1
  // 2026-05-04 — first attempt used ROLLBACK TO SAVEPOINT which doesn't
  // recover an aborted-before-savepoint state; this version uses a
  // full ROLLBACK + BEGIN.)
  try {
    await client.query('SELECT 1');
  } catch {
    // Outer tx is aborted at savepoint creation time. Discard the bad
    // savepoint, reset the outer tx fully, and start fresh.
    try {
      await client.query(`RELEASE SAVEPOINT ${_currentSavepoint}`);
    } catch {
      // RELEASE may fail in some edge cases — swallow; the next ROLLBACK
      // resets everything.
    }
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    _savepointCounter += 1;
    _currentSavepoint = `sp_${_savepointCounter}`;
    await client.query(`SAVEPOINT ${_currentSavepoint}`);
  }
});

afterEach(async () => {
  if (_currentSavepoint !== null) {
    const client = getTestClient();
    // ROLLBACK TO SAVEPOINT works on aborted txns; RELEASE SAVEPOINT
    // works on the post-rollback (non-aborted) savepoint. Both must run
    // to keep the outer tx healthy for the next test. Errors here are
    // logged but swallowed so a single test's cleanup failure doesn't
    // abort the entire test run.
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${_currentSavepoint}`);
    } catch {
      // Swallow — beforeEach probe will recover.
    }
    try {
      await client.query(`RELEASE SAVEPOINT ${_currentSavepoint}`);
    } catch {
      // Swallow — beforeEach probe will recover.
    }
    _currentSavepoint = null;
  }
});
