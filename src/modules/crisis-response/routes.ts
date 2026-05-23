/**
 * crisis-response/routes.ts — Fastify route registration (Sprint 1 skeleton).
 *
 * Status at v0.1 (Sprint 1 — this commit): SKELETON — only `/health` (200) +
 * `/ready` (503) are mounted. Liveness/readiness split applies the
 * canonical BLOCKED-aware pattern from pharmacy / med-interaction /
 * subscription / async-consult modules.
 *
 * Sprint 2-4 routes (NOT mounted yet; full surface):
 *   POST   /v0/crisis-events                      — initiate (FLOOR-020 emit)
 *   POST   /v0/crisis-events/:id/acknowledge      — clinician claim
 *   POST   /v0/crisis-events/:id/respond          — clinician first-response
 *   POST   /v0/crisis-events/:id/resolve          — clinician resolution
 *   POST   /v0/crisis-events/:id/sweep            — operator-initiated sweep
 *   GET    /v0/crisis-events/:id                  — read (staff/patient view)
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0
 *   - docs/crisis-response-implementation-plan.md
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 *   - I-019 (crisis-detection-always-on platform-floor)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const registerCrisisResponseRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked` carried as informational metadata for operator
  // monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'crisis-response',
    blocked: 'Crisis Response slice handler implementation (Sprint 1 of 4 at v0.1)',
    blocked_message:
      'DB layer COMPLETE through migration 038 (6 tables + 2 views + 6 SECDEF + ' +
      '15 RBAC roles + 18 Codex APPROVE rounds). Application-layer handlers + ' +
      'audit emission + KMS envelope encryption + integration tests land across ' +
      'Sprints 2-4. See src/modules/crisis-response/README.md + ' +
      'docs/crisis-response-implementation-plan.md.',
  }));

  // Readiness probe — module is NOT ready to serve traffic at v0.1 because
  // handler implementation hasn't landed. Returns 503 (Service Unavailable)
  // to advertise BLOCKED state to load-balancers + deploy gates per the
  // canonical pharmacy / med-interaction / subscription / async-consult
  // pattern (Sprint 1 Codex MED finding `pharmacy-blocked-handler`).
  app.get('/ready', async (_request, reply) => {
    return reply.code(503).send({
      status: 'unavailable',
      module: 'crisis-response',
      reason: 'handlers_not_yet_implemented',
      reason_message:
        'Crisis Response handlers (POST /v0/crisis-events + acknowledge/respond/resolve/sweep + GET) ' +
        'are not yet mounted. DB layer COMPLETE; Fastify route handlers land in Sprint 2+. ' +
        'The /ready probe will return 200 once Sprint 4 (full audit emission + KMS envelope + ' +
        'cross-tenant tests) closes. See src/modules/crisis-response/README.md for the resume path.',
    });
  });
};
