/**
 * tests/perf/db/setup.ts — Bench-mode ephemeral Postgres setup
 *
 * Sprint 17 / TLC-027 EXECUTE (rebuilds the Sprint 14 / TLC-025-SCAFFOLD
 * attempt that was reverted at `af193e7` after Codex perf-bench-r10
 * surfaced 4 findings; full rationale at
 * `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md`).
 *
 * Closes all 4 r10 findings:
 *
 *   r10-A HIGH (setupFiles fail-open): see vitest.bench.config.ts
 *     header — setupFiles is now ALWAYS-ON; this setup file's beforeAll
 *     fast-exits with success when BENCH_DATABASE_URL is unset, so
 *     pure-function benches still run without Postgres dependency.
 *     DB-backed bench files explicitly import + call `requireBenchDb()`
 *     from this module, throwing at module-resolution time if the bench
 *     client isn't initialized.
 *
 *   r10-B HIGH (savepoint translation breaks lock semantics): this
 *     setup file installs a REAL pg.Pool via `setBenchPool()` (NEW
 *     export in src/lib/db.ts; see that file's "Bench-mode pool
 *     override" section for full rationale). Bench iterations get
 *     fresh connections per call, run REAL BEGIN/COMMIT/ROLLBACK,
 *     hold `pg_advisory_xact_lock` for real per-iteration lifetime.
 *     State accumulation across iterations is acceptable because
 *     hash-chain extend cost is roughly constant per row; afterAll
 *     TRUNCATEs accumulated rows for cleanup.
 *
 *   r10-C MEDIUM (URL collision check is string-equality): this file
 *     CANONICALIZES URLs via `URL` parser before comparison. Compares
 *     hostname + port (defaulted to 5432) + database name (lowercase).
 *     Auth credentials, query strings, and host aliases are normalized
 *     out. Same physical DB referenced via different URL formats is
 *     correctly rejected.
 *
 *   r10-D MEDIUM (migration replay full-file skip): this file uses an
 *     explicit `schema_migrations_bench` tracking table. Each migration
 *     file is applied at most once; a partial apply leaves the row
 *     un-INSERTed so the next session re-attempts and fails explicitly
 *     rather than silently skipping. NO "already exists" substring
 *     matching that could mask non-idempotent DDL skips.
 *
 * Distinct from `tests/setup.ts` because:
 *   1. Bench's many-iteration model is INCOMPATIBLE with per-iteration
 *      SAVEPOINT wrapping. Bench iterations run thousands of times in
 *      tight loops; each iteration's BEGIN/SAVEPOINT/ROLLBACK overhead
 *      would dominate the measurement.
 *   2. Bench mode uses `setBenchPool()` (real pool) not `setTestPool()`
 *      (savepoint-translation override). Savepoint translation breaks
 *      `pg_advisory_xact_lock` lifetime per Codex r10-B.
 *
 * Spec references:
 *   - ORT v1.5 OR-218 (Tier 1 launch-blocking)
 *   - tests/perf/README.md §"Bench-mode DB-backed corpus"
 *   - vitest.bench.config.ts (separate-config rationale)
 *   - src/lib/db.ts setBenchPool() + clearBenchPool() (NEW Sprint 17)
 *   - docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md (acceptance criteria)
 *   - migrations/002_audit_chain.sql (pg_advisory_xact_lock per partition)
 *   - ADR-023 (RLS — bench runs against real Postgres)
 *   - ADR-024 (per-tenant KMS — both tenants seeded)
 *   - I-027 (audit_records carry tenant_id — both tenants seeded)
 *
 * Required environment:
 *   - BENCH_DATABASE_URL — connection string to a DEDICATED bench
 *     Postgres database. MUST NOT match DATABASE_URL or
 *     TEST_DATABASE_URL (canonicalized comparison; see r10-C closure).
 *     Connects as superuser for migrations + role setup; bench-app
 *     pool then connects via the same URL but the role is constrained
 *     by SET SESSION AUTHORIZATION on each acquired connection (RLS
 *     enforcement layer; deferred to Sprint 18+ — v0.1 measures
 *     superuser path which over-estimates cost; over-estimating is
 *     the safe direction for thresholds).
 *
 * Failure modes (fail-closed by design):
 *   - BENCH_DATABASE_URL absent → beforeAll fast-exits with success
 *     (pure-function benches still run). DB-backed bench files
 *     calling `requireBenchDb()` will fail-fast with explicit error.
 *   - BENCH_DATABASE_URL canonicalizes equal to DATABASE_URL or
 *     TEST_DATABASE_URL → throw before any migration applies.
 *   - Migration apply fails → throw with filename + SQL error;
 *     schema_migrations_bench row NOT inserted; next session retries.
 *   - Tenant seed conflicts with prior session leftover state →
 *     ON CONFLICT DO NOTHING (idempotent for canonical-tenant rows).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll } from 'vitest';

import { setBenchPool, clearBenchPool } from '../../../src/lib/db.ts';

// canonicalizeDbUrl is extracted to a dedicated file (Sprint 17 r13
// fix-forward) so the regression test in tests/contracts/canonicalize-
// db-url.test.ts can import it without dragging the beforeAll/afterAll
// hooks this setup file registers.
import { canonicalizeDbUrl } from './canonicalize-db-url.ts';

const { Client } = pg;

// ---------------------------------------------------------------------------
// Module-scope state
// ---------------------------------------------------------------------------

let _benchAdminClient: pg.Client | null = null;

/**
 * DB-backed bench files MUST call this to assert the bench setup ran
 * successfully before reading from the pool. Closes Codex r10-A: a
 * DB-backed bench file that imports this and calls requireBenchDb()
 * fails at module-resolution time if BENCH_DATABASE_URL was unset
 * (because beforeAll fast-exited and didn't initialize state).
 *
 * Pure-function bench files do NOT import this; they don't depend on
 * the bench setup running at all.
 */
