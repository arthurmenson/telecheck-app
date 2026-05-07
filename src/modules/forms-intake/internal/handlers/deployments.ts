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

import { requireAdminRole } from '../../../../lib/admin-role.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { CreateDeploymentRequestSchema } from '../../schemas.js';
import {
  DEPLOYMENT_ALREADY_RETIRED,
  DEPLOYMENT_NOT_FOUND,
} from '../repositories/submission-repo.js';
import * as templateService from '../services/template-service.js';

/**
 * Module-local service-error mapper for `withIdempotentExecution`. The
 * forms-intake module surfaces preconditions as string-sentinel Error
 * objects, which are caught + remapped to Fastify httpErrors INSIDE
 * the body callback (so the surrounding tx rolls back and the reservation
 * is purged). No domain-specific Error classes flow up to this mapper, so
 * it is a deliberate no-op — unmapped errors propagate to Fastify's global
 * error handler. Same shape as async-consult's mapper, just no cases.
 */
function mapServiceError(): boolean {
  return false;
}

/**
 * Resolve the acting actor's identity. Same shim + production-fail-closed
 * gate as templates.ts (kept duplicated rather than extracted to keep each
 * handler-file's auth boundary obvious; centralization happens when the
 * Identity & Auth slice lands).
 */
function resolveActorId(req: FastifyRequest): string {
  // Tier 1: JWT-resolved actor (preferred via authContextPlugin;
  // landed 2d45f98). Tier 2: x-actor-id header shim (production
  // fail-closed unless ALLOW_ACTOR_HEADER_AUTH=true).
  if (req.actorContext !== undefined) {
    return req.actorContext.accountId;
  }
  const isProd = process.env['NODE_ENV'] === 'production';
  const optIn = process.env['ALLOW_ACTOR_HEADER_AUTH'] === 'true';
  if (isProd && !optIn) {
    throw req.server.httpErrors.unauthorized(
      'Actor identity could not be authenticated for this request.',
    );
  }
  const headerValue = req.headers['x-actor-id'];
  const actorId = typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : null;
  if (actorId === null) {
    throw req.server.httpErrors.unauthorized('No actor identity resolved for this request.');
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
  requireAdminRole(req);

  const parsed = CreateDeploymentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    try {
      const deployment = await templateService.createDeployment(ctx, actorId, parsed.data, tx);
      return { status: 201, view: deployment };
    } catch (err) {
      // Precondition-failure error codes map to 400 with the canonical code
      // preserved. All other errors propagate to the global error envelope
      // plugin and surface as 500 with a tenant-blind generic message.
      // Throw inside body() so the surrounding tx rolls back and the
      // idempotency reservation is purged — clean retry possible.
      const code = err instanceof Error ? err.message : '';
      if (
        code === 'forms.deployment.template_not_found' ||
        code === 'forms.deployment.template_not_published'
      ) {
        throw req.server.httpErrors.badRequest(code);
      }
      throw err;
    }
  });
}

/**
 * GET /v0/forms/deployments/:deploymentId — read a deployment.
 *
 * Returns 200 + body on hit. Returns 404 (tenant-blind per I-025) when
 * the deployment doesn't exist in this tenant.
 *
 * Requires authenticated actor identity per Codex variants-resume-http-r1
 * pattern closure 2026-05-03 (extended to deployments by the
 * deployments-http test pass) — deployment CRUD is a tenant-admin surface
 * (Slice PRD v2.1 §6.2 deployment workflow), so even read endpoints must
 * authenticate. The previous implementation only required tenant context,
 * which let any tenant-network caller hit the endpoint without proving an
 * admin identity. Auth shim is the same `resolveActorId` (production
 * fail-closed gated by `ALLOW_ACTOR_HEADER_AUTH`) used by the create +
 * retire handlers; the Identity & Auth slice replaces the shim with RBAC
 * role enforcement.
 */
export async function getDeploymentHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  // Auth precondition: read endpoints on the admin deployment surface
  // require an authenticated actor — closes the unauthenticated-admin-read
  // path (variants-resume-http-r1 pattern, applied here by the
  // deployments-http test pass).
  void resolveActorId(req);
  requireAdminRole(req);

  const params = req.params as Record<string, unknown>;
  const deploymentIdParam = params['deploymentId'];
  if (typeof deploymentIdParam !== 'string' || deploymentIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `deploymentId` is required.');
  }

  const deployment = await templateService.getDeployment(ctx, deploymentIdParam);
  if (deployment === null) {
    throw req.server.httpErrors.notFound('Form deployment not found.');
  }
  return reply.code(200).send(deployment);
}

/**
 * POST /v0/forms/deployments/:deploymentId/retire — retire an active
 * deployment. In-progress submissions complete on their assigned version
 * per Slice PRD §14.5 supersession discipline.
 *
 * Sentinel error mapping (tenant-blind per I-025):
 *   - DEPLOYMENT_NOT_FOUND       → 400 with canonical code
 *   - DEPLOYMENT_ALREADY_RETIRED → 400 with canonical code
 *
 * Both map to the same wire-out 400 envelope so the response NEVER
 * differentiates "doesn't exist" from "exists but already retired" from
 * "exists in another tenant." The structured error code preserves the
 * operator-facing distinction for observability tooling.
 */
export async function retireDeploymentHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actorId = resolveActorId(req);
  requireAdminRole(req);

  const params = req.params as Record<string, unknown>;
  const deploymentIdParam = params['deploymentId'];
  if (typeof deploymentIdParam !== 'string' || deploymentIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `deploymentId` is required.');
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    try {
      const retired = await templateService.retireDeployment(ctx, actorId, deploymentIdParam, tx);
      return { status: 200, view: retired };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === DEPLOYMENT_NOT_FOUND || message === DEPLOYMENT_ALREADY_RETIRED) {
        // Tenant-blind 400 per I-025 — the response shape is identical for
        // "doesn't exist" / "exists in another tenant" / "already retired."
        // Throw inside body() so the surrounding tx rolls back and the
        // idempotency reservation is purged — clean retry possible.
        throw req.server.httpErrors.badRequest(
          'The requested form deployment cannot be retired in its current state.',
        );
      }
      throw err;
    }
  });
}
