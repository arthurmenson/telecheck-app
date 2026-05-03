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

export function getPool(): pg.Pool {
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
export async function withConnection<T>(
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
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
): Promise<T> {
  return withConnection(async (client) => {
    await client.query('SELECT set_tenant_context($1)', [tenantId]);
    try {
      return await fn(client);
    } finally {
      // Clear the binding before the connection returns to the pool so the
      // next caller doesn't inherit it. The TTL on the binding (5 min per
      // migration 003) is the primary safeguard, but explicit cleanup
      // shortens the leak window.
      await client.query('SELECT clear_tenant_context()').catch(() => {
        // Swallow cleanup error — the original `fn` result is more important
        // to surface; if the connection itself died, the pool will discard it.
      });
    }
  });
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
 */
export async function withTransaction<T>(
  fn: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
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
