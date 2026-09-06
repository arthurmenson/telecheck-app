/** Pharmacy routes. Handler wiring does not establish production readiness.
 * Patient reads use the live-identity capability from migration 087.
 * Full prescribing, fulfillment and provider acceptance remain required.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import {
  approveMedicationRequestHandler,
  clinicianDiscontinueMedicationRequestHandler,
  createDraftHandler,
  declineMedicationRequestHandler,
  discontinueMedicationRequestHandler,
  getMedicationRequestByIdHandler,
  listMedicationRequestsForPatientHandler,
  modifyMedicationRequestHandler,
  submitForReviewHandler,
  supersedeMedicationRequestHandler,
} from './internal/handlers/prescriptions.js';

export const registerPharmacyRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running). `phase` field reports the implementation milestone for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'pharmacy',
    phase: 'patient_read_capability',
    schema_ratified: true,
    schema_ratified_at: '2026-05-11',
    schema_ratified_by: 'P-011',
    read_surface_wired: true,
    read_surface_wired_at: '2026-05-13',
    read_surface_wired_by: 'TLC-055 PR C',
    patient_write_surface_wired: true,
    patient_write_surface_wired_at: '2026-05-13',
    patient_write_surface_wired_by: 'TLC-055 PR D',
    clinician_write_surface_complete: true,
    clinician_write_surface_complete_at: '2026-05-13',
    clinician_write_surface_complete_by:
      'TLC-055 PR E (draft + submit) + PR F (discontinue) + PR G (approve) + PR H (decline) + PR J (supersede) + PR K (modify)',
    i012_first_gated_activation_wired: true,
    i012_first_gated_activation_wired_by: 'TLC-055 PR G (clinician_approve)',
    engine_writeback_wired: true,
    engine_writeback_wired_at: '2026-05-13',
    engine_writeback_wired_by: 'TLC-055 PR I (service-callable; no HTTP surface at v1.0)',
    supersession_wired: true,
    supersession_wired_at: '2026-05-13',
    supersession_wired_by: 'TLC-055 PR J',
    clinician_modify_wired: true,
    clinician_modify_wired_at: '2026-05-13',
    clinician_modify_wired_by: 'TLC-055 PR K',
    handlers_wired: true,
    handlers_wired_at: '2026-05-13',
    handlers_wired_by: 'TLC-055 PR K',
    production_ready: false,
  }));

  // Full-slice readiness remains false until the actual restricted-role
  // write/fulfillment/provider journeys are verified. Patient reads stay usable.
  app.get('/ready', async (_req, reply) =>
    reply.code(503).send({
      status: 'not_ready',
      module: 'pharmacy',
      phase: 'patient_read_capability',
      production_ready: false,
      pending: ['restricted_role_write_acceptance', 'refill_and_dispensing', 'provider_acceptance'],
    }),
  );

  // Read surface (PR C). PHI-safe views; tenant-blind / cross-patient-
  // blind 404 envelopes per I-025. See handler module for the
  // authorization + error-mapping rules.
  app.get('/prescriptions/:id', getMedicationRequestByIdHandler);
  app.get('/patients/:patientId/prescriptions', listMedicationRequestsForPatientHandler);

  // Patient-origin write surface (PR D — TLC-055 PR D 2026-05-13).
  // Service-layer composition lives in
  // pharmacy/internal/services/medication-request-service.ts; the
  // handler wraps it with withIdempotentExecution for IDEMPOTENCY v5.1
  // replay semantics. Audit + domain-event emission happen inside the
  // service-layer transaction so a failure rolls back the entire patient
  // action atomically.
  //
  // ONLY patient-origin writes are exposed at PR D — patient_request_-
  // discontinue is the single transition State Machines v1.2 §19
  // permits the patient role to drive (v1.0 JWT only carries
  // role: 'patient'). Clinician-origin writes (createDraft / submit /
  // approve / decline / supersede) land in TLC-055 PR E once the
  // identity slice ships the clinician role claim.
  app.post('/prescriptions/:id/discontinue', discontinueMedicationRequestHandler);

  // Clinician-origin write surface (PR E — TLC-055 PR E 2026-05-13).
  // requireClinicianActorContext (from TLC-058 / migration 027) gates
  // these routes. v1.0 scope: createDraft + submit_for_review only —
  // neither is I-012-gated. The I-012-gated activation transitions
  // (clinician_approve, protocol_authorized_prescribing), plus
  // clinician_discontinue / supersede / clinician_modify, land in
  // subsequent pharmacy PRs (E.2/F/G).
  app.post('/prescriptions', createDraftHandler);
  app.post('/prescriptions/:id/submit', submitForReviewHandler);
  // Clinician-side discontinue (TLC-055 PR F — 2026-05-13). Companion
  // to the patient-side /:id/discontinue from PR D. Body discriminator
  // `reason` selects clinician_discontinue vs adverse_event_discontinue
  // state-machine event.
  app.post(
    '/prescriptions/:id/clinician-discontinue',
    clinicianDiscontinueMedicationRequestHandler,
  );
  // Clinician approve — first I-012-gated activation (TLC-055 PR G —
  // 2026-05-13). pending_clinician_review → active via clinician_approve.
  // The service layer threads an I012GuardClinicianOnly through
  // validateTransition; the prescribing.approved audit emission IS the
  // I-012 confirmation event for this route (workload+autonomy='n/a'
  // per AUDIT_EVENTS v5.3 clinician-only carve-out). Mode 2's
  // protocol_authorized_prescribing route is NOT exposed here; it lands
  // when the protocol engine slice ships.
  app.post('/prescriptions/:id/approve', approveMedicationRequestHandler);
  // Clinician decline (TLC-055 PR H — 2026-05-13). NOT I-012-gated; a
  // clinician's deliberate refusal is the opposite of an execution.
  // Body: { reason_code, reason_text?, recommended_action? }. Drives
  // pending_clinician_review → rejected (terminal); emits
  // prescribing.declined Category A audit.
  app.post('/prescriptions/:id/decline', declineMedicationRequestHandler);
  // Supersession (TLC-055 PR J — 2026-05-13). Activates THIS row (the
  // new replacement) AND marks the supplied old row as superseded
  // atomically. I-012-gated on the new row's clinician_approve
  // transition; migration 026's deferred CONSTRAINT TRIGGER validates
  // reciprocity at commit time.
  app.post('/prescriptions/:id/supersede', supersedeMedicationRequestHandler);
  // Clinician modify re-route (TLC-055 PR K — 2026-05-13). NOT
  // I-012-gated; clinician amends prescribing payload and the row
  // re-enters the engine evaluation queue. transitionStatus's
  // clinician_modify carve-out atomically resets
  // interaction_signals_status='pending' so the engine writeback
  // (PR I) can re-evaluate.
  app.post('/prescriptions/:id/modify', modifyMedicationRequestHandler);
};
