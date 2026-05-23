/**
 * with-db-role.ts — Per-transaction SET LOCAL ROLE helper for the
 *                   Option B app-role acquisition mechanism ratified
 *                   2026-05-23 (Engineering Review Request —
 *                   App-Role-Acquisition-SECDEF-Slice-Wrappers).
 *
 * **Mechanism (Option B per ERR §5):**
 *   1. `telecheck_app_role` is `NOINHERIT` + granted membership in 13
 *      slice application/reader roles per migration 051.
 *   2. With `NOINHERIT`, those memberships do NOT bestow passive
 *      privileges — the slice role's EXECUTE/SELECT grants only apply
 *      within an explicit `SET LOCAL ROLE <slice_role>` block.
 *   3. This helper performs that elevation safely inside an open
 *      transaction, AFTER Fastify Layer B authorization has validated
 *      that the request's actor is entitled to the slice role.
 *
 * **Composability with the existing context helpers (Pass-2 mandate):**
 *   Required nesting order — `withTransaction` outermost; `withDbRole`
 *   innermost just before the SECDEF wrapper call:
 *
 *     await withTransaction(async (tx) => {
 *       await withTenantContext(tx, tenantId, async () => {
 *         await withActorContext(tx, actorNonce, async () => {
 *           await withDbRole(tx, 'crisis_initiator', async () => {
 *             await tx.query('SELECT record_crisis_initiation(...)', ...);
 *             // audit emission within the same tx
 *           });
 *         });
 *       });
 *     });
 *
 *   GUC composability: `SET LOCAL ROLE` does NOT create a new GUC scope;
 *   `app.tenant_id` (from `withTenantContext`) and `app.request_nonce`
 *   (from `withActorContext`) remain bound across the role elevation.
 *   The SECDEF wrapper's body — running AS the wrapper-owner under
 *   SECURITY DEFINER semantics — sees the same session GUCs because GUCs
 *   are transaction-scoped, not role-scoped. (Codex Pass-2 verified +
 *   approved 2026-05-23.)
 *
 * **Allowlist enforcement (defense-in-depth):**
 *   `SET LOCAL ROLE` accepts a PostgreSQL identifier (not a parameter),
 *   so we cannot use `$1` placeholders to safely interpolate the role
 *   name. To prevent SQL-injection via a tampered role string, this
 *   helper accepts ONLY a `SliceRole` (a string-literal union narrowed
 *   from the const `SLICE_ROLES` tuple). TypeScript enforces this at
 *   compile time; the runtime `assertSliceRole` check is a defense-in-
 *   depth backstop for code paths that pass dynamic values (e.g.,
 *   selecting the role from request data via a switch + mapper).
 *
 * **Failure discipline (Codex Pass-2 mandate + R1 HIGH-1 closure):**
 *   - If `SET LOCAL ROLE` succeeds and the callback raises, the surrounding
 *     transaction MUST be rolled back (default `withTransaction`
 *     behavior). Do NOT swallow the exception inside the callback.
 *   - If Layer B authorization (in the Fastify handler, BEFORE entering
 *     this helper) fails, the handler MUST return early WITHOUT calling
 *     this helper. Elevating into a slice role for a request whose actor
 *     is not entitled to it would defeat the LAYER B trust boundary.
 *   - **Scoped elevation (R1 HIGH-1 closure 2026-05-23):** the helper
 *     captures `current_user` BEFORE issuing `SET LOCAL ROLE`, then in a
 *     `finally` block restores to that previous role via
 *     `SET LOCAL ROLE <prev_role>`. This guarantees that any code running
 *     in the same transaction AFTER the callback returns does NOT
 *     continue to hold the elevated slice role's privileges — only the
 *     wrapper call inside `fn` runs at the elevated identity. Nesting
 *     `withDbRole` (e.g., A → B inner → restore-to-A → outer continues)
 *     composes correctly because each invocation captures its own
 *     prior role, not the outermost session_user.
 *
 * **Why this lives in src/lib (not in a slice module):**
 *   This helper is platform-floor infrastructure consumed by every slice
 *   whose handlers call SECDEF wrappers (Crisis Response, Admin Backend,
 *   Med-Interaction, and all future SECDEF-using slices). The allowlist
 *   is the union of all slice application/reader roles. New SECDEF slices
 *   add to the `SLICE_ROLES` tuple here AND grant membership in their new
 *   roles to `telecheck_app_role` via a follow-up foundation migration
 *   (analogous to 051 §2).
 *
 * **Spec references:**
 *   - Telecheck_v1_10_PRD_Update/Engineering-Review-Request-App-Role-
 *     Acquisition-SECDEF-Slice-Wrappers-2026-05-23.md
 *   - Cockpit Addenda 76 (ERR authored) + 80 (this helper landed)
 *   - migrations/051_app_role_acquisition_foundation.sql
 *   - Codex Pass-1 + Pass-2 dual-recommendation transcripts in the
 *     cockpit Addendum trail
 */

