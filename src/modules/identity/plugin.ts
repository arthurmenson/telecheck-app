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
 *   - Master Completion Plan v1.0 Phase A item 2 (this slice's route
 *     surface; production-ready as of 2026-05-15)
 *
 * Routes mounted (full pilot-viable surface):
 *
 *   GET    /health                — module health probe (allowlisted)
 *
 *   POST   /registration/start    — issue OTP for unregistered phone
 *   POST   /registration/verify   — verify OTP + create+activate account
 *
 *   POST   /login/start           — issue OTP for existing account
 *   POST   /login/verify          — verify OTP, issue session
 *                                   (returns refresh-token + session
 *                                   + PatientAccountView)
 *   POST   /sessions/refresh      — extend session via refresh token
 *   POST   /sessions/logout       — revoke session via refresh token
 *                                   (idempotent, tenant-blind 204)
 *
 *   POST   /devices               — register new device (auto-evicts at 3-cap)
 *   GET    /devices?account_id=…  — list active devices for account
 *   DELETE /devices/:deviceId     — revoke device
 *
 *   GET    /accounts/me           — authenticated account self-read
 *
 * Test coverage: 16 integration test files across handler / service /
 * repo / cross-tenant isolation / JWT end-to-end / domain events / OTP
 * lifecycle layers. See tests/integration/identity-*.test.ts.
 *
 * SI-010 integration: authContextPlugin (in src/lib/auth-context.ts)
 * invokes bind_actor_context() on the dedicated bind pool after JWT
 * verification — so route handlers that need server-derived actor
 * identity in DB SECURITY DEFINER procedures can read it via
 * current_actor_*() helpers per migration 031.
 *
 * Out of scope (deferred to v1.1):
 *   - MFA (TOTP / WebAuthn)
 *   - SSO / OAuth federation
 *   - Device-trust certificates beyond the 3-cap multi-device baseline
 *   - Password-reset flow (current v1.0 uses OTP-only login)
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
