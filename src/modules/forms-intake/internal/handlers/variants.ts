/**
 * forms-intake/internal/handlers/variants.ts — A/B variant administration handlers.
 *
 * Endpoints (per Slice PRD v2.1 §14 A/B testing native):
 *   - POST   /v0/forms/variants                          create variant
 *   - GET    /v0/forms/variants/:variantId               read variant
 *   - POST   /v0/forms/variants/:variantId/promote       promote winner
 *
 * Variant lifecycle audit is Category B per Slice PRD §14.6 — the service
 * layer threads the audit emit through the same transaction as the DB write.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireTenantContext } from '../../../../lib/tenant-context.js';

/** POST /v0/forms/variants — create an A/B variant of a deployed template. */
export async function createVariantHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  // TODO: validate body via CreateVariantRequestSchema; call repo write
  // with audit-emit txCallback; PostHog feature-flag setup deferred to
  // analytics adapter.
  throw new Error('not implemented');
}

/** GET /v0/forms/variants/:variantId — read variant state + traffic split. */
export async function getVariantHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}

/**
 * POST /v0/forms/variants/:variantId/promote — promote a statistically
 * significant winner to new Control. Per Slice PRD §14.5 retires losing
 * variants; in-progress submissions complete on assigned variant.
 */
export async function promoteVariantHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}