import type { DbClient } from './db.js';

// ---------------------------------------------------------------------------
// §1. Allowlisted slice roles.
//
// MUST match exactly the 13 GRANT membership clauses in
// migrations/051_app_role_acquisition_foundation.sql §2.
//
// Adding a new role to this list WITHOUT a corresponding GRANT
// in 051 (or a follow-up foundation migration) will cause SET LOCAL ROLE
// to fail at runtime with `permission denied to set role "..."`. The
// allowlist is the COMPILE-TIME safety; the migration is the RUNTIME
// safety; together they prevent both arbitrary-role escalation AND
// silent drift between code and DB.
// ---------------------------------------------------------------------------

export const SLICE_ROLES = [
  // Crisis Response (SI-022; 7 roles)
  'crisis_initiator',
  'crisis_acknowledger',
  'crisis_responder',
  'crisis_resolver',
  'crisis_sweep_scheduler',
  'crisis_event_staff_reader',
  'crisis_event_patient_reader',
  // Admin Backend Basics (SI-023; 2 roles)
  'admin_basic_operator',
  'admin_template_reviewer',
  // Medication Interaction Engine (SI-019; 4 roles)
  'medication_interaction_engine_evaluator',
  'medication_interaction_signal_viewer',
  'medication_interaction_override_recorder',
  'medication_interaction_knowledge_base_updater',
] as const;

export type SliceRole = typeof SLICE_ROLES[number];

const SLICE_ROLES_SET: ReadonlySet<string> = new Set<string>(SLICE_ROLES);

/**
 * Defense-in-depth runtime check that the role is in the allowlist.
 *
 * TypeScript narrows callers passing literal `SliceRole`-typed values
 * to the union, but code that derives a role from request data or
 * config MAY accidentally widen to `string` — this check catches that
 * case and refuses to interpolate an arbitrary identifier into
 * `SET LOCAL ROLE`.
 *
 * Throws a generic Error (not a tenant-scoped envelope) because this
 * is a programming-time bug, not a per-request enforcement failure.
 * Layer B authorization should already have rejected the request
 * before reaching this check; if this throws, a bug above this layer
 * exists.
 */
export function assertSliceRole(role: string): asserts role is SliceRole {
  if (!SLICE_ROLES_SET.has(role)) {
    throw new Error(
      `withDbRole: role "${role}" is not an allowlisted slice role. ` +
        `Allowlist (migration 051 §2): ${SLICE_ROLES.join(', ')}. ` +
        `If this is a legitimate new SECDEF slice, add the role to the ` +
        `SLICE_ROLES tuple in src/lib/with-db-role.ts AND grant membership ` +
        `to telecheck_app_role via a follow-up foundation migration.`,
    );
  }
}

// ---------------------------------------------------------------------------
// §2. The helper.
// ---------------------------------------------------------------------------

/**
 * Acquire EXECUTE/SELECT privileges of a slice role for the duration
 * of `fn`, by issuing `SET LOCAL ROLE <role>` on the open transaction.
 * The role assignment is automatically reset at tx commit/rollback
 * (PostgreSQL SET LOCAL semantics); no explicit RESET ROLE.
 *
 * **Preconditions** (caller responsibility):
 *   - `tx` is an open transaction (from a surrounding `withTransaction`).
 *   - Fastify Layer B authorization has ALREADY verified that the
 *     request's actor is entitled to act in the role being requested.
 *     This helper does NOT re-check that — it trusts the caller.
 *   - `withTenantContext` + `withActorContext` have ALREADY bound the
 *     tenant + actor-nonce GUCs on `tx`. Order:
 *       withTransaction → withTenantContext → withActorContext → withDbRole → fn
 *
 * **Postconditions**:
 *   - If `fn` returns, the transaction continues with the role still
 *     set (the role resets only at tx end). If callers need to call
 *     code that should NOT execute under the slice role, they must
 *     either commit + start a new tx OR use nested `withDbRole` to a
 *     different role.
 *   - If `fn` throws, the exception propagates. The transaction will
 *     roll back if it propagates past `withTransaction`. Do NOT catch
 *     and swallow inside this helper.
 *
 * **Identifier safety**:
 *   The role is asserted against the `SLICE_ROLES` allowlist before
 *   interpolation. Per PostgreSQL: `SET LOCAL ROLE <name>` does NOT
 *   accept `$1` parameters — only an identifier. We use a quoted
 *   identifier (PostgreSQL's `format('%I', ...)`) to defeat any
 *   character-level injection, but the allowlist is the primary
 *   defense.
 *
 * @param tx   Open transaction client from `withTransaction`.
 * @param role Slice role to elevate to (must be in `SLICE_ROLES`).
 * @param fn   Callback to run under the elevated role.
 * @returns    Whatever `fn` returns.
 */
