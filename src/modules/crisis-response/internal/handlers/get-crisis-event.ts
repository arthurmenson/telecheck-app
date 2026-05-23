/**
 * crisis-response/internal/handlers/get-crisis-event.ts — staff-scoped
 * single-row read for a crisis_event.
 *
 * Endpoint: GET /v0/crisis-events/:id
 *
 * **Sprint 2 PR 1 — the FIRST real Fastify handler in the Crisis Response
 * slice** (lands after foundation 051's app-role-acquisition mechanism +
 * `withDbRole` helper merged on `main` at 79ad0ca). Staff-scoped read
 * (via `crisis_event_current_state_v` + role `crisis_event_staff_reader`)
 * is the simplest entrypoint — patient-scoped read (via
 * `crisis_event_patient_summary_v` + `crisis_event_patient_reader`) lands
 * in a follow-up PR.
 *
 * Mirrors the canonical pattern established by SI-023 PR 1 at
 * `src/modules/admin-backend/internal/handlers/get-crisis-operational-health.ts`
 * (the first cross-slice handler to consume the Option B mechanism).
 *
 * **Authoritative shape — migration 034 §1 view columns:**
 *   - crisis_event_id                   UUID
 *   - tenant_id                         TEXT
 *   - patient_id                        UUID
 *   - server_signal_id                  UUID
 *   - crisis_type                       TEXT  (6-value enum)
 *   - severity                          TEXT  (3-value enum)
 *   - regulatory_reporting_enabled      BOOLEAN
 *   - detected_at                       TIMESTAMPTZ
 *   - current_state                     TEXT (LATERAL latest; nullable when no transition exists)
 *   - current_state_transition_at       TIMESTAMPTZ (nullable)
 *   - current_state_transition_reason   TEXT (nullable)
 *   - current_state_actor_principal_id  TEXT (nullable)
 *
 * **Composition stack (per `src/lib/with-db-role.ts` §preconditions):**
 *
 *     withTransaction
 *      └─ withTenantContext (lib/rls.ts; binds private _session_tenant_context row)
 *         └─ withActorContext (binds SI-010 `app.request_nonce` GUC; only when nonce bound)
 *            └─ withDbRole(tx, 'crisis_event_staff_reader', fn)
 *               └─ SELECT ... FROM crisis_event_current_state_v WHERE crisis_event_id = $1
 *
 * The view's body uses `security_invoker=true` so RLS on the underlying
 * `crisis_event` + `crisis_event_lifecycle_transition` tables evaluates
 * against the CALLER's role — which is `crisis_event_staff_reader` for the
 * duration of `withDbRole`'s SET LOCAL ROLE. The view body ALSO carries
 * an explicit `WHERE ce.tenant_id = current_tenant_id()` predicate as a
 * defense-in-depth tenant filter alongside the base-table RLS. The
 * combination delivers I-023 three-layer isolation at the read path.
 *
 * **Layer B authorization (DEFERRED — staff-reader role-gate gap):**
 *   The brief says "verify the request's actor is entitled to act as
 *   crisis_event_staff_reader". The codebase currently has role-gates
 *   for the 4 canonical JWT roles (patient / clinician / tenant_admin /
 *   platform_admin) via `requireXxxActorContext` in
 *   `src/lib/auth-context.ts`, but there is no mapping yet from JWT role
 *   → DB slice-role membership (a future Phase A item once Identity
 *   slice publishes role-to-DB-membership). For Sprint 2 PR 1, we apply
 *   the closest available gate — clinician — since
 *   `crisis_event_staff_reader` is conceptually a clinician/operator
 *   role (it has tenant-wide view access to all crisis_events with
 *   operator-internal columns like `actor_principal_id` +
 *   `transition_reason` that patients MUST NOT see per migration 034's
 *   column-grant data-minimization split).
 *
 *   **TODO (Layer B gap):** when the JWT-role → DB-slice-role membership
 *   mapping lands (Phase A successor to SI-010 / SI-024.1), replace the
 *   clinician role-gate with a precise membership check that asserts the
 *   acting JWT role is entitled to act as `crisis_event_staff_reader`
 *   (likely a clinician OR tenant_admin entitled by `RoleAssignment` in
 *   Identity slice). For now, clinician is the closest available gate
 *   that does NOT widen the staff-reader surface to patients.
 *
 *   Defense-in-depth: even if the Layer B gate were absent, the DB layer
 *   fails closed — the request's bound role (`telecheck_app_role`) does
 *   NOT inherit `crisis_event_staff_reader` privileges (NOINHERIT per
 *   migration 051), so `withDbRole`'s SET LOCAL ROLE is what gates
 *   privilege acquisition; bypassing the role-gate at the Fastify layer
 *   would still require an explicit `withDbRole` call to reach the view.
 *
 * **404 envelope (I-025 tenant-blind):**
 *   When the view returns 0 rows we throw via
 *   `req.server.httpErrors.notFound`; the global error-envelope plugin
 *   formats it into the canonical ERROR_MODEL v5.1 envelope. The
 *   envelope is IDENTICAL whether the crisis_event genuinely does not
 *   exist OR exists in a different tenant the caller cannot see — RLS
 *   + the view predicate filter cross-tenant rows out so the query
 *   returns 0 rows in both cases. No tenant_id is leaked in the error
 *   body per I-025 + ERROR_MODEL v5.1.
 *
 * **No audit emission (per SI-022 §6 audit catalog):**
 *   Read endpoints do NOT emit Cat A/B audit events. The 5 Cat A events
 *   (`crisis.detected` / `crisis.acknowledged` / `crisis.responded` /
 *   `crisis.resolved` / `crisis.no_acknowledgement_escalation`) fire at
 *   write-path transitions only, which land in follow-up PRs.
 *
 * **Out of scope (per brief; tracked in README followups):**
 *   - POST /v0/crisis-events (initiation) — Sprint 2 follow-up PR
 *   - POST .../:id/acknowledge — Sprint 2 follow-up PR
 *   - POST .../:id/respond / .../resolve — Sprint 3
 *   - POST .../:id/sweep — Sprint 3
 *   - GET .../:id with patient-scoped view (crisis_event_patient_reader)
 *     — Sprint 2 PR 1.1 follow-up
 *   - Cat A audit emission helper — lands with first write endpoint
 *   - Cross-slice shared utilities — refactor after all 3 slices ship
 *     first handler
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 §6 (read path)
 *   - migrations/034_crisis_response_derived_views.sql §1 (staff view)
 *   - migrations/051_app_role_acquisition_foundation.sql (role-acquisition)
 *   - src/lib/with-db-role.ts (Option B per-tx SET LOCAL ROLE helper)
 *   - I-023 (three-layer tenant isolation: RLS + view predicate +
 *     tenant-context binding)
 *   - I-025 (tenant-blind 404 envelope)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requireClinicianActorContext } from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import type {
  CrisisLifecycleState,
  CrisisLifecycleTransitionReason,
  CrisisSeverity,
  CrisisType,
} from '../types.js';

// ---------------------------------------------------------------------------
// Path-param validation — crisis_event.id is UUID per migration 033 §4
// ---------------------------------------------------------------------------

/**
 * RFC 4122 UUID shape (any variant; case-insensitive hex). The DB column
 * is `UUID PRIMARY KEY DEFAULT gen_random_uuid()` (migration 033 §4
 * line 472), NOT VARCHAR(26) ULID. This regex catches malformed input at
 * the boundary so the DB never sees a non-UUID literal (which would
 * otherwise surface as a PG type-cast error → 500 rather than 400).
 *
 * The brief mentioned a VARCHAR(26) ULID shape — that was brief/spec
 * drift; the canonical CDM v1.10 §4.NEW1 + migration 033 §4 use UUID.
 * Choosing the DB-aligned validator is the only correct option.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidShape(raw: string): boolean {
  return UUID_PATTERN.test(raw);
}

// ---------------------------------------------------------------------------
// View row shape — mirrors migration 034 §1 SELECT projection
// ---------------------------------------------------------------------------

/**
 * Row shape returned by `crisis_event_current_state_v` (migration 034 §1).
 * Field names match the view's SELECT projection exactly so the handler's
 * `tx.query<CrisisEventCurrentStateRow>(...)` typecheck matches what pg
 * returns.
 *
 * Nullable fields (`current_state*`) reflect the LEFT JOIN LATERAL — a
 * crisis_event with no lifecycle_transition row (transient state during
 * the brief window between the initiation INSERT and the first
 * `record_crisis_initiation` lifecycle row commit) would project NULLs.
 * In steady state this should not be observable from a read because the
 * initiation wrapper commits both rows in the same transaction, but the
 * type is permissive to avoid runtime crashes if the read ever races a
 * partially-committed write in a future code path.
 */
