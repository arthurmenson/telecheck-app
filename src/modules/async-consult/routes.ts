/**
 * async-consult/routes.ts — Fastify route registration (skeleton).
 *
 * Status at v0.1 (Sprint 8): SKELETON — Sprint 1 of 3 for this slice.
 * Only `/health` (200) + `/ready` (503) are mounted; every other path
 * under `/v0/async-consult` will land in Sprints 9-10:
 *   - Sprint 9: POST /v0/async-consult (initiate), POST /v0/async-consult/:id/submit,
 *     POST /v0/async-consult/:id/abandon, GET /v0/async-consult/:id (read)
 *   - Sprint 10: clinician decision endpoints (claim / prescribe / advise /
 *     request-data / escalate-sync / decline / refer), patient response,
 *     follow-up messaging
 *
 * Liveness/readiness split applied a-priori per Sprint 1 Codex MEDIUM
 * finding `pharmacy-blocked-handler`. This is the 4th application of
 * the BLOCKED-aware skeleton recipe (after pharmacy / med-interaction /
 * subscription).
 *
 * Spec references:
 *   - Async Consult Slice PRD v1.0
 *   - State Machines v1.1 §3
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import {
  abandonConsultHandler,
  initiateConsultHandler,
  listConsultEventsHandler,
  patientRespondsConsultHandler,
  resumeConsultHandler,
  submitConsultHandler,
} from './internal/handlers/consults.js';

export const registerAsyncConsultRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'async-consult',
    blocked: 'Async Consult slice authoring (Sprint 1 of 3 at v0.1)',
    blocked_message:
      'Async Consult slice is in skeleton state — only branded ID types + ' +
      'state vocabulary are exported at v0.1. Repos / service layer / ' +
      'state-machine transitions / HTTP handlers land across Sprints 9-10. ' +
      'See src/modules/async-consult/README.md.',
  }));

  // Readiness probe — module is READY to serve traffic. Returns 503
  // while the slice is in skeleton state: the module is intentionally
  // not production-ready (no real handlers yet), so a Kubernetes/load-
  // balancer readiness probe will keep traffic away. Distinguishes
  // liveness ("process up") from readiness ("traffic-acceptable").
  //
  // When Sprint 10 lands the full HTTP integration + audit emitters,
  // this returns 200 unconditionally + the blocked field is removed.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'not_ready',
      module: 'async-consult',
      blocked: 'Async Consult slice authoring (Sprint 1 of 3 at v0.1)',
      blocked_message:
        'Module is not ready to serve traffic — Async Consult slice is in ' +
        'skeleton state. Sprint 9 + 10 add the handler surface. See ' +
        'src/modules/async-consult/README.md.',
    });
  });

  // Sprint 10 / TLC-021e: 6 routes for the supported transitions.
  //
  // NOT exposed at v0.1:
  //   - POST /:id/start-intake (fail-closed pending SI-006 Payment slice)
  //   - POST /:id/process     (fail-closed pending SI-007 AI Service slice)
  //
  // Both transitions exist as exported service functions so the eventual
  // upstream callers (Payment slice; AI Service slice) have stable
  // targets, but neither is reachable through HTTP at v0.1 — see Codex
  // async-consult-r9 / r10 / r11 / r12 closure rationale in
  // src/modules/async-consult/internal/services/consult-service.ts.
  app.post('/', initiateConsultHandler);
  app.post('/:id/submit', submitConsultHandler);
  app.post('/:id/abandon', abandonConsultHandler);
  app.post('/:id/resume', resumeConsultHandler);
  app.post('/:id/patient-responds', patientRespondsConsultHandler);
  app.get('/:id/events', listConsultEventsHandler);
};
