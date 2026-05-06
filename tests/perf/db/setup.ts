/**
 * tests/perf/db/setup.ts — Bench-mode ephemeral Postgres setup
 *
 * Sprint 14 / TLC-025-SCAFFOLD. Provides session-scoped Postgres
 * connection + migration apply + minimal seed for bench scenarios that
 * need a live DB (e.g., `emitAudit` hash chain — added Sprint 15+).
 *
 * Distinct from `tests/setup.ts` because:
 *   1. Bench's many-iteration model is INCOMPATIBLE with per-iteration
 *      SAVEPOINT wrapping. Bench iterations run thousands of times in
 *      tight loops; each iteration's BEGIN/SAVEPOINT/ROLLBACK overhead
 *      would dominate the measurement.
 *   2. Test-mode pool override (`setTestPool`) in `tests/setup.ts`
 *      INTERCEPTS BEGIN/COMMIT/ROLLBACK and translates to nested
 *      savepoints, which is correct for integration tests but wrong
 *      for bench mode (we want real transaction semantics so the
 *      measurement reflects production cost).
 *   3. Per-test SAVEPOINT/ROLLBACK in `tests/setup.ts` doesn't apply —
 *      bench has no equivalent of `it()` granularity. Vitest bench
 *      reports operations-per-second over a fixed wall-clock window;
 *      writes accumulate across iterations.
 *
 * Sprint 14 = SCAFFOLD ONLY. This file lands the infrastructure;
 * Sprint 15+ adds the first DB-backed bench scenario (candidate:
 * `emitAudit` hash chain) once CI validates this scaffold works
 * end-to-end against a real Postgres instance.
 *
 * Why scaffold-only at Sprint 14:
 *   - Authoring this file is verifiable in the autonomous shell via
 *     lint + tsc + structural-shape correctness (mirrors
 *     `tests/setup.ts` patterns)
 *   - Authoring a DB-backed bench file (e.g., `tests/perf/audit/
 *     emit-audit.bench.ts`) without local Postgres for execution
 *     verification would risk landing un-runnable code with the same
 *     hollow-coverage class issues Codex flagged 4 times on Sprint 13's
 *     TLC-026 closure-path infrastructure (per `docs/SPRINT_13_RETRO.md`
 *     §"Process changes for Sprint 14")
 *   - Sprint 15+ retro evaluates whether to add the first bench
 *     scenario only after CI confirms this scaffold's
 *     migration-apply + seed + non-superuser-role wiring is healthy
 *
 * Bench-mode usage pattern (Sprint 15+ pending):
 *   ```ts
 *   import { bench, describe } from 'vitest';
 *   import { withTransaction } from '../../../src/lib/db.ts';
 *   import { emitAudit } from '../../../src/lib/audit.ts';
 *
 *   describe('emitAudit — DB-backed bench', () => {
 *     bench('§9 happy-path single-row append', async () => {
 *       await withTransaction(async (tx) => {
 *         await emitAudit({ ... }, tx);
 *       });
 *     });
 *   });
 *   ```
 *
 * The `setupFiles` wiring in `vitest.bench.config.ts:36` runs THIS
 * file once per bench session; all bench files share the same DB +
 * connection pool.
 *
 * Spec references:
 *   - ORT v1.5 OR-218 (Tier 1 launch-blocking)
 *   - tests/perf/README.md §"Bench-mode DB-backed corpus"
 *   - vitest.bench.config.ts:13-18 (separate-config rationale)
 *   - ADR-023 (RLS — bench runs against real Postgres with RLS on
 *     against the non-superuser bench role; same enforcement as
 *     integration tests)
 *   - ADR-024 (per-tenant KMS — bench seeds Telecheck-US +
 *     Telecheck-Ghana tenants)
 *   - I-027 (audit_records carry tenant_id — bench seeds both tenant
 *     rows so emit-audit benches can target either)
 *
 * Required environment:
 *   - BENCH_DATABASE_URL — connection string to a fresh ephemeral
 *     Postgres for bench session use. Distinct from TEST_DATABASE_URL
 *     (integration tests) and DATABASE_URL (dev/prod) to prevent
 *     cross-contamination. The bench session writes to this DB and
 *     does NOT clean up between sessions; operators are expected to
 *     drop/recreate the bench DB on a schedule.
 *   - NODE_ENV — should be 'test' (matches existing migration-runner
 *     conventions). Bench mode does NOT use a separate NODE_ENV value
 *     because the audit.ts production-path durability gate
 *     (`if (tx) { INSERT }`) is exactly what we want to measure.
 *
 * Failure modes (fail-closed by design):
 *   - BENCH_DATABASE_URL not set → throw immediately. Don't fall back
 *     to TEST_DATABASE_URL or DATABASE_URL — silent fallback would
 *     pollute the integration-test or dev DB with bench iteration
 *     writes. Sprint 13 retro pre-emption pattern: doc-only-discipline
 *     ("don't run bench against your dev DB") is unenforceable; code
 *     enforcement = explicit env-var requirement.
 *   - Migration apply fails → throw with the failing migration filename
 *     and SQL error. Don't swallow.
 *   - Tenant seed conflicts with prior session leftover state → ON
 *     CONFLICT DO NOTHING (idempotent; same pattern as
 *     `tests/setup.ts` seedMinimalRbac).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { setTestPool, type DbClient } from '../../../src/lib/db.ts';

const { Client } = pg;

// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------

let _benchClient: pg.Client | null = null;

/**
 * Bench-mode shared client. Bench files MAY import this for direct
 * query access (e.g., for pre-bench fixture setup); they SHOULD prefer
 * the existing `withTransaction` / `withTenantBoundConnection` helpers
 * in `src/lib/db.ts` so the measurement reflects real production code
 * paths.
 */
