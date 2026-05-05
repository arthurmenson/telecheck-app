/**
 * tenant-config/routes.ts — Fastify route registration.
 *
 * Routes mounted under /v0/tenant-config:
 *   GET /health — module health probe (allowlisted in tenantContextPlugin)
 *   GET /me     — patient-facing brand + country profile snapshot
 *
 * Spec references:
 *   - CDM v1.2 §4.2-§4.4
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import {
  adminWriteReadyHandler,
  createAdapterConfigHandler,
  deleteAdapterConfigHandler,
  patchAdapterConfigHandler,
  patchCcrConfigHandler,
  patchTenantBrandHandler,
} from './internal/handlers/admin-write.js';
import {
  getTenantBrandHandler,
  listAdapterConfigsHandler,
  listCcrConfigsHandler,
  listCountryProfilesHandler,
} from './internal/handlers/admin.js';
import { getTenantConfigMeHandler } from './internal/handlers/tenant-config.js';

export const registerTenantConfigRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  app.get('/health', async () => ({ status: 'ok', module: 'tenant-config' }));

  app.get('/me', getTenantConfigMeHandler);
};

/**
 * Admin handlers — read at v0.1 (Sprint 2 / TLC-004); write at 503-stub
 * (Sprint 3 / TLC-009). Mounted at /v0/admin/*. Separate plugin from
 * the tenant-config patient-facing surface so the admin Tier-1-JWT
 * authz model can evolve independently of the patient /me bootstrap
 * probe.
 *
 * Write surface (PATCH/POST/DELETE) returns 503 via canonical error
 * envelope until Admin Backend slice v1.1 lands with ADR-024
 * encryption-at-rest wiring.
 */
export const registerTenantConfigAdminRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Read surface — Sprint 2 / TLC-004
  app.get('/country-profiles', listCountryProfilesHandler);
  app.get('/tenant-brand', getTenantBrandHandler);
  app.get('/ccr-configs', listCcrConfigsHandler);
  app.get('/adapter-configs', listAdapterConfigsHandler);

  // Write surface — Sprint 3 / TLC-009 (503 stubs; await Admin Backend slice v1.1)
  app.patch('/tenant-brand', patchTenantBrandHandler);
  app.patch('/ccr-configs/:configKey', patchCcrConfigHandler);
  app.post('/adapter-configs', createAdapterConfigHandler);
  app.patch('/adapter-configs/:adapterId', patchAdapterConfigHandler);
  app.delete('/adapter-configs/:adapterId', deleteAdapterConfigHandler);

  // Mutation-surface readiness probe (tenant-blind; no JWT required)
  app.get('/ready', adminWriteReadyHandler);
};
