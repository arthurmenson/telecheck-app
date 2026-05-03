/**
 * forms-intake/internal/handlers/templates.ts — template + version route handlers.
 *
 * Endpoints (per Slice PRD v2.1 §6 visual-builder workflows):
 *   - POST   /v0/forms/templates                          create draft
 *   - GET    /v0/forms/templates                          list templates for tenant
 *   - GET    /v0/forms/templates/:templateId              read template
 *   - POST   /v0/forms/templates/:templateId/versions/:versionId/publish
 *
 * Each handler:
 *   1. Resolves tenant context via requireTenantContext(req).
 *   2. Validates the body via the Zod schemas from ../schemas.ts.
 *   3. Delegates to the template-service (which threads audit + events
 *      inside the same transaction the repository opens).
 *   4. Returns the typed response; tenant-blind error envelopes are
 *      handled by the global error envelope plugin per I-025.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireTenantContext } from '../../../../lib/tenant-context.js';

/** POST /v0/forms/templates — create a draft template. */
export async function createTemplateHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  // Resolves tenant context; throws programming error if route is on the
  // tenant-blind allowlist (which it is not).
  void requireTenantContext(req);
  // TODO: validate body via CreateTemplateRequestSchema; resolve actor from
  // req.user (auth slice); call templateService.createDraftTemplate; return.
  throw new Error('not implemented');
}

/** GET /v0/forms/templates — list templates for the active tenant. */
export async function listTemplatesHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}

/** GET /v0/forms/templates/:templateId — read a single template. */
export async function getTemplateHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}

/**
 * POST /v0/forms/templates/:templateId/versions/:versionId/publish — flip
 * a draft version to published. Pre-publish governance gates run inside
 * template-service.publishVersion (six-category I-030 static analysis,
 * marketing-copy resolution, Mode 2 contract conformance).
 */
export async function publishVersionHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}
