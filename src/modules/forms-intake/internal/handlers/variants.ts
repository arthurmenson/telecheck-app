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
 *
 * **Actor identity:** tenant admin operations. Same `x-actor-id` header shim
 * as templates.ts; production fail-closed per `ALLOW_ACTOR_HEADER_AUTH`.
 * Replaced by Identity & Auth slice once that lands.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireAdminRole } from '../../../../lib/admin-role.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { CreateVariantRequestSchema, PromoteVariantRequestSchema } from '../../schemas.js';
import {
  VARIANT_LABEL_CONFLICT,
  VARIANT_NOT_ACTIVE,
  VARIANT_NOT_FOUND,
  VARIANT_PRECONDITION_FAILED,
} from '../repositories/submission-repo.js';
import * as templateService from '../services/template-service.js';

/**
 * Module-local service-error mapper for `withIdempotentExecution`. The
 * forms-intake module surfaces preconditions as string-sentinel Error
 * objects, which are caught + remapped to Fastify httpErrors INSIDE the
 * body callback (so the surrounding tx rolls back and the reservation is
 * purged). No domain-specific Error classes flow up to this mapper, so it
 * is a deliberate no-op — unmapped errors propagate to Fastify's global
 * error handler.
 */
function mapServiceError(): boolean {
  return false;
}

/**
 * Resolve the acting tenant admin's identity. Same shim + production-fail-closed
 * gate as the other handler files (kept duplicated rather than extracted
 * to keep each handler-file's auth boundary obvious; centralization happens
 * when the Identity & Auth slice lands).
 */
function resolveActorId(req: FastifyRequest): string {
  // Tier 1 JWT (preferred via authContextPlugin); Tier 2 x-actor-id
  // header shim (production fail-closed unless opt-in).
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
 * Map repo-layer sentinel errors to canonical 4xx responses per I-025 +
 * ERROR_MODEL v5.1. Both sentinels resolve to a uniform 400 envelope; the
 * structured code preserves operator-facing distinction for observability.
 */
function isHandledVariantSentinel(message: string): boolean {
  return message === VARIANT_PRECONDITION_FAILED || message === VARIANT_LABEL_CONFLICT;
}

/**
 * POST /v0/forms/variants — create an A/B variant of a deployed template.
 *
 * Sentinel error mapping (tenant-blind 400 per I-025):
 *   - VARIANT_PRECONDITION_FAILED — deployment missing/retired OR
 *     variant_template missing in tenant.
 *   - VARIANT_LABEL_CONFLICT — duplicate (deployment, label) pair.
 */
export async function createVariantHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actorId = resolveActorId(req);
  requireAdminRole(req);

  const parsed = CreateVariantRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.issues
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    try {
      const variant = await templateService.createVariant(ctx, actorId, parsed.data, tx);
      return { status: 201, view: variant };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isHandledVariantSentinel(message)) {
        // Throw inside body() so the surrounding tx rolls back and the
        // idempotency reservation is purged — clean retry possible.
        throw req.server.httpErrors.badRequest(
          'The requested variant cannot be created in its current state.',
        );
      }
      throw err;
    }
  });
}

/**
 * GET /v0/forms/variants/:variantId — read variant state + traffic split.
 *
 * Requires authenticated actor identity per Codex variants-resume-http-r1
 * closure 2026-05-03 — variants are a tenant-admin surface (Slice PRD
 * §14), so even read endpoints must authenticate. The previous
 * implementation only required tenant context, which let any
 * tenant-network caller hit the endpoint without proving an admin
 * identity. Auth shim is the same `resolveActorId` (production
 * fail-closed gated by `ALLOW_ACTOR_HEADER_AUTH`) used by the create +
 * promote handlers; the Identity & Auth slice replaces the shim with
 * RBAC role enforcement.
 *
 * 200 hit / 404 tenant-blind miss per I-025 (cross-tenant resolves to the
 * same envelope as missing).
 */
export async function getVariantHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  // Auth precondition: read endpoints on the admin variant surface
  // require an authenticated actor — closes the unauthenticated-admin-read
  // path Codex flagged on the HTTP-test pass.
  void resolveActorId(req);
  requireAdminRole(req);

  const params = req.params as Record<string, unknown>;
  const variantIdParam = params['variantId'];
  if (typeof variantIdParam !== 'string' || variantIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `variantId` is required.');
  }

  const variant = await templateService.getVariant(ctx, variantIdParam);
  if (variant === null) {
    throw req.server.httpErrors.notFound('Form variant not found.');
  }
  return reply.code(200).send(variant);
}

/**
 * POST /v0/forms/variants/:variantId/promote — promote a statistically
 * significant winner to new Control. Per Slice PRD §14.5 retires losing
 * variants; in-progress submissions complete on assigned variant
 * (Pattern A immutability).
 *
 * Sentinel error mapping (tenant-blind 400 per I-025):
 *   - VARIANT_NOT_FOUND — target variant not in tenant.
 *   - VARIANT_NOT_ACTIVE — target exists but isn't active (retired /
 *     already winner). Both surface as the same byte-identical 400
 *     envelope; structured codes preserve operator-facing distinction.
 */
export async function promoteVariantHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actorId = resolveActorId(req);
  requireAdminRole(req);

  const params = req.params as Record<string, unknown>;
  const variantIdParam = params['variantId'];
  if (typeof variantIdParam !== 'string' || variantIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `variantId` is required.');
  }

  const parsed = PromoteVariantRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.issues
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    try {
      const promoted = await templateService.promoteVariant(
        ctx,
        actorId,
        variantIdParam,
        parsed.data,
        tx,
      );
      return { status: 200, view: promoted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === VARIANT_NOT_FOUND || message === VARIANT_NOT_ACTIVE) {
        // Throw inside body() so the surrounding tx rolls back and the
        // idempotency reservation is purged — clean retry possible.
        throw req.server.httpErrors.badRequest(
          'The requested variant cannot be promoted in its current state.',
        );
      }
      throw err;
    }
  });
}
