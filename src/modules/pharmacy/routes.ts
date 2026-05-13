/**
 * pharmacy/routes.ts — Fastify route registration (skeleton).
 *
 * Status at v0.2 (post-P-011 / SI-001 closure 2026-05-11): SI-001
 * (MedicationRequest schema) is RATIFIED — CDM v1.3 §4.16 + State Machines
 * v1.2 §19 + AUDIT_EVENTS v5.3 + DOMAIN_EVENTS v5.2 in-place are canonical
 * in the spec corpus (Promotion Ledger P-011; telecheckONE commit 879cd57).
 * The pharmacy scaffold (migration 025_medication_requests.sql + branded ID
 * types + I-012-gated state machine + audit emitter v5.3) landed via PR
 * #110 (commit a8c9b99). The HANDLER SURFACE — POST /prescriptions, POST
 * /refills, route-level service wiring — is the remaining gap, tracked as
 * Sprint 35-36 / TLC-055 (pharmacy slice handler implementation + repository
 * layer + repository tests + supersession reciprocity constraint trigger).
 *
 * The `/health` + `/ready` semantics below distinguish:
 *   - SCHEMA RATIFICATION (DONE 2026-05-11 via P-011) — `schema_ratified: true`.
 *   - HANDLER WIRING (PENDING TLC-055) — `handlers_wired: false`. The
 *     module's real routes (POST /prescriptions, POST /refills, etc.)
 *     remain absent so any premature wiring breaks at typecheck time
 *     rather than reaching production half-built.
 *
 * Spec references:
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md (status: RATIFIED 2026-05-11)
 *   - CDM v1.3 §4.16 MedicationRequest (in telecheckONE; commit 879cd57)
 *   - migrations/025_medication_requests.sql (this repo)
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const registerPharmacyRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running). `phase` field reports the implementation milestone for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'pharmacy',
    phase: 'schema_ratified_handlers_pending',
    schema_ratified: true,
    schema_ratified_at: '2026-05-11',
    schema_ratified_by: 'P-011',
    handlers_wired: false,
    handlers_wired_tracking: 'TLC-055',
  }));

  // Readiness probe — module is READY to serve traffic. Returns 503 while
  // the handler surface is not wired: the module is intentionally not
  // production-ready, so a Kubernetes/load-balancer readiness probe will
  // keep traffic away from this module's real routes (which don't exist
  // yet). Distinguishes liveness ("process up") from readiness
  // ("traffic-acceptable") per the canonical k8s pattern.
  //
  // When the handler surface lands (TLC-055), this returns 200 and the
  // `pending_*` fields are removed.
  app.get('/ready', async (_req, reply) => {
    return reply.code(503).send({
      status: 'not_ready',
      module: 'pharmacy',
      phase: 'schema_ratified_handlers_pending',
      pending: 'TLC-055',
      pending_message:
        'Module is not ready to serve traffic — handler surface ' +
        '(POST /prescriptions, POST /refills, etc.) is not yet wired. ' +
        'Schema is ratified per P-011 / SI-001 closure 2026-05-11 ' +
        '(migration 025_medication_requests.sql + pharmacy state-machine + ' +
        'audit emitter v5.3 landed via PR #110). Handler wiring is the ' +
        'remaining gap, tracked as Sprint 35-36 / TLC-055.',
    });
  });

  // Real routes (POST /prescriptions, POST /refills, etc.) land at TLC-055
  // when the pharmacy slice handler implementation + repository layer +
  // repository tests + supersession reciprocity constraint trigger are
  // authored. The handler surface is intentionally absent here so that
  // any premature wiring breaks at typecheck time rather than reaching
  // production half-built.
};
