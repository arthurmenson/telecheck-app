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
import { CreateTemplateRequestSchema } from '../../schemas.js';
import * as templateService from '../services/template-service.js';

/**
 * Resolve the acting actor's identity. PLACEHOLDER pending the Identity &
 * Auth slice — currently reads `x-actor-id` header. Production will source
 * this from `req.user.id` populated by an auth plugin. Throws a tenant-blind
 * 401-style error if no actor can be resolved.
 *
 * SPEC ISSUE: this header-based shim is for the foundation+slice scaffold
 * demonstration only. The Identity & Auth Spec v1.0 defines the canonical
 * resolution path; this function MUST be replaced before any non-test
 * deployment. Filed inline so engineering escalation per EHBG §12 catches
 * it during the Identity slice's authoring.
 */
function resolveActorId(req: FastifyRequest): string {
  const headerValue = req.headers['x-actor-id'];
  const actorId =
    typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : null;
  if (actorId === null) {
    throw req.server.httpErrors.unauthorized(
      'No actor identity resolved for this request.',
    );
  }
  return actorId;
}

/**
 * POST /v0/forms/templates — create a draft template.
 *
 * Flow:
 *   1. Resolve tenant context (foundation middleware; fails 400 closed if absent).
 *   2. Resolve actor (placeholder header shim until auth slice).
 *   3. Validate body via Zod (CreateTemplateRequestSchema); 400 on parse failure.
 *   4. Delegate to template-service which runs INSERT + audit + domain event
 *      atomically inside withTransaction (per I-003 + I-016 + same-tx outbox).
 *   5. Return 201 Created with the FormTemplate row.
 *
 * Tenant-blind error envelope is handled by the global error envelope plugin
 * (lib/error-envelope.ts) per I-025; this handler does NOT format errors
 * itself — it lets thrown errors propagate.
 */
export async function createTemplateHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actorId = resolveActorId(req);

  const parsed = CreateTemplateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  const template = await templateService.createDraftTemplate(ctx, actorId, parsed.data);

  return reply.code(201).send(template);
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
