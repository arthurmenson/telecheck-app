/**
 * subscription/plugin.ts — Fastify plugin entry point (skeleton).
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point
 * that registers the module's routes. Cross-module callers consume
 * the Subscription module ONLY through `index.ts`.
 *
 * Status at v0.1: BLOCKED on SI-001. Plugin registers the module's
 * `/health` (200) + `/ready` (503) probes so app-level wiring works;
 * full implementation (POST /subscriptions, PATCH /subscriptions/:id/pause,
 * /resume, /cancel, /switch + the state machine + Pharmacy + Payment
 * adapter wiring) lands when SI-001 closes and the CDM §4 schema is
 * canonical.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md
 *   - Pharmacy + Refill Slice PRD v2.1 §5
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerSubscriptionRoutes } from './routes.js';

const subscriptionPluginImpl: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  await app.register(registerSubscriptionRoutes, { prefix: '/v0/subscription' });
};

export const subscriptionPlugin = fp(subscriptionPluginImpl, {
  name: 'subscription',
  fastify: '5.x',
});