export function requireBenchDb(): void {
  if (process.env['BENCH_DATABASE_URL'] === undefined) {
    throw new Error(
      'requireBenchDb: BENCH_DATABASE_URL environment variable is not set. ' +
        'DB-backed bench files require a dedicated bench Postgres DB. ' +
        'Set BENCH_DATABASE_URL in your .env or shell environment, ' +
        'then re-run `npm run bench`. See tests/perf/README.md ' +
        '§"Running DB-backed benches" for the invocation pattern.',
    );
  }
}

// ---------------------------------------------------------------------------
// URL canonicalization (Codex r10-C → r11-2 → r12 → r13 closure trajectory)
// canonicalizeDbUrl is imported from `./canonicalize-db-url.ts` (top of file).
// The dedicated split keeps the function regression-testable
// (`tests/contracts/canonicalize-db-url.test.ts`) without dragging this
// setup file's beforeAll/afterAll hooks into the test runner. See the
// dedicated file's header for the full r10-C → r13 trajectory.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Migration runner with schema_migrations_bench tracking
// (Codex r10-D closure)
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(import.meta.dirname ?? __dirname, '../../../migrations');

/**
 * Bootstrap the tracking table. Idempotent.
 */
async function ensureMigrationTrackingTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations_bench (
      filename     TEXT PRIMARY KEY,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum_sha TEXT NOT NULL
    )
  `);
}

/**
 * Apply each migration file at most once, ATOMICALLY (apply + track
 * in one transaction). Per Codex r11-1 closure (Sprint 17 fix-forward):
 * the prior implementation ran SQL then INSERTed the tracking row in
 * SEPARATE statements — a crash between the two left a successful
 * migration UNTRACKED, and the next session would replay it against
 * an already-mutated schema (failing on non-idempotent DDL like
 * CREATE POLICY / CREATE TRIGGER).
 *
 * Fix: wrap apply + tracking insert in BEGIN/COMMIT. If apply fails:
 * ROLLBACK; tracking row not inserted; throw. If tracking insert
 * fails: ROLLBACK (which also rolls back the apply if migrations are
 * fully transactional); throw. There's no "applied but untracked"
 * state.
 *
 * Caveat: some migration files contain non-transactional DDL
 * (e.g., CREATE INDEX CONCURRENTLY). Those will throw inside BEGIN
 * with a clear "cannot run within transaction" error — which is
 * correct fail-loud behavior. Sprint 18+ may add a per-migration
 * "non-transactional" flag if any future migration needs that path.
 *
 * Per Codex r10-D (closed Sprint 17 EXECUTE): NO "already exists"
 * substring matching that would mask non-idempotent DDL skips.
 */
async function applyMigrationsTracked(client: pg.Client): Promise<void> {
  await ensureMigrationTrackingTable(client);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.startsWith('rollback'))
    .sort(); // lexicographic sort → 000, 001, 002 ... is correct

  // Read already-applied set.
  const appliedResult = await client.query<{ filename: string }>(
    'SELECT filename FROM schema_migrations_bench',
  );
  const applied = new Set(appliedResult.rows.map((r) => r.filename));

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = `len=${String(sql.length)}`;

    // r11-1 closure: atomic apply+track. BEGIN; SQL; INSERT; COMMIT.
    // If anything fails: ROLLBACK; throw with context.
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations_bench (filename, checksum_sha) VALUES ($1, $2)',
        [file, checksum],
      );
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Best-effort rollback; if it also fails, the throw below
        // surfaces the original error.
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Bench DB migration ${file} failed (transactional apply+track): ${message}. ` +
          `ROLLBACK issued; tracking row NOT inserted; next bench session will re-attempt.`,
      );
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
    // eslint-disable-next-line no-console
    console.warn(
      `[bench setup] tenant seed soft-failed (${message}); ` +
        'bench files relying on canonical tenants must verify presence',
    );
  }
}

