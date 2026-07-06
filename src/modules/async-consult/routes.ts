/**
 * async-consult/routes.ts — Fastify route registration (legacy /v0 surface).
 *
 * Status at Sprint 10 PR 6: this file registers the Sprint-9 legacy
 * surface under `/v0/async-consult` (migration 020 `consults` tables;
 * 6 functional routes, implementation-complete) PLUS the module's
 * `/health` + `/ready` probes. The Sprint-10 canonical surface
 * (`/v1/async-consults`; P-038 entity chain, migrations 055-060) is
 * registered separately via routes-v1.ts — see plugin.ts.
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
    blocked: 'Async Consult slice hardening (Sprint 10 PR 6 — dual surface mounted)',
    blocked_message:
      'Two route surfaces are mounted: the Sprint-9 legacy surface under ' +
      '/v0/async-consult (migration 020 consults tables; 6 functional routes, ' +
      'implementation-complete with HTTP integration tests) AND the Sprint-10 ' +
      'canonical surface under /v1/async-consults (P-038 entity chain; migrations ' +
      '055-060; 6 core endpoints: initiate / intake / queue / get / claim / ' +
      'decision through the migration 059 SECDEF wrappers + migration 057 ' +
      'caller-class views, with async_consult.* audit emission per AUDIT_EVENTS ' +
      'v5.11). Slice hardening still open on the v1 surface: delegate-initiated ' +
      'flows fail closed (403), the AI-preparation + claim-reassignment wrappers ' +
      'are not yet exposed, and the live-PostgreSQL integration-test pass for the ' +
      'v1 endpoints has not run. See src/modules/async-consult/README.md.',
  }));

  // Readiness probe — module is READY to serve traffic. Returns 503
  // while v1-surface hardening is open (med-interaction /ready
  // convention: keep deploy gates from advancing the slice through
  // production rollout until the PR series closes). Distinguishes
  // liveness ("process up") from readiness ("traffic-acceptable").
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'not_ready',
      module: 'async-consult',
      blocked: 'Async Consult slice hardening (Sprint 10 PR 6 — dual surface mounted)',
      blocked_message:
        'Module is not ready to serve production traffic — the Sprint-10 ' +
        '/v1/async-consults surface (6 core endpoints on the P-038 canonical ' +
        'entity chain) landed at PR 6 but slice hardening is open: delegate ' +
        'flows fail closed, AI-preparation + claim-reassignment endpoints are ' +
        'deferred, and integration tests for the v1 surface are pending. The ' +
        'legacy /v0/async-consult surface remains implementation-complete. See ' +
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
