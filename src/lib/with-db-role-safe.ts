/**
 * with-db-role-safe.ts — `withDbRole` + canonical PostgreSQL 42501
 *                        (`insufficient_privilege`) → tenant-blind 403
 *                        envelope mapping, extracted into a single shared
 *                        helper so every handler that calls a SECDEF
 *                        wrapper under `withDbRole` enforces I-025 the
 *                        same way.
 *
 * **Why this helper exists (cross-slice refactor 2026-05-23):**
 *   The Med-Interaction PR 7.1 hotfix + the Crisis Sprint 2 PR 1 R2 MED-1
 *   closure + the Admin Sprint 2 PR 1 R1 HIGH-1 closure each independently
 *   added the SAME try/catch-around-`withDbRole` pattern to map SQLSTATE
 *   42501 to `req.server.httpErrors.forbidden('Insufficient scope for this
 *   request.')`. With three handlers in main + more on the way, Codex
 *   correctly flagged that the inline duplication was a footgun for future
 *   handlers (one forgotten catch = one I-025 leak). Extracting the
 *   pattern into a single helper makes it impossible to forget — the
 *   call site shrinks to a single function call, and the canonical
 *   42501 mapping lives in exactly one place.
 *
 * **What 42501 means in this codebase:**
 *   PostgreSQL raises SQLSTATE 42501 (`insufficient_privilege`) in two
 *   places along the SECDEF-wrapper call path, both of which this helper
 *   covers because the try/catch wraps the ENTIRE `withDbRole` call:
 *
 *   (1) Inside `withDbRole`'s `SET LOCAL ROLE <slice_role>` pre-callback
 *       step — if the slice-role membership grant in
 *       `migrations/051_app_role_acquisition_foundation.sql` is missing
 *       or skewed (a foundation-051 drift state). Raised BEFORE the
 *       callback runs, so a catch placed INSIDE the callback would miss
 *       this path.
 *
 *   (2) Inside the SECDEF wrapper's body — when LAYER C tenant-scope
 *       guard rejects (e.g., `current_actor_account_tenant_id() <>
 *       p_tenant_id`) or when RLS evaluation on the underlying tables
 *       denies the read.
 *
 * **Why mapping to a tenant-blind 403 is the canonical choice:**
 *   Without this mapping, an uncaught 42501 would reach the global error
 *   envelope (`src/lib/error-envelope.ts`) as a 500 because pg errors do
 *   not carry `statusCode`. The envelope's `buildErrorEnvelope` derives
 *   statusCode from `error.statusCode ?? 500`; in non-prod the raw PG
 *   message (which may include tenant_id, role names, schema hints) would
 *   then be exposed to the client. That is an I-025 violation
 *   ("error responses do not leak cross-tenant existence").
 *
 *   Mapping to `req.server.httpErrors.forbidden('Insufficient scope for
 *   this request.')` produces the canonical ERROR_MODEL v5.1 403 envelope
 *   formatted by the global error-envelope plugin — generic message, no
 *   tenant identifiers, no SQLSTATE, no schema details. The body is
 *   identical regardless of WHICH layer raised the 42501 (Option B
 *   role acquisition vs LAYER C tenant guard vs RLS), preserving I-025.
 *
 * **Why this composes ON TOP of `withDbRole` rather than replacing it:**
 *   `withDbRole` is platform-floor infrastructure (Option B mechanism per
 *   ERR App-Role-Acquisition-SECDEF-Slice-Wrappers 2026-05-23, ratified
 *   at `79ad0ca`). Its sole job is correctly elevating to a slice role
 *   for the duration of a callback inside an open transaction. Mapping
 *   pg errors to HTTP envelopes is an HTTP-handler concern. Keeping the
 *   two helpers separate lets non-HTTP callers (background jobs, queue
 *   workers, integration test harnesses) keep using bare `withDbRole`
 *   without dragging in Fastify dependencies; HTTP handlers use
 *   `withDbRoleSafe` to get the canonical I-025 envelope for free.
 *
 * **Other pg errors:** propagate unchanged — the global envelope formats
 * them per their existing `statusCode` (if any) or as a 500 with a
 * default message in production. Adding more `code === '...'` branches
 * here is intentional case-by-case work — do NOT broaden this helper to
 * blindly swallow all pg errors.
 *
 * Spec references:
 *   - I-025 (tenant-blind error envelopes)
 *   - ERROR_MODEL v5.1 §"Tenant-isolation error behavior" + §HTTP status
 *     mapping table
 *   - src/lib/with-db-role.ts (the underlying SET LOCAL ROLE helper this
 *     wrapper composes on)
 *   - src/lib/error-envelope.ts §insufficientTenantScopeError (the
 *     canonical 403 envelope shape; this helper goes through
 *     `req.server.httpErrors.forbidden` which the global error handler
 *     formats into the same shape)
 *   - migrations/051_app_role_acquisition_foundation.sql (the source-of-
 *     truth for which slice-role memberships `withDbRole` can elevate to;
 *     drift here is one of the two paths that raises 42501)
 *   - Cockpit Addendum 83 (parallel-agent close-out establishing the
 *     cross-slice 42501 → 403 pattern across 3 handlers)
 */