export async function withDbRole<T>(
  tx: DbClient,
  role: SliceRole,
  fn: () => Promise<T>,
): Promise<T> {
  // Defense-in-depth: assert at runtime even though TypeScript narrows.
  // Code that derives `role` from `string` may have widened the type.
  assertSliceRole(role);

  // R1 HIGH-1 closure 2026-05-23: capture current_user BEFORE elevation
  // so the finally block can restore to that prior identity. Without this
  // restore step, SET LOCAL ROLE persists until tx commit/rollback and
  // any code running in the same transaction AFTER fn returns would
  // continue to hold the slice role's privileges — a privilege-boundary
  // footgun especially for handlers that perform audit/outbox/status
  // work after the wrapper call.
  //
  // current_user returns the effective role: for the OUTERMOST withDbRole
  // call it is the session login role (telecheck_app_role); for nested
  // calls it is the outer slice role. Capturing it dynamically (rather
  // than hardcoding 'telecheck_app_role') makes nested withDbRole
  // compositions correct — the inner restore returns to the OUTER slice
  // role, not to telecheck_app_role, preserving the outer scope's
  // intended elevation.
  const priorRoleResult = await tx.query<{ current_user: string }>(
    'SELECT current_user',
  );
  const priorRole = priorRoleResult.rows[0]?.current_user;
  if (typeof priorRole !== 'string' || priorRole.length === 0) {
    throw new Error(
      'withDbRole: could not read current_user to capture prior role for ' +
        'restoration. Aborting elevation to avoid leaving the slice role ' +
        'active past the callback boundary.',
    );
  }

  // SET LOCAL ROLE accepts only an identifier (no $1 placeholder is
  // permitted at the syntactic position). After the allowlist gate
  // above, `role` is guaranteed to be one of the 13 hard-coded
  // identifiers in SLICE_ROLES — all alphanumeric + underscore, no
  // special characters, no uppercase, no quoting required. The captured
  // priorRole comes from current_user (PostgreSQL-generated), which is
  // similarly a safe identifier (login roles + slice roles in this
  // codebase are all simple identifiers). Direct interpolation is safe
  // BECAUSE the allowlist + PG-generated identifier are the security
  // barriers (not the SQL escape).
  //
  // If a future role in SLICE_ROLES is added that requires quoting
  // (e.g., contains a hyphen or uppercase), update this implementation
  // to wrap the identifier in double-quotes per PG's quoted-identifier
  // syntax. The current set is all simple identifiers; no quoting
  // needed.
  await tx.query(`SET LOCAL ROLE ${role}`);

  try {
    return await fn();
  } finally {
    // Restore prior role even if fn throws. If the transaction is
    // rolling back (which it will if fn threw and the throw propagates
    // past withTransaction), the SET LOCAL is irrelevant — but if the
    // caller catches the exception and continues the tx, the restore
    // prevents accidental privilege escalation in the catch path.
    //
    // Wrap in try/catch + swallow because: (a) JavaScript finally-throw
    // would SHADOW the original fn error, destroying observability of
    // the real failure; (b) if the tx is already in aborted state
    // (common when fn threw with a PG error: "current transaction is
    // aborted, commands ignored until end of transaction block"), the
    // SET LOCAL ROLE call itself will throw, but the tx will roll back
    // anyway, clearing all role state. Preserving the fn error is more
    // important than capturing the restore failure here. If you need
    // observability into restore failures, instrument at the db.ts
    // layer (e.g., a query hook that counts SET LOCAL ROLE failures by
    // SQLSTATE 25P02 "in_failed_sql_transaction").
    try {
      await tx.query(`SET LOCAL ROLE ${priorRole}`);
    } catch {
      // Swallow — see comment above.
    }
  }
}
