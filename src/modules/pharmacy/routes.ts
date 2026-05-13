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
  discontinueMedicationRequestHandler,
  getMedicationRequestByIdHandler,
  listMedicationRequestsForPatientHandler,
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
    phase: 'schema_ratified_read_surface_wired_patient_write_wired_clinician_writes_pending',
    schema_ratified: true,
    schema_ratified_at: '2026-05-11',
    schema_ratified_by: 'P-011',
    read_surface_wired: true,
    read_surface_wired_at: '2026-05-13',
    read_surface_wired_by: 'TLC-055 PR C',
    patient_write_surface_wired: true,
    patient_write_surface_wired_at: '2026-05-13',
    patient_write_surface_wired_by: 'TLC-055 PR D',
    handlers_wired: false,
    handlers_wired_tracking: 'TLC-055 PR E (clinician role + clinician writes)',
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
      phase: 'schema_ratified_read_surface_wired_patient_write_wired_clinician_writes_pending',
      pending: 'TLC-055 PR E (clinician role + clinician writes)',
      pending_message:
        'Module is not yet fully ready to serve traffic — read surface is wired ' +
        '(GET /prescriptions/:id, GET /patients/:patientId/prescriptions, PR C) ' +
        'AND the patient-origin write surface is wired (POST /prescriptions/:id/' +
        'discontinue with patient_request_discontinue, PR D 2026-05-13), but the ' +
        'clinician-origin write surface (POST /prescriptions/draft, POST /:id/' +
        'submit, POST /:id/approve, POST /:id/decline, POST /:id/supersede) is ' +
        'pending TLC-055 PR E — the v1.0 JWT only carries role: patient, so the ' +
        'clinician write handlers wait for the identity slice to ship the ' +
        'clinician role claim. Schema is ratified per P-011 / SI-001 closure ' +
        '2026-05-11; supersession reciprocity trigger landed PR #115. Per the ' +
        'async-consult readiness-flip precedent, /ready flips to 200 only when ' +
        'the slice is fully production-ready (every endpoint wired).',
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
};
