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

import { registerTenantConfigRoutes } from './routes.js';

const tenantConfigPluginImpl: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(registerTenantConfigRoutes, { prefix: '/v0/tenant-config' });
};

export const tenantConfigPlugin = fp(tenantConfigPluginImpl, {
  name: 'tenant-config',
  fastify: '5.x',
});
