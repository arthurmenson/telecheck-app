/**
 * crisis-response/internal/handlers/get-crisis-event-patient-summary.ts —
 * patient-scoped (data-minimized) single-row read for a crisis_event.
 *
 * Endpoint: GET /v0/crisis-events/:id/patient-summary
 *
 * **Sprint 2 PR 5 — the patient-scoped counterpart to the staff-scoped
 * read (`GET /v0/crisis-events/:id`) from Sprint 2 PR 1.** Mirrors the
 * canonical staff-handler pattern (composition, 42501→403 mapping,
 * tenant-blind 404, UUID validation) but reads the **patient view**
 * (`crisis_event_patient_summary_v` per migration 034 §2) via the
 * **patient slice role** (`crisis_event_patient_reader`).
 *
 * **Authoritative shape — migration 034 §2 view columns (8 columns;
 * minimized vs the 12-col staff projection):**
 *   - crisis_event_id                   UUID
 *   - tenant_id                         TEXT
 *   - patient_id                        UUID
 *   - crisis_type                       TEXT  (6-value enum)
 *   - severity                          TEXT  (3-value enum)
 *   - detected_at                       TIMESTAMPTZ
 *   - current_state                     TEXT (LATERAL latest; nullable when no transition exists)
 *   - current_state_transition_at       TIMESTAMPTZ (nullable)
 *
 * Columns intentionally OMITTED vs the staff view (per migration 034 §2):
 *   `server_signal_id`, `regulatory_reporting_enabled`,
 *   `current_state_transition_reason`, `current_state_actor_principal_id`,
 *   plus all `intake_payload_*` KMS envelope columns. Patient sees the
 *   state of their own crisis event — not operator-internal diagnostic
 *   metadata.
 *
 * **Composition stack (identical to the staff-scoped read; per
 * `src/lib/with-db-role.ts` §preconditions):**
 *
 *     withTransaction
 *      └─ withTenantContext (lib/rls.ts; binds private _session_tenant_context row)
 *         └─ withActorContext (binds SI-010 `app.request_nonce` GUC)
 *            └─ withDbRole(tx, 'crisis_event_patient_reader', fn)
 *               └─ SELECT ... FROM crisis_event_patient_summary_v WHERE crisis_event_id = $1
 *
 * **CRITICAL — actorNonce REQUIRED for patient view (unlike staff view):**
 *   The patient view's body carries an explicit self-scoping predicate:
 *       AND ce.patient_account_id = current_actor_account_id()
 *   `current_actor_account_id()` returns NULL when no actor context is
 *   bound. NULL comparison (`patient_id = NULL`) is never true, so the
 *   view returns 0 rows — fail-closed at the DB layer. However, that
 *   masquerades as a tenant-blind 404 for a row that may exist for this
 *   patient. To avoid a confusing "404 even though it should exist"
 *   experience for the patient AND to surface the real failure (caller
 *   reached the patient endpoint with no actor nonce — a deployment /
 *   request-binding defect, not a not-found), this handler **fails closed
 *   at the application layer** when `req.actorNonce` is undefined,
 *   throwing a tenant-blind 403 BEFORE opening the transaction.
 *
 *   This is the documented divergence from the staff handler, which
 *   tolerates undefined actorNonce because the staff view's body does
 *   NOT consult `current_actor_*()` helpers.
 *
 * **Layer B authorization (DEFERRED — patient-reader role-gate gap):**
 *   The brief says "deferred-permissive for v0.1 (any authenticated actor
 *   passes)". For Sprint 2 PR 5, we apply `requirePatientActorContext`
 *   (the closest available role-gate that matches the slice role's
 *   conceptual identity — the `crisis_event_patient_reader` DB slice
 *   role is intended for patients reading their own crisis events).
 *
 *   **TODO (patient-self-scope-check tightening):** when the JWT-role
 *   → DB-slice-role membership mapping lands (Phase A successor to
 *   SI-010 / SI-024.1), replace the patient role-gate with a precise
 *   membership check that asserts the acting JWT role is entitled to
 *   act as `crisis_event_patient_reader`. Additionally, when delegated
 *   access lands (the patient view's `consent_grant` predicate from
 *   the spec is currently OMITTED per migration 034 §2 v1.0 Option 2
 *   adaptation), the Layer B gate must widen to accept a delegate
 *   acting on behalf of the patient — at which point the view body's
 *   self-scoping predicate will also widen via the canonical
 *   delegation-lookup helper. For v0.1, the gate stays at "patient
 *   role only"; the view body restricts to the actor's own patient_id.
 *
 *   Defense-in-depth: even if the Layer B gate were absent, the DB
 *   layer fails closed — the request's bound role (`telecheck_app_role`)
 *   does NOT inherit `crisis_event_patient_reader` privileges (NOINHERIT
 *   per migration 051), so `withDbRole`'s SET LOCAL ROLE is what gates
 *   privilege acquisition.
 *
 * **404 envelope (I-025 tenant-blind):**
 *   When the view returns 0 rows we throw via
 *   `req.server.httpErrors.notFound`. The error-envelope plugin formats
 *   it into the canonical ERROR_MODEL v5.1 envelope. The envelope is
 *   IDENTICAL whether:
 *     - the crisis_event genuinely does not exist
 *     - it exists in a different tenant the caller cannot see
 *     - it exists in this tenant but belongs to a different patient
 *       (the view's self-scoping predicate filters it out)
 *   No tenant_id, no patient_id, no schema hints are leaked.
 *
 * **No audit emission (per SI-022 §6 audit catalog):**
 *   Read endpoints do NOT emit Cat A/B audit events. Same rationale as
 *   the staff-scoped read.
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0 §5 (patient endpoints)
 *   - migrations/034_crisis_response_derived_views.sql §2 (patient view)
 *   - migrations/051_app_role_acquisition_foundation.sql (role-acquisition)
 *   - src/lib/with-db-role.ts (Option B per-tx SET LOCAL ROLE helper)
 *   - I-023 (three-layer tenant isolation: RLS + view predicate +
 *     tenant-context binding + actor-identity self-scoping)
 *   - I-025 (tenant-blind 404 envelope)
 *   - SI-010 trust anchor (actor identity binding via app.request_nonce GUC)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requirePatientActorContext } from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import type { CrisisEventPatientSummaryRow } from '../types.js';

// ---------------------------------------------------------------------------
// Path-param validation — crisis_event.id is UUID per migration 033 §4
// ---------------------------------------------------------------------------

/**
 * RFC 4122 UUID shape (any variant; case-insensitive hex). Same validator
 * as the staff-scoped handler — the DB column is `UUID PRIMARY KEY` per
 * migration 033 §4 line 472. Catching malformed input at the boundary
 * keeps the DB from seeing a non-UUID literal (which would otherwise
 * surface as a PG type-cast error → 500 rather than 400).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidShape(raw: string): boolean {
  return UUID_PATTERN.test(raw);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * GET /v0/crisis-events/:id/patient-summary — patient-scoped single-row
 * crisis_event read (data-minimized projection).
 *
 * Flow (6 phases — extends the staff-handler 5-phase flow with an
 * explicit Phase 3.5 actorNonce-required check):
 *   1. Resolve tenant context (foundation tenantContextPlugin; throws
 *      → tenant-blind 400 via error-envelope when absent).
 *   2. LAYER B: requirePatientActorContext (closest-available role-gate
 *      pending Phase A JWT-role → DB-slice-role membership mapping;
 *      see header TODO).
 *   3. Validate path param `id` is a UUID shape (400 on malformed).
 *   3.5. **Fail closed on missing actorNonce** (the patient view's
 *        self-scoping predicate requires the SI-010 actor binding;
 *        without it, the view returns 0 rows for ALL inputs — a
 *        deployment defect, not a not-found). 403 tenant-blind.
 *   4. Open a tx via withTransaction; compose:
 *        withTenantContext (RLS + private tenant binding)
 *        → withActorContext (SI-010 nonce GUC — REQUIRED here, unlike staff)
 *        → withDbRole crisis_event_patient_reader (Option B elevation)
 *        → SELECT ... FROM crisis_event_patient_summary_v WHERE crisis_event_id = $1
 *   5. Return 200 with the row, OR 404 (tenant-blind) when 0 rows.
 */
