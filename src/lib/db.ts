/**
 * db.ts — PostgreSQL connection pool + transaction helpers.
 *
 * Purpose:
 *   Singleton Postgres pool driving all DB-backed foundation modules
 *   (audit, idempotency, domain-events, tenant-context, rls). Centralizes
 *   connection lifecycle so each module doesn't open its own pool.
 *
 * Spec references:
 *   - ADR-023 (multi-tenancy Model A — single PG cluster, single schema,
 *     RLS for isolation): one pool serves all tenants; per-request tenant
 *     context is set on the acquired connection via rls.ts before queries
 *     run.
 *   - I-023 (three-layer tenant isolation): the pool itself is layer 1
 *     (network); RLS is layer 2 (set per-connection via withTenantContext);
 *     application-layer filtering is layer 3 (in module repositories).
 *   - I-028 (single physical region): one pool, no failover routing here.
 *
 * Design decisions:
 *   - Lazy pool creation (`getPool()` constructs on first call) so test
 *     code paths that never touch the DB don't pay the connection cost.
 *   - `withTransaction` runs the callback inside a transaction with
 *     BEGIN/COMMIT/ROLLBACK. Caller doesn't have to remember to clean up.
 *   - Module-local DbClient + DbTransaction interfaces mirror the
 *     structural types used by audit.ts / domain-events.ts / rls.ts so
 *     no module imports `pg` types directly.
 *
 * Open questions for Engineering Lead:
 *   - Pool sizing: defaults to `max=10, idleTimeoutMillis=30000`. Tune per
 *     deployment; expose via env if needed.
 *   - Statement timeout: not set here; per-query timeouts are the safer
 *     pattern via `query` options. Engineering Lead should decide whether
 *     a coarse pool-wide timeout is also wanted.
 *   - SSL: production deployments MUST enable SSL. The pool config below
 *     reads from `DATABASE_SSL_MODE` env (default `disable` for local dev,
 *     `require` for production); deployment must override.
 */

import pg from 'pg';

import { config } from './config.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Structural types (decoupled from `pg` so other modules don't import it)
// ---------------------------------------------------------------------------

