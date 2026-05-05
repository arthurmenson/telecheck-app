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

import { getTenantConfigMeHandler } from './internal/handlers/tenant-config.js';

export const registerTenantConfigRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  app.get('/health', async () => ({ status: 'ok', module: 'tenant-config' }));

  app.get('/me', getTenantConfigMeHandler);
};
