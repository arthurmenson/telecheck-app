/**
 * med-interaction/routes.ts — Fastify route registration (skeleton).
 *
 * Status at v0.1: BLOCKED on Med Interaction Engine slice PRD
 * ratification. Only `/health` (200) + `/ready` (503) are mounted;
 * every other path under `/v0/med-interaction` will return the
 * canonical tenant-blind error envelope when the slice PRD lands
 * and real handlers are authored.
 *
 * Pharmacy `/health` + `/ready` split applied a-priori to avoid the
 * Codex MEDIUM finding from Sprint 1 (`pharmacy-blocked-handler` —
 * conflating liveness with readiness).
 *
 * Spec references:
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const registerMedInteractionRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'med-interaction',
    blocked: 'Med Interaction Engine slice ratification',
    blocked_message:
      'Med Interaction Engine slice PRD has not been ratified. Branded ID types ' +
      'are exported for downstream slice consumption; signal/override/ruleset ' +
      'row schemas + handlers + adapter abstraction land when the slice PRD is ratified. ' +
      'See src/modules/med-interaction/README.md.',
  }));

  // Readiness probe — module is READY to serve traffic. Returns 503
  // while the slice PRD is unratified: the module is intentionally not
  // production-ready, so a Kubernetes/load-balancer readiness probe
  // will keep traffic away from this module's real routes (which don't
  // exist yet). Distinguishes liveness ("process up") from readiness
  // ("traffic-acceptable") per the canonical k8s pattern.
  //
  // When the slice PRD is ratified and the real handler surface lands,
  // this returns 200 unconditionally + the blocked field is removed.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'not_ready',
      module: 'med-interaction',
      blocked: 'Med Interaction Engine slice ratification',
      blocked_message:
        'Module is not ready to serve traffic — Med Interaction Engine slice PRD ' +
        'has not been ratified. See src/modules/med-interaction/README.md.',
    });
  });

  // Real routes (POST /signals/check, POST /overrides, GET /rulesets/:id, etc.)
  // land when the slice PRD is ratified and handler/adapter authoring begins.
  // The handler surface is intentionally absent here so that any premature
  // wiring breaks at typecheck time rather than reaching production half-built.
};
