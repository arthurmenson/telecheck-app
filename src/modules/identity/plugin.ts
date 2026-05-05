/**
 * identity/plugin.ts — Fastify plugin entry point for the Identity & Auth module.
 *
 * Registered in `src/app.ts` after the foundation middleware (tenantContext,
 * idempotency, errorEnvelope, aiContext). All routes are mounted under the
 * `/v0/identity` prefix so they participate in tenant context resolution and
 * the canonical error envelope per I-023 / I-025.
 *
 * Per ADR-001 modular monolith: this plugin is the only entry point that
 * may register the module's routes. Other modules consume the Identity
 * module ONLY through the public interface in `index.ts`.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - Identity & Authentication Spec v1.0 §2 (registration), §3 (authn)
 *   - I-023 / I-025 (tenant scoping + tenant-blind errors)
 *
 * Out-of-scope (deferred to follow-up commits):
 *   - JWT signing keys + issuance hook (replaces forms-intake's
 *     x-actor-id / x-patient-id header stubs)
 *   - Full route surface: POST /registration/start + verify, POST /login/
 *     start + verify, POST /sessions/refresh + logout, /devices CRUD,
 *     GET /accounts/me
 *   - Currently registers ONLY a /health probe so app.ts wiring can be
 *     verified end-to-end. Real handler routes land in subsequent commits.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerIdentityRoutes } from './routes.js';

const identityPluginImpl: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(registerIdentityRoutes, { prefix: '/v0/identity' });
};

export const identityPlugin = fp(identityPluginImpl, {
  name: 'identity',
  fastify: '5.x',
});
