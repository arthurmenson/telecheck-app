/**
 * identity/routes.ts — Fastify route registration for the Identity module.
 *
 * Currently registers only a `/health` probe so module wiring can be
 * verified end-to-end. The full route surface (registration / login /
 * sessions / devices / accounts) lands in subsequent commits.
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §2 (registration), §3 (authn)
 *   - OpenAPI v0.2 (canonical endpoint contracts; identity surface is
 *     scoped under /v0/identity)
 *   - I-023 (tenant scoping handled by the foundation tenantContext plugin)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import {
  listDevicesHandler,
  registerDeviceHandler,
  revokeDeviceHandler,
} from './internal/handlers/devices.js';
import {
  loginStartHandler,
  loginVerifyHandler,
  sessionLogoutHandler,
  sessionRefreshHandler,
} from './internal/handlers/login.js';
import {
  registrationStartHandler,
  registrationVerifyHandler,
} from './internal/handlers/registration.js';

export const registerIdentityRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  /**
   * Module health probe — module-scoped equivalent of the platform-level
   * /health endpoint. Lets ops verify the Identity plugin is registered
   * and responsive without hitting any tenant-scoped state.
   *
   * Listed in the tenant-context plugin's allowlistedPaths so it bypasses
   * tenant resolution.
   */
  app.get('/health', async (_request, reply) => {
    await reply.code(200).send({ status: 'ok', module: 'identity' });
  });

  /**
   * Registration flow per Identity Spec v1.0 §2.
   *
   *   POST /registration/start  — issue OTP for an unregistered phone
   *   POST /registration/verify — verify code + create+activate account
   *
   * Both routes are tenant-scoped (require tenantContext via Host header
   * resolution). Idempotency is enforced at the OTP layer (same phone
   * within cooldown returns OTP_LOCKOUT_ACTIVE) so these don't need
   * Idempotency-Key for the v1.0 surface — the foundation idempotency
   * plugin's exempt-paths set may need to allow these later if a tenant
   * client treats them as retryable.
   */
  app.post('/registration/start', registrationStartHandler);
  app.post('/registration/verify', registrationVerifyHandler);

  /**
   * Login flow per Identity Spec v1.0 §3.
   *
   *   POST /login/start    — issue OTP for an existing account by phone
   *   POST /login/verify   — verify code; on success issue a session
   *                          (returns refresh-token plaintext + session
   *                          + PatientAccountView)
   *   POST /sessions/refresh — exchange refresh token for an extended
   *                            session (no-op rotation at v1.0)
   *   POST /sessions/logout  — revoke session by refresh token
   *                            (idempotent, tenant-blind 204)
   */
  app.post('/login/start', loginStartHandler);
  app.post('/login/verify', loginVerifyHandler);
  app.post('/sessions/refresh', sessionRefreshHandler);
  app.post('/sessions/logout', sessionLogoutHandler);

  /**
   * Device management per Identity Spec v1.0 §3.1 (biometric unlock) +
   * §3.4 (multi-device cap).
   *
   *   POST   /devices                  — register a new device for an
   *                                      account (auto-evicts oldest
   *                                      when account is at the 3-cap)
   *   GET    /devices?account_id=<id>  — list active devices
   *   DELETE /devices/:deviceId        — revoke (patient_unregistered)
   */
  app.post('/devices', registerDeviceHandler);
  app.get('/devices', listDevicesHandler);
  app.delete('/devices/:deviceId', revokeDeviceHandler);
};
