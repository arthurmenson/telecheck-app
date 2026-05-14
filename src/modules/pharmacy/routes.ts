/**
 * pharmacy/routes.ts — Fastify route registration.
 *
 * Status at v0.3 (post-TLC-055 PR C 2026-05-13): the read surface is
 * wired — GET /v0/pharmacy/prescriptions/:id and
 * GET /v0/pharmacy/patients/:patientId/prescriptions are live, backed
 * by `medication-request-repo`'s `findById` and `listForPatient`. The
 * write surface (POST /prescriptions/draft, POST /:id/submit,
 * POST /:id/transitions, POST /:id/supersede) remains absent because
 * writes need a service layer to coordinate audit emission, domain
 * events, and idempotency atomically — that lands in TLC-055 PR D.
 *
 * The `/health` + `/ready` semantics distinguish:
 *   - SCHEMA RATIFICATION (DONE 2026-05-11 via P-011) — `schema_ratified: true`.
 *   - HANDLER WIRING (PARTIAL post-PR-C) — read endpoints wired
 *     (`read_surface_wired: true`); write endpoints pending TLC-055 PR D
 *     (`handlers_wired: false`).
 *
 * `/ready` continues to return 503 per the async-consult precedent
 * (Sprint 10 / TLC-021e): readiness flips to 200 only when the slice is
 * FULLY production-ready (every endpoint wired, including writes +
 * audit + domain events). A partial surface is intentionally not
 * readiness-acceptable so a Kubernetes / load-balancer probe keeps
 * traffic away from the module until the write surface lands.
 *
 * Spec references:
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md (RATIFIED 2026-05-11)
 *   - CDM v1.3 §4.16 MedicationRequest (in telecheckONE; commit 879cd57)
 *   - migrations/025_medication_requests.sql
 *   - migrations/026_medication_requests_supersession_reciprocity.sql (PR B)
 *   - src/modules/pharmacy/internal/handlers/prescriptions.ts (PR C handlers)
 *   - src/modules/async-consult/routes.ts (readiness-flip precedent)
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
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
    phase:
      'schema_ratified_read_and_write_wired_supersession_landed_clinician_modify_pending',
    schema_ratified: true,
    schema_ratified_at: '2026-05-11',
    schema_ratified_by: 'P-011',
    read_surface_wired: true,
    read_surface_wired_at: '2026-05-13',
    read_surface_wired_by: 'TLC-055 PR C',
    patient_write_surface_wired: true,
    patient_write_surface_wired_at: '2026-05-13',
    patient_write_surface_wired_by: 'TLC-055 PR D',
    clinician_write_surface_partial: true,
    clinician_write_surface_partial_at: '2026-05-13',
    clinician_write_surface_partial_by:
      'TLC-055 PR E (draft + submit) + PR F (discontinue) + PR G (approve) + PR H (decline) + PR J (supersede)',
    i012_first_gated_activation_wired: true,
    i012_first_gated_activation_wired_by: 'TLC-055 PR G (clinician_approve)',
    engine_writeback_wired: true,
    engine_writeback_wired_at: '2026-05-13',
    engine_writeback_wired_by: 'TLC-055 PR I (service-callable; no HTTP surface at v1.0)',
    supersession_wired: true,
    supersession_wired_at: '2026-05-13',
    supersession_wired_by: 'TLC-055 PR J',
    handlers_wired: false,
    handlers_wired_tracking: 'TLC-055 PR K (clinician_modify re-route)',
  }));

  // Readiness probe — module is READY to serve traffic. Returns 503
  // while the write surface is not yet wired. Per the async-consult
  // precedent (Sprint 10 / TLC-021e), readiness flips to 200 only when
  // the slice is FULLY production-ready, not when an arbitrary subset
  // of endpoints responds. A partial surface is intentionally not
  // readiness-acceptable so a Kubernetes / load-balancer probe keeps
  // traffic away until the slice can serve every documented endpoint.
  //
  // When the write surface lands (TLC-055 PR D), this returns 200 and
  // the `pending_*` fields are removed.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'not_ready',
      module: 'pharmacy',
      phase:
        'schema_ratified_read_and_write_wired_supersession_landed_clinician_modify_pending',
      pending: 'TLC-055 PR K (clinician_modify re-route)',
      pending_message:
        'Module is not yet fully ready to serve traffic — read surface (PR C), ' +
        'patient-origin write surface (PR D), clinician createDraft + submit ' +
        '(PR E), clinician_discontinue + adverse_event_discontinue (PR F), the ' +
        'first I-012-gated activation clinician_approve (PR G), ' +
        'clinician_decline (PR H), engine writeback service-callable (PR I), ' +
        'AND supersession write-path (PR J 2026-05-13) are all wired. Still ' +
        'pending TLC-055 PR K: clinician_modify — the State Machines v1.2 §19 ' +
        're-route path (pending_clinician_review → pending_interaction_check) ' +
        'a clinician uses to amend the prescribing payload and re-run the ' +
        'interaction engine without declining-then-recreating. The audit ' +
        'action prescribing.modified exists in AUDIT_EVENTS v5.3; the state ' +
        'machine accepts the transition; an HTTP handler + service-layer ' +
        'composition is the remaining gap. Mode 2 protocol_authorized_' +
        'prescribing route is intentionally NOT exposed at v1.0 — it ships ' +
        'with the protocol engine slice. Per the async-consult readiness-' +
        'flip precedent, /ready flips to 200 only when every documented ' +
        'clinician transition has a handler — clinician_modify is the last ' +
        'remaining item.',
    });
  });

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
};
