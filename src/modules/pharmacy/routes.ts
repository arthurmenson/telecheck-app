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
    phase: 'schema_ratified_read_surface_wired_writes_pending',
    schema_ratified: true,
    schema_ratified_at: '2026-05-11',
    schema_ratified_by: 'P-011',
    read_surface_wired: true,
    read_surface_wired_at: '2026-05-13',
    read_surface_wired_by: 'TLC-055 PR C',
    handlers_wired: false,
    handlers_wired_tracking: 'TLC-055 PR D',
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
      phase: 'schema_ratified_read_surface_wired_writes_pending',
      pending: 'TLC-055 PR D',
      pending_message:
        'Module is not yet fully ready to serve traffic — read surface is wired ' +
        '(GET /prescriptions/:id, GET /patients/:patientId/prescriptions) but the ' +
        'write surface (POST /prescriptions/draft, POST /:id/submit, ' +
        'POST /:id/transitions, POST /:id/supersede) is pending TLC-055 PR D. ' +
        'Schema is ratified per P-011 / SI-001 closure 2026-05-11; the supersession ' +
        'reciprocity constraint trigger landed at PR #115 (TLC-055 PR B). Per the ' +
        'async-consult readiness-flip precedent, /ready flips to 200 only when ' +
        'the slice is fully production-ready (every endpoint wired, including ' +
        'audit emission + domain events + idempotency on the write path).',
    });
  });

  // Read surface (PR C). PHI-safe views; tenant-blind / cross-patient-
  // blind 404 envelopes per I-025. See handler module for the
  // authorization + error-mapping rules.
  app.get('/prescriptions/:id', getMedicationRequestByIdHandler);
  app.get('/patients/:patientId/prescriptions', listMedicationRequestsForPatientHandler);

  // Write surface (POST /prescriptions/draft, POST /:id/submit,
  // POST /:id/transitions, POST /:id/supersede) lands at TLC-055 PR D
  // when the service-layer abstraction is authored — service-layer
  // composition of audit emission + domain events + idempotency is the
  // gap that distinguishes a real write surface from a thin wrapper
  // over the repo. PR D's scope: pharmacy/internal/services/, error
  // classes, idempotency wiring, audit + domain-event emission per
  // AUDIT_EVENTS v5.3 + DOMAIN_EVENTS v5.2.
};