export async function getCrisisEventPatientSummaryHandler(
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
  const actor = requirePatientActorContext(req);
  void actor;

  // Phase 3 — path param validation.
  const params = req.params as Record<string, unknown>;
  const idParam = params['id'];
  if (typeof idParam !== 'string' || idParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `id` is required.');
  }
  if (!isUuidShape(idParam)) {
    throw req.server.httpErrors.badRequest('Path param `id` must be a UUID (8-4-4-4-12 hex form).');
  }

  // Phase 3.5 — fail closed on missing actor nonce.
  //
  // Unlike the staff view (which does not consult current_actor_*() helpers
  // in its body), the patient view's self-scoping predicate is:
  //     AND ce.patient_account_id = current_actor_account_id()
  // When `app.request_nonce` is unbound, current_actor_account_id() returns
  // NULL; NULL comparison filters all rows out. To avoid a misleading 404
  // (it would look like "your event doesn't exist" when in reality the
  // request-binding wasn't applied), we fail closed here at the app layer
  // with a tenant-blind 403. The error-envelope plugin formats this into
  // the canonical ERROR_MODEL v5.1 envelope; no actor / patient / tenant
  // hints leak.
  if (req.actorNonce === undefined) {
    throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
  }

  // Phase 4 — open tx + compose context helpers in canonical order
  // (withTransaction → withTenantContext → withActorContext → withDbRole).
  //
  // Same `tx`-reuse-inside-nested-callbacks pattern as the staff handler
  // (see get-crisis-event.ts header comment for the type-narrowing
  // rationale). The bound client returned by withTenantContext's inner
  // callback is the SAME physical connection as `tx` from withTransaction;
  // calls on `tx` inside the nested callbacks are equivalent at runtime.
  const row = await withTransaction<CrisisEventPatientSummaryRow | null>(async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      // I-025 envelope-leak defense (mirrors staff handler):
      //
      // PostgreSQL SQLSTATE 42501 ("insufficient_privilege") can be raised
      // in TWO places:
      //   (1) Inside withDbRole's SET LOCAL ROLE pre-callback step — if
      //       the role membership/grant for crisis_event_patient_reader is
      //       missing or skewed (a foundation-051 drift state).
      //   (2) Inside the view body's RLS evaluation / column-level grant
      //       checks — when the SELECT runs.
      //
      // The try/catch wraps the ENTIRE withDbRole call so both paths are
      // covered. Without this widening, a privilege-acquisition 42501 would
      // escape past an inner catch and reach the global envelope as a 500
      // with a leaky raw PG message (tenant_id disclosure in non-prod),
      // violating I-025.
      //
      // Other PG errors propagate to the global handler unchanged (tx
      // still rolls back; envelope formats as 500 with default-replaced
      // message in prod).
      const runRead = async (): Promise<CrisisEventPatientSummaryRow | null> => {
        try {
          return await withDbRole(tx, 'crisis_event_patient_reader', async () => {
            const result = await tx.query<CrisisEventPatientSummaryRow>(
              'SELECT crisis_event_id, tenant_id, patient_account_id, crisis_type, severity, ' +
                'detected_at, current_state, current_state_transition_at ' +
                'FROM crisis_event_patient_summary_v ' +
                'WHERE crisis_event_id = $1',
              [idParam],
            );
            return result.rows[0] ?? null;
          });
        } catch (err) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code?: unknown }).code === '42501'
          ) {
            throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
          }
          throw err;
        }
      };

      // actorNonce is GUARANTEED bound here — Phase 3.5 fail-closed above
      // throws 403 before tx open if it's undefined. The patient view
      // depends on the bound nonce to resolve current_actor_account_id()
      // for its self-scoping predicate, so we always wrap in
      // withActorContext.
      return withActorContext(tx, req.actorNonce!, runRead);
    });
  });

  // Phase 5 — 404 (tenant-blind) on miss.
  if (row === null) {
    // I-025 tenant-blind 404. Envelope shape is identical whether the
    // crisis_event genuinely doesn't exist, lives in another tenant, OR
    // lives in this tenant but belongs to a different patient (view's
    // self-scoping predicate filtered it out). No tenant_id, no
    // patient_id, no schema hints.
    throw req.server.httpErrors.notFound('Crisis event not found.');
  }

  return reply.code(200).send(row);
}
