/**
 * consent/routes.ts — Fastify route registration for the Consent module.
 *
 * Currently registers only a /health probe; the full route surface
 * (POST /consents, POST /consents/:id/revoke, POST /delegations,
 * POST /delegations/:id/{accept,decline}, etc.) lands in subsequent
 * commits with handler implementations.
 *
 * Spec references:
 *   - Consent Slice PRD v1.0 (full route surface defined per slice spec)
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const registerConsentRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  /**
   * Module health probe — module-scoped equivalent of the platform-level
   * /health. Bypasses tenant resolution via the app.ts allowlist entry.
   */
  app.get('/health', async (_request, reply) => {
    await reply.code(200).send({ status: 'ok', module: 'consent' });
  });
};
