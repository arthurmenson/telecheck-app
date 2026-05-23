/**
 * admin-backend/routes.ts — Fastify route registration (Sprint 1 skeleton).
 *
 * Status at v0.1 (Sprint 1 — this commit): SKELETON — only `/health` (200) +
 * `/ready` (503) are mounted (under the spec-canonical `/v1/admin` plugin
 * prefix, so the absolute URLs are `/v1/admin/health` + `/v1/admin/ready`).
 * Liveness/readiness split applies the canonical BLOCKED-aware pattern
 * from pharmacy / med-interaction / subscription / async-consult /
 * crisis-response modules.
 *
 * Sprint 2+ routes (NOT mounted yet; per SI-023 §5 + CDM v1.10 → v1.11
 * Amendment §4 endpoint list, 5 endpoints total under the SAME `/v1/admin`
 * prefix — paths below are relative to the plugin's prefix):
 *   GET    /dashboards/crisis-operational-health
 *   GET    /dashboards/consult-queue-health        (deferred per Option 2)
 *   GET    /dashboards/mode1-volume-health         (deferred per Option 2)
 *   POST   /templates/{template_id}/submit-for-review
 *   POST   /template-reviews/{review_id}/decision
 *
 * Absolute URLs visible to clients:
 *   /v1/admin/dashboards/crisis-operational-health
 *   /v1/admin/templates/{template_id}/submit-for-review
 *   /v1/admin/template-reviews/{review_id}/decision
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW1-NEW9 (RATIFIED 2026-05-22 P-042)
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 *   - I-027 (audit completeness on admin read + write paths)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

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
      'Admin Backend Basics handler implementation (Sprint 1 of N at v0.1)',
    blocked_message:
      'DB layer COMPLETE through migration 044 (12 RBAC roles + 4 entities + ' +
      '2 derived views + 2 deferred + raw lifecycle writer + 2 template ' +
      'wrappers + 1 dashboard read-wrapper + 2 deferred per Option 2 carryforward; ' +
      '5 of 6 PR-series rounds shipped Codex APPROVE: PR 1 RBAC+entities, ' +
      'PR 2 derived views, PR 3 raw lifecycle writer, PR 4 template wrappers, ' +
      'PR 5 dashboard read-wrappers). Application-layer Fastify handlers + ' +
      'Cat A audit emission (admin.dashboard_query_executed + ' +
      'admin.template_submitted_for_review + admin.template_review_decision + ' +
      'admin.template_published_via_review_workflow) + LAYER B role-membership ' +
      'authorization land in Sprint 2+. See src/modules/admin-backend/README.md.',
  }));

  // Readiness probe — module is NOT ready to serve traffic at v0.1 because
  // handler implementation hasn't landed. Returns 503 (Service Unavailable)
  // to advertise BLOCKED state to load-balancers + deploy gates per the
  // canonical pharmacy / med-interaction / subscription / async-consult /
  // crisis-response pattern.
  app.get('/ready', async (_request, reply) => {
    return reply.code(503).send({
      status: 'unavailable',
      module: 'admin-backend',
      reason: 'handlers_not_yet_implemented',
      reason_message:
        'Admin Backend handlers (5 endpoints per SI-023 §5: 3 dashboard reads + ' +
        '2 template wrappers) are not yet mounted. DB layer COMPLETE; Fastify ' +
        'route handlers land in Sprint 2+. The /ready probe will return 200 ' +
        'once Sprint 4 (full audit emission + LAYER B role check + cross-tenant ' +
        'tests) closes. Note: 2 of the 3 dashboard endpoints are DEFERRED per ' +
        'Option 2 (consult + Mode 1 dashboards need their entities to land ' +
        'first). See src/modules/admin-backend/README.md for the resume path.',
    });
  });
};
