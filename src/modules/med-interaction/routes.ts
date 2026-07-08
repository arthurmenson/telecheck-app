/**
 * med-interaction/routes.ts — Fastify route registration (Sprint 1).
 *
 * Status at v0.2 (post-migration-070 evidence-unlock — FULL ENDPOINT
 * SURFACE MOUNTED; 6 of 8 OPERATIONAL): the PR 7 read handler
 * (GET /signals/:id), PR 8's 3 write handlers (POST /evaluations +
 * POST /signals + POST /signals/:id/activate), PR 9's supersede, and —
 * since migration 070 executed migration 050 §6's own fail-closed
 * closure prescription — POST /signals/:id/override is OPERATIONAL
 * (SI-019 §6.NEW7 STEP 3 + STEP 4 evidence checks live). POST
 * /signals/:id/{resolve, expire} remain FAIL-CLOSED at the wrapper
 * layer with precisely-narrowed deferrals (see migration 070 header +
 * the /ready reason_message). `/health` (200) + `/ready` (503 until
 * slice hardening closes) apply the canonical BLOCKED-aware
 * liveness/readiness split from pharmacy / subscription / async-consult /
 * crisis-response / admin-backend modules.
 *
 * Post-P-033/P-034 ratified + DB-layer-implemented state (2026-05-23):
 * SI-019 Slice PRD v2.0 RATIFIED P-033 + CDM v1.6 → v1.7 + AUDIT_EVENTS
 * v5.8 → v5.9 + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 + RBAC
 * v1.1 → v1.2 RATIFIED P-034 (both 2026-05-21). DB layer COMPLETE through
 * migration 070:
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
 *   - migration 070: override wrapper OPERATIONAL — executes 050 §6's
 *     closure prescription (STEP 3 medication-still-on-active-list +
 *     STEP 4 SI-010-realized LAYER B; INSERT + raw-writer call re-enabled)
 *
 * Mounted endpoint surface (PRs 7-9 + evidence-unlock; /v0/med-interaction):
 *   - GET  /signals/:id           — read via SECDEF access function
 *                                   (PR 7; migration 048 §3)
 *   - POST /evaluations           — initiate evaluation (PR 8)
 *   - POST /signals               — emit signal (PR 8)
 *   - POST /signals/:id/activate  — (PR 8)
 *   - POST /signals/:id/supersede — OPERATIONAL (PR 9; migration 050 §3)
 *   - POST /signals/:id/override  — OPERATIONAL (evidence-unlock;
 *                                   migration 070 §1; LAYER B clinician
 *                                   gate + KMS-envelope rationale)
 *   - POST /signals/:id/resolve   — FAIL-CLOSED wrapper (0A000/42501 → 503;
 *                                   deferral narrowed in migration 070)
 *   - POST /signals/:id/expire    — FAIL-CLOSED wrapper (0A000 → 503;
 *                                   deferral narrowed in migration 070)
 *   + Cat A audit emission (same-tx; savepoint-recovered COMMITTED
 *     rejection attestation on the fail-closed paths per I-003)
 *   + LAYER B role-membership: ENFORCED on override
 *     (requireClinicianActorContext); deferred-permissive on the other 7
 *     endpoints (SI-024.1 JWT-binding deferred per Option 2)
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
      'Med Interaction Engine slice hardening (Sprint 1 of N at v0.2; evidence-unlock ' +
      'PR after PR 9 of N — all 8 endpoint handlers mounted; override OPERATIONAL)',
    blocked_message:
      'Spec layer COMPLETE: SI-019 v2.0 RATIFIED 2026-05-21 P-033 + CDM v1.6 → v1.7 ' +
      '+ AUDIT_EVENTS v5.8 → v5.9 + OpenAPI v0.2 → v0.3 + State Machines v1.1 → v1.2 ' +
      '+ RBAC v1.1 → v1.2 RATIFIED P-034. DB layer COMPLETE through migration 070 ' +
      "(the evidence-unlock migration executing migration 050 §6's own fail-closed " +
      'closure prescription). Endpoint surface (PRs 7-9): GET /signals/:id (SECDEF ' +
      'access function, migration 048) + POST /evaluations + POST /signals + POST ' +
      '/signals/:id/activate + POST /signals/:id/supersede (OPERATIONAL, migration ' +
      '050 §3) + POST /signals/:id/override (OPERATIONAL since migration 070 — ' +
      'SI-019 §6.NEW7 STEP 3 medication-still-on-active-list evidence against the ' +
      'landed medication_requests chain [025/026] + STEP 4 LAYER B clinician gate ' +
      'via requireClinicianActorContext at the route layer AND SI-010 actor binding ' +
      '+ accounts.account_type=clinician at the DB layer; rationale arrives as the ' +
      'pre-encrypted 8-field KMS envelope [async-consult precedent]; two-event Cat A ' +
      'rule: interaction_signal_override + lifecycle attestation in same tx) + POST ' +
      '/signals/:id/{resolve, expire} (FAIL-CLOSED at the wrapper layer — wrappers ' +
      'RAISE SQLSTATE 0A000; deferrals narrowed in migration 070: resolve needs the ' +
      'protocol-specific washout-period config + the ' +
      'medication_interaction_resolution_subscriber role [Async Consult subscriber ' +
      'registry] + outbox event-id type reconciliation; expire needs the CCR-driven ' +
      'per-basis cadence config table; handlers map to tenant-blind 503 per I-025 ' +
      'and COMMIT the Cat A rejection attestation via savepoint recovery per I-003 ' +
      'bare-suppression-forbidden). All under the canonical withTransaction ' +
      '(via withIdempotentExecution) → withTenantContext → withActorContext → ' +
      'withDbRole(medication_interaction_engine_evaluator) composition (override ' +
      'elevates to medication_interaction_override_recorder) with same-tx audit per ' +
      'Option 2 carryforward; 42501 → tenant-blind 403 (I-025); 23514/02000 → ' +
      'tenant-blind 404; 55000 medication_not_on_list → 409. 0 endpoints remain; ' +
      'slice hardening still open (LAYER B role-membership tightening for the 7 ' +
      'non-override endpoints + evidence-source migrations for the 2 remaining ' +
      'fail-closed wrappers + broader integration pass). See ' +
      'src/modules/med-interaction/README.md + ' +
      'docs/med-interaction-implementation-plan.md.',
  }));

  // Readiness probe — all 8 endpoint handlers are wired and 6 of 8 are
  // OPERATIONAL after the migration 070 evidence-unlock pass (override
  // joined the operational set), but the slice as a whole is NOT yet
  // production-ready. /ready stays 503 (NOT the async-consult PR #254
  // 200-with-gap-inventory shape) because one remaining item is NOT
  // fail-closed: LAYER B role-membership on the 7 non-override endpoints
  // is still deferred-PERMISSIVE (any authenticated actor) per the
  // Option 2 ratifier decision — a permissive gap is a real readiness
  // blocker, unlike the 2 remaining wrappers which are spec-gated AND
  // fail closed. Returns 503 with `reason: 'slice_hardening_pending'`
  // per the Crisis-Response / Admin-Backend scaffold convention.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'unavailable',
      module: 'med-interaction',
      reason: 'slice_hardening_pending',
      reason_message:
        '8 of 8 Med Interaction Engine Fastify handlers wired; 6 of 8 OPERATIONAL ' +
        '(PR 7: GET /v0/med-interaction/signals/:id; PR 8: POST /evaluations + POST ' +
        '/signals + POST /signals/:id/activate; PR 9: POST /signals/:id/supersede; ' +
        'evidence-unlock PR: POST /signals/:id/override via migration 070 — SI-019 ' +
        '§6.NEW7 STEP 3 + STEP 4 evidence checks live, LAYER B clinician gate ' +
        'enforced at the route layer, KMS-envelope rationale required, two-event ' +
        'Cat A audit). Spec + DB layers COMPLETE through migration 070. Remaining ' +
        'hardening, precisely: (1) POST /signals/:id/resolve FAIL-CLOSED — needs ' +
        'protocol-specific washout-period configuration + the ' +
        'medication_interaction_resolution_subscriber role from the Async Consult ' +
        "domain-event subscriber registry + reconciliation of the wrapper's " +
        'VARCHAR(26) event-id parameter with the UUID domain_events_outbox.event_id ' +
        '(the discontinuation-event log itself NOW EXISTS: ' +
        'medication_request.discontinued.v1 in domain_events_outbox); (2) POST ' +
        '/signals/:id/expire FAIL-CLOSED — needs the CCR-driven per-basis cadence ' +
        'config table for the §6.NEW6 elapsed-time predicate; (3) LAYER B ' +
        'role-membership on the 7 non-override endpoints is deferred-permissive per ' +
        'Option 2 (NOT fail-closed — this item is why /ready remains 503). The ' +
        '/ready probe returns 200 once (3) closes and (1)/(2) are either unlocked ' +
        'or accepted as spec-gated fail-closed gaps per the async-consult PR #254 ' +
        'precedent. See src/modules/med-interaction/README.md for the resume path.',
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

  // PR 9 + evidence-unlock: the 4 remaining write endpoints.
  //   - supersede: OPERATIONAL (record_signal_supersession, migration 050 §3).
  //   - override:  OPERATIONAL since migration 070 (record_interaction_
  //                signal_override with SI-019 §6.NEW7 STEP 3 medication-
  //                still-on-active-list + STEP 4 SI-010-realized clinician
  //                checks; LAYER B requireClinicianActorContext at the
  //                route layer; pre-encrypted KMS-envelope rationale;
  //                two-event Cat A audit; 55000 medication_not_on_list →
  //                409, 42501 → 403, 23514/02000 → 404 per I-025).
  //   - resolve + expire: FAIL-CLOSED at the wrapper layer (RAISE 0A000
  //                per Codex R1 closure 2026-05-23; deferrals narrowed in
  //                migration 070's header — washout-period config +
  //                resolution_subscriber role + event-id reconciliation
  //                for resolve; per-basis cadence config for expire). The
  //                handlers map to tenant-blind 503 per I-025 and COMMIT
  //                the Cat A rejection attestation via savepoint recovery
  //                per I-003 bare-suppression-forbidden.
  app.post('/signals/:id/supersede', supersedeSignalHandler);
  app.post('/signals/:id/override', overrideSignalHandler);
  app.post('/signals/:id/resolve', resolveSignalHandler);
  app.post('/signals/:id/expire', expireSignalHandler);
};
