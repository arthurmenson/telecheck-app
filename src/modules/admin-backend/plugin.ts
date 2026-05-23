/**
 * admin-backend/plugin.ts — Fastify plugin entry point.
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point that
 * registers the module's routes. Cross-module callers consume the Admin
 * Backend module ONLY through `index.ts`.
 *
 * Status at v0.1 (Sprint 1 — this commit): SKELETON. Plugin registers
 * `/health` (200) + `/ready` (503) so app-level wiring works. Full
 * implementation (5 endpoints per SI-023 §5: 3 dashboard reads + 2
 * template wrappers + Cat A audit emission + LAYER B role-membership
 * authorization + integration tests) lands across Sprints 2-N.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW1-NEW9 (RATIFIED 2026-05-22 P-042)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerAdminBackendRoutes } from './routes.js';

const adminBackendPluginImpl: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  await app.register(registerAdminBackendRoutes, { prefix: '/v0/admin-backend' });
};

export const adminBackendPlugin = fp(adminBackendPluginImpl, {
  name: 'admin-backend',
  fastify: '5.x',
});
