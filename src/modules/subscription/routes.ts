/**
 * subscription/routes.ts — Fastify route registration for the Subscription
 * slice HTTP surface (OpenAPI v0.2 §20; base path /v0/subscriptions).
 *
 * SI-001 CLOSED (Promotion Ledger P-011; operator-confirmed 2026-07-08):
 * the real handler surface is now mounted. The 7 §20 endpoints are live:
 *
 *   GET  /v0/subscriptions                         list (§20.1)
 *   GET  /v0/subscriptions/:subscription_id        get (§20.2)
 *   POST /v0/subscriptions/:subscription_id/pause   pause (§20.3)
 *   POST /v0/subscriptions/:subscription_id/resume  resume (§20.4)
 *   POST /v0/subscriptions/:subscription_id/switch  switch (§20.5)
 *   POST /v0/subscriptions/:subscription_id/cancel  cancel (§20.6)
 *   GET  /v0/subscriptions/:subscription_id/events  event history (§20.7)
 *
 * NOT mounted (no ratified HTTP surface at v0.2 / deferred — do not build
 * ad hoc):
 *   - POST /subscriptions (DRAFT create) — ratified under the OpenAPI v0.2
 *     PAYMENTS module (checkout orchestration), not this slice. The stable
 *     in-process target is subscription's exported createSubscriptionDraft
 *     service function.
 *   - Clinician transitions (approve/decline/switch-approve/release/
 *     terminate) and system transitions (period_end/complete/auto-resume/
 *     pause_expires/end_period/payment_failed/safety_hold) — reached via
 *     exported service functions (scheduler / domain-event subscriber
 *     wiring); OpenAPI v0.2 §20 ratifies no clinician/system endpoint.
 *
 * All POSTs require the Idempotency-Key header (IDEMPOTENCY v5.1,
 * tenant-scoped) and follow the canonical composition documented in
 * transition-handlers.ts. All handlers emit tenant-blind error envelopes
 * (I-025); state transitions emit same-tx §15 audit records (I-003/I-027).
 *
 * Spec references: OpenAPI v0.2 §20, State Machines v1.1 §15,
 * I-023 / I-025 / I-027, migrations/075-077.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import {
  getSubscriptionHandler,
  listSubscriptionEventsHandler,
  listSubscriptionsHandler,
} from './internal/handlers/read-handlers.js';
import {
  cancelSubscriptionHandler,
  pauseSubscriptionHandler,
  resumeSubscriptionHandler,
  switchSubscriptionHandler,
} from './internal/handlers/transition-handlers.js';

export const registerSubscriptionRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Liveness probe — process is alive. Allowlisted in tenantContextPlugin.
  app.get('/health', async () => ({
    status: 'ok',
    module: 'subscription',
    surface: 'OpenAPI v0.2 §20 — 7 endpoints live (list/get/pause/resume/switch/cancel/events)',
  }));

  // Readiness probe — module is READY to serve traffic. SI-001 closed
  // (P-011); the ratified §20 read + patient-transition surface is mounted,
  // so this returns 200. Documented deferrals (Payments-module create path,
  // clinician/system service-function transitions, real payment adapter)
  // are out of the §20 HTTP scope and do NOT gate readiness.
  app.get('/ready', async (_req, reply) => {
    return reply.code(200).send({
      status: 'ready',
      module: 'subscription',
      surface_message:
        '7 of 7 OpenAPI v0.2 §20 subscription endpoints are live. DRAFT create rides the ' +
        'Payments module; clinician/system transitions are exported service functions; ' +
        'payment adapter posture is mock_local_dev (Track-5 gap).',
    });
  });

  // §20 resource surface. Static probes are registered above; Fastify's
  // router prefers static segments over the :subscription_id param, so the
  // health/ready paths never collide with the get route.
  app.get('/', listSubscriptionsHandler);
  app.get('/:subscription_id', getSubscriptionHandler);
  app.get('/:subscription_id/events', listSubscriptionEventsHandler);
  app.post('/:subscription_id/pause', pauseSubscriptionHandler);
  app.post('/:subscription_id/resume', resumeSubscriptionHandler);
  app.post('/:subscription_id/switch', switchSubscriptionHandler);
  app.post('/:subscription_id/cancel', cancelSubscriptionHandler);
};
