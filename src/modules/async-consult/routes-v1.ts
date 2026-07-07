/**
 * async-consult/routes-v1.ts — Fastify route registration for the
 * Sprint 10 PR 6 /v1/async-consults surface (P-038 canonical entity
 * chain; migrations 055-060).
 *
 * Mounted ALONGSIDE the Sprint-9 legacy surface (routes.ts under
 * /v0/async-consult against the migration 020 `consults` tables) —
 * plugin.ts registers both. The legacy surface is unchanged; migration
 * of its callers onto this surface is a follow-on workstream.
 *
 * Six core endpoints per OpenAPI v0.4 (Sprint 10 PR 6 scope):
 *
 *   POST /v1/async-consults                      — initiate (patient principal;
 *                                                  record_consult_initiation;
 *                                                  Cat C async_consult.initiated)
 *   POST /v1/async-consults/:consult_id/intake   — intake submission
 *                                                  (record_consult_intake_submission;
 *                                                  pre-encrypted KMS envelope;
 *                                                  Cat C async_consult.intake_submitted)
 *   GET  /v1/async-consults/queue                — staff review queue
 *                                                  (async_consult_staff_summary_v;
 *                                                  paginated; staff callers only)
 *   GET  /v1/async-consults/:consult_id          — caller-class-routed read
 *                                                  (patient/delegate → patient view;
 *                                                  staff → staff view; tenant-blind 404)
 *   POST /v1/async-consults/:consult_id/claim    — clinician claim
 *                                                  (claim_consult_for_review;
 *                                                  55006 → 409 claim_already_held;
 *                                                  Cat B auto-release + Cat C claimed)
 *   POST /v1/async-consults/:consult_id/decision — clinician decision
 *                                                  (record_consult_clinician_decision;
 *                                                  Cat A decision_recorded
 *                                                  [+ prescribing_recorded / rationale
 *                                                  disagreement per decision shape])
 *
 * Added post-PR 6:
 *   POST /v1/async-consults/:consult_id/ai-preparation — AI-service
 *     caller class records a completed case preparation
 *     (record_consult_ai_preparation_completed; migration 064 wires the
 *     ai_service_account slice role + closes the 059 §3 deferred grant;
 *     Cat C async_consult.ai_preparation_started + _completed).
 *
 * NOT exposed yet (deferred per migration 059 documented TODOs):
 *   - Claim reassignment (reassign_consult_claim) — admin surface;
 *     lands with the admin-backend follow-on PR.
 *   - Delegate-initiated flows — patient-principal-only at PR 6 (see
 *     initiate-consult-v1.ts docstring for the fail-closed 403 + TODO).
 *
 * All POSTs are idempotency-protected via the Idempotency-Key header
 * (IDEMPOTENCY v5.1, tenant-scoped). All handlers follow the canonical
 * composition (withIdempotentExecution/withTransaction → withTenantContext
 * → withActorContext → withDbRole(<slice role>) → SQL → same-tx audit
 * under the restored app role) with 42501 → tenant-blind 403 (I-025).
 *
 * Spec references: migrations 055-060, AUDIT_EVENTS v5.11 async_consult.*
 * catalog, OpenAPI v0.4, I-003 / I-023 / I-025 / I-027.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { aiPreparationV1Handler } from './internal/handlers/ai-preparation-v1.js';
import { claimConsultV1Handler } from './internal/handlers/claim-consult-v1.js';
import { getConsultV1Handler } from './internal/handlers/get-consult-v1.js';
import { getQueueV1Handler } from './internal/handlers/get-queue-v1.js';
import { initiateConsultV1Handler } from './internal/handlers/initiate-consult-v1.js';
import { recordDecisionV1Handler } from './internal/handlers/record-decision-v1.js';
import { submitIntakeV1Handler } from './internal/handlers/submit-intake-v1.js';

export const registerAsyncConsultV1Routes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Static route registered before the :consult_id param route by
  // convention (Fastify's router prefers static segments regardless,
  // but the ordering keeps intent obvious).
  app.get('/queue', getQueueV1Handler);

  app.post('/', initiateConsultV1Handler);
  app.get('/:consult_id', getConsultV1Handler);
  app.post('/:consult_id/intake', submitIntakeV1Handler);
  app.post('/:consult_id/ai-preparation', aiPreparationV1Handler);
  app.post('/:consult_id/claim', claimConsultV1Handler);
  app.post('/:consult_id/decision', recordDecisionV1Handler);
};
