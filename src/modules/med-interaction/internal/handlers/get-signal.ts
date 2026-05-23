/**
 * med-interaction/internal/handlers/get-signal.ts —
 *   GET /v0/med-interaction/signals/:id — single-signal current-state lookup.
 *
 * **PR 7 of N — FIRST REAL HANDLER POST-FOUNDATION-051.**
 *
 * This is the first Fastify handler shipped for the Med-Interaction slice
 * (SI-019 v2.0 RATIFIED 2026-05-21 P-033 + CDM v1.7 P-034) after the Option B
 * app-role acquisition foundation merged at `79ad0ca` (migration 051 +
 * `withDbRole` helper). It demonstrates the canonical handler shape every
 * subsequent SECDEF-wrapper-calling handler will mirror across this slice
 * (and across Crisis Response + Admin Backend once their PR 7+ work begins).
 *
 * Endpoint contract:
 *   Method   GET
 *   Path     /v0/med-interaction/signals/:id      (module prefix /v0/med-interaction)
 *   Params   id (path) — VARCHAR(26) ULID — the interaction_signal_id
 *   Returns  200 + InteractionSignalCurrentStateView on hit
 *            404 (tenant-blind per I-025) on miss / wrong tenant
 *            400 on malformed :id (not a 26-char Crockford-base32 ULID)
 *            401 if no authenticated actor (production fail-closed)
 *
 * **Backing surface (migration 048 §3):**
 *   `get_interaction_signal_current_state(p_signal_id VARCHAR(26))` is the
 *   SECURITY DEFINER access function owned by `mv_refresh_owner` with EXECUTE
 *   GRANTed to `medication_interaction_signal_viewer`. It reads the optional
 *   materialized view (`interaction_signal_current_state_mv`) under a
 *   `tenant_id = current_tenant_id()` predicate enforced inside the function
 *   body, returning a single row `(signal_id, current_state, as_of,
 *   transition_reason)` or zero rows when the signal does not exist in this
 *   tenant. Cross-tenant rows are invisible because the predicate uses the
 *   per-transaction `app.tenant_id` GUC bound by `withTenantContext`.
 *
 * **Read-path classification (SI-019 Sub-decision 9):**
 *   This handler is a **HOT-PATH DISPLAY** consumer (clinician dashboard /
 *   pharmacy portal active-signals indicator / patient app summary). The
 *   handler is NOT a strict-freshness consumer — those (override procedure
 *   STEP 4, prescribing decision gates, refill release checks, protocol
 *   gates, pharmacy enforcement) MUST query `interaction_signal_lifecycle_
 *   transition` directly under advisory lock per SI-019 Sub-decision 9, and
 *   land in their own dedicated handlers (PR 8+ as the lifecycle endpoints
 *   come online).
 *
 * **Audit posture:**
 *   Per SI-019 §6 audit catalog, READS do NOT emit Cat A/B audit events.
 *   The 6 cataloged events are all write-class (evaluation_completed,
 *   signal_emitted, evaluation_failed, knowledge_base_updated,
 *   signal_enforcement_override, interaction_engine_projection_divergence_
 *   detected). No audit emission is required from this handler. The Cat A
 *   audit emission helper lands when the first write endpoint ships
 *   (PR 8 — POST evaluations).
 *
 * **Composition order (per `src/lib/with-db-role.ts` §0 docstring):**
 *   withTransaction → withTenantContext → withActorContext → withDbRole → fn
 *
 *   - `withTransaction` — owns BEGIN/COMMIT/ROLLBACK so any failure
 *     (including the role-restoration failure path) rolls back cleanly.
 *   - `withTenantContext` — sets the `app.tenant_id` GUC consumed by the
 *     SECDEF function's `WHERE mv.tenant_id = current_tenant_id()` predicate.
 *   - `withActorContext` — sets the `app.request_nonce` GUC for SI-010
 *     downstream helpers; for a pure read this is defensive (no `current_actor_*()`
 *     call inside the SECDEF function) but mirrors the canonical write
 *     composition so the handler shape is uniform with PR 8+ handlers.
 *   - `withDbRole(tx, 'medication_interaction_signal_viewer', ...)` —
 *     elevates from `telecheck_app_role` to the slice reader role so the
 *     SECDEF function's EXECUTE GRANT is satisfied (per migration 048 §3 +
 *     migration 051 §2 grant of membership).
 *
 * **Layer B authorization (deferred — known followup):**
 *   Per the Med-Interaction module README "Option 2 ratifier decision":
 *   LAYER B role-membership authorization is deferred from SQL wrappers
 *   to the Fastify route layer because the spec's `tenant_account_membership`
 *   table does not exist in the code repo yet. At PR 7 the only Layer B
 *   check is that an authenticated `actorContext` is present (any verified
 *   JWT — patient / clinician / tenant_admin / platform_admin — can read).
 *   This is intentionally permissive for the first real handler and is
 *   tightened in a cross-slice integration cycle when (a) the Identity &
 *   Auth slice ships the role-membership table OR (b) a per-slice membership
 *   cache lands, whichever is first. See TODO inline below.
 *
 *   Until that tightening, the trust boundary that matters is the
 *   `withDbRole` allowlist + the SECDEF function's tenant predicate. A
 *   forged JWT cannot widen the role beyond `medication_interaction_signal_viewer`
 *   because the handler hard-codes the role string; tenant isolation
 *   remains intact because the SECDEF function predicates on
 *   `current_tenant_id()`, which is bound from the request's resolved
 *   tenant context, not from any actor claim.
 *
 * Spec references:
 *   - SI-019 Slice PRD v2.0 §5 (signal-read endpoint), §6 (audit catalog),
 *     §Sub-decision 9 (read-path consumer classification)
 *   - CDM v1.6 → v1.7 Amendment §4.NEW3 (interaction_signal), §4.NEW4
 *     (interaction_signal_lifecycle_transition), §4.NEW5 (access function)
 *   - migration 048 (SECDEF function `get_interaction_signal_current_state`)
 *   - migration 051 + `src/lib/with-db-role.ts` (Option B foundation)
 *   - I-023 (tenant isolation; enforced by SECDEF function predicate)
 *   - I-025 (tenant-blind 404 envelope)
 *   - src/modules/med-interaction/README.md (PR 7 of N status)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withTransaction } from '../../../../lib/db.js';
import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRoleSafe } from '../../../../lib/with-db-role-safe.js';
import type { InteractionSignalCurrentStateView } from '../types.js';

// ---------------------------------------------------------------------------
// ULID validation (Crockford base32, 26 chars).
//
// The SECDEF function's parameter is VARCHAR(26); supplying a longer value
// would silently truncate (PostgreSQL VARCHAR semantics) and a shorter value
// would be cast at the parameter boundary. Either case would mask a client
// bug as a tenant-blind 404. Validating shape at the HTTP boundary surfaces
// the malformed-id case as 400 — distinct from "valid id, not in this tenant"
// which is the tenant-blind 404 below.
//
// Allowed characters: Crockford base32 excludes I, L, O, U. The pattern
// below matches the alphabet `0-9 A-H J K M N P-T V-Z` (case-sensitive;
// ULIDs are uppercase by convention + the `ulid()` generator in
// `src/lib/ulid.ts` emits uppercase).
// ---------------------------------------------------------------------------
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isUlid(s: string): boolean {
  return ULID_PATTERN.test(s);
}

// ---------------------------------------------------------------------------
// Layer B authorization (deferred — see file-level docstring).
//
// At PR 7 the only check is "an authenticated actorContext is present."
// The handler does NOT discriminate on role beyond that; any verified JWT
// (patient / clinician / tenant_admin / platform_admin) can read a signal
// in their resolved tenant. Tightening to the slice's intended LAYER B
// (clinician + tenant_admin + platform_admin only, plus a patient-self
// carve-out where the signal's evaluation pertains to the patient) lands
// in a cross-slice integration cycle when the role-membership infrastructure
// arrives.
//
// Production fail-closed gate (mirrors forms-intake `resolveActorId`):
//   - If a JWT actorContext is present, accept it.
//   - Otherwise, in production reject 401 (no header-shim fallback).
//   - In non-production accept anonymous reads so local dev / test setup
//     fixtures can exercise the endpoint without minting a real JWT. This
//     mirrors the `ALLOW_ACTOR_HEADER_AUTH` posture of every other v0.1
//     handler in the codebase and is removed when the Identity slice
//     becomes the canonical auth boundary.
// ---------------------------------------------------------------------------
function assertLayerBAuthorized(req: FastifyRequest): void {
  // TODO(med-interaction PR 8+ or cross-slice integration cycle): replace
  // this permissive check with the SI-019-§5 spec's role/membership matrix
  // once `tenant_account_membership` (or the per-slice cache equivalent) is
  // available. The spec intent is: clinician + tenant_admin + platform_admin
  // unconditionally; patient only when the signal's evaluation references
  // their patient_id. Until then, this check is intentionally permissive.
  if (req.actorContext !== undefined) {
    return;
  }
  const isProd = process.env['NODE_ENV'] === 'production';
  if (isProd) {
    throw req.server.httpErrors.unauthorized(
      'Actor identity could not be authenticated for this request.',
    );
  }
  // Non-production: permit anonymous reads for test ergonomics. The
  // tenant-blind envelope below + the SECDEF function's tenant predicate
  // mean an anonymous request still cannot enumerate cross-tenant signals.
}

// ---------------------------------------------------------------------------
// Handler.
// ---------------------------------------------------------------------------

/**
 * Row shape returned by `get_interaction_signal_current_state` (migration
 * 048 §3). Field set + types mirror the function's RETURNS TABLE clause
 * 1:1 — `signal_id` and `current_state` + `transition_reason` are TEXT
 * (Option 2 carryforward: custom DOMAIN types not formalized in code repo
 * yet; the migration explicitly notes this as a future TYPES amendment),
 * `as_of` is TIMESTAMPTZ which the `pg` driver materializes as a JS Date.
 */