/** Minimal client interface — matches pg.PoolClient and pg.Client. */
export interface DbClient {
  query<R = unknown>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * Transaction client — same shape as DbClient but the type carries a
 * "you're inside a transaction" semantic guarantee that callers should
 * preserve.
 */
export type DbTransaction = DbClient;

// ---------------------------------------------------------------------------
// Pool singleton
// ---------------------------------------------------------------------------

let _pool: pg.Pool | null = null;

/**
 * Test-mode pool override. When set (via `setTestPool()` from tests/setup.ts),
 * `getPool()` returns this wrapper instead of constructing a real pg.Pool.
 *
 * Why: integration tests share a SINGLE pg.Client across all queries (so per-
 * test SAVEPOINT rollback isolates state). When the app instead uses a real
 * pg.Pool, every `pool.connect()` returns a DIFFERENT physical connection that
 * cannot see the test client's open-transaction writes. The test seeds
 * a row inside the savepoint, the HTTP request opens a fresh pool connection
 * to query it, and the row is invisible — the request 404s / 500s and
 * upstream tests fail with `expected 201 to be 400`-shaped mismatches.
 *
 * The fix is to make the app's pool a thin wrapper that returns the same
 * test client on every `connect()` call, with `release()` and `release(true)`
 * as no-ops (the test harness owns the client lifecycle). This is gated to
 * test mode only — production keeps the real pg.Pool.
 *
 * (Closed 2026-05-04 per CI 25325596109 forensic — the diagnostic
 * console.log in commit 37db5b3 surfaced `forms.deployment.template_not_found`
 * on a freshly-seeded template, isolating the failure mode to test-client
 * vs pool-client transaction-visibility split.)
 */
let _testPoolOverride: pg.Pool | null = null;

/**
 * Test-only: install a wrapper pool that returns the supplied client on
 * every `connect()` and treats `release` as a no-op. Called by
 * tests/setup.ts beforeAll once the shared test client is connected.
 *
 * Production code MUST NOT call this — there is no mode where a real
 * deployment wants pool.connect() to return a single fixed connection.
 */
export function setTestPool(client: DbClient): void {
  // r11-4 closure (Sprint 17 fix-forward 2026-05-06): mutual-exclusion
  // assertion. A test process operates as EITHER integration mode
  // (savepoint translation) OR bench mode (real pool); never both.
  // Calling setTestPool while a bench pool is already installed would
  // create silent ambiguity — the prior getPool() priority order
  // returned testPool first, so a bench harness would silently fall
  // back to savepoint translation, breaking the lock-semantics
  // guarantee TLC-027 was authored to preserve.
  if (_benchPoolOverride !== null) {
    throw new Error(
      'setTestPool: bench-mode pool is already installed. ' +
        'Test mode and bench mode are mutually exclusive. Call clearBenchPool() first.',
    );
  }
  // Build a structural-typed pool wrapper. We cast to pg.Pool because the
  // app code paths only call `connect()` and the connection's `query` /
  // `release`. Anything else (idleTimeout, on('error'), end()) is noop'd
  // here — the harness owns the real client.
  //
  // CRITICAL — transaction-command translation:
  //
  //   The app's `withTransaction` runs literal `BEGIN` / `COMMIT` / `ROLLBACK`
  //   on the connection it gets from `pool.connect()`. If those statements
  //   ran on the shared test client unmodified, the app would commit/rollback
  //   the OUTER test transaction managed by tests/setup.ts (the one that
  //   wraps every test in a SAVEPOINT). After that COMMIT, subsequent
  //   `SAVEPOINT sp_N` calls fail with "SAVEPOINT can only be used in
  //   transaction blocks" — which is exactly the cascade that surfaced on
  //   CI run 25325909032 (commit 1ea8965): 75 × SAVEPOINT + 82 × ROLLBACK
  //   TO SAVEPOINT errors when the test-pool override was naive.
  //
  //   Fix: intercept the three transaction commands per-connection and
  //   translate them to nested-savepoint operations against a connection-
  //   local savepoint name. The app sees normal transaction semantics
  //   (begin → work → commit, rollback discards mid-flight work) while the
  //   shared test client's outer-transaction state is preserved for the
  //   harness's per-test SAVEPOINT/ROLLBACK TO SAVEPOINT cycle.
  //
  //     app `BEGIN`     → SAVEPOINT app_tx_N
  //     app `COMMIT`    → RELEASE SAVEPOINT app_tx_N
  //     app `ROLLBACK`  → ROLLBACK TO SAVEPOINT app_tx_N + RELEASE
  //
  //   The savepoint counter is module-scope so re-entrant withTransaction
  //   calls (rare but possible) get distinct names.
  let _appTxCounter = 0;
  const connect = async () => {
    let activeAppTxSavepoint: string | null = null;

    const interceptedQuery = async (text: string, values?: ReadonlyArray<unknown>) => {
      // Only the leading keyword matters — strip surrounding whitespace and
      // check the first token, case-insensitive. We don't need to match
      // exact `BEGIN ISOLATION LEVEL ...` variants (the app doesn't use
      // them) but we lowercase to be robust against future stylistic drift.
      const trimmed = text.trim().toUpperCase();
      if (trimmed === 'BEGIN' || trimmed.startsWith('BEGIN ')) {
        if (activeAppTxSavepoint !== null) {
          // Re-entrant BEGIN on the same fake connection — preserve the
          // first one's name; nested transactions on the same connection
          // are not supported by withTransaction's contract anyway.
          return { rows: [], rowCount: null };
        }
        _appTxCounter += 1;
        activeAppTxSavepoint = `app_tx_${_appTxCounter}`;
        return client.query(`SAVEPOINT ${activeAppTxSavepoint}`);
      }
      if (trimmed === 'COMMIT' || trimmed.startsWith('COMMIT ')) {
        if (activeAppTxSavepoint !== null) {
          const sp = activeAppTxSavepoint;
          activeAppTxSavepoint = null;
          return client.query(`RELEASE SAVEPOINT ${sp}`);
        }
        // No active app savepoint — silently no-op so app code that does
        // a defensive COMMIT outside withTransaction doesn't error.
        return { rows: [], rowCount: null };
      }
      if (trimmed === 'ROLLBACK' || trimmed.startsWith('ROLLBACK ')) {
        if (activeAppTxSavepoint !== null) {
          const sp = activeAppTxSavepoint;
          activeAppTxSavepoint = null;
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          return client.query(`RELEASE SAVEPOINT ${sp}`);
        }
        return { rows: [], rowCount: null };
      }
      // Pass through every other query unchanged.
      return values === undefined ? client.query(text) : client.query(text, values);
    };

    const decorated = {
      query: interceptedQuery,
      release: (_err?: boolean | Error) => {
        // No-op: the harness owns the client lifecycle. If there's an
        // active app-level savepoint that was never committed/rolled back
        // (e.g., the app threw between BEGIN and COMMIT and never reached
        // either ROLLBACK or finally), we leave the savepoint dangling —
        // the harness's per-test ROLLBACK TO SAVEPOINT discards it
        // along with everything else.
      },
    };
    return decorated;
  };

  const wrapper = {
    connect,
    end: async () => {
      // No-op: the harness owns the client lifecycle.
    },
    on: () => {
      // No-op: error handling is on the real client in the harness.
    },
  } as unknown as pg.Pool;
  _testPoolOverride = wrapper;
  // Reset _pool so getPool() picks up the override on next call.
  _pool = null;
}

/**
 * Test-only: clear the test-pool override. Called by tests/setup.ts in
 * afterAll for cleanliness, though typically not strictly needed because
 * each test fork has its own module-scope state.
 */
export function clearTestPool(): void {
  _testPoolOverride = null;
  _pool = null;
}

// ---------------------------------------------------------------------------
// Bench-mode pool override (Sprint 17 / TLC-027 closure of Codex r10-B)
// ---------------------------------------------------------------------------

/**
 * Bench-mode pool override. When set (via `setBenchPool()` from
 * tests/perf/db/setup.ts), `getPool()` returns this REAL pg.Pool instead
 * of constructing the production pool from `config.databaseUrl`.
 *
 * Distinct from `setTestPool()` because:
 *
 *   - `setTestPool()` translates BEGIN/COMMIT/ROLLBACK to nested savepoints
 *     against ONE shared client — correct for integration-test SAVEPOINT
 *     isolation, WRONG for bench mode because:
 *
 *       a) `pg_advisory_xact_lock` (used by audit_records hash-chain
 *          trigger; see migration 002) is RELEASED at outer-transaction
 *          end. With savepoint-translation, all bench iterations share
 *          the outer transaction → advisory lock held for whole bench
 *          session → measurement does NOT reflect production per-request
 *          lock lifetime.
 *
 *       b) Bench iterations don't have real commit durability; they roll
 *          back at session end. Cross-connection visibility patterns
 *          (e.g., a different connection observing a committed audit
 *          row) are not exercised.
 *
 *       c) Production contention/failure behavior (concurrent INSERTs on
 *          the same partition deadlocking on the advisory lock) is
 *          unmeasurable.
 *
 *   - `setBenchPool()` returns a REAL pg.Pool. Bench iterations get
 *     fresh connections per call, run real BEGIN/COMMIT/ROLLBACK, hold
 *     advisory locks for real per-iteration lifetime. Measurements
 *     reflect the production code path AS PRODUCTION RUNS IT.
 *
 *   - State accumulation across iterations is acceptable because the
 *     hash-chain-extend cost is roughly constant per row (FOR UPDATE
 *     on the latest partition row). After the bench session, the bench
 *     setup file's afterAll TRUNCATEs accumulated rows.
 *
 * Closes Codex perf-bench-r10-B MEDIUM 2026-05-05 (which flagged that
 * Sprint 14 TLC-025-SCAFFOLD's setTestPool-based design would have
 * measured the wrong thing for emit-audit hash-chain bench).
 *
 * Mutually exclusive with `setTestPool()`. A test process operates as
 * EITHER integration mode OR bench mode, never both. Calling both is
 * a configuration error; the bench override wins (last-set-wins; see
 * `getPool()` priority order).
 */
let _benchPoolOverride: pg.Pool | null = null;

export interface BenchPoolConfig {
  /** Connection string for the bench app role (NOT superuser). */
  connectionString: string;
  /**
   * Max pool size. Defaults to 5 — bounded because bench iterations are
   * sequential, not concurrent. Higher values waste connection slots.
   */
  max?: number;
}

/**
 * Bench-only: install a real pg.Pool against `BENCH_DATABASE_URL`. Called
 * by tests/perf/db/setup.ts beforeAll once migrations + role setup
 * complete.
 *
 * Production code MUST NOT call this — there is no mode where a real
 * deployment overrides the production pool with a different DB.
 *
 * Returns the pool reference so the caller can call `pool.end()` in
 * afterAll for cleanup.
 */
export function setBenchPool(cfg: BenchPoolConfig): pg.Pool {
  // r11-4 closure (Sprint 17 fix-forward 2026-05-06): mutual-exclusion
  // assertion against test-mode pool override. See setTestPool() for
  // rationale.
  if (_testPoolOverride !== null) {
    throw new Error(
      'setBenchPool: integration-test pool is already installed. ' +
        'Test mode and bench mode are mutually exclusive. Call clearTestPool() first.',
    );
  }
  if (_benchPoolOverride !== null) {
    return _benchPoolOverride;
  }
  const pool = new Pool({
    connectionString: cfg.connectionString,
    max: cfg.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // Bench mode is local-only by design (BENCH_DATABASE_URL must NOT
    // match production DATABASE_URL; enforced by tests/perf/db/setup.ts
    // collision check). No SSL.
    ssl: false,
  });

  pool.on('error', (err) => {
    // Same posture as production pool: surface but do not exit.
    // eslint-disable-next-line no-console
    console.error('[db.bench] unexpected pool error:', err);
  });

  _benchPoolOverride = pool;
  // Reset _pool so getPool() picks up the override on next call.
  _pool = null;
  return pool;
}

/**
 * Bench-only: clear + close the bench pool. Called by
 * tests/perf/db/setup.ts in afterAll for cleanliness.
 */
export async function clearBenchPool(): Promise<void> {
  if (_benchPoolOverride !== null) {
    const pool = _benchPoolOverride;
    _benchPoolOverride = null;
    _pool = null;
    await pool.end();
  }
}

export function getPool(): pg.Pool {
  // r11-4 closure (Sprint 17 fix-forward 2026-05-06): bench pool wins
  // priority over test pool. Defense-in-depth alongside the mutual-
  // exclusion check at setter time. If both somehow get installed
  // (e.g., a future composition error), the bench-mode lock-semantics
  // guarantee is preserved rather than silently bypassed via savepoint
  // translation.
  if (_benchPoolOverride !== null) {
    return _benchPoolOverride;
  }
  if (_testPoolOverride !== null) {
    return _testPoolOverride;
  }
  if (_pool === null) {
    _pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // Production deployments MUST set DATABASE_SSL_MODE=require; local dev
      // (Postgres in Docker / native) typically uses disable.
      ssl: config.dbSslMode === 'require' ? { rejectUnauthorized: false } : false,
    });

