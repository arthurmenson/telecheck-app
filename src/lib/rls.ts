/**
 * rls.ts — PostgreSQL Row-Level Security session-variable setter.
 *
 * Purpose:
 *   Defense-in-depth database-layer tenant enforcement per I-023.
 *   Wraps query callbacks in a `set_tenant_context($1)` SQL call so the
 *   DB session variable `current_tenant_id()` is always populated before
 *   any RLS-gated query executes.
 *
 *   Even though the application layer filters by tenant_id in every query,
 *   the DB layer independently enforces isolation via RLS. A bug that skips
 *   the app-layer filter is caught at the DB layer.
 *
 * Spec references:
 *   - I-023: three independent enforcement layers (DB RLS, app-layer filtering,
 *     per-tenant KMS). This module implements the DB layer shim.
 *   - I-028: single DB, single schema; tenant isolation is logical — RLS is
 *     the DB-layer mechanism.
 *   - ADR-023 (multi-tenancy Model A): `tenant_id` on every PHI record;
 *     RLS policies on every PHI-touching table.
 *   - Migration 003: creates the private `_session_tenant_context` table,
 *     `set_tenant_context(text)`, `clear_tenant_context()`, and
 *     `current_tenant_id()` SECURITY DEFINER functions used here.
 *
 * Design decisions:
 *   - `withTenantContext` takes a generic query callback `fn` rather than
 *     constructing queries directly, so it composes with any DB client
 *     (pg, Prisma raw, etc.).
 *   - The callback receives the same `client` passed in — no new connection
 *     is opened. The session variable is set on that client's connection.
 *   - Reset: after `fn` completes (success or error), the session variable
 *     is cleared to prevent inadvertent cross-request leakage if a pooled
 *     connection is reused.
 *
 * Open questions for Engineering Lead:
 *   - Connection pool behavior: with PgBouncer in transaction mode, the
 *     same PG backend serves many app sessions. The migration-003 binding
 *     is keyed on pg_backend_pid() with a 5-minute TTL and is upserted on
 *     every set_tenant_context() call, so the most recent caller's tenant
 *     is always reflected. Confirm pooler mode with DevOps before
 *     production deployment; consider RESET ALL between requests.
 *
 * Resolved (Codex foundation-verify-r3 patch v0.2 — 2026-05-02):
 *   - Migration 003 is now authored. The SQL call below targets the
 *     hardened table-backed binding mechanism (not the prior settable
 *     GUC, which was bypassable via direct `SET app.current_tenant_id`).
 */

// ---------------------------------------------------------------------------
// DB client interface
//
// This module is DB-client-agnostic. The `DbClient` interface abstracts the
// raw `query(sql, params)` contract. Both `pg.PoolClient` and Prisma's
// `$queryRawUnsafe` satisfy this interface after a thin adapter.
// ---------------------------------------------------------------------------

export interface DbClient {
  /**
   * Execute a SQL query with positional parameters.
   * Returns a promise resolving to query results (shape not prescribed here).
   */
  query(sql: string, params?: readonly unknown[]): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// withTenantContext
// ---------------------------------------------------------------------------

/**
 * withTenantContext — sets the RLS session variable for `tenantId`, runs `fn`,
 * then clears the session variable on exit (success or failure).
 *
 * This is the mandatory wrapper for all DB access that touches PHI tables.
 * Bypassing this wrapper is a code-review-blocking violation per I-023.
 *
 * @param client  A DB client for the current connection/transaction.
 * @param tenantId  The operating-tenant identifier (must be `Telecheck-{country}` format).
 * @param fn  Callback receiving the same `client`; performs actual queries.
 * @returns  The result of `fn`.
 *
 * @throws  If `set_tenant_context` fails (indicates migration 003 not applied).
 * @throws  Any error thrown by `fn` is re-thrown after clearing the session variable.
 */
export async function withTenantContext<T>(
  client: DbClient,
  tenantId: string,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  // Establish the tenant context binding via migration 003's
  // set_tenant_context() SECURITY DEFINER function. The binding is keyed
  // on pg_backend_pid() and stored in the private _session_tenant_context
  // table — NOT a settable GUC — so it cannot be spoofed by a session
  // doing `SET app.current_tenant_id`.
  // (v0.2 patch 2026-05-02 per Codex foundation-verify-r3 CRITICAL.)
  await client.query('SELECT set_tenant_context($1)', [tenantId]);

  let result: T;
  try {
    result = await fn(client);
  } finally {
    // Always clear the binding after the callback, even on error. Prevents
    // cross-request tenant leakage on pooled connections. Belt-and-suspenders:
    // the binding has a 5-minute TTL on the DB side, but explicit cleanup
    // shortens the leak window for crashes.
    // Fire-and-forget — if cleanup fails, log and continue (the original
    // error from `fn` is more important to surface).
    await client
      .query('SELECT clear_tenant_context()', [])
      .catch(() => {
        // Intentional: swallow clear-error to avoid masking the original error.
        // Monitoring should alert on repeated clear failures as a pool-leak signal.
      });
  }

  return result;
}

/**
 * assertRlsActive — verifies that the current DB session has a tenant context set.
 * Used in tests and critical-path assertions to confirm `withTenantContext` was called.
 *
 * STUB: requires migration 003's `current_tenant_id()` function.
 *
 * @throws If `current_tenant_id()` returns null (no context set).
 */
export async function assertRlsActive(client: DbClient): Promise<void> {
  // STUB: migration 003 required.
  const result = await client.query('SELECT current_tenant_id() AS tid') as {
    rows: Array<{ tid: string | null }>;
  };
  const rows = result as unknown as { rows: Array<{ tid: string | null }> };
  const tid = rows.rows[0]?.tid ?? null;
  if (tid === null) {
    throw new Error(
      'assertRlsActive: current_tenant_id() is null — withTenantContext was not called. ' +
        'This is an I-023 enforcement violation.',
    );
  }
}
