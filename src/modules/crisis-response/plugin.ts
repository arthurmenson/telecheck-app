/**
 * crisis-response/plugin.ts — Fastify plugin entry point.
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point that
 * registers the module's routes. Cross-module callers consume the Crisis
 * Response module ONLY through `index.ts`.
 *
 * Status at v0.1 (Sprint 1 — this commit): SKELETON. Plugin registers
 * `/health` (200) + `/ready` (503) so app-level wiring works. Full
 * implementation (POST /crisis-events, acknowledge/respond/resolve/sweep,
 * audit emission, KMS envelope, integration tests) lands across Sprints 2-4.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - SI-022 Crisis Response Slice v1.0 (RATIFIED 2026-05-21 P-039)
 *   - docs/crisis-response-implementation-plan.md
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerCrisisResponseRoutes } from './routes.js';

const crisisResponsePluginImpl: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  await app.register(registerCrisisResponseRoutes, { prefix: '/v0/crisis-events' });
};

export const crisisResponsePlugin = fp(crisisResponsePluginImpl, {
  name: 'crisis-response',
  fastify: '5.x',
});