    // Crash-loud on pool errors rather than silently dropping. The audit
    // chain depends on us NEVER swallowing DB failures (I-003).
    _pool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[db] unexpected pool error:', err);
      // Do not exit — the pool can recover; just surface loudly.
    });
  }
  return _pool;
}

/**
 * Close the pool (test cleanup / graceful shutdown). After this is called,
 * the next `getPool()` will create a new pool.
 */
export async function closePool(): Promise<void> {
  if (_pool !== null) {
    await _pool.end();
    _pool = null;
  }
}

// ---------------------------------------------------------------------------
// SI-010 dedicated bind pool
// ---------------------------------------------------------------------------
//
// SI-010 requires `bind_actor_context()` to be invoked from a connection
// whose session_user is `bind_actor_context_role` (NOT `telecheck_app_role`)
// per migration 031's session_user gate. This pool is the dedicated path —
// constructed from `config.bindActorContextDatabaseUrl` so operators wire
// it to a connection string authenticating as the bind role directly
// (NOT via SET ROLE from the main app role, which would defeat the
// caller-isolation guarantee).
//
// When `config.bindActorContextDatabaseUrl` is undefined (dev/test where
// SI-010 wiring is opt-in), `getBindActorContextPool()` returns null. The
// authContextPlugin's onRequest hook treats null as "skip bind"; requests
// proceed without an actorNonce and DB-side `current_actor_*()` helpers
// correctly raise `actor_context_unbound` if invoked.
//
// In integration tests, `setTestPool()` also installs an override here so
// the bind path can run against the shared test client (which holds
// elevated DDL/DML privileges in the test schema). Production fail-closed
// posture is preserved by the migration's session_user gate.
// ---------------------------------------------------------------------------

