/**
 * admin-backend/internal/handlers/get-consult-queue-health.ts —
 * Sprint 2 PR 4 deferred-wrapper handler scaffold for the Admin Backend
 * Basics slice (SI-023).
 *
 * Endpoint:
 *   GET /v1/admin/dashboards/consult-queue-health
 *
 *   Plugin prefix is `/v1/admin` (admin-backend/plugin.ts §R1 MED-1
 *   closure 2026-05-22 — spec-canonical SI-023 §5 endpoint contract).
 *
 * What it does (post-migration-065 — LIVE DATA SOURCE):
 *   Originally the Sprint 2 PR 4 deferred-wrapper scaffold: the SECDEF
 *   wrapper `read_admin_consult_queue_health()` was DEFERRED at
 *   migration 044 §3 pending the P-038 consult entities. Those landed at
 *   migrations 055-061, and **migration 065 unlocked the surface** —
 *   the view (`admin_consult_queue_health_v`, CDM §4.NEW6) + wrapper
 *   (§4.NEW8c) now exist, so the wrapper call succeeds and the 42883 →
 *   503 mapping below is dead code on the happy path (kept as the
 *   fail-closed posture for environments that lag the migration).
 *
 *   The handler nonetheless implements the FULL composition pipeline
 *   (auth + tx + tenant + actor + db role + wrapper call) mirroring
 *   `get-crisis-operational-health.ts` (Sprint 2 PR 1), so that:
 *
 *     1. The route exists + responds with a canonical tenant-blind
 *        envelope (503 instead of a 404/500 surprise to callers).
 *     2. The auth + role gates are exercised before the 503 — operator
 *        probes can't enumerate the surface as "unauthorized = exists,
 *        503 = unblocked" because both yield non-success envelopes.
 *     3. When the Async Consult slice + the matching Option-2 hygiene
 *        migration land the view + wrapper (per migration 044 §3
 *        deferral note), THIS HANDLER REQUIRES NO CHANGE — the
 *        wrapper call succeeds + the 503 mapping becomes dead code
 *        for that path.
 *
 *   The fail-closed mapping covers THREE PG SQLSTATEs the wrapper
 *   call can plausibly surface at v0.1 → v0.2:
 *
 *     - `42883` (undefined_function) → 503, MEANS the wrapper hasn't
 *       been created yet (current v0.1 state per migration 044 §3).
 *     - `0A000` (feature_not_supported) → 503, MEANS a future hygiene
 *       migration created a wrapper STUB that RAISES 0A000 pending the
 *       underlying view body landing.
 *     - `42501` (insufficient_privilege) → 403, MEANS LAYER C tenant
 *       scope mismatch or role-membership gap at withDbRole elevation
 *       (mirrors get-crisis-operational-health.ts R2 MED-1 pattern).
 *
 *   Other PG errors propagate UNCHANGED — they surface as 500 via the
 *   global error envelope (5xx default-message replacement preserves
 *   tenant-blind I-025 behavior).
 *
 * What it does NOT do:
 *   - No Cat A `admin.dashboard_query_executed` AUDIT_EVENTS v5.2
 *     emission (READ endpoint scope per Sprint 2 PR 1 brief — the
 *     I-027 read-trail row is inserted by the wrapper when it lands).
 *   - No LAYER B role-membership check beyond the legacy admin-role
 *     shim (replaced by `requireSliceRoleMembership('admin_basic_operator')`
 *     in Sprint 4 hardening).
 *
 * Composability discipline (per lib/with-db-role.ts header):
 *   withTransaction → withTenantContext → withActorContext → withDbRole → fn
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041)
 *     §3.5 (dashboard read-path canonical wrapper-only discipline)
 *     §5 endpoint contract (`/v1/admin/dashboards/consult-queue-health`)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW8c (RATIFIED 2026-05-22 P-042)
 *   - migrations/044_admin_backend_dashboard_wrappers.sql §3 (deferral
 *     rationale — DELIBERATELY NOT CREATED at v0.1)
 *   - migrations/041_admin_backend_derived_views.sql §2 (view deferral
 *     rationale — Async Consult entities missing from code repo)
 *   - migrations/051_app_role_acquisition_foundation.sql §2 (slice-role
 *     membership grant for admin_basic_operator)
 *   - src/lib/with-db-role.ts (Option B SET LOCAL ROLE helper)
 *   - I-023 (three-layer tenancy: RLS + tenant-context GUC + wrapper LAYER C)
 *   - I-025 (tenant-blind errors)
 *   - I-027 (audit completeness via wrapper-level
 *     admin_dashboard_query_execution INSERT — applies once wrapper lands)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requireAdminRole } from '../../../../lib/admin-role.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

/**
 * Row shape returned by `read_admin_consult_queue_health(text, jsonb)` —
 * the RETURNS TABLE definition landed at migration 065 verbatim from CDM
 * §4.NEW6/§4.NEW8c (P-042 RATIFIED): per-(program_id, current_state)
 * rollup with independently-aggregated metrics (P-042 R3 HIGH-1
 * anti-join-multiplication design). NUMERIC / BIGINT are surfaced as JS
 * `string` by the `pg` driver — same convention as the
 * crisis-operational-health row. program_id / current_state are NULL for
 * general consults / transition-less consults respectively.
 */
