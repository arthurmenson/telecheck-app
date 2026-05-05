/**
 * tenant-config/plugin.ts — Fastify plugin entry point for the
 * tenant-config module.
 *
 * Per ADR-001: this plugin is the only entry point that registers
 * the module's routes. Cross-module callers consume the tenant-config
 * module ONLY through the public interface in index.ts (CCR resolver
 * service).
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - CDM v1.2 §4.2-§4.4
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerTenantConfigAdminRoutes, registerTenantConfigRoutes } from './routes.js';

const tenantConfigPluginImpl: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(registerTenantConfigRoutes, { prefix: '/v0/tenant-config' });
  // Admin read paths under /v0/admin/* — JWT-auth Tier 1 enforced
  // per-handler via requireActorContext. Sprint 2 / TLC-004.
  await app.register(registerTenantConfigAdminRoutes, { prefix: '/v0/admin' });
};

export const tenantConfigPlugin = fp(tenantConfigPluginImpl, {
  name: 'tenant-config',
  fastify: '5.x',
});
