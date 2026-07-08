/**
 * admin-backend/internal/handlers/get-mode1-volume-health.ts —
 * Sprint 2 PR 4 deferred-wrapper handler scaffold for the Admin Backend
 * Basics slice (SI-023).
 *
 * Endpoint:
 *   GET /v1/admin/dashboards/mode1-volume-health
 *
 * What it does (post-migration-069 — LIVE DATA SOURCE):
 *   Originally the Sprint 2 PR 4 deferred-wrapper scaffold (same shape
 *   as get-consult-queue-health.ts): the SECDEF wrapper
 *   `read_admin_mode1_volume_health()` was DEFERRED at migration 044 §4
 *   because the underlying view `admin_mode1_volume_health_v` was itself
 *   deferred (migration 041 §3: the Mode 1 `ai_mode1_conversation`
 *   entity + Mode 1 audit emitters were not in the code repo). Those
 *   landed at migrations 066-068, and **migration 069 unlocked the
 *   surface** — the view (CDM §4.NEW7, Option-2 adapted) + wrapper
 *   (§4.NEW8d) now exist, so the wrapper call succeeds and the 42883 →
 *   503 mapping below is dead code on the happy path (kept as the
 *   fail-closed posture for environments that lag the migration).
 *
 *   The handler implements the FULL composition pipeline mirroring
 *   `get-crisis-operational-health.ts` (Sprint 2 PR 1); NO logic change
 *   was required at unlock time (by design — only this row-shape
 *   interface + docstrings were synced to the ratified columns).
 *
 *   Fail-closed mapping (three PG SQLSTATEs; dead code on the happy
 *   path post-069):
 *     - `42883` (undefined_function) → 503 — pre-069 environments.
 *     - `0A000` (feature_not_supported) → 503 — stub-RAISE state.
 *     - `42501` (insufficient_privilege) → 403 — LAYER C / role gap.
 *
 *   Other PG errors propagate UNCHANGED (surface as 500 via global
 *   envelope; 5xx default-message replacement preserves I-025).
 *
 * What it does NOT do:
 *   - No Cat A `admin.dashboard_query_executed` AUDIT_EVENTS v5.2
 *     emission (deferred to Sprint 4 hardening).
 *   - No LAYER B role-membership check beyond the legacy admin-role
 *     shim (deferred to Sprint 4 hardening).
 *
 * Composability discipline (per lib/with-db-role.ts header):
 *   withTransaction → withTenantContext → withActorContext → withDbRole → fn
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041)
 *     §3.5 (dashboard read-path canonical wrapper-only discipline)
 *     §5 endpoint contract (`/v1/admin/dashboards/mode1-volume-health`)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW7 + §4.NEW8d (RATIFIED
 *     2026-05-22 P-042)
 *   - migrations/069_admin_mode1_volume_health_unlock.sql (the Option-2
 *     hygiene migration that landed the view + wrapper, incl. the
 *     action-ID + ended_at→archival adaptations)
 *   - migrations/044_admin_backend_dashboard_wrappers.sql §4 +
 *     migrations/041_admin_backend_derived_views.sql §3 (the executed
 *     deferral prescriptions)
 *   - migrations/051_app_role_acquisition_foundation.sql §2 (slice-role
 *     membership grant for admin_basic_operator)
 *   - src/lib/with-db-role.ts (Option B SET LOCAL ROLE helper)
 *   - I-023, I-025, I-027
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requireAdminRole } from '../../../../lib/admin-role.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';

/**
 * Row shape returned by `read_admin_mode1_volume_health(text, jsonb)` —
 * the RETURNS TABLE definition landed at migration 069 per CDM
 * §4.NEW7/§4.NEW8d (P-042 RATIFIED; post-migration-069 LIVE): one
 * per-tenant last-24h aggregate row (SI-023 Surface 3 contract —
 * conversation volume + the two Cat-A-equivalent safety counts + p50/p95
 * conversation-duration percentiles). BIGINT / NUMERIC surface as JS
 * `string` from the `pg` driver — same convention as the other dashboard
 * rows. The duration percentiles are NULL when no conversation was
 * archived in the window (069 ended_at→archival adaptation: durations
 * derive from ai_mode1_conversation_archival_event.archived_at).
 */
interface Mode1VolumeHealthRow {
  tenant_id: string;
  active_conversation_count_24h: string;
  crisis_detection_trigger_count_24h: string;
  safety_floor_response_emitted_count_24h: string;
  conversation_duration_p50_seconds_24h: string | null;
  conversation_duration_p95_seconds_24h: string | null;
}

/**
 * Response envelope. Mirrors the crisis-operational-health envelope
 * shape (`{ rows: [...] }`) for API uniformity across the 3 SI-023
 * dashboard reads.
 */
export interface GetMode1VolumeHealthResponse {
  rows: Mode1VolumeHealthRow[];
}

/**
 * GET /v1/admin/dashboards/mode1-volume-health
 *
 * Flow (post-migration-069 — LIVE DATA SOURCE):
 *   1. Resolve tenant context.
 *   2. LAYER B: requireAdminRole (legacy admin shim).
 *   3. Open a tx.
 *   4. Compose withTransaction → withTenantContext → withActorContext
 *      → withDbRole('admin_basic_operator') → wrapper call.
 *   5a. Wrapper EXISTS (post-069 happy path): return { rows: [...] }.
 *   5b. Wrapper UNDEFINED (pre-069 environment, 42883) → 503.
 *   5c. Wrapper RAISES 0A000 (stub state) → 503.
 *   5d. Wrapper RAISES 42501 → 403.
 */
export async function getMode1VolumeHealthHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<GetMode1VolumeHealthResponse> {
  // Phase 1 — tenant context.
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization (admin role gate).
  requireAdminRole(req);

  // Phase 3-4 — open tx + compose context helpers in canonical order.
  // Catch wraps the ENTIRE withDbRole call per Sprint 2 PR 1 R2 MED-1
  // pattern (role-membership gap could raise 42501 at SET LOCAL ROLE
  // before the inner callback runs; catch placed inside the callback
  // would miss it).
  const rows = await withTransaction<Mode1VolumeHealthRow[]>(async (tx) => {
    return withTenantContext(tx, ctx.tenantId, async () => {
      const runWrapper = async (): Promise<Mode1VolumeHealthRow[]> => {
        try {
          return await withDbRole(tx, 'admin_basic_operator', async () => {
            // Wrapper signature (migration 069 per CDM §4.NEW8d):
            //   read_admin_mode1_volume_health(p_tenant_id TEXT,
            //                                  p_query_params_jsonb JSONB)
            // Empty `{}` query params at v0.1.
            const result = await tx.query<Mode1VolumeHealthRow>(
              'SELECT * FROM read_admin_mode1_volume_health($1, $2)',
              [ctx.tenantId, {}],
            );
            return result.rows;
          });
        } catch (err) {
          if (typeof err === 'object' && err !== null && 'code' in err) {
            const code = (err as { code?: unknown }).code;

            // 42883 (undefined_function) — wrapper not created in this
            // environment (pre-migration-069 state per 044 §4 deferral).
            // 0A000 (feature_not_supported) — future stub-RAISE state.
            // Both → 503 tenant-blind. Tenant-uniform message (no
            // tenant ids; wrapper-availability is platform-wide).
            if (code === '42883' || code === '0A000') {
              throw req.server.httpErrors.serviceUnavailable(
                'This dashboard is temporarily unavailable in this environment.',
              );
            }

            // 42501 (insufficient_privilege) — LAYER C / role gap.
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
