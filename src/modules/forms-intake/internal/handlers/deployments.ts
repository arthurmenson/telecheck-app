/**
 * forms-intake/internal/handlers/deployments.ts — deployment route handlers.
 *
 * Endpoints (per Slice PRD v2.1 §6.2 deployment workflow):
 *   - POST   /v0/forms/deployments                  create active deployment
 *   - GET    /v0/forms/deployments/:deploymentId    read deployment
 *   - POST   /v0/forms/deployments/:deploymentId/retire   retire deployment
 *
 * Per Slice PRD §25.4 program porting workflow, the deployment binds a
 * specific (tenant, template, version, ProgramMarketPolicy) tuple — Pattern A
 * one-version-per-market immutability is preserved per FORMS_ENGINE v5.2.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { CreateDeploymentRequestSchema } from '../../schemas.js';
import * as templateService from '../services/template-service.js';

/**
 * Resolve the acting actor's identity. Same shim + production-fail-closed
 * gate as templates.ts (kept duplicated rather than extracted to keep each
 * handler-file's auth boundary obvious; centralization happens when the
 * Identity & Auth slice lands).
 */
function resolveActorId(req: FastifyRequest): string {
  const isProd = process.env['NODE_ENV'] === 'production';
  const optIn = process.env['ALLOW_ACTOR_HEADER_AUTH'] === 'true';
  if (isProd && !optIn) {
    throw req.server.httpErrors.unauthorized(
      'Actor identity could not be authenticated for this request.',
    );
  }
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
 * POST /v0/forms/deployments — deploy a published template to its program.
 *
 * Same canonical pattern as createTemplateHandler:
 *   1. Resolve tenant context (foundation; fails 400 closed if absent).
 *   2. Resolve actor (production-gated header shim until auth slice).
 *   3. Validate body via Zod (400 on parse failure).
 *   4. Delegate to templateService.createDeployment which enforces the
 *      cross-table precondition (template must be published) before
 *      delegating to submissionRepo.createActiveDeployment which runs
 *      INSERT + audit + domain event atomically inside withTransaction.
 *   5. Return 201 with the FormDeployment row.
 *
 * Precondition error mapping:
 *   - 'forms.deployment.template_not_found'      → 400 with canonical code
 *   - 'forms.deployment.template_not_published'  → 400 with canonical code
 *
 * Both are tenant-blind per I-025: the response body does NOT differentiate
 * "template doesn't exist" from "template exists but in wrong state" beyond
 * the structured error code.
 */
export async function createDeploymentHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actorId = resolveActorId(req);

  const parsed = CreateDeploymentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  try {
    const deployment = await templateService.createDeployment(ctx, actorId, parsed.data);
    return reply.code(201).send(deployment);
  } catch (err) {
    // Precondition-failure error codes map to 400 with the canonical code
    // preserved. All other errors propagate to the global error envelope
    // plugin and surface as 500 with a tenant-blind generic message.
    const code = err instanceof Error ? err.message : '';
    if (
      code === 'forms.deployment.template_not_found' ||
      code === 'forms.deployment.template_not_published'
    ) {
      throw req.server.httpErrors.badRequest(code);
    }
    throw err;
  }
}

/** GET /v0/forms/deployments/:deploymentId — read a deployment. */
export async function getDeploymentHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}

/**
 * POST /v0/forms/deployments/:deploymentId/retire — retire an active
 * deployment. In-progress submissions complete on their assigned version
 * per Slice PRD §14.5 supersession discipline.
 */
export async function retireDeploymentHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}