interface RawCurrentStateRow {
  signal_id: string;
  current_state: string;
  as_of: Date;
  transition_reason: string;
}

export async function getSignalHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  // §1 — Tenant context (I-023 fail-closed; tenantContextPlugin already
  // ran in the onRequest hook; absence here is a programming error, not
  // a user error).
  const ctx = requireTenantContext(req);

  // §2 — Layer B authorization (deferred-permissive per file-level docstring).
  assertLayerBAuthorized(req);

  // §3 — Path-param validation. The pattern check is the HTTP-boundary
  // shape gate; the SECDEF function's VARCHAR(26) parameter is the DB
  // boundary gate. Both are necessary: a malformed value here would
  // otherwise produce a tenant-blind 404 (the SECDEF function would
  // return zero rows on a non-existent id) — distinct from "valid id,
  // not in this tenant," which we DO want to be tenant-blind.
  const params = req.params as Record<string, unknown>;
  const rawId = params['id'];
  if (typeof rawId !== 'string' || rawId.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `id` is required.');
  }
  if (!isUlid(rawId)) {
    throw req.server.httpErrors.badRequest(
      'Path param `id` must be a 26-character Crockford-base32 ULID.',
    );
  }
  const signalId = rawId;

  // §4 — Resolve the actor nonce for withActorContext composition. For
  // pre-auth / shim paths the nonce may be undefined; in that case we
  // skip the `SET LOCAL app.request_nonce` step (the SECDEF function
  // does NOT call any `current_actor_*()` helpers, so the nonce is
  // defensive only for this handler — the canonical composition stays
  // the same for write handlers in PR 8+).
  const actorNonce = req.actorNonce;

  // §5 — Canonical composition: withTransaction → withTenantContext →
  // withActorContext → withDbRole → SECDEF call. The role elevation
  // is restored to `telecheck_app_role` automatically when the
  // withDbRole callback returns (or throws); the transaction commits
  // or rolls back when withTransaction's outer scope resolves.
  const row = await withTransaction(async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      // withActorContext is a thin wrapper around `SET LOCAL
      // app.request_nonce = $1`; when the nonce is undefined we skip
      // it to avoid binding an empty/invalid GUC value. The SECDEF
      // function this handler calls does not require the nonce.
      //
      // I-025 envelope-leak defense: `withDbRoleSafe` (src/lib/with-db-
      // role-safe.ts) composes `withDbRole` + the canonical SQLSTATE
      // 42501 → tenant-blind 403 mapping. The mapping covers BOTH raise
      // paths — (1) the SET LOCAL ROLE pre-callback step (foundation-051
      // role-membership drift) and (2) the SECDEF function body /
      // RLS evaluation when the actor lacks tenant scope — because the
      // wrapper's try/catch wraps the ENTIRE withDbRole call. Other PG
      // errors propagate to the global error-envelope handler unchanged.
      // See src/lib/with-db-role-safe.ts for the full rationale + the
      // cross-slice refactor history (Med-Interaction PR 7.1 / Crisis
      // Sprint 2 PR 1 R2 / Admin Sprint 2 PR 1 R1 closures).
      const callWrappers = async (): Promise<RawCurrentStateRow | null> => {
        return withDbRoleSafe(tx, 'medication_interaction_signal_viewer', req, async () => {
          const result = await tx.query<RawCurrentStateRow>(
            'SELECT signal_id, current_state, as_of, transition_reason FROM get_interaction_signal_current_state($1)',
            [signalId],
          );
          if (result.rows.length === 0) {
            return null;
          }
          // The function returns at most one row by id; defensive against
          // any future widening that would surface duplicates.
          return result.rows[0] ?? null;
        });
      };
      if (typeof actorNonce === 'string' && actorNonce.length > 0) {
        return withActorContext(tx, actorNonce, callWrappers);
      }
      return callWrappers();
    });
  });

  // §6 — Tenant-blind 404 envelope per I-025. The response shape MUST NOT
  // differentiate "signal does not exist anywhere" from "signal exists in
  // another tenant" — both fall through here. The SECDEF function's
  // tenant predicate is the enforcement; this 404 is the wire-out shape.
  if (row === null) {
    throw req.server.httpErrors.notFound('Interaction signal not found.');
  }

  // §7 — Marshal to the public view shape. The `as_of` Date is serialized
  // as an ISO-8601 string (Fastify's default JSON serializer uses
  // Date.prototype.toJSON). Field names are snake_case to match the
  // OpenAPI v0.3 contract (CDM v1.7 §4.NEW5 access function row shape).
  const view: InteractionSignalCurrentStateView = {
    signal_id: row.signal_id,
    current_state: row.current_state,
    as_of: row.as_of.toISOString(),
    transition_reason: row.transition_reason,
  };
  return reply.code(200).send(view);
}
