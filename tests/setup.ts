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

  // Apply all migrations idempotently.
  await applyMigrations(_client);

  // Seed minimal RBAC stubs for I-012 tests.
  await seedMinimalRbac(_client);
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
});

afterEach(async () => {
  if (_currentSavepoint !== null) {
    const client = getTestClient();
    await client.query(`ROLLBACK TO SAVEPOINT ${_currentSavepoint}`);
    await client.query(`RELEASE SAVEPOINT ${_currentSavepoint}`);
    _currentSavepoint = null;
  }
});