let _bindActorContextPool: pg.Pool | null = null;

/**
 * Test-mode override for the bind pool. Mirrors `_testPoolOverride` for
 * the main pool; installed by `setTestPool()` so tests can exercise
 * `bind_actor_context()` against the shared savepoint-wrapped client.
 */
let _bindActorContextPoolTestOverride: pg.Pool | null = null;

/**
 * Test-only: install a wrapper pool for SI-010 bind invocations. Called
 * by tests/setup.ts in the same beforeAll that installs the main test
 * pool, so the bind helper and the main DB share the same shared
 * client + savepoint isolation.
 *
 * Production code MUST NOT call this. The bind pool is constructed
 * lazily from `config.bindActorContextDatabaseUrl` when first requested.
 */
export function setBindActorContextTestPool(client: DbClient): void {
  const connect = async (): Promise<unknown> => ({
    query: client.query.bind(client),
    release: () => {
      /* no-op; harness owns lifecycle */
    },
  });
  const wrapper = {
    connect,
    end: async () => {
      /* no-op */
    },
    on: () => {
      /* no-op */
    },
  } as unknown as pg.Pool;
  _bindActorContextPoolTestOverride = wrapper;
  _bindActorContextPool = null;
}

/**
 * Test-only: clear the bind-pool test override.
 */
