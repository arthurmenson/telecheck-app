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
  // R1 MED-1 closure 2026-05-22 (PR 6 Codex R1): use the spec-canonical
  // `/v1/admin` prefix, NOT `/v0/admin-backend`. The Sprint 2+ endpoint
  // contract per SI-023 §5 + CDM §4 amendment is `/v1/admin/...` (e.g.,
  // `/v1/admin/dashboards/crisis-operational-health`,
  // `/v1/admin/templates/{template_id}/submit-for-review`,
  // `/v1/admin/template-reviews/{review_id}/decision`). If we mounted under
  // `/v0/admin-backend` the future Sprint 2 routes would expose at
  // `/v0/admin-backend/v1/admin/...` — a contract break with the ratified
  // spec. (The probe URLs are therefore `/v1/admin/health` + `/v1/admin/ready`,
  // distinct from the tenant-config module's pre-existing `/v0/admin/...`
  // paths because the version prefix is different.)
  await app.register(registerAdminBackendRoutes, { prefix: '/v1/admin' });
};

export const adminBackendPlugin = fp(adminBackendPluginImpl, {
  name: 'admin-backend',
  fastify: '5.x',
});
