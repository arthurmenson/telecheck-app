/**
 * admin-backend/internal/handlers/get-mode1-volume-health.ts —
 * Sprint 2 PR 4 deferred-wrapper handler scaffold for the Admin Backend
 * Basics slice (SI-023).
 *
 * Endpoint:
 *   GET /v1/admin/dashboards/mode1-volume-health
 *
 * What it does (v0.1 — DEFERRED DATA SOURCE):
 *   Same shape as get-consult-queue-health.ts (sibling Sprint 2 PR 4
 *   deferred scaffold). The SECDEF wrapper `read_admin_mode1_volume_health()`
 *   was DEFERRED at migration 044 §4 because the underlying view
 *   `admin_mode1_volume_health_v` is itself deferred (migration 041 §3:
 *   the Mode 1 `ai_mode1_conversation` entity + Mode 1 audit emitters are
 *   not in the code repo yet). The wrapper is NOT a stub that RAISEs
 *   `0A000`; it does NOT exist at all in the database. Calling
 *   `SELECT * FROM read_admin_mode1_volume_health($1, $2)` returns
 *   PostgreSQL SQLSTATE `42883` (undefined_function).
 *
 *   The handler implements the FULL composition pipeline mirroring
 *   `get-crisis-operational-health.ts` (Sprint 2 PR 1) so the route
 *   exists + responds with a canonical tenant-blind envelope (503),
 *   the auth gates run before the 503 (no enumeration), and ZERO
 *   handler change is required when the Mode 1 slice + matching
 *   Option-2 hygiene migration land the view + wrapper.
 *
 *   Fail-closed mapping (three PG SQLSTATEs at v0.1 → v0.2):
 *     - `42883` (undefined_function) → 503 — current v0.1 state.
 *     - `0A000` (feature_not_supported) → 503 — future stub-RAISE state.
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
 *   - CDM v1.10 → v1.11 Amendment §4.NEW8d (RATIFIED 2026-05-22 P-042)
 *   - migrations/044_admin_backend_dashboard_wrappers.sql §4 (deferral
 *     rationale — DELIBERATELY NOT CREATED at v0.1)
 *   - migrations/041_admin_backend_derived_views.sql §3 (view deferral
 *     rationale — Mode 1 entities + audit emitters missing from code
 *     repo)
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
 * Row shape returned by `read_admin_mode1_volume_health(text, jsonb)`
 * once the deferred wrapper + underlying view land per CDM §4.NEW8d.
 *
 * Field-shape rationale (forward-compatible, may be refined when the
 * hygiene migration lands): per-tenant per-hour-bucket rollup of
 * Mode 1 conversational-AI volume metrics (conversation counts,
 * average turn-latency, guardrail-trigger rate). BIGINT / NUMERIC
 * surface as JS `string` from the `pg` driver — same convention as
 * the other dashboard rows.
 *
 * Until the wrapper lands the handler never returns a row at v0.1.
 */
interface Mode1VolumeHealthRow {
  tenant_id: string;
  bucket_hour: string;
  active_conversations_count: string;
  total_turns_count: string;
  avg_turn_latency_ms: string | null;
  guardrail_trigger_count: string;
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
 * v0.1 flow (DEFERRED DATA SOURCE — fail-closed 503 at wrapper call):
 *   1. Resolve tenant context.
 *   2. LAYER B: requireAdminRole (legacy admin shim).
 *   3. Open a tx.
 *   4. Compose withTransaction → withTenantContext → withActorContext
 *      → withDbRole('admin_basic_operator') → wrapper call.
 *   5a. Wrapper EXISTS (post-hygiene): return { rows: [...] }.
 *   5b. Wrapper UNDEFINED (current v0.1, 42883) → 503.
 *   5c. Wrapper RAISES 0A000 (future stub) → 503.
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
            // Wrapper signature (once authored per CDM §4.NEW8d):
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

            // 42883 (undefined_function) — wrapper not yet created
            // (current v0.1 state per migration 044 §4).
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
