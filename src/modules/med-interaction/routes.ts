/**
 * med-interaction/routes.ts — Fastify route registration (Sprint 1 skeleton).
 *
 * Status at v0.1 (post-PR-1-5 DB-layer COMPLETE; this commit = PR 6 of 6
 * for the Med-Interaction DB-layer series): SKELETON — only `/health`
 * (200) + `/ready` (503) are mounted. Liveness/readiness split applies
 * the canonical BLOCKED-aware pattern from pharmacy / med-interaction's
 * own prior skeleton / subscription / async-consult / crisis-response /
 * admin-backend modules.
 *
 * Post-P-033/P-034 ratified + DB-layer-implemented state (2026-05-23):
 * SI-019 Slice PRD v2.0 RATIFIED P-033 + CDM v1.6 → v1.7 + AUDIT_EVENTS
 * v5.8 → v5.9 + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 + RBAC
 * v1.1 → v1.2 RATIFIED P-034 (both 2026-05-21). DB layer COMPLETE through
 * migration 050:
 *   - migration 046: 12 net-new RBAC roles (4 application + 6 wrapper-
 *     owner + 2 service-level-owner)
 *   - migration 047: 4 entities (interaction_engine_evaluation +
 *     interaction_signal + interaction_signal_override +
 *     interaction_signal_lifecycle_transition) + RLS + per-table append-
 *     only triggers + server-assigned monotonic-ordering trigger with
 *     state-continuity check + caller-tenant guard (7 Codex rounds)
 *   - migration 048: 1 SECURITY BARRIER view + 1 optional MV + SECDEF
 *     access function + MV access-discipline (preflight + immediate
 *     REVOKE + aclexplode loop + final verifier; 5 Codex rounds)
 *   - migration 049: raw lifecycle writer SECDEF + anti-bypass EXECUTE
 *     matrix (6 wrapper-owners) + STEP 3.5 advisory-locked activation-
 *     override-evidence check (3 Codex rounds)
 *   - migration 050: 6 reason-specific wrappers (3 operational: emission
 *     + activation + supersession; 3 fail-closed: resolution + expiry +
 *     override pending evidence-source migrations) (3 Codex rounds)
 *
 * Subsequent PRs (PR 7+) land Fastify handler implementation:
 *   - POST /v1/med-interaction/evaluations         — initiate evaluation
 *   - POST /v1/med-interaction/signals             — emit signal
 *   - POST /v1/med-interaction/signals/:id/activate
 *   - POST /v1/med-interaction/signals/:id/override
 *   - POST /v1/med-interaction/signals/:id/resolve  (gated; fail-closed
 *                                                    wrapper in 050)
 *   - POST /v1/med-interaction/signals/:id/expire   (gated; fail-closed)
 *   - POST /v1/med-interaction/signals/:id/supersede
 *   - GET  /v1/med-interaction/signals/:id          — read via SECDEF
 *                                                    access function or
 *                                                    SECURITY BARRIER view
 *   + Cat A audit emission (6 audit events under medication_interaction.*)
 *   + LAYER B role-membership check at route layer (SI-024.1 JWT-binding
 *     deferred per Option 2)
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

import { getSignalCurrentStateHandler } from './internal/handlers/signals.js';

export const registerMedInteractionRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'med-interaction',
    blocked: 'Med Interaction Engine handler implementation (Sprint 1 of N at v0.1)',
    blocked_message:
      'Spec layer COMPLETE: SI-019 v2.0 RATIFIED 2026-05-21 P-033 + CDM v1.6 → v1.7 ' +
      '+ AUDIT_EVENTS v5.8 → v5.9 + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 ' +
      '+ RBAC v1.1 → v1.2 RATIFIED P-034. DB layer COMPLETE through migration 050 ' +
      '(PRs 1-5 merged; 21 Codex rounds total): 12 RBAC roles (046) + 4 entities + RLS + ' +
      'triggers (047) + view + MV + SECDEF access function (048) + raw lifecycle writer ' +
      'SECDEF + anti-bypass matrix (049) + 6 reason-specific wrappers (050; 3 ' +
      'operational + 3 fail-closed pending evidence-source migrations). Subsequent ' +
      'PRs land Fastify handlers + Cat A audit emission + LAYER B role-membership ' +
      'check. See src/modules/med-interaction/README.md + ' +
      'docs/med-interaction-implementation-plan.md.',
  }));

  // Readiness probe — module is NOT ready to serve traffic at v0.1 because
  // Fastify handlers haven't landed yet (DB layer is complete; only the
  // HTTP surface is pending). Returns 503 (Service Unavailable) to
  // advertise BLOCKED state to load-balancers + deploy gates per the
  // canonical pharmacy / med-interaction's prior skeleton / subscription
  // / async-consult / crisis-response / admin-backend pattern.
  //
  // NOT a spec-ratification blocker — SI-019 + CDM v1.7 are RATIFIED.
  // NOT a DB-layer blocker — migrations 046-050 are merged. Purely a
  // Fastify-route-handler-not-yet-mounted reason. The /ready probe
  // returns 200 when PR 7+ ships the route handlers + Cat A audit
  // emission + LAYER B role-membership check + integration tests.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'unavailable',
      module: 'med-interaction',
      reason: 'handlers_not_yet_implemented',
      reason_message:
        'Med Interaction Engine Fastify handlers (8 endpoints per SI-019 §5 + CDM §6: ' +
        'evaluation initiation + signal lifecycle actions + signal read) are not yet ' +
        'mounted. Spec layer COMPLETE; DB layer COMPLETE through migration 050; ' +
        'Fastify route handlers land in PR 7+. The /ready probe will return 200 once ' +
        'the full PR series (Fastify handlers + Cat A audit emission + LAYER B role ' +
        'check + integration tests) closes. See src/modules/med-interaction/README.md ' +
        'for the resume path.',
    });
  });

  // PR 7 — first handler of the series: the lowest-risk read endpoint
  // (cockpit Addendum 81). GET /v0/med-interaction/signals/:id returns the
  // current-state projection via the SECDEF access function from migration
  // 048, gated at the route layer (LAYER B) to signal_viewer-entitled roles
  // and elevated into the `medication_interaction_signal_viewer` slice role
  // via withDbRole (Option B app-role acquisition; migration 051). Pure
  // read: NO Cat A audit emission (SI-019 §6 audit catalog has no read
  // event). Mounted relative to the plugin prefix `/v0/med-interaction`.
  app.get('/signals/:id', getSignalCurrentStateHandler);

  // Remaining write/lifecycle routes (POST .../evaluations, POST .../signals,
  // POST .../signals/:id/activate | override | resolve | expire | supersede)
  // land in PR 8+ together with their Cat A audit emission + the SECDEF
  // lifecycle wrappers from migrations 049/050. They are intentionally
  // absent here so that any premature wiring breaks at typecheck time
  // rather than reaching production half-built. The /ready probe above
  // continues to advertise 503 until the full surface + its live-DB
  // integration tests close.
};
