/**
 * med-interaction/routes.ts — Fastify route registration (Sprint 1).
 *
 * Status at v0.1 (post-PR-8/PR-9 merge — FULL ENDPOINT SURFACE MOUNTED):
 * all 8 SI-019 endpoint handlers are wired — the PR 7 read handler
 * (GET /signals/:id), PR 8's 3 write handlers (POST /evaluations +
 * POST /signals + POST /signals/:id/activate), and PR 9's 4 remaining
 * write handlers (POST /signals/:id/{supersede, override, resolve,
 * expire}; supersede OPERATIONAL, the other 3 FAIL-CLOSED at the wrapper
 * layer pending evidence-source migrations). `/health` (200) + `/ready`
 * (503 until slice hardening closes) apply the canonical BLOCKED-aware
 * liveness/readiness split from pharmacy / subscription / async-consult /
 * crisis-response / admin-backend modules.
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
 * Mounted endpoint surface (PRs 7-9; all under /v0/med-interaction):
 *   - GET  /signals/:id           — read via SECDEF access function
 *                                   (PR 7; migration 048 §3)
 *   - POST /evaluations           — initiate evaluation (PR 8)
 *   - POST /signals               — emit signal (PR 8)
 *   - POST /signals/:id/activate  — (PR 8)
 *   - POST /signals/:id/supersede — OPERATIONAL (PR 9; migration 050 §3)
 *   - POST /signals/:id/override  — FAIL-CLOSED wrapper (PR 9; 0A000 → 503)
 *   - POST /signals/:id/resolve   — FAIL-CLOSED wrapper (PR 9; 0A000/42501 → 503)
 *   - POST /signals/:id/expire    — FAIL-CLOSED wrapper (PR 9; 0A000 → 503)
 *   + Cat A audit emission (same-tx; audit-on-rejection for fail-closed
 *     paths per I-003 bare-suppression-forbidden)
 *   + LAYER B role-membership check deferred-permissive at route layer
 *     (SI-024.1 JWT-binding deferred per Option 2)
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

import { activateSignalHandler } from './internal/handlers/activate-signal.js';
import { createEvaluationHandler } from './internal/handlers/create-evaluation.js';
import { emitSignalHandler } from './internal/handlers/emit-signal.js';
import { expireSignalHandler } from './internal/handlers/expire-signal.js';
import { getSignalHandler } from './internal/handlers/get-signal.js';
import { overrideSignalHandler } from './internal/handlers/override-signal.js';
import { resolveSignalHandler } from './internal/handlers/resolve-signal.js';
import { supersedeSignalHandler } from './internal/handlers/supersede-signal.js';

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
      'Med Interaction Engine slice hardening (Sprint 1 of N at v0.1; PR 9 of N — all 8 endpoint handlers mounted after the PR 8 + PR 9 merge)',
    blocked_message:
      'Spec layer COMPLETE: SI-019 v2.0 RATIFIED 2026-05-21 P-033 + CDM v1.6 → v1.7 ' +
      '+ AUDIT_EVENTS v5.8 → v5.9 + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 ' +
      '+ RBAC v1.1 → v1.2 RATIFIED P-034. DB layer COMPLETE through migration 050. ' +
      'PR 7 shipped the first read handler (GET /signals/:id via SECDEF access ' +
      'function from migration 048). PR 8 shipped 3 write handlers that establish ' +
      'the Cat A audit-emission pattern for the slice: POST /evaluations ' +
      '(direct interaction_engine_evaluation INSERT + Cat A audit ' +
      'interaction_engine_evaluation_completed), POST /signals (interaction_signal ' +
      'INSERT + SECDEF wrapper record_signal_emission from migration 050 §1 + Cat A ' +
      'audit interaction_signal_emitted), POST /signals/:id/activate (SECDEF wrapper ' +
      'record_signal_activation from migration 050 §2 + Cat A audit ' +
      'interaction_signal_lifecycle_transition_emitted per Option A SI-019 ' +
      'Sub-decision 3 item 5). PR 9 (merged with PR 8 in this commit) ships the 4 ' +
      'remaining write handlers: POST /signals/:id/supersede (OPERATIONAL — SECDEF ' +
      'wrapper record_signal_supersession from migration 050 §3) + POST ' +
      '/signals/:id/{override, resolve, expire} (FAIL-CLOSED at the wrapper layer — ' +
      'wrappers RAISE SQLSTATE 0A000 pending evidence-source migrations; handlers ' +
      'map 0A000 → tenant-blind 503 per I-025 and emit Cat A audit on rejection per ' +
      'I-003 bare-suppression-forbidden). All under the canonical withTransaction ' +
      '(via withIdempotentExecution) → withTenantContext → withActorContext → ' +
      'withDbRole(medication_interaction_engine_evaluator) composition with same-tx ' +
      'audit per Option 2 carryforward; 42501 → tenant-blind 403 (I-025); 23514/02000 ' +
      '→ tenant-blind 404. 0 endpoints remain; slice hardening still open (LAYER B ' +
      'role-membership tightening + KMS-envelope wiring for override + ' +
      'evidence-source migrations for the 3 fail-closed wrappers + integration ' +
      'tests). See src/modules/med-interaction/README.md + ' +
      'docs/med-interaction-implementation-plan.md.',
  }));

  // Readiness probe — all 8 endpoint handlers are wired after the PR 8 +
  // PR 9 merge, but the slice as a whole is NOT yet production-ready:
  // 3 of the 4 PR 9 handlers sit on FAIL-CLOSED wrappers (0A000 pending
  // evidence-source migrations), LAYER B role-membership authorization is
  // still the deferred-permissive shape per the Option 2 ratifier
  // decision, and the live-PostgreSQL integration-test pass has not run.
  // Returns 503 with `reason: 'slice_hardening_pending'` to keep
  // load-balancers / deploy gates from advancing the slice through
  // production rollout until hardening closes. This follows the canonical
  // Crisis-Response / Admin-Backend scaffold convention where /ready
  // stays 503 with an updated reason until the slice's PR series closes.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'unavailable',
      module: 'med-interaction',
      reason: 'slice_hardening_pending',
      reason_message:
        '8 of 8 Med Interaction Engine Fastify handlers wired (PR 7: GET ' +
        '/v0/med-interaction/signals/:id; PR 8: POST /evaluations + POST /signals + ' +
        'POST /signals/:id/activate; PR 9: POST /signals/:id/{supersede, override, ' +
        'resolve, expire} — all under the canonical withDbRole composition with ' +
        'same-tx Cat A audit emission per Option 2 carryforward). Spec + DB layers ' +
        'COMPLETE through migration 050. Slice hardening still open: supersede is ' +
        'OPERATIONAL; override/resolve/expire are FAIL-CLOSED at the wrapper layer ' +
        '(0A000 → tenant-blind 503) pending evidence-source migrations; LAYER B ' +
        'role-membership tightening deferred-permissive per Option 2. The /ready ' +
        'probe returns 200 once hardening (evidence-source unblock + LAYER B ' +
        'tightening + integration tests) closes. ' +
        'See src/modules/med-interaction/README.md for the resume path.',
    });
  });

  // ----- Real routes -----

  // PR 7 of N: GET /v0/med-interaction/signals/:id — single-signal
  // current-state lookup via the SECDEF access function from migration
  // 048 §3. Read-only; no audit emission (SI-019 §6 catalogs only
  // write events). See handler file-level docstring for the canonical
  // composition order + Layer B deferral rationale.
  app.get('/signals/:id', getSignalHandler);

  // PR 8 of N: 3 write handlers establishing the Cat A audit emission
  // pattern for the slice. Each handler follows the canonical Option B
  // composition (withTransaction → withTenantContext → withActorContext →
  // withDbRole('medication_interaction_engine_evaluator')) + the same-tx
  // Cat A audit emission (Option 2 carryforward — audit deferred from
  // SQL wrappers to the application layer for atomicity with the wrapper
  // INSERT) + the 42501 → tenant-blind 403 mapping (I-025) inherited
  // from the PR 7 reference handler.
  //
  //   POST /evaluations          — create an interaction_engine_evaluation row;
  //                                emits `interaction_engine_evaluation_completed`.
  //                                Per SI-019 §5, NOT via a SECDEF wrapper —
  //                                the wrappers in migration 050 are scoped to
  //                                the signal-lifecycle state machine only.
  //   POST /signals              — INSERT interaction_signal row + call SECDEF
  //                                `record_signal_emission(...)` (migration 050 §1)
  //                                in same tx; emits `interaction_signal_emitted`.
  //   POST /signals/:id/activate — call SECDEF `record_signal_activation(...)`
  //                                (migration 050 §2); emits
  //                                `interaction_signal_lifecycle_transition_emitted`
  //                                (Option A add per SI-019 Sub-decision 3 item 5).
  app.post('/evaluations', createEvaluationHandler);
  app.post('/signals', emitSignalHandler);
  app.post('/signals/:id/activate', activateSignalHandler);

  // PR 9 of N: 4 remaining write endpoints (supersede + override + resolve +
  // expire). Supersede is OPERATIONAL (calls record_signal_supersession,
  // migration 050 §3). The other 3 are FAIL-CLOSED at the wrapper layer
  // (RAISE EXCEPTION SQLSTATE 0A000 per Codex R1 closure 2026-05-23
  // pending evidence-source migrations — Async Consult discontinuation-
  // event log for resolve, per-basis cadence config for expire,
  // SI-024.1 JWT-binding for override). The handler scaffolds map 0A000
  // → tenant-blind 503 per I-025 and emit Cat A audit on rejection per
  // I-003 bare-suppression-forbidden (the rejected attempt belongs in
  // the audit chain).
  app.post('/signals/:id/supersede', supersedeSignalHandler);
  app.post('/signals/:id/override', overrideSignalHandler);
  app.post('/signals/:id/resolve', resolveSignalHandler);
  app.post('/signals/:id/expire', expireSignalHandler);
};