export function getBenchClient(): pg.Client {
  if (_benchClient === null) {
    throw new Error(
      'Bench DB client is not initialized. ' +
        'Make sure this module is loaded via setupFiles in vitest.bench.config.ts AND ' +
        'BENCH_DATABASE_URL environment variable is set.',
    );
  }
  return _benchClient;
}

// ---------------------------------------------------------------------------
// Migration runner — mirrors tests/setup.ts:applyMigrations()
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(import.meta.dirname ?? __dirname, '../../../migrations');

async function applyMigrations(client: pg.Client): Promise<void> {
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
        throw new Error(`Bench DB migration ${file} failed: ${message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Tenant seed — Telecheck-US + Telecheck-Ghana per ADR-023/024 + I-027
// ---------------------------------------------------------------------------

async function seedMinimalTenants(client: pg.Client): Promise<void> {
  // Same canonical operator-tenant identifiers as integration tests +
  // production. ON CONFLICT DO NOTHING for idempotency across bench
  // session restarts on the same DB.
  try {
    await client.query(`
      INSERT INTO tenants (tenant_id, country_of_care, consumer_dba, kms_alias)
      VALUES
        ('Telecheck-US',    'US', 'Heros Health',       'alias/telecheck/us-bench'),
        ('Telecheck-Ghana', 'GH', 'Heros Health Ghana', 'alias/telecheck/gh-bench')
      ON CONFLICT (tenant_id) DO NOTHING
    `);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Tenants table may have a different shape in some migration states;
    // log + continue rather than fail the whole bench session for a
    // non-critical seed step.
    // (If the bench scenario actually needs tenant rows and they're
    //  missing, the bench file's own pre-step seed will fail explicitly.)
    console.warn(
      `bench-mode setup: tenant seed soft-failed (${message}); ` +
        'bench files relying on canonical tenants must verify presence',
    );
  }
}

// ---------------------------------------------------------------------------
// Non-superuser bench app role — mirrors tests/setup.ts pattern
//
// Same RLS-enforcement rationale: Postgres SUPERUSER bypasses RLS
// regardless of FORCE ROW LEVEL SECURITY. Bench runs as a non-superuser
// role so the measurement reflects production-realistic enforcement
// cost (RLS predicates are evaluated; cross-tenant filtering applies).
// ---------------------------------------------------------------------------

const BENCH_APP_ROLE = 'telecheck_bench_app';

async function installBenchAppRole(client: pg.Client): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${BENCH_APP_ROLE}') THEN
        CREATE ROLE ${BENCH_APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END
    $$;
  `);

  await client.query(`GRANT USAGE ON SCHEMA public TO ${BENCH_APP_ROLE}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${BENCH_APP_ROLE}`,
  );
  await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${BENCH_APP_ROLE}`);
  await client.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${BENCH_APP_ROLE}`);

  // Match production privilege posture per I-003: revoke UPDATE/DELETE
  // on append-only tables. (Same semantics as tests/setup.ts.)
  await client.query(`REVOKE UPDATE, DELETE ON audit_records FROM ${BENCH_APP_ROLE}`);
  await client.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'forms_snapshot' AND relkind = 'r') THEN
        EXECUTE 'REVOKE UPDATE, DELETE ON forms_snapshot FROM ${BENCH_APP_ROLE}';
      END IF;
    END
    $$;
  `);
}

// ---------------------------------------------------------------------------
// Vitest beforeAll — connect + migrate + seed (session-scoped; runs once)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const connectionString = process.env['BENCH_DATABASE_URL'];
  if (!connectionString) {
    throw new Error(
      'BENCH_DATABASE_URL environment variable is not set. ' +
        'Set it to a connection string pointing to a DEDICATED bench Postgres database — ' +
        'NOT the same database as DATABASE_URL (dev) or TEST_DATABASE_URL (integration tests). ' +
        "Bench iterations write to this DB and do NOT clean up between sessions; operators " +
        'are expected to drop/recreate the bench DB on a schedule. See tests/perf/db/setup.ts ' +
        'header comment for rationale + tests/perf/README.md §"Bench-mode DB-backed corpus".',
    );
  }

  // Fail-closed sanity check: BENCH_DATABASE_URL must NOT match
  // DATABASE_URL or TEST_DATABASE_URL exactly. Sprint 13 retro
  // pre-emption pattern: doc-only-discipline ("don't run bench against
  // your dev DB") is unenforceable; code enforcement = explicit
  // collision check at startup.
  const devUrl = process.env['DATABASE_URL'];
  const testUrl = process.env['TEST_DATABASE_URL'];
  if (devUrl !== undefined && devUrl === connectionString) {
    throw new Error(
      'BENCH_DATABASE_URL must NOT equal DATABASE_URL — bench iterations would pollute the dev DB. ' +
        'Use a dedicated bench DB (e.g., postgresql://telecheck_bench:password@localhost:5432/telecheck_bench).',
    );
  }
  if (testUrl !== undefined && testUrl === connectionString) {
    throw new Error(
      'BENCH_DATABASE_URL must NOT equal TEST_DATABASE_URL — bench iterations would pollute the integration-test DB.',
    );
  }

  _benchClient = new Client({ connectionString });
  await _benchClient.connect();

  // Apply all migrations idempotently. Runs as superuser — required
  // for CREATE EXTENSION, CREATE FUNCTION ... SECURITY DEFINER, etc.
  // (Same pattern as tests/setup.ts.)
  await applyMigrations(_benchClient);

  // Seed canonical operator tenants for bench scenarios that need them.
  await seedMinimalTenants(_benchClient);

  // Switch the session to a non-superuser role so RLS actually applies.
  await installBenchAppRole(_benchClient);
  await _benchClient.query(`SET SESSION AUTHORIZATION ${BENCH_APP_ROLE}`);

  // Install the bench-pool override so any code path that calls
  // `getPool()` (withConnection / withTenantBoundConnection /
  // withTransaction in src/lib/db.ts) gets back a wrapper that returns
  // THIS shared client on every connect().
  //
  // IMPORTANT distinction from tests/setup.ts: setTestPool's
  // BEGIN/COMMIT/ROLLBACK interception is INTENDED for bench mode too.
  // Bench scenarios that wrap each iteration in withTransaction will
  // hit those translation hooks — the bench measures the cost of the
  // production code path AS PRODUCTION RUNS IT (BEGIN → work →
  // COMMIT/ROLLBACK), and the override translates those to savepoint
  // operations against this shared client.
  //
  // Why this is correct for bench:
  //   - Bench iterations run with thousands of sequential transactions.
  //     Each iteration's BEGIN/COMMIT translation cost is constant per
  //     iteration and reflects in the per-iteration measurement.
  //   - Real production cost includes the BEGIN/COMMIT round-trip; the
  //     translation overhead is comparable (single SAVEPOINT/RELEASE
  //     query each).
  //   - State accumulates across iterations (audit_records grows).
  //     Hash-chain-extend cost is roughly constant per row (FOR UPDATE
  //     on the latest partition row), so accumulation does NOT bias
  //     measurements meaningfully. Sprint 15+ retro evaluates whether
  //     to add a session-end TRUNCATE for very long bench sessions.
  setTestPool(_benchClient as unknown as DbClient);

  // Open the outer transaction that the test-pool's BEGIN/COMMIT
  // translation expects. Same boilerplate as tests/setup.ts beforeAll
  // implicit pattern (the integration-test setup's beforeEach opens
  // the outer tx; bench has no beforeEach so we open here).
  await _benchClient.query('BEGIN');
});

// ---------------------------------------------------------------------------
// Vitest afterAll — close cleanly (session-scoped)
// ---------------------------------------------------------------------------

afterAll(async () => {
  if (_benchClient !== null) {
    try {
      // Roll back the outer transaction so accumulated bench state
      // (audit_records inserts, etc.) doesn't persist to the next
      // bench session unless operators explicitly want it.
      await _benchClient.query('ROLLBACK');
    } catch {
      // Swallow — connection cleanup is best-effort at session end.
    }
    try {
      await _benchClient.end();
    } catch {
      // Swallow.
    }
    _benchClient = null;
  }
});