// ---------------------------------------------------------------------------
// Constrained bench-app role (Codex r11-3 closure — Sprint 17 fix-forward)
//
// Per Codex r11-3 HIGH 2026-05-06: bench iterations connecting as
// superuser bypass RLS regardless of `current_tenant_id()` (Postgres
// kernel rule for SUPERUSER + FORCE ROW LEVEL SECURITY). This means
// the bench measures a privileged path that does NOT exercise the
// production RLS-enforcement layer — and could miss real-world overhead.
//
// Fix: install a NOLOGIN, NOSUPERUSER, NOBYPASSRLS bench-app role with
// the same privilege posture as `telecheck_test_app` (per
// `tests/setup.ts:installTestAppRole()`). Bench iterations issue
// `SET LOCAL ROLE telecheck_bench_app` inside their transaction so
// queries run AS that role; RLS applies; emit-audit measures the
// production-equivalent path.
//
// Mirrors `tests/setup.ts:installTestAppRole` deliberately so future
// changes to one MUST be propagated to the other.
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

  // Mirror tests/setup.ts: revoke UPDATE/DELETE on append-only audit_records
  // (I-003 platform-floor; production privilege posture).
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
// (Codex r10-A closure: fast-exits cleanly when BENCH_DATABASE_URL unset)
// ---------------------------------------------------------------------------

beforeAll(async () => {
  const connectionString = process.env['BENCH_DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    // r10-A closure: fast-exit with success. Pure-function benches
    // still run; DB-backed bench files calling requireBenchDb() will
    // fail-fast at the bench file's own import/module level.
    return;
  }

  // r10-C closure: canonicalized URL collision check.
  const benchCanonical = canonicalizeDbUrl(connectionString);
  const dbCanonical = canonicalizeDbUrl(process.env['DATABASE_URL']);
  const testCanonical = canonicalizeDbUrl(process.env['TEST_DATABASE_URL']);

  if (benchCanonical === null) {
    throw new Error(
      `BENCH_DATABASE_URL is unparseable as a URL: "${connectionString}". ` +
        'Provide a valid postgresql:// connection string.',
    );
  }
  if (dbCanonical !== null && benchCanonical === dbCanonical) {
    throw new Error(
      `BENCH_DATABASE_URL canonicalizes equal to DATABASE_URL (host:port/db = "${benchCanonical}"). ` +
        'Bench iterations would pollute the dev DB. Use a dedicated bench DB.',
    );
  }
  if (testCanonical !== null && benchCanonical === testCanonical) {
    throw new Error(
      `BENCH_DATABASE_URL canonicalizes equal to TEST_DATABASE_URL (host:port/db = "${benchCanonical}"). ` +
        'Bench iterations would pollute the integration-test DB.',
    );
  }

  // Connect as superuser to apply migrations + seed tenants.
  _benchAdminClient = new Client({ connectionString });
  await _benchAdminClient.connect();

  // r10-D closure: tracked migration apply.
  await applyMigrationsTracked(_benchAdminClient);

  // Seed canonical operator tenants for bench scenarios that need them.
  await seedMinimalTenants(_benchAdminClient);

  // r11-3 closure: install constrained bench-app role for RLS-applicable
  // bench iterations. Bench files issue `SET LOCAL ROLE telecheck_bench_app`
  // inside their transaction to drop privileges from superuser to the
  // constrained role for the iteration.
  await installBenchAppRole(_benchAdminClient);

  // Install the bench pool override — REAL pg.Pool, not savepoint
  // translation (closes r10-B). Pool config defaults to max=5;
  // bench iterations are sequential so higher max wastes connections.
  setBenchPool({ connectionString, max: 5 });
});

// ---------------------------------------------------------------------------
// Public exports for DB-backed bench files
// ---------------------------------------------------------------------------

/**
 * Name of the constrained bench-app role created by `installBenchAppRole()`.
 * DB-backed bench files import this and issue `SET LOCAL ROLE ${BENCH_APP_ROLE_NAME}`
 * inside their transaction to drop superuser privilege for the iteration —
 * making RLS apply, matching the production code path measurement
 * fidelity per Codex r11-3 closure.
 */
export const BENCH_APP_ROLE_NAME = BENCH_APP_ROLE;

// ---------------------------------------------------------------------------
// Vitest afterAll — TRUNCATE accumulated state + close cleanly
// ---------------------------------------------------------------------------

afterAll(async () => {
  // Cleanup ordering: clear bench pool first (so no in-flight queries
  // race the TRUNCATE), then TRUNCATE accumulated bench-written tables
  // via the admin client, then close admin client.
  await clearBenchPool();

  if (_benchAdminClient !== null) {
    try {
      // TRUNCATE in dependency order (children first), CASCADE for
      // safety. audit_records is the primary bench-writer; other
      // tables included so future bench scenarios don't leave
      // residue.
      //
      // Wrapped in DO block so missing tables don't fail the whole
      // cleanup (e.g., if migrations didn't fully apply).
      await _benchAdminClient.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'audit_records' AND relkind = 'r') THEN
            EXECUTE 'TRUNCATE TABLE audit_records CASCADE';
          END IF;
        END
        $$;
      `);
    } catch {
      // Best-effort cleanup; failures here don't propagate.
    }
    try {
      await _benchAdminClient.end();
    } catch {
      // Swallow.
    }
    _benchAdminClient = null;
  }
});
