/**
 * actor-context-binding.ts — SI-010 server-derived actor identity wiring.
 *
 * Module helpers that bridge the SI-010 DB infrastructure (migration 031:
 * `bind_actor_context_role`, `_session_actor_context` table,
 * `bind_actor_context(...)` SECURITY DEFINER function, `current_actor_*()`
 * helpers) to the Fastify request lifecycle.
 *
 * Phase A scope (Master Completion Plan v1.0):
 *   This PR lands the helper functions + type augmentation. The
 *   authContextPlugin onRequest-hook wiring + the dedicated bind-pool
 *   configuration land in successor PRs in the same Phase A track.
 *
 * Design (per docs/SI-010-Session-Actor-Context-DB-Binding.md):
 *   1. Per request, generate a UUIDv4 nonce. Nonce is the trust anchor
 *      (122 bits of entropy, treated as request-bound shared secret,
 *      never logged).
 *   2. Call `bind_actor_context(...)` on a DEDICATED bind pool whose
 *      session_user is `bind_actor_context_role` (NOT the main app role).
 *      The migration's session_user gate rejects calls from
 *      `telecheck_app_role`.
 *   3. The request's transactional work runs on the main app pool. At
 *      tx-start, the request executes `SET LOCAL app.request_nonce =
 *      '<uuid>'` so DB-side helpers (`current_actor_account_id()` etc.)
 *      can find the trusted row keyed by nonce.
 *
 * Spec references:
 *   - docs/SI-010-Session-Actor-Context-DB-Binding.md
 *   - migrations/031_session_actor_context.sql
 *   - Identity & Authentication Spec v1.0 §3 (session lifecycle)
 *   - INVARIANTS v5.2 I-023 / I-024 / I-027
 *   - Master Completion Plan v1.0 Phase A item 1
 */

import { randomUUID } from 'node:crypto';

import type { DbClient } from './db.js';

/**
 * The set of canonical actor roles SI-010 binds. Mirrors the migration's
 * CHECK constraint on `_session_actor_context.actor_role`.
 */
export type BindActorRole =
  | 'patient'
  | 'delegate'
  | 'clinician'
  | 'tenant_admin'
  | 'platform_admin';

/**
 * Inputs to `bindActorContextForRequest`. All values are derived from
 * the verified JWT claims + the resolved tenant context.
 */
export interface BindActorContextInputs {
  actorAccountId: string;
  actorAccountTenantId: string;
  actorRole: BindActorRole;
  /**
   * Non-null only for `platform_admin`. Mirrors the migration's
   * iff-platform_admin CHECK constraint. Other roles MUST pass null.
   */
  actorAdminHomeTenantId: string | null;
  sessionId: string;
  /** Optional TTL override (seconds). Default 300. */
  ttlSeconds?: number;
}

/**
 * Result of binding the actor context for a request. The nonce is the
 * trust anchor — the caller stores it on `request.actorNonce` and the
 * tx wrapper later does `SET LOCAL app.request_nonce = <nonce>` so
 * DB-side procedures can read the bound identity row.
 */
export interface BoundActorContext {
  /** UUIDv4 generated for this request; the trust anchor. */
  nonce: string;
  /** Seconds the bind is valid (also reflected in the DB row's expires_at). */
  ttlSeconds: number;
}

/**
 * Default TTL — matches the migration's DEFAULT 300 in bind_actor_context().
 * Centralized here so authContextPlugin doesn't drift from the DB default.
 */
export const DEFAULT_BIND_TTL_SECONDS = 300;

/**
 * Bind a per-request actor identity row in `_session_actor_context`.
 *
 * MUST be called on a connection whose session_user is
 * `bind_actor_context_role` (NOT `telecheck_app_role`). The migration's
 * SECURITY DEFINER function rejects calls from the application primary
 * role with `bind_actor_context: forbidden session_user <role>`. The
 * caller provides the bind-pool client via the `bindClient` parameter;
 * pool wiring lives in `db.ts getBindActorContextPool()` (added in the
 * successor PR).
 *
 * Returns the generated nonce + the TTL applied. The caller stores the
 * nonce on `request.actorNonce`; the request's transactional code
 * later does `SET LOCAL app.request_nonce = <nonce>` so the SI-010
 * helpers (`current_actor_account_id()` etc.) can find this row.
 *
 * @throws if the bind connection's session_user is not authorized
 *         (migration session_user gate), if any input is malformed
 *         (migration parameter checks), or if the DB is unreachable.
 *         Callers in authContextPlugin should treat any throw as a
 *         hard fail-closed and leave `actorContext` + `actorNonce`
 *         undefined so the request flows to handlers without a bound
 *         identity (and SECURITY DEFINER procedures correctly raise
 *         `actor_context_unbound` if invoked).
 */
export async function bindActorContextForRequest(
  bindClient: DbClient,
  inputs: BindActorContextInputs,
): Promise<BoundActorContext> {
  // Defensive symmetry with the migration's iff-platform_admin CHECK —
  // catch malformed inputs at the TS boundary before the DB raises.
  if (inputs.actorRole === 'platform_admin' && inputs.actorAdminHomeTenantId === null) {
    throw new Error('bindActorContextForRequest: platform_admin requires actorAdminHomeTenantId');
  }
  if (inputs.actorRole !== 'platform_admin' && inputs.actorAdminHomeTenantId !== null) {
    throw new Error(
      `bindActorContextForRequest: actorAdminHomeTenantId must be null for role ${inputs.actorRole}`,
    );
  }

  const nonce = randomUUID();
  const ttl = inputs.ttlSeconds ?? DEFAULT_BIND_TTL_SECONDS;

  await bindClient.query('SELECT bind_actor_context($1, $2, $3, $4, $5, $6, $7)', [
    inputs.actorAccountId,
    inputs.actorAccountTenantId,
    inputs.actorRole,
    inputs.actorAdminHomeTenantId, // null is a valid value here; pg driver maps to NULL
    inputs.sessionId,
    nonce,
    ttl,
  ]);

  return { nonce, ttlSeconds: ttl };
}

/**
 * Wrap a callback in `SET LOCAL app.request_nonce = <nonce>` for the
 * duration of the callback, so DB-side `current_actor_*()` helpers
 * invoked from inside the callback can resolve the trusted identity row.
 *
 * Lifecycle parity with `withTenantContext`: `SET LOCAL` is scoped to
 * the surrounding transaction; the nonce is automatically cleared at
 * tx commit/rollback. The caller MUST be inside an open transaction
 * before invoking this helper (statement-level set_config would
 * persist beyond the request and leak across connections in a pool).
 *
 * Same-tx re-entry is safe: the inner call overwrites the GUC for its
 * scope and the outer scope's value is NOT automatically restored
 * (Postgres SET LOCAL semantics). Callers that nest `withActorContext`
 * over different nonces should not — there is exactly one actor per
 * request. Defensive: a future iteration may save/restore the prior
 * value if a use case emerges, but at v1.0 there's none.
 *
 * Pass `tx` from the surrounding `withTransaction` wrapper. Do NOT
 * call this with a fresh pool connection — it would set the GUC
 * outside any active transaction and the value would persist beyond
 * the connection's lifecycle in production pools.
 */
export async function withActorContext<T>(
  tx: DbClient,
  nonce: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Use set_config(setting, value, is_local=true) instead of a raw
  // SET LOCAL statement so we can safely parameterize. Raw SET LOCAL
  // doesn't accept $1 placeholders.
  await tx.query("SELECT set_config('app.request_nonce', $1, true)", [nonce]);
  return fn();
}
