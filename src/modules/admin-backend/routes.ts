/**
 * admin-backend/routes.ts — Fastify route registration.
 *
 * Status at v0.2 (Sprint 2 PR 1 — this commit): FIRST HANDLER MOUNTED.
 *
 *   - GET /dashboards/crisis-operational-health (NEW Sprint 2 PR 1)
 *     wraps the SECDEF read wrapper read_admin_crisis_operational_health
 *     from migration 044 §1. First real handler post-foundation-051
 *     (Option B app-role acquisition via lib/with-db-role.ts).
 *
 *   - /health (200) + /ready (still 503 until full Sprint 2-4 work
 *     closes — see /ready body for the remaining-blockers list).
 *
 * All routes are mounted under the spec-canonical `/v1/admin` plugin
 * prefix (admin-backend/plugin.ts), so absolute URLs are
 *   /v1/admin/health
 *   /v1/admin/ready
 *   /v1/admin/dashboards/crisis-operational-health   ← NEW
 *
 * Sprint 2+ routes still pending (NOT mounted yet; per SI-023 §5 + CDM
 * v1.10 → v1.11 Amendment §4 endpoint list, 4 of 5 endpoints remain):
 *   GET    /dashboards/consult-queue-health        (deferred per Option 2)
 *   GET    /dashboards/mode1-volume-health         (deferred per Option 2)
 *   POST   /templates/{template_id}/submit-for-review
 *   POST   /template-reviews/{review_id}/decision
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW1-NEW9 (RATIFIED 2026-05-22 P-042)
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 *   - I-027 (audit completeness on admin read + write paths — the SECDEF
 *     wrapper inserts the co-transactional admin_dashboard_query_execution
 *     row at the read path)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { getCrisisOperationalHealthHandler } from './internal/handlers/get-crisis-operational-health.js';

export const registerAdminBackendRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'admin-backend',
    blocked:
      'Admin Backend Basics handler implementation (Sprint 2 PR 1 of N at v0.2)',
    blocked_message:
      'DB layer COMPLETE through migration 044 (12 RBAC roles + 4 entities + ' +
      '2 derived views + 2 deferred + raw lifecycle writer + 2 template ' +
      'wrappers + 1 dashboard read-wrapper + 2 deferred per Option 2 carryforward). ' +
      'Foundation 051 (Option B app-role acquisition) merged. ' +
      'Sprint 2 PR 1 mounts the first real handler: GET ' +
      '/v1/admin/dashboards/crisis-operational-health (wraps ' +
      'read_admin_crisis_operational_health SECDEF). Remaining Sprint 2-N ' +
      'work: 2 template wrappers (submit + decision), Cat A audit emission ' +
      '(admin.dashboard_query_executed + 3 template events), proper LAYER B ' +
      'role-membership check (replacing the legacy admin-role shim), ' +
      'cross-tenant isolation tests. See src/modules/admin-backend/README.md.',
  }));

  // Readiness probe — module is still NOT ready to serve full traffic at
  // v0.2: 4 of 5 spec endpoints remain unmounted (2 deferred per Option 2 +
  // 2 template wrappers) AND Cat A audit emission + LAYER B role-membership
  // check are deferred. The single mounted handler (Sprint 2 PR 1's crisis
  // dashboard read) works end-to-end via the foundation-051 mechanism, but
  // the module as a whole is not ready until Sprint 4 closes the hardening
  // items. Continues returning 503 per the canonical BLOCKED-aware pattern.
  app.get('/ready', async (_request, reply) => {
    return reply.code(503).send({
      status: 'unavailable',
      module: 'admin-backend',
      reason: 'partial_handlers_mounted_full_surface_incomplete',
      reason_message:
        'Sprint 2 PR 1 mounted GET /v1/admin/dashboards/crisis-operational-health ' +
        '(first real handler post-foundation-051). 4 of 5 SI-023 §5 endpoints still ' +
        'pending: 2 template wrappers (submit + decision) + 2 deferred dashboard ' +
        'reads (consult-queue-health + mode1-volume-health; deferred per Option 2 ' +
        'until consult + Mode 1 entities land). Additionally: Cat A audit emission ' +
        '(admin.dashboard_query_executed + 3 template events) + proper LAYER B ' +
        'role-membership check (replacing the legacy admin-role shim) + cross-tenant ' +
        'isolation tests pending Sprint 4 hardening. /ready will return 200 once ' +
        'Sprint 4 closes. See src/modules/admin-backend/README.md.',
    });
  });

  // -------------------------------------------------------------------------
  // Sprint 2 PR 1 — FIRST REAL HANDLER (post-foundation-051).
  //
  // GET /v1/admin/dashboards/crisis-operational-health
  //   - Wraps read_admin_crisis_operational_health (migration 044 §1).
  //   - Composes withTransaction → withTenantContext → withActorContext →
  //     withDbRole('admin_basic_operator') → SECDEF wrapper call.
  //   - LAYER B authorization via the platform admin-role shim
  //     (lib/admin-role.ts), pending proper RBAC v1.1 wiring in Sprint 4.
  //   - I-027 read-trail row inserted co-transactionally by the wrapper
  //     into admin_dashboard_query_execution.
  //   - Cat A audit emission (admin.dashboard_query_executed) deferred to
  //     Sprint 4 hardening per task brief (READ endpoint — no Cat A/B audit
  //     emission at this PR; only template submit + decision emit audit).
  // -------------------------------------------------------------------------
  app.get(
    '/dashboards/crisis-operational-health',
    getCrisisOperationalHealthHandler,
  );
};
