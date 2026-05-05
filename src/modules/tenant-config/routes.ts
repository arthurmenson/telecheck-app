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
 * Admin read handlers — Sprint 2 / TLC-004. Mounted at /v0/admin/*.
 * Separate plugin from the tenant-config patient-facing surface so the
 * admin Tier-1-JWT authz model can evolve independently of the patient
 * /me bootstrap probe.
 */
export const registerTenantConfigAdminRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  app.get('/country-profiles', listCountryProfilesHandler);
  app.get('/tenant-brand', getTenantBrandHandler);
  app.get('/ccr-configs', listCcrConfigsHandler);
  app.get('/adapter-configs', listAdapterConfigsHandler);
};
