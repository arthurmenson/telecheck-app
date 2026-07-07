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
  // SAVE the current binding (if any) so nested calls restore correctly on
  // exit. Without this save/restore step, an inner withTenantContext exit
  // would unconditionally clear the outer binding — leaving any subsequent
  // queries in the outer scope running with NO RLS context. That is a
  // direct I-023 floor violation: an outer-scope SELECT after an inner
  // operation would either fail closed (if RLS denies tenant_id NULL) or
  // worse, run unfiltered if the test/dev RLS posture differs from prod.
  //
  // Closed 2026-05-03 per Codex rls-r1 HIGH (verify-r2). Prior implementation
  // unconditionally cleared on exit; the new save/restore preserves outer-
  // scope RLS context across nested withTenantContext calls on the same
  // client.
  const previous = await readCurrentTenantId(client);

  // Establish the tenant context binding via migration 003's
  // set_tenant_context() SECURITY DEFINER function. The binding is keyed
  // on pg_backend_pid() and stored in the private _session_tenant_context
  // table — NOT a settable GUC — so it cannot be spoofed by a session
  // doing `SET app.current_tenant_id`.
  // (v0.2 patch 2026-05-02 per Codex foundation-verify-r3 CRITICAL.)
  await client.query('SELECT set_tenant_context($1)', [tenantId]);

  let result: T;
  let cbError: unknown;
  try {
    result = await fn(client);
  } catch (err) {
    cbError = err;
    // we'll re-throw after the restore phase
    result = undefined as unknown as T;
  }

  // RESTORE phase. Both branches are fail-closed (Codex rls-r3 HIGH closure):
  //
  //   previous !== null (nested call):
  //     Restore failure is FATAL. Outer-scope code is about to continue
  //     executing queries on this connection; if the binding is stuck on
  //     the inner tenant, those queries silently run under the wrong
  //     tenant — a cross-tenant context mismatch that's WORSE than
  //     fail-closed because the caller doesn't know it happened.
  //
  //   previous === null (outermost call):
  //     Clear failure is ALSO FATAL. The connection is about to return
  //     to the pool. If the inner tenant binding is still active, the
  //     next caller's withTenantContext will (a) read the stale tenant
  //     as `previous`, (b) install its own tenant for its callback,
  //     (c) on exit "restore" the stale tenant — perpetuating the leak
  //     forever. Worse: any code path that touches the connection without
  //     first calling withTenantContext runs under the stale binding.
  //     Fail closed: throw so the pool/caller can discard the connection.
  //     The migration-003 5-minute TTL is a safety net only against
  //     crashes, not against silent cleanup failures.
  //
  // Closed 2026-05-03 per Codex rls-r2 HIGH (verify-r3) + rls-r3 HIGH
  // (verify-r4) which extended the fix to the outermost-clear branch.
  let cleanupError: unknown;
  if (previous !== null) {
    try {
      await client.query('SELECT set_tenant_context($1)', [previous]);
    } catch (err) {
      cleanupError = err;
    }
  } else {
    try {
      await client.query('SELECT clear_tenant_context()', []);
    } catch (err) {
      cleanupError = err;
    }
  }

  if (cleanupError !== undefined) {
    // Aborted-transaction carve-out (staging E2E closure 2026-07-07): when
    // the callback error aborted the surrounding transaction, EVERY
    // subsequent statement — including our restore/clear — fails with
    // SQLSTATE 25P02 until ROLLBACK. That restore failure is expected and
    // harmless: set_tenant_context writes are transactional, so the
    // caller's ROLLBACK (withTransaction always rolls back on throw)
    // undoes the inner binding along with everything else — no stale
    // binding can survive. Wrapping the typed callback error in an
    // AggregateError here masked handler 4xx envelopes into 500s.
    // Re-throw the ORIGINAL error instead. (Outside a transaction, 25P02
    // cannot occur, so the fail-closed discard path below is untouched.)
    const isAbortedTx =
      typeof cleanupError === 'object' &&
      cleanupError !== null &&
      (cleanupError as { code?: string }).code === '25P02';
    if (isAbortedTx && cbError !== undefined) {
      throw cbError;
    }

    // I-023 safety: queries cannot be allowed to run under a stale
    // tenant binding on this connection. Fail closed. If the callback
    // ALSO errored, wrap both errors via AggregateError so the original
    // failure isn't masked. The thrown error signals to the caller
    // (and to db.ts withTenantBoundConnection) that this connection's
    // tenant-context state is unsafe and the connection should be
    // discarded from the pool, not returned to it.
    const cleanupMsg = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    const cleanupKind = previous !== null ? 'restore' : 'clear';
    if (cbError !== undefined) {
      throw new AggregateError(
        [cbError, cleanupError],
        `I-023 violation: tenant-context ${cleanupKind} failed (${cleanupMsg}); ` +
          `connection has a stale tenant binding and must be discarded from the pool. ` +
          `Original callback error preserved at AggregateError.errors[0].`,
      );
    }
    throw new Error(
      `I-023 violation: tenant-context ${cleanupKind} failed (${cleanupMsg}). ` +
        `Connection has a stale tenant binding and must be discarded from the pool.`,
    );
  }

  if (cbError !== undefined) {
    throw cbError;
  }
  return result;
}

