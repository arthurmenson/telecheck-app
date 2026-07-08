/**
 * crisis-response/routes.ts — Fastify route registration.
 *
 * Status at v1.0 (Sprint 4 COMPLETE — this commit): all 7 handlers
 * mounted — initiate (PR 2; Sprint 4 adds the optional pre-encrypted
 * intake_payload KMS envelope), acknowledge (PR 3), respond + resolve
 * (PR 4), patient-summary (PR 5 handler; Sprint 4 route-mount fix),
 * sweep (PR 6), alongside the PR 1 staff-scoped read. Sprint 4 also
 * lands the live-PG integration suite
 * (tests/integration/crisis-response-http.test.ts) and flips /ready to
 * 200 with machine-readable spec_gated_gaps.
 *
 * Mounted under plugin prefix `/v0/crisis-events`:
 *   GET    /health                                 — liveness (200)
 *   GET    /ready                                  — readiness (200 +
 *                                                    spec_gated_gaps; Sprint 4
 *                                                    hardening closed)
 *   GET    /:id/patient-summary                    — patient-scoped
 *                                                    data-minimized read via
 *                                                    crisis_event_patient_summary_v
 *                                                    (Sprint 2 PR 5; mount
 *                                                    fixed Sprint 4)
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
 *   POST   /:id/_sweep                            — operator-invoked no-acknowledgement sweep
 *                                                    via execute_crisis_no_acknowledgement_sweep
 *                                                    + Cat A crisis.no_acknowledgement_escalation
 *                                                    (Sprint 2 PR 6)
 *
 * All 7 handlers mounted (Sprint 4 verified via the live-PG suite).
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

import { getCrisisEventPatientSummaryHandler } from './internal/handlers/get-crisis-event-patient-summary.js';
import { getCrisisEventHandler } from './internal/handlers/get-crisis-event.js';
import { postCrisisAcknowledgeHandler } from './internal/handlers/post-crisis-acknowledge.js';
import { postCrisisEventHandler } from './internal/handlers/post-crisis-event.js';
import { postCrisisResolveHandler } from './internal/handlers/post-crisis-resolve.js';
import { postCrisisRespondHandler } from './internal/handlers/post-crisis-respond.js';
import { postCrisisSweepHandler } from './internal/handlers/post-crisis-sweep.js';

export const registerCrisisResponseRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'crisis-response',
    blocked: null,
    blocked_message:
      'DB layer COMPLETE through migration 038 + 053 identity re-shape (6 tables ' +
      '+ 2 views + 6 SECDEF + 15 RBAC roles + 18 Codex APPROVE rounds). ALL 7 ' +
      'endpoint handlers mounted: initiate (PR 2, Sprint 4 adds the optional ' +
      'pre-encrypted intake_payload KMS envelope pass-through per ADR-021/ADR-024), ' +
      'staff read (PR 1), acknowledge (PR 3), respond + resolve (PR 4), ' +
      'patient-summary (PR 5; route mount landed Sprint 4), sweep (PR 6). ' +
      'Sprint 4 (this commit) closes the hardening list: KMS envelope wire ' +
      'surface + live-PG cross-tenant integration suite ' +
      '(tests/integration/crisis-response-http.test.ts). See ' +
      'src/modules/crisis-response/README.md + docs/crisis-response-implementation-plan.md.',
  }));

  // Readiness probe — READY (200). The Sprint 4 hardening list that held
  // this at 503 has closed: the intake_payload KMS envelope is accepted
  // on the initiate wire surface (pre-encrypted 8-field posture per
  // ADR-021/ADR-024 — platform-standard; async-consult precedent), and
  // the live-PG integration suite covers all 7 handlers over the real
  // SI-010 bind path (happy paths + I-025 tenant-blind cross-tenant
  // denials + idempotency-replay audit dedupe + FLOOR-020 atomicity +
  // state-machine guards). The remaining gaps are SPEC-GATED, not
  // build-gated, and fail closed (or fail-conservative) at their
  // boundaries per the KNOWN_FOLLOWUPS.md waiver record:
  //   - lifecycle-audit dedupe 30-day TTL long tail → a >30-day replay
  //     through a NEW Idempotency-Key re-emits the (append-only) Cat A
  //     audit row — over-emission, never suppression; the canonical
  //     exactly-once-forever marker class is a schema artifact needing
  //     its own SI (KNOWN_FOLLOWUPS.md Followup 1)
  //   - on_call_clinician / ai_mode1_service initiator identities → 403
  //     at Layer B until the JWT-role → DB-slice-role mapping lands
  //     (Phase A successor to SI-010 / SI-024.1; KNOWN_FOLLOWUPS.md
  //     Followup 2)
  //   - crisis_sweep_scheduler JWT identity → sweep gate is the
  //     closest-available admin gate + deploy-time network ACL until
  //     the same Phase A successor lands (fails closed to
  //     patient/clinician)
  //   - app-side KMS envelope encryption → standing platform-wide
  //     hardening TODO (pre-encrypted wire posture; async-consult
  //     v1-shared.ts precedent — did not hold that module's gate)
  // Per the readiness contract, "ready" means traffic-acceptable for
  // the implemented surface — spec-gated gaps that fail closed do not
  // hold the gate (pharmacy + async-consult precedent, PR #254).
  app.get('/ready', async (_request, reply) => {
    return reply.code(200).send({
      status: 'ready',
      module: 'crisis-response',
      spec_gated_gaps: [
        'lifecycle_audit_dedupe_ttl_long_tail_needs_schema_si',
        'crisis_initiator_identity_expansion_needs_phase_a_si',
        'sweep_scheduler_jwt_identity_needs_phase_a_si',
        'app_side_kms_envelope_encryption_todo',
      ],
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

  // Sprint 2 PR 5 — patient-scoped (data-minimized) single-row read.
  //
  // Sprint 4 latent-defect fix: the PR 5 handler + its unit tests landed
  // on main WITHOUT this route mount (the import + app.get were dropped
  // in the PR 6 rebase union), while /ready + the routes docstring
  // claimed 7 mounted handlers. The live-PG integration suite now pins
  // the mount.
  //
  // Composition: requireTenantContext → requirePatientActorContext →
  // fail-closed on missing actorNonce (the patient view's self-scoping
  // predicate needs the bound actor) → path validation → withTransaction
  // → withTenantContext → withActorContext → withDbRole
  // crisis_event_patient_reader → SELECT FROM crisis_event_patient_summary_v.
  //
  // Returns 200 + the view's 8-column data-minimized row shape on hit,
  // 404 (tenant-blind per I-025) on miss / cross-tenant / other-patient.
  app.get('/:id/patient-summary', getCrisisEventPatientSummaryHandler);

  // Sprint 2 PR 6 — operator-invoked no-acknowledgement sweep.
  app.post('/:id/_sweep', postCrisisSweepHandler);
};
