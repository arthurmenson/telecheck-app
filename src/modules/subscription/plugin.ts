/**
 * subscription/plugin.ts — Fastify plugin entry point (skeleton).
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point
 * that registers the module's routes. Cross-module callers consume
 * the Subscription module ONLY through `index.ts`.
 *
 * SI-001 CLOSED (P-011): the plugin mounts the real §20 handler surface
 * under the canonical OpenAPI v0.2 base path `/v0/subscriptions` (plural),
 * alongside the module's `/health` (200) + `/ready` (200) probes.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - OpenAPI v0.2 §20 (subscription endpoint contracts; base path)
 *   - Pharmacy + Refill Slice PRD v2.1 §5/§8
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerSubscriptionRoutes } from './routes.js';

const subscriptionPluginImpl: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(registerSubscriptionRoutes, { prefix: '/v0/subscriptions' });
};

export const subscriptionPlugin = fp(subscriptionPluginImpl, {
  name: 'subscription',
  fastify: '5.x',
});