import type { FastifyRequest } from 'fastify';

import type { DbClient } from './db.js';
import { withDbRole, type SliceRole } from './with-db-role.js';

/**
 * Run `fn` under the elevated `role` via `withDbRole`, mapping any
 * PostgreSQL SQLSTATE 42501 (`insufficient_privilege`) raise to a
 * tenant-blind 403 via `req.server.httpErrors.forbidden(...)`. Other
 * errors propagate unchanged.
 *
 * **Caller responsibilities** (unchanged from `withDbRole`):
 *   - `tx` is an open transaction (from a surrounding `withTransaction`).
 *   - Fastify LAYER B authorization has already verified the request's
 *     actor is entitled to act in `role`.
 *   - `withTenantContext` + `withActorContext` have already bound the
 *     tenant + actor-nonce GUCs on `tx`.
 *
 * **What this helper adds on top of `withDbRole`:**
 *   - A single try/catch around the ENTIRE `withDbRole(tx, role, fn)`
 *     call so 42501 raised at either (1) the `SET LOCAL ROLE` pre-
 *     callback step or (2) inside the SECDEF wrapper body is caught.
 *   - Maps 42501 to `req.server.httpErrors.forbidden('Insufficient scope
 *     for this request.')`. The global error-envelope plugin formats
 *     this into the canonical ERROR_MODEL v5.1 403 envelope with no
 *     tenant identifiers in the response body (I-025).
 *
 * **What this helper does NOT change vs `withDbRole`:**
 *   - Role elevation semantics (capture `current_user`, SET LOCAL ROLE,
 *     restore in `finally`) — unchanged; delegated to `withDbRole`.
 *   - Allowlist enforcement — unchanged; delegated to `withDbRole`
 *     (`assertSliceRole`).
 *   - Non-42501 error propagation — unchanged; non-42501 errors
 *     re-throw exactly as the underlying call produced them.
 *
 * @param tx    Open transaction client from `withTransaction`.
 * @param role  Slice role to elevate to (must be in `SLICE_ROLES`).
 * @param req   Fastify request — used for `req.server.httpErrors.forbidden`.
 * @param fn    Callback to run under the elevated role.
 * @returns     Whatever `fn` returns.
 */
export async function withDbRoleSafe<T>(
  tx: DbClient,
  role: SliceRole,
  req: FastifyRequest,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withDbRole(tx, role, fn);
  } catch (err) {
    if (isInsufficientPrivilegeError(err)) {
      // The global error-envelope plugin formats Fastify's forbidden()
      // into the canonical ERROR_MODEL v5.1 envelope:
      //   { error: { code: 'internal.auth.insufficient_scope',
      //              message: 'Insufficient scope for this request.',
      //              trace_id, timestamp } }
      // No tenant_id, no SQLSTATE, no role name, no PG body in the
      // response — that is the I-025 contract this mapping enforces.
      throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
    }
    throw err;
  }
}

/**
 * Type guard for PostgreSQL SQLSTATE 42501 (`insufficient_privilege`).
 *
 * The `pg` driver attaches `code` (a string SQLSTATE) to error objects
 * raised from the database. We narrow to `unknown` because `withDbRole`
 * may also raise plain `Error` instances (e.g., the allowlist guard or
 * the prior-role-restoration failure path), neither of which carries
 * `code` — those propagate unchanged.
 *
 * Exported so handler tests + integration tests can assert against the
 * same predicate this helper uses internally; do NOT use it in handler
 * code (handlers should reach for `withDbRoleSafe` instead).
 */
export function isInsufficientPrivilegeError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '42501'
  );
}
