/**
 * crisis-response/routes.ts — Fastify route registration.
 *
 * Status at v0.4 (Sprint 2): the initiate write-path (PR 2), the
 * acknowledge mid-lifecycle write-path (PR 3), and the respond + resolve
 * mid-lifecycle write-paths (PR 4, this commit's merge) are all mounted
 * alongside the PR 1 staff-scoped read. The remaining Sprint 2 handlers
 * (sweep PR 6; patient-scoped read PR 5) stay parked on sibling
 * [CODEX-PENDING] branches based on `main`; their route mounts + audit
 * emitters union into this file as each lands.
 *
 * Mounted under plugin prefix `/v0/crisis-events`:
 *   GET    /health                                 — liveness (200)
 *   GET    /ready                                  — readiness (503; remaining
 *                                                    Sprint 2 endpoints not
 *                                                    yet fully mounted)
 *   POST   /                                       — initiate via SECDEF wrapper
 *                                                    record_crisis_initiation()
 *                                                    + Cat A crisis.detected
 *                                                    audit emit (same tx;
 *                                                    FLOOR-020 fail-closed)
 *                                                    (Sprint 2 PR 2)
 *   GET    /:id                                    — staff-scoped read via
 *                                                    crisis_event_current_state_v
 *                                                    (Sprint 2 PR 1)
 *   POST   /:id/acknowledge                        — clinician/care-team claim
 *                                                    via record_crisis_acknowledgement_claim
 *                                                    + Cat A crisis.acknowledged
 *                                                    audit emit (same tx;
 *                                                    FLOOR-020 fail-closed)
 *                                                    (Sprint 2 PR 3)
 *   POST   /:id/respond                            — clinician first-response via
 *                                                    record_crisis_response()
 *                                                    + Cat A crisis.responded
 *                                                    audit emit (same tx;
 *                                                    FLOOR-020 fail-closed)
 *                                                    (NEW — Sprint 2 PR 4)
 *   POST   /:id/resolve                            — clinician resolution via
 *                                                    record_crisis_resolution()
 *                                                    + Cat A crisis.resolved
 *                                                    audit emit (same tx;
 *                                                    FLOOR-020 fail-closed)
 *                                                    (NEW — Sprint 2 PR 4)
 *
 * Sprint 2 routes still parked on sibling [CODEX-PENDING] branches based on
 * `main` (full surface per SI-022):
 *   POST   /:id/sweep                              — operator-initiated sweep (PR 6)
 *   GET    /:id (patient-scoped variant)           — uses
 *                                                    crisis_event_patient_summary_v
 *                                                    + crisis_event_patient_reader
 *                                                    role (Sprint 2 PR 5)
 *
 * Spec references:
 *   - SI-022 Crisis Response Slice v1.0
 *   - docs/crisis-response-implementation-plan.md
 *   - I-019 (crisis-detection-always-on platform-floor)
 *   - I-023 (tenant scoping via foundation tenantContext plugin + view +
 *     base-table RLS)
 *   - I-025 (tenant-blind error envelopes)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { getCrisisEventHandler } from './internal/handlers/get-crisis-event.js';
import { postCrisisAcknowledgeHandler } from './internal/handlers/post-crisis-acknowledge.js';
import { postCrisisEventHandler } from './internal/handlers/post-crisis-event.js';
import { postCrisisResolveHandler } from './internal/handlers/post-crisis-resolve.js';
import { postCrisisRespondHandler } from './internal/handlers/post-crisis-respond.js';

export const registerCrisisResponseRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'crisis-response',
    blocked: 'Crisis Response slice handler implementation (Sprint 2 of 4 at v0.4)',
    blocked_message:
      'DB layer COMPLETE through migration 038 (6 tables + 2 views + 6 SECDEF + ' +
      '15 RBAC roles + 18 Codex APPROVE rounds). Sprint 2 PR 1 landed GET ' +
      '/v0/crisis-events/:id staff-scoped read; PR 2 landed POST /v0/crisis-events ' +
      'initiate via record_crisis_initiation() SECDEF wrapper + Cat A crisis.detected ' +
      'audit emission; PR 3 landed POST /v0/crisis-events/:id/acknowledge via ' +
      'record_crisis_acknowledgement_claim() + Cat A crisis.acknowledged audit emission; ' +
      'PR 4 (this commit) lands POST /v0/crisis-events/:id/respond + /:id/resolve via ' +
      'record_crisis_response() + record_crisis_resolution() + Cat A crisis.responded / ' +
      'crisis.resolved audit emission (all same tx; FLOOR-020 fail-closed). Remaining ' +
      'Sprint 2 handlers (sweep; GET patient-scoped) + KMS envelope encryption + ' +
      'integration tests land across follow-up PRs. See ' +
      'src/modules/crisis-response/README.md + docs/crisis-response-implementation-plan.md.',
  }));

  // Readiness probe — module is NOT yet fully ready to serve traffic at
  // v0.4 because the remaining write-path handler (sweep) + patient-scoped
  // read + KMS envelope haven't all landed. Returns 503 (Service
  // Unavailable) to advertise BLOCKED state to load-balancers + deploy
  // gates per the canonical pharmacy / med-interaction / subscription /
  // async-consult pattern.
  app.get('/ready', async (_request, reply) => {
    return reply.code(503).send({
      status: 'unavailable',
      module: 'crisis-response',
      reason: 'write_path_handlers_not_yet_implemented',
      reason_message:
        'Crisis Response remaining write-path handler (POST /v0/crisis-events/:id/sweep, ' +
        'parked at PR 6) + patient-scoped read (GET /v0/crisis-events/:id patient variant, ' +
        'parked at PR 5) + KMS envelope are not yet mounted. Sprint 2 PR 1 landed the ' +
        'staff-scoped read; PR 2 landed initiate; PR 3 landed acknowledge; PR 4 (this ' +
        'commit) lands respond + resolve; the /ready probe will return 200 once Sprint 4 ' +
        '(full audit emission + KMS envelope + cross-tenant tests) closes. See ' +
        'src/modules/crisis-response/README.md for the resume path.',
    });
  });

  // Sprint 2 PR 2 — initiate a crisis event (FIRST write-path handler).
  //
  // Composition: requireTenantContext → requireCrisisInitiatorActorContext
  // (SI-022 §7 slice-role gate; returns bound crisisInitiatorIdentity) →
  // body validation → resolveActorTenantIdForAudit → withIdempotentExecution
  // → withTenantContext → (withActorContext when nonce bound) → withDbRole
  // crisis_initiator → SELECT record_crisis_initiation(...) →
  // claimResourceLifecycleAuditSlot (replay-aware audit dedupe; same tx) →
  // emitCrisisDetectedAudit (only when claimed=true; FLOOR-020 fail-closed
  // Cat A; Codex R1 #201 findings 1+2 closure 2026-05-24).
  //
  // Returns 201 + { crisis_event_id } on success, 400 on body validation,
  // 403 (tenant-blind per I-025; 42501 mapped via R2 MED-1 closure pattern
  // wrapping ENTIRE withDbRole call) on privilege failure, 409 on
  // idempotency-mismatch (SQLSTATE 23505 from wrapper) or
  // Idempotency-Key body-mismatch.
  app.post('/', postCrisisEventHandler);

  // Sprint 2 PR 1 — staff-scoped single-row crisis_event read.
  //
  // Composition: requireTenantContext → requireClinicianActorContext →
  // path-param validation → withTransaction → withTenantContext →
  // (withActorContext when nonce bound) → withDbRole crisis_event_staff_reader
  // → SELECT FROM crisis_event_current_state_v.
  //
  // Returns 200 + the view's 12-column row shape on hit, 404 (tenant-blind
  // per I-025) on miss / cross-tenant.
  app.get('/:id', getCrisisEventHandler);

  // Sprint 2 PR 3 — acknowledge a detected (or escalated) crisis event.
  //
  // Composition: requireTenantContext → requireClinicianActorContext →
  // path :id validation → optional body validation →
  // resolveActorTenantIdForAudit → withIdempotentExecution →
  // withTenantContext → (withActorContext when nonce bound) → withDbRole
  // crisis_event_staff_reader (pre-fetch patient_id; 404 branch on 0 rows)
  // → withDbRole crisis_acknowledger → SELECT
  // record_crisis_acknowledgement_claim(...) → claimResourceLifecycleAuditSlot
  // (per-transition dedupe) → from_state read-back → emitCrisisAcknowledgedAudit
  // (same tx; FLOOR-020 fail-closed Cat A).
  //
  // Two allowed from-states per migration 037 §1 + State Machines v1.1 §3
  // triples #7 + #8: detected → acknowledged OR escalated → acknowledged
  // (both via clinician_acknowledgement transition reason).
  //
  // Returns 200 + { crisis_event_id, lifecycle_transition_id } on
  // success, 400 on path/body validation, 403 (tenant-blind per I-025;
  // 42501 mapped via R2 MED-1 closure) on privilege failure, 404
  // (tenant-blind) on missing / cross-tenant, 409 on wrapper SQLSTATE
  // 40001 (concurrent-claim race-loss or invalid-from-state).
  app.post('/:id/acknowledge', postCrisisAcknowledgeHandler);

  // Sprint 2 PR 4 — respond to a previously-acknowledged crisis event.
  //
  // Composition: requireTenantContext → requireClinicianActorContext →
  // path :id validation → optional body validation →
  // resolveActorTenantIdForAudit → withIdempotentExecution →
  // withTenantContext → (withActorContext when nonce bound) → withDbRole
  // crisis_event_staff_reader (pre-fetch patient_id; 404 branch on 0
  // rows) → withDbRole crisis_responder → SELECT record_crisis_response(...)
  // → emitCrisisRespondedAudit (same tx; FLOOR-020 fail-closed Cat A).
  //
  // Returns 200 + { crisis_event_id, lifecycle_transition_id } on
  // success, 400 on path/body validation, 403 (tenant-blind per I-025;
  // 42501 mapped via R2 MED-1 closure) on privilege failure, 404
  // (tenant-blind) on missing / cross-tenant, 409 on wrapper SQLSTATE
  // 40001 (race-loss or invalid-from-state).
  app.post('/:id/respond', postCrisisRespondHandler);

  // Sprint 2 PR 4 — resolve a previously-responded OR previously-escalated
  // crisis event.
  //
  // Composition: identical to /:id/respond except (a) the audit's
  // `detail.from_state` is read back AFTER the wrapper from the committed
  // crisis_event_lifecycle_transition row (responded OR escalated; NOT the
  // pre-lock pre-fetch, per Codex R1 #202), and (b) the role is
  // `crisis_resolver` + the wrapper is `record_crisis_resolution()`. Two
  // allowed from-states per migration 037 §3 + State Machines v1.1 §3
  // triples #10 + #11: responded → resolved OR escalated → resolved (both
  // via clinician_resolution transition reason).
  //
  // Returns 200 + { crisis_event_id, lifecycle_transition_id } on
  // success, 400 / 403 / 404 / 409 on mapped failures.
  app.post('/:id/resolve', postCrisisResolveHandler);
};