export interface CrisisEventCurrentStateRow {
  crisis_event_id: string;
  tenant_id: string;
  patient_id: string;
  server_signal_id: string;
  crisis_type: CrisisType;
  severity: CrisisSeverity;
  regulatory_reporting_enabled: boolean;
  detected_at: Date;
  current_state: CrisisLifecycleState | null;
  current_state_transition_at: Date | null;
  current_state_transition_reason: CrisisLifecycleTransitionReason | null;
  current_state_actor_principal_id: string | null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * GET /v0/crisis-events/:id — staff-scoped single-row crisis_event read.
 *
 * Flow (5 phases — mirrors SI-023 admin-backend canonical handler):
 *   1. Resolve tenant context (foundation tenantContextPlugin; throws
 *      → tenant-blind 400 via error-envelope when absent).
 *   2. LAYER B: requireClinicianActorContext (closest available role-gate
 *      pending Phase A JWT-role → DB-slice-role membership mapping).
 *      Throws 401 on missing auth / 403 on role mismatch.
 *   3. Validate path param `id` is a UUID shape (400 on malformed).
 *   4. Open a tx via withTransaction; compose:
 *        withTenantContext (RLS + private tenant binding)
 *        → withActorContext (SI-010 nonce GUC; only if actorNonce bound)
 *        → withDbRole crisis_event_staff_reader (Option B elevation)
 *        → SELECT ... FROM crisis_event_current_state_v WHERE crisis_event_id = $1
 *   5. Return 200 with the row, OR 404 (tenant-blind) when 0 rows.
 */
export async function getCrisisEventHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Phase 1 — tenant context.
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization (closest-available role-gate).
  // See file header "Layer B authorization (DEFERRED)" for the TODO.
  // Mark `actor` as consumed via void to satisfy unused-var lint while
  // preserving the role-gate side effect — the throw on missing/wrong
  // actor is what enforces authorization here.
  const actor = requireClinicianActorContext(req);
  void actor;

