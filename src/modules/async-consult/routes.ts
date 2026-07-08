/**
 * async-consult/routes.ts — Fastify route registration (legacy /v0 surface).
 *
 * Status at Sprint 10 PR 6: this file registers the Sprint-9 legacy
 * surface under `/v0/async-consult` (migration 020 `consults` tables;
 * 6 functional routes, implementation-complete) PLUS the module's
 * `/health` + `/ready` probes. The Sprint-10 canonical surface
 * (`/v1/async-consults`; P-038 entity chain, migrations 055-060) is
 * registered separately via routes-v1.ts — see plugin.ts.
 *
 * Liveness/readiness split applied a-priori per Sprint 1 Codex MEDIUM
 * finding `pharmacy-blocked-handler`. This is the 4th application of
 * the BLOCKED-aware skeleton recipe (after pharmacy / med-interaction /
 * subscription).
 *
 * Spec references:
 *   - Async Consult Slice PRD v1.0
 *   - State Machines v1.1 §3
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import {
  abandonConsultHandler,
  initiateConsultHandler,
  listConsultEventsHandler,
  patientRespondsConsultHandler,
  resumeConsultHandler,
  submitConsultHandler,
} from './internal/handlers/consults.js';

export const registerAsyncConsultRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Returns 200 always (module is
  // running), with `blocked` carried as informational metadata for
  // operator monitoring. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'async-consult',
    blocked: null,
    blocked_message:
      'Two route surfaces are mounted: the Sprint-9 legacy surface under ' +
      '/v0/async-consult (migration 020 consults tables; 6 functional routes, ' +
      'implementation-complete with HTTP integration tests) AND the Sprint-10 ' +
      'canonical surface under /v1/async-consults (P-038 entity chain; migrations ' +
      '055-065; 9 endpoints: initiate / intake / ai-preparation / queue / get / ' +
      'claim / decision / request-additional-data / follow-up-messages through ' +
      'the migration 059 SECDEF wrappers + 057 caller-class views + 064 ' +
      'ai_service_account wiring, with async_consult.* audit emission per ' +
      'AUDIT_EVENTS v5.11 and live-PostgreSQL HTTP integration coverage incl. ' +
      'the real SI-010 bind path). See src/modules/async-consult/README.md.',
  }));

  // Readiness probe — READY (200). The v1-surface hardening list that
  // held this at 503 has closed: every buildable ratified endpoint is
  // live (AI-preparation at migration 064; request-additional-data +
  // follow-up messages post-PR 250), and the live-PG integration suite
  // covers the full pilot loop over the real SI-010 bind path. The
  // remaining gaps are SPEC-GATED, not build-gated, and fail closed at
  // their boundaries:
  //   - delegate-initiated writes → 403 (Consent-slice delegate-principal
  //     binding primitive; read path DOES honor delegates per 057 §2)
  //   - intake abandon (endpoint #3) → no wrapper spec'd in P-038 §3
  //     (needs SI before the route can exist)
  //   - claim reassignment → wrapper ratified but NO HTTP endpoint
  //     ratified anywhere (needs SI)
  //   - admin caller on GET follow-up-messages → 403 (no ratified
  //     SELECT grant in 056 §7)
  //   - app-side KMS envelope encryption → standing platform-wide
  //     hardening TODO (v1-shared.ts posture; crisis precedent)
  // Per the readiness contract, "ready" means traffic-acceptable for the
  // implemented surface — spec-gated gaps that fail closed do not hold
  // the gate (pharmacy precedent).
  app.get('/ready', async (_req, reply) => {
    return reply.code(200).send({
      status: 'ready',
      module: 'async-consult',
      spec_gated_gaps: [
        'delegate_initiated_writes_403_pending_consent_primitive',
        'intake_abandon_needs_wrapper_si',
        'claim_reassignment_needs_endpoint_si',
        'follow_up_admin_read_needs_grant_si',
        'app_side_kms_envelope_encryption_todo',
      ],
    });
  });

  // Sprint 10 / TLC-021e: 6 routes for the supported transitions.
  //
  // NOT exposed at v0.1:
  //   - POST /:id/start-intake (fail-closed pending SI-006 Payment slice)
  //   - POST /:id/process     (fail-closed pending SI-007 AI Service slice)
  //
  // Both transitions exist as exported service functions so the eventual
  // upstream callers (Payment slice; AI Service slice) have stable
  // targets, but neither is reachable through HTTP at v0.1 — see Codex
  // async-consult-r9 / r10 / r11 / r12 closure rationale in
  // src/modules/async-consult/internal/services/consult-service.ts.
  app.post('/', initiateConsultHandler);
  app.post('/:id/submit', submitConsultHandler);
  app.post('/:id/abandon', abandonConsultHandler);
  app.post('/:id/resume', resumeConsultHandler);
  app.post('/:id/patient-responds', patientRespondsConsultHandler);
  app.get('/:id/events', listConsultEventsHandler);
};
