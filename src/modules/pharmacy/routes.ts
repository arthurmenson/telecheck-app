/**
 * pharmacy/routes.ts — Fastify route registration (skeleton).
 *
 * Status at v0.1: BLOCKED on SI-001. Only `/health` is mounted; every
 * other path under `/v0/pharmacy` returns the canonical 501-equivalent
 * tenant-blind error envelope when SI-001 closure adds real handlers.
 *
 * Spec references:
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const registerPharmacyRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked: 'SI-001'` carried as informational metadata
  // for operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'pharmacy',
    blocked: 'SI-001',
    blocked_message:
      'MedicationRequest schema not yet ratified in CDM v1.2 §4. ' +
      'See docs/SI-001-MedicationRequest-Schema-Gap.md.',
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
      module: 'pharmacy',
      blocked: 'SI-001',
      blocked_message:
        'Module is not ready to serve traffic — MedicationRequest schema ' +
        'not yet ratified in CDM v1.2 §4. See docs/SI-001-MedicationRequest-Schema-Gap.md.',
    });
  });

  // Real routes (POST /prescriptions, POST /refills, etc.) land when
  // SI-001 closes and the schema migrations are authored. The handler
  // surface is intentionally absent here so that any premature wiring
  // breaks at typecheck time rather than reaching production half-built.
};