export function clearBindActorContextTestPool(): void {
  _bindActorContextPoolTestOverride = null;
  _bindActorContextPool = null;
}

/**
 * Returns the SI-010 bind pool, or null when bind-pool wiring is not
 * configured (dev/test where the env var is absent). authContextPlugin
 * treats null as "skip bind"; requests proceed without an actorNonce.
 *
 * The returned pool authenticates as `bind_actor_context_role` per the
 * env-var contract. The migration's session_user gate (inside
 * `bind_actor_context()`) refuses calls whose session_user is
 * `telecheck_app_role`, providing defense-in-depth against an operator
 * pointing this var at the main app credentials.
 */
export function getBindActorContextPool(): pg.Pool | null {
  if (_bindActorContextPoolTestOverride !== null) {
    return _bindActorContextPoolTestOverride;
  }
  if (config.bindActorContextDatabaseUrl === undefined) {
    return null;
  }
  if (_bindActorContextPool === null) {
    _bindActorContextPool = new Pool({
      connectionString: config.bindActorContextDatabaseUrl,
      max: config.bindActorContextPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: config.dbSslMode === 'require' ? { rejectUnauthorized: false } : false,
    });
    _bindActorContextPool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[db] unexpected bind-pool error:', err);
      // Don't exit — the pool can recover; surface loudly. authContextPlugin
      // will treat individual bind failures as fail-closed (leave
      // actorNonce undefined) so a transient pool error doesn't elevate
      // requests beyond their authenticated identity.
    });
  }
  return _bindActorContextPool;
}

/**
 * Close the bind pool. Test cleanup + graceful shutdown.
 */
export async function closeBindActorContextPool(): Promise<void> {
  if (_bindActorContextPool !== null) {
    await _bindActorContextPool.end();
    _bindActorContextPool = null;
  }
}

/**
 * SI-010 production boot probe (Codex R2 closure 2026-05-15).
 *
 * Acquires a connection from the bind pool and verifies the deployment
 * is correctly wired BEFORE Fastify accepts traffic. Catches the
 * misconfiguration classes that `loadConfig()`'s missing-env check
 * cannot catch:
 *   - Wrong password / unreachable host (connect throws)
 *   - Connection authenticating as the wrong role (session_user check)
 *   - Migration 031 not applied / bind_actor_context() missing
 *     (has_function_privilege returns null)
 *   - Connection role lacks EXECUTE on bind_actor_context()
 *     (has_function_privilege returns false)
 *
 * Called from `buildApp()` once per process boot when
 * `config.bindActorContextDatabaseUrl !== undefined`. Throws on any
 * failure — the process exits non-zero and the listener never binds.
 *
 * Skipped automatically when the bind pool is unconfigured (dev/test
 * opt-in path; bind-pool null = SI-010 wiring opt-out).
 *
 * @throws if probe fails — propagated up so buildApp() aborts.
 */