interface ConsultQueueHealthRow {
  tenant_id: string;
  program_id: string | null;
  current_state: string | null;
  consult_count: string;
  avg_time_to_first_claim_seconds: string | null;
  orphan_claim_backlog_count: string;
  async_consult_audit_24h_count: string;
}

/**
 * Response envelope. Mirrors the crisis-operational-health envelope
 * shape (`{ rows: [...] }`) for API uniformity across the 3 SI-023
 * dashboard reads.
 */
export interface GetConsultQueueHealthResponse {
  rows: ConsultQueueHealthRow[];
}

/**
 * GET /v1/admin/dashboards/consult-queue-health
 *
 * v0.1 flow (DEFERRED DATA SOURCE — fail-closed 503 at wrapper call):
 *   1. Resolve tenant context (foundation tenantContextPlugin).
 *   2. LAYER B: requireAdminRole (legacy admin shim).
 *   3. Open a tx via withTransaction.
 *   4. Within the tx, compose:
 *        withTenantContext (RLS + private tenant binding)
 *        → withActorContext (SI-010 nonce GUC; only if actorNonce bound)
 *        → withDbRole admin_basic_operator (Option B elevation)
 *        → SELECT * FROM read_admin_consult_queue_health($1, $2)
 *   5a. Wrapper EXISTS (post-hygiene-migration): return { rows: [...] }.
 *   5b. Wrapper UNDEFINED (current v0.1 state, SQLSTATE 42883) → 503.
 *   5c. Wrapper RAISES 0A000 (future stub-RAISE pattern) → 503.
 *   5d. Wrapper RAISES 42501 (tenant scope mismatch / role gap) → 403.
 */
export async function getConsultQueueHealthHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<GetConsultQueueHealthResponse> {
  // Phase 1 — tenant context.
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization (admin role gate).
  // Same legacy shim as get-crisis-operational-health.ts; replaced in
  // Sprint 4 with `requireSliceRoleMembership('admin_basic_operator')`.
  requireAdminRole(req);

  // Phase 3-4 — open tx + compose context helpers in canonical order.
  // The 42501 catch wraps the ENTIRE withDbRole call per the Sprint 2
  // PR 1 R2 MED-1 pattern (SET LOCAL ROLE precedes the inner callback
  // — a role-membership gap would raise 42501 at the pre-callback
  // boundary, escaping a catch placed inside the callback).
  //
  // The 42883 + 0A000 catches are NEW to this PR 4 deferred-wrapper
  // scaffold: they map the "data source not yet available" failure
  // modes (wrapper undefined, or wrapper stub-RAISEs 0A000) to a
  // canonical 503 tenant-blind envelope.
  const rows = await withTransaction<ConsultQueueHealthRow[]>(async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      const runWrapper = async (): Promise<ConsultQueueHealthRow[]> => {
        try {
          return await withDbRole(tx, 'admin_basic_operator', async () => {
            // Wrapper signature (once authored per CDM §4.NEW8c):
            //   read_admin_consult_queue_health(p_tenant_id TEXT,
            //                                   p_query_params_jsonb JSONB)
            // Empty `{}` query params at v0.1 — same convention as the
            // crisis handler. Future iterations may surface query
            // filters from URL query string (?queue_status=waiting).
            const result = await tx.query<ConsultQueueHealthRow>(
              'SELECT * FROM read_admin_consult_queue_health($1, $2)',
              [ctx.tenantId, {}],
            );
            return result.rows;
          });
        } catch (err) {
          if (typeof err === 'object' && err !== null && 'code' in err) {
            const code = (err as { code?: unknown }).code;

            // 42883 (undefined_function) — wrapper not yet created.
            // Current v0.1 state per migration 044 §3. Future hygiene
            // migration creating the wrapper makes this mapping dead
            // code for the wrapper-EXISTS path.
            //
            // 0A000 (feature_not_supported) — wrapper exists as a stub
            // that explicitly RAISEs 0A000 pending the underlying view
            // body. Forward-compat with a possible future intermediate
            // hygiene state.
            //
            // Both → 503 tenant-blind. The httpErrors.serviceUnavailable
            // surfaces via the global error envelope as:
            //   { error: { code: 'internal.service.unavailable', ... } }
            // with `retry_after: 'PT30S'` set by ERROR_MODEL v5.1
            // defaults (error-envelope.ts §503).
            //
            // The message intentionally contains NO tenant identifiers
            // per I-025 (the wrapper-availability state is platform-
            // wide, not per-tenant, but the response is uniform either
            // way to avoid leaking deployment status as a side channel).
            if (code === '42883' || code === '0A000') {
              throw req.server.httpErrors.serviceUnavailable(
                'This dashboard is temporarily unavailable in this environment.',
              );
            }

            // 42501 (insufficient_privilege) — LAYER C tenant scope
            // mismatch from the wrapper, or role-membership gap at
            // withDbRole. Mirrors get-crisis-operational-health.ts
            // R1 HIGH-1 + R2 MED-1 closure pattern.
            if (code === '42501') {
              throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
            }
          }
          throw err;
        }
      };

      if (req.actorNonce !== undefined) {
        return withActorContext(tx, req.actorNonce, runWrapper);
      }
      return runWrapper();
    });
  });

  return { rows };
}
