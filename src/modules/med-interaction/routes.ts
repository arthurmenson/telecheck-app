/**
 * med-interaction/routes.ts — Fastify route registration (Sprint 1 skeleton).
 *
 * Status at v0.1 (Sprint 1 — this commit): SKELETON — only `/health` (200) +
 * `/ready` (503) are mounted. Liveness/readiness split applies the canonical
 * BLOCKED-aware pattern from pharmacy / med-interaction's own prior skeleton /
 * subscription / async-consult / crisis-response / admin-backend modules.
 *
 * Post-P-033/P-034 ratified state (2026-05-21): the Med-Interaction slice
 * PRD is RATIFIED at v2.0 + CDM v1.6 → v1.7 + AUDIT_EVENTS v5.8 → v5.9 +
 * OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 + RBAC v1.1 → v1.2
 * are all RATIFIED. PR 1 (this commit) lands the 12 net-new RBAC roles
 * (migration 046). Subsequent PRs land:
 *   PR 2: 4 entities (interaction_engine_evaluation +
 *         interaction_signal + interaction_signal_override +
 *         interaction_signal_lifecycle_transition) + RLS + per-table
 *         append-only triggers
 *   PR 3: 1 SECURITY BARRIER view + 1 optional materialized view +
 *         SECURITY DEFINER access function
 *   PR 4: raw lifecycle writer SECDEF + anti-bypass EXECUTE matrix
 *   PR 5: 5 reason-specific lifecycle wrappers (emission + activation +
 *         supersession + resolution + expiry) + 1 override wrapper
 *   PR 6+: Fastify handler implementation (8 endpoints per SI-019 §5 +
 *          CDM §6 OpenAPI v0.3) + Cat A audit emission + LAYER B
 *          role-membership check + integration tests
 *
 * Spec references:
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
 *   - SI-019 Med-Interaction Engine Slice PRD v2.0 (RATIFIED 2026-05-21
 *     P-033)
 *   - CDM v1.6 → v1.7 Amendment (RATIFIED 2026-05-21 P-034)
 *   - I-002 (interaction engine runs BEFORE clinician commits
 *     medication_request)
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 *   - src/modules/med-interaction/README.md
 *   - docs/med-interaction-implementation-plan.md
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
    blocked:
      'Med Interaction Engine handler implementation (Sprint 1 of N at v0.1)',
    blocked_message:
      'Spec layer COMPLETE: SI-019 v2.0 RATIFIED 2026-05-21 P-033 + CDM v1.6 → v1.7 ' +
      '+ AUDIT_EVENTS v5.8 → v5.9 + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 ' +
      '+ RBAC v1.1 → v1.2 RATIFIED P-034. DB layer at PR 1 of ~6: migration 046 has ' +
      'shipped the 12 net-new RBAC roles (4 application + 6 wrapper-owner + 2 ' +
      'service-level-owner). Subsequent migrations land 4 entities + RLS + triggers ' +
      '(PR 2), MV + view + access function (PR 3), raw lifecycle writer (PR 4), 5 ' +
      'reason-specific lifecycle wrappers + override wrapper (PR 5), Fastify handlers ' +
      '+ Cat A audit emission + LAYER B role-membership check (PR 6+). See ' +
      'src/modules/med-interaction/README.md + docs/med-interaction-implementation-plan.md.',
  }));

  // Readiness probe — module is NOT ready to serve traffic at v0.1 because
  // entities + procedures + handlers haven't landed yet. Returns 503
  // (Service Unavailable) to advertise BLOCKED state to load-balancers +
  // deploy gates per the canonical pharmacy / med-interaction's prior
  // skeleton / subscription / async-consult / crisis-response / admin-
  // backend pattern. NOT a spec-ratification blocker — SI-019 + CDM v1.7
  // are RATIFIED — purely an implementation-not-yet-shipped reason.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'unavailable',
      module: 'med-interaction',
      reason: 'handlers_not_yet_implemented',
      reason_message:
        'Med Interaction Engine handlers (8 endpoints per SI-019 §5 + CDM §6: signal-check ' +
        '+ override-record + lifecycle-action endpoints) are not yet mounted. Spec layer ' +
        'COMPLETE; Fastify route handlers land in PR 6+. The /ready probe will return 200 ' +
        'once the full PR series (entities → views → raw writer → wrappers → handlers + ' +
        'audit emission + LAYER B role check + integration tests) closes. See ' +
        'src/modules/med-interaction/README.md for the resume path.',
    });
  });

  // Real routes (POST /signals/check, POST /overrides, GET /rulesets/:id, etc.)
  // land in PR 6+ when handler / adapter / service authoring begins. The
  // handler surface is intentionally absent here so that any premature wiring
  // breaks at typecheck time rather than reaching production half-built.
};