/**
 * Read the current tenant binding (if any) for save/restore in withTenantContext.
 * Returns null if no binding is set OR if the SELECT fails (treats failure as
 * "no prior binding to restore" — the subsequent set will install our binding
 * either way; the only loss is outer-scope nested context, which is acceptable
 * compared to the alternative of failing the whole `withTenantContext` call).
 */
async function readCurrentTenantId(client: DbClient): Promise<string | null> {
  // current_tenant_id() RAISES EXCEPTION `tenant_context_not_set` (migration
  // 003) when no binding exists for this backend. Inside an outer transaction
  // (the test harness wraps every test in a SAVEPOINT, and the production
  // code path also runs inside withTransaction), that exception aborts the
  // current savepoint/subtransaction — every subsequent statement fails with
  // `current transaction is aborted` until a ROLLBACK fires. The legacy
  // `try { SELECT } catch { return null }` swallowed the JS error but did
  // NOT recover the savepoint state, so the very next query (e.g.,
  // `set_tenant_context($1)` on rls.ts:109) cascaded into the aborted-tx
  // failure mode that surfaced as the rls.test.ts §6 5-test cascade in CI.
  //
  // Fix (Codex rls-readcurrent-r0 closure 2026-05-04): wrap the probe in a
  // sub-savepoint so the EXCEPTION aborts only the sub-savepoint, and
  // ROLLBACK TO that sub-savepoint to recover the outer state. The
  // sub-savepoint name uses a high-entropy suffix to avoid collisions
  // with the harness's per-test `sp_N` names.
  const probeSavepoint = `rls_probe_${Math.random().toString(36).slice(2, 10)}`;
  await client.query(`SAVEPOINT ${probeSavepoint}`);
  try {
    const result = (await client.query('SELECT current_tenant_id() AS tid', [])) as {
      rows: Array<{ tid: string | null }>;
    };
    await client.query(`RELEASE SAVEPOINT ${probeSavepoint}`);
    return result.rows[0]?.tid ?? null;
  } catch {
    // tenant_context_not_set (or any other exception). Roll back the
    // sub-savepoint to recover outer-savepoint state, then signal "no
    // current binding" via null.
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${probeSavepoint}`);
      await client.query(`RELEASE SAVEPOINT ${probeSavepoint}`);
    } catch {
      // The recovery itself failed (extremely unlikely — ROLLBACK TO
      // SAVEPOINT works in aborted txns). Caller's set_tenant_context
      // call will surface a clearer error if so.
    }
    return null;
  }
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
  const result = (await client.query('SELECT current_tenant_id() AS tid')) as {
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
