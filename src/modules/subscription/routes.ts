/**
 * subscription/routes.ts — Fastify route registration (skeleton).
 *
 * Status at v0.1: BLOCKED on SI-001. Only `/health` (200) + `/ready` (503)
 * are mounted; every other path under `/v0/subscription` will return the
 * canonical tenant-blind error envelope when SI-001 closure adds real
 * handlers.
 *
 * Pharmacy `/health` + `/ready` split applied a-priori (3rd application
 * of the BLOCKED-aware skeleton recipe; Sprint 1 Codex MEDIUM finding
 * `pharmacy-blocked-handler` is now the standing rule).
 *
 * Spec references:
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const registerSubscriptionRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked: 'SI-001'` carried as informational metadata
  // for operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'subscription',
    blocked: 'SI-001',
    blocked_message:
      'Subscription depends on MedicationRequest schema (CDM v1.2 §4) which ' +
      'has not been ratified. See docs/SI-001-MedicationRequest-Schema-Gap.md.',
  }));

  // Readiness probe — module is READY to serve traffic. Returns 503
  // while SI-001 is open: the module is intentionally not production-
  // ready, so a Kubernetes/load-balancer readiness probe will keep
  // traffic away from this module's real routes (which don't exist
  // yet). Distinguishes liveness ("process up") from readiness
  // ("traffic-acceptable") per the canonical k8s pattern.
  //
  // When SI-001 closes and the real handler surface lands, this returns
  // 200 unconditionally + the blocked field is removed.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'not_ready',
      module: 'subscription',
      blocked: 'SI-001',
      blocked_message:
        'Module is not ready to serve traffic — Subscription depends on ' +
        'MedicationRequest schema (SI-001 not yet closed). See ' +
        'docs/SI-001-MedicationRequest-Schema-Gap.md.',
    });
  });

  // Real routes (POST /subscriptions, PATCH /subscriptions/:id/pause,
  // /resume, /cancel, /switch) land when SI-001 closes and the schema
  // migrations + state machine are authored. The handler surface is
  // intentionally absent here so that any premature wiring breaks at
  // typecheck time rather than reaching production half-built.
};