  // Phase 3 — path param validation.
  const params = req.params as Record<string, unknown>;
  const idParam = params['id'];
  if (typeof idParam !== 'string' || idParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `id` is required.');
  }
  if (!isUuidShape(idParam)) {
    throw req.server.httpErrors.badRequest(
      'Path param `id` must be a UUID (8-4-4-4-12 hex form).',
    );
  }

  // Phase 4 — open tx + compose context helpers in canonical order
  // (withTransaction → withTenantContext → withActorContext → withDbRole).
  //
  // Note on `tx` reuse inside the nested callbacks: `withTenantContext`
  // (from src/lib/rls.ts) declares its own narrow `DbClient` interface
  // whose `query` returns `Promise<unknown>` — fine for the binding-
  // helper internals but unwieldy for downstream typed `query<R>`
  // calls. We therefore use the `tx` handle from `withTransaction` (the
  // canonical `DbTransaction` interface with typed `query<R>` returns)
  // throughout the nested callbacks; the rls.ts inner callback's bound
  // client is the SAME physical connection (just narrowed at the type
  // boundary), so calls on `tx` are equivalent to calls on the bound
  // client at runtime. Mirrors the canonical pattern from the SI-023
  // admin-backend handler.
  const row = await withTransaction<CrisisEventCurrentStateRow | null>(async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      // SI-010 actor nonce: when authContextPlugin's bind-pool wiring is
      // configured, `req.actorNonce` is populated; when the deployment
      // opts out of SI-010 (dev/test where bind pool isn't configured),
      // the nonce is undefined. The staff view does NOT consult
      // `current_actor_*()` helpers in its body (unlike the patient view
      // which uses `current_actor_account_id()` for self-scoping), so the
      // staff read does not strictly require the nonce. We still wrap
      // with `withActorContext` when present so any future SECDEF helper
      // invoked from this read path can resolve the trusted actor —
      // defense in depth for downstream additions.
      const runRead = async (): Promise<CrisisEventCurrentStateRow | null> => {
        return withDbRole(tx, 'crisis_event_staff_reader', async () => {
          const result = await tx.query<CrisisEventCurrentStateRow>(
            'SELECT crisis_event_id, tenant_id, patient_id, server_signal_id, ' +
              'crisis_type, severity, regulatory_reporting_enabled, detected_at, ' +
              'current_state, current_state_transition_at, ' +
              'current_state_transition_reason, current_state_actor_principal_id ' +
              'FROM crisis_event_current_state_v ' +
              'WHERE crisis_event_id = $1',
            [idParam],
          );
          return result.rows[0] ?? null;
        });
      };

      if (req.actorNonce !== undefined) {
        return withActorContext(tx, req.actorNonce, runRead);
      }
      return runRead();
    });
  });

  // Phase 5 — 404 (tenant-blind) on miss.
  if (row === null) {
    // I-025 tenant-blind 404. The error-envelope plugin formats this
    // into the canonical ERROR_MODEL v5.1 envelope:
    //   { error: { code: 'internal.resource.not_found', message: ..., trace_id, timestamp } }
    // No tenant_id, no actor info, no schema hints.
    throw req.server.httpErrors.notFound('Crisis event not found.');
  }

  return reply.code(200).send(row);
}
