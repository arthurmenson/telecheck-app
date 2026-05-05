/**
 * med-interaction/plugin.ts — Fastify plugin entry point (skeleton).
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point
 * that registers the module's routes. Cross-module callers consume
 * the Med Interaction module ONLY through `index.ts`.
 *
 * Status at v0.1: BLOCKED on Med Interaction Engine slice PRD
 * ratification. Plugin registers the module's `/health` (200) +
 * `/ready` (503) probes so app-level wiring works; full
 * implementation (POST /signals/check, POST /overrides, ruleset
 * resolver, adapter abstraction, etc.) lands when the slice PRD
 * is ratified.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
 *   - Pharmacy + Refill Slice PRD v2.1 §6 (downstream consumer)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerMedInteractionRoutes } from './routes.js';

const medInteractionPluginImpl: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  await app.register(registerMedInteractionRoutes, { prefix: '/v0/med-interaction' });
};

export const medInteractionPlugin = fp(medInteractionPluginImpl, {
  name: 'med-interaction',
  fastify: '5.x',
});
