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
};
