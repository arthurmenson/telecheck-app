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

import { getSignalHandler } from './internal/handlers/get-signal.js';
import { postEvaluationHandler } from './internal/handlers/post-evaluation.js';

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
      'Med Interaction Engine handler implementation (Sprint 1 of N at v0.1; PR 8 of N — first write handler shipped)',
    blocked_message:
      'Spec layer COMPLETE: SI-019 v2.0 RATIFIED 2026-05-21 P-033 + CDM v1.6 → v1.7 ' +
      '+ AUDIT_EVENTS v5.8 → v5.9 + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 ' +
      '+ RBAC v1.1 → v1.2 RATIFIED P-034. DB layer COMPLETE through migration 050 ' +
      '(PRs 1-5 merged; 21 Codex rounds total): 12 RBAC roles (046) + 4 entities + RLS + ' +
      'triggers (047) + view + MV + SECDEF access function (048) + raw lifecycle writer ' +
      'SECDEF + anti-bypass matrix (049) + 6 reason-specific wrappers (050; 3 ' +
      'operational + 3 fail-closed pending evidence-source migrations). ' +
      'PR 7 shipped the first read handler (GET /v0/med-interaction/signals/:id). ' +
      'PR 8 (this commit) ships the FIRST write handler: POST /v0/med-interaction/evaluations ' +
      'INSERTing the append-only interaction_engine_evaluation row under withDbRole(' +
      'medication_interaction_engine_evaluator) + emitting the Cat A ' +
      'medication_interaction.engine_evaluation_completed audit event (AUDIT_EVENTS v5.9 / ' +
      'P-034) in the same transaction. 6 endpoints remain (POST signals + 5 signal lifecycle ' +
      'actions); they land in PRs 9+ with Cat A/B audit emission + LAYER B role-membership ' +
      'tightening. See src/modules/med-interaction/README.md + docs/med-interaction-implementation-plan.md.',
  }));

  // Readiness probe — module is partially serving traffic at PR 7 (the
  // signal-read endpoint is live) but the slice as a whole is NOT yet
  // production-ready: 7 of 8 handlers remain, the audit emission helper is
  // not wired, and Layer B role-membership authorization is still the
  // deferred-permissive shape per the Option 2 ratifier decision. Returns
  // 503 with `reason: 'partial_handlers_wired'` to keep load-balancers /
  // deploy gates from advancing the slice through production rollout
  // until the full handler set ships. This follows the canonical
  // Crisis-Response / Admin-Backend scaffold convention where /ready
  // stays 503 with an updated reason until the slice's PR series closes.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'unavailable',
      module: 'med-interaction',
      reason: 'partial_handlers_wired',
      reason_message:
        '2 of 8 Med Interaction Engine Fastify handlers wired (PR 7: ' +
        'GET /v0/med-interaction/signals/:id via SECDEF access function from ' +
        'migration 048; PR 8: POST /v0/med-interaction/evaluations INSERTing the ' +
        'append-only interaction_engine_evaluation row + emitting the Cat A ' +
        'medication_interaction.engine_evaluation_completed audit event). 6 endpoints ' +
        'remain: POST /signals + POST /signals/:id/{activate, override, resolve, expire, ' +
        'supersede}. Spec + DB layers COMPLETE through migration 050. The /ready probe ' +
        'returns 200 once the full PR series (remaining handlers + Cat A/B audit emission + ' +
        'LAYER B role-membership check + integration tests) closes. See ' +
        'src/modules/med-interaction/README.md for the resume path.',
    });
  });

  // ----- Real routes -----

  // PR 7 of N: GET /v0/med-interaction/signals/:id — single-signal
  // current-state lookup via the SECDEF access function from migration
  // 048 §3. Read-only; no audit emission (SI-019 §6 catalogs only
  // write events). See handler file-level docstring for the canonical
  // composition order + Layer B deferral rationale.
  app.get('/signals/:id', getSignalHandler);

  // PR 8 of N: POST /v0/med-interaction/evaluations — record an
  // interaction-engine evaluation (OpenAPI v0.3 endpoint #1). FIRST
  // write handler: INSERTs the strict-append-only interaction_engine_
  // evaluation row under withDbRole(medication_interaction_engine_
  // evaluator) and emits the Cat A medication_interaction.engine_
  // evaluation_completed audit event inside the same transaction
  // (I-003 durability). Establishes the canonical write composition for
  // PR 9+ signal-lifecycle handlers. See handler file-level docstring.
  app.post('/evaluations', postEvaluationHandler);

  // Remaining 6 endpoints (POST /signals, POST /signals/:id/{activate,
  // override, resolve, expire, supersede}) land in PR 9+ when signal-
  // lifecycle write-handler implementation begins. They share the same
  // withTransaction → withTenantContext → withActorContext → withDbRole
  // composition; the lifecycle variants additionally call the migration
  // 050 SECDEF wrappers and wire Cat A/B audit emission inside the same
  // DB transaction as the wrapper call (so a partial commit cannot leave
  // a wrapper effect without its audit record, per the module README's
  // Option 2 carryforward).
};