export async function verifyBindActorContextPoolOrThrow(): Promise<void> {
  const pool = getBindActorContextPool();
  if (pool === null) {
    // Unconfigured. Production fail-fast is enforced at config-loader
    // boundary (BIND_ACTOR_CONTEXT_DATABASE_URL required in production);
    // here we only short-circuit when the pool is genuinely null.
    return;
  }

  const client = await pool.connect();
  try {
    // 1) R3 HIGH closure (Codex 2026-05-15): session_user MUST be
    //    EXACTLY `bind_actor_context_role`. A non-app-role-but-still-
    //    over-privileged login (superuser, migration owner,
    //    accidentally-granted ops role) would otherwise satisfy the
    //    EXECUTE check and pass this probe — defeating the trust
    //    boundary the bind-pool model is designed to enforce. The
    //    probe is the latest-still-safe checkpoint to catch URL
    //    miswiring at an over-privileged role.
    //
    //    Defense-in-depth: even with role-name match, refuse if the
    //    role is unexpectedly elevated (operator may have ALTERed
    //    the role's attributes post-migration). bind_actor_context_role
    //    is narrowly scoped: NOT superuser, NOT bypassrls.
    const sessionResult = await client.query<{
      session_user: string;
      is_superuser: boolean;
      is_bypassrls: boolean;
    }>(
      'SELECT session_user, rolsuper AS is_superuser, rolbypassrls AS is_bypassrls FROM pg_roles WHERE rolname = session_user',
    );
    const row = sessionResult.rows[0];
    if (row === undefined) {
      throw new Error(
        'SI-010 bind-pool probe: SELECT session_user returned no rows. ' +
          'Verify BIND_ACTOR_CONTEXT_DATABASE_URL credentials are valid.',
      );
    }
    if (row.session_user !== 'bind_actor_context_role') {
      throw new Error(
        `SI-010 bind-pool probe: session_user is "${row.session_user}" — ` +
          'BIND_ACTOR_CONTEXT_DATABASE_URL MUST authenticate as the dedicated ' +
          'bind_actor_context_role created by migration 031. Any other role ' +
          '(telecheck_app_role, superuser, migration owner, accidentally-granted ' +
          'operational role) is rejected at this probe even if it can EXECUTE ' +
          'bind_actor_context — the trust boundary is the EXACT role identity, ' +
          'not just the absence of the app role.',
      );
    }
    if (row.is_superuser) {
      throw new Error(
        'SI-010 bind-pool probe: bind_actor_context_role unexpectedly has SUPERUSER. ' +
          'Operator: ALTER ROLE bind_actor_context_role NOSUPERUSER. The trust ' +
          'boundary requires this role to be narrowly scoped (EXECUTE on the ' +
          'binder only; no broader DB privileges).',
      );
    }
    if (row.is_bypassrls) {
      throw new Error(
        'SI-010 bind-pool probe: bind_actor_context_role unexpectedly has BYPASSRLS. ' +
          'Operator: ALTER ROLE bind_actor_context_role NOBYPASSRLS. The trust ' +
          'boundary requires this role to be subject to RLS like every other ' +
          'application role.',
      );
    }

    // 2) bind_actor_context() must exist + bind_actor_context_role
    //    must have EXECUTE. has_function_privilege returns NULL when
    //    the function does not exist, FALSE when it exists but no
    //    EXECUTE, TRUE when callable.
    const privResult = await client.query<{ has_privilege: boolean | null }>(
      "SELECT has_function_privilege('bind_actor_context_role', 'bind_actor_context(text, text, text, text, text, uuid, integer)', 'EXECUTE') AS has_privilege",
    );
    const hasPrivilege = privResult.rows[0]?.has_privilege ?? null;
    if (hasPrivilege === null) {
      throw new Error(
        'SI-010 bind-pool probe: bind_actor_context() function not found. ' +
          'Migration 031_session_actor_context.sql is not applied.',
      );
    }
    if (hasPrivilege === false) {
      throw new Error(
        'SI-010 bind-pool probe: bind_actor_context_role lacks EXECUTE on ' +
          'bind_actor_context(). Migration 031 GRANTs it; verify the migration ' +
          'applied cleanly and no subsequent migration revoked the GRANT.',
      );
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Connection + transaction helpers
// ---------------------------------------------------------------------------

/**
 * Acquire a connection from the pool, run `fn(client)`, and release the
 * connection afterwards (success or error). Use this when your callback
 * needs query-level operations but no transaction.
 *
 * For tenant-scoped queries, prefer `rls.ts withTenantContext()` which
 * also sets the RLS session binding before running `fn`.
 */
export async function withConnection<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Acquire a connection from the pool, set the tenant context binding via
 * `set_tenant_context($1)` (migration 003 SECURITY DEFINER function), run
 * `fn(client)`, then clear the binding and release the connection. Use
 * this for queries against tenant-scoped tables (under RLS) that aren't
 * inside a larger transaction.
 *
 * Per I-023, fresh pool connections have NO tenant context binding —
 * queries against RLS-enabled tables would otherwise fail closed with
 * `tenant_context_not_set`. This helper closes that gap for the
 * "single tenant-scoped read or write outside a business transaction"
 * code paths.
 *
 * For business actions that touch multiple tables, use `withTransaction`
 * + a tenant-context call as the first statement instead — the
 * transaction lifetime keeps the binding active for the whole atomic
 * operation.
 *
 * (Added v0.2 patch 2026-05-02 per Codex foundation-wiring HIGH finding:
 *  the prior `withConnection` usage in idempotency.ts bypassed RLS
 *  binding and would have failed closed against migration 005's
 *  `tenant_isolation` policy.)
 */
export async function withTenantBoundConnection<T>(
  tenantId: string,
  fn: (client: DbClient) => Promise<T>,
  /**
   * Test-only opt-in: when supplied, `fn` runs against the caller's
   * connection/transaction handle instead of acquiring a fresh pool
   * connection. The caller owns the tenant-context binding lifecycle —
   * a typical test driver wraps the call in `withTenantContext(tenant,
   * () => helperFn(..., getTestClient()))` so the binding is set before
   * the helper runs.
   *
   * Mirror of the `withTransaction(fn, externalTx?)` pattern from
   * publishVersion-r1 MEDIUM closure 2026-05-03. Production callers
   * MUST NOT supply this — RLS binding cleanup happens in the pool
   * branch's `finally`, but the externalTx branch deliberately doesn't
   * touch the binding (caller's responsibility).
   */
  externalTx?: DbClient,
): Promise<T> {
  if (externalTx !== undefined) {
    // Caller owns binding + connection lifecycle. We just run `fn`.
    return fn(externalTx);
  }
  // Manage the pool client lifecycle here (rather than via withConnection)
  // so we can call `client.release(error)` to DISCARD the connection from
  // the pool on cleanup failure. This is the I-023 floor enforcement at
  // the pool layer: a clear failure means the binding is still active on
  // this backend; returning that connection to the pool would let the
  // next caller inherit the stale binding.
  // (Closed 2026-05-03 per Codex rls-r4 HIGH (verify-r5) — companion to
  //  the rls.ts fix; both layers must fail closed for the I-023 floor to
  //  hold across pool checkouts.)
  const pool = getPool();
  const client = await pool.connect();

  // Everything from this point onward MUST be in a controlled lifecycle
  // that releases the client on every exit. A failure between pool.connect()
  // and the cleanup phase (e.g., set_tenant_context throws because
  // migration 003 isn't applied, or the connection drops mid-query) would
  // otherwise leak the client back to the JS heap without ever returning
  // it to the pool — repeated failures exhaust the pool and turn an
  // auth/RLS setup failure into a broader availability incident.
  // (Closed 2026-05-03 per Codex db-r5 HIGH (verify-r6).)
  // Helper: discard the client from the pool. ALWAYS marks releaseHandled
  // and ALWAYS swallows release errors — the caller's primary error
  // (set/clear/callback failure) is what should surface, not a synchronous
  // throw from pg's release path. Idempotent if called twice.
  // Closure over `releaseHandled`; declared before use.
  let releaseHandled = false;
  function discardClient(): void {
    if (releaseHandled) return;
    releaseHandled = true;
    try {
      client.release(true);
    } catch {
      // Swallow — release errors during fault paths must not mask the
      // primary diagnostic. The connection is in an unknown state but
      // the JS-side reference is now decoupled from the pool.
    }
  }
  function returnClient(): void {
    if (releaseHandled) return;
    releaseHandled = true;
    try {
      client.release();
    } catch {
      // Same swallow rationale as discardClient — happy-path release
      // errors are extraordinarily rare and the callback already
      // succeeded.
    }
  }

  try {
    // Phase A: install tenant binding. If this fails, the connection
    // state is uncertain — discard rather than risk reusing a half-bound
    // backend.
    try {
      await client.query('SELECT set_tenant_context($1)', [tenantId]);
    } catch (setErr) {
      discardClient();
      const setMsg = setErr instanceof Error ? setErr.message : String(setErr);
      throw new Error(
        `withTenantBoundConnection: set_tenant_context failed (${setMsg}). ` +
          `Connection discarded from the pool. ` +
          `Common causes: migration 003 not applied; connection dropped mid-query; ` +
          `unknown tenantId.`,
      );
    }

    // Phase B: callback + cleanup, with the asymmetric I-023 fail-closed
    // contract for cleanup failures.
    let result: T;
    let cbError: unknown;
    try {
      result = await fn(client);
    } catch (err) {
      cbError = err;
      result = undefined as unknown as T;
    }

    let cleanupError: unknown;
    try {
      await client.query('SELECT clear_tenant_context()');
    } catch (err) {
      cleanupError = err;
    }

    if (cleanupError !== undefined) {
      // Discard the connection. discardClient() marks releaseHandled and
      // swallows any release-side throw so the AggregateError contract
      // below remains the authoritative diagnostic.
      discardClient();
      const cleanupMsg =
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      if (cbError !== undefined) {
        throw new AggregateError(
          [cbError, cleanupError],
          `I-023 violation: tenant-context clear failed in withTenantBoundConnection (${cleanupMsg}); ` +
            `connection has been discarded from the pool. ` +
            `Original callback error preserved at AggregateError.errors[0].`,
        );
      }
      throw new Error(
        `I-023 violation: tenant-context clear failed in withTenantBoundConnection (${cleanupMsg}). ` +
          `Connection has been discarded from the pool.`,
      );
    }

    // Healthy cleanup; return the connection to the pool normally.
    returnClient();

    if (cbError !== undefined) {
      throw cbError;
    }
    return result;
  } catch (err) {
    // Catch-all leak guard. Every controlled exit above already called
    // discardClient() or returnClient(). If we got here without
    // releaseHandled set, an unexpected error escaped before any
    // release/discard ran (e.g., a JS-level error in the test path).
    // Discard now to prevent pool exhaustion. discardClient() is a no-op
    // when already handled, so calling it unconditionally here is safe.
    discardClient();
    throw err;
  }
}

/**
 * Run `fn(tx)` inside a transaction. BEGIN/COMMIT on success;
 * BEGIN/ROLLBACK on any thrown error. The error is re-thrown after
 * rollback so callers see it.
 *
 * Use this for any business action that:
 *   - Modifies more than one row across more than one table, OR
 *   - Emits a domain event (DOMAIN_EVENTS v5.2 same-tx outbox pattern), OR
 *   - Emits an audit record (AUDIT_EVENTS v5.2 + I-003 durability).
 *
 * Per I-003, audit emission failures inside `fn` MUST cause the transaction
 * to roll back so the upstream business action is reverted — this helper
 * is the mechanism.
 *
 * **`externalTx` opt-in (Codex publishVersion-r1 MEDIUM closure 2026-05-03):**
 * When provided, `fn` runs against the supplied DbTransaction directly
 * without acquiring a fresh pool connection or issuing BEGIN/COMMIT —
 * the caller owns the transaction lifecycle. This is what unblocks
 * integration tests that need a service-level call to share state with
 * a savepoint-isolated test client.
 *
 * Mirror of the `lib/audit.ts emitAudit(input, tx?)` pattern. Production
 * code must NOT pass externalTx — the durability discipline depends on
 * the BEGIN/COMMIT happening here. Tests pass `getTestClient()` so the
 * service's transactional work shares the test outer transaction and
 * gets rolled back at savepoint end with everything else.
 *
 * (Why not gate on NODE_ENV: gating is harder to grep for than the
 * presence of an explicit parameter at call sites. Reviews of `git grep
 * 'withTransaction(.*,.*,'` are sufficient to catch any production
 * code that passes externalTx.)
 */
export async function withTransaction<T>(
  fn: (tx: DbTransaction) => Promise<T>,
  externalTx?: DbTransaction,
): Promise<T> {
  if (externalTx !== undefined) {
    // Caller owns BEGIN/COMMIT + connection lifecycle. We just run `fn`.
    return fn(externalTx);
  }
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        // ROLLBACK can fail if the connection died; the underlying error is
        // more important to surface, so swallow this one.
      });
      throw err;
    }
  } finally {
    client.release();
  }
}
