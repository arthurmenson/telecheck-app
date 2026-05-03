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
import { CreateTemplateRequestSchema, PublishVersionRequestSchema } from '../../schemas.js';
import {
  PUBLISH_VERSION_NOT_DRAFT,
  PUBLISH_VERSION_NOT_FOUND,
} from '../repositories/template-repo.js';
import * as templateService from '../services/template-service.js';
import { PUBLISH_GATES_NOT_IMPLEMENTED } from '../services/template-service.js';

/**
 * Resolve the acting actor's identity. PLACEHOLDER pending the Identity &
 * Auth slice — currently reads `x-actor-id` header. Production will source
 * this from `req.user.id` populated by an auth plugin.
 *
 * **Hardened production gate (per Codex first-handler-implementation HIGH
 * finding closure 2026-05-02):** the header path is FAIL-CLOSED in non-test
 * environments unless the `ALLOW_ACTOR_HEADER_AUTH` env flag is explicitly
 * set to `'true'`. Without that opt-in, production requests get 401 with
 * a tenant-blind error envelope — no audit-actor forgery is possible from
 * an unauthenticated client. Local dev / integration tests opt in via the
 * env flag; the Identity slice replaces the entire function once it lands.
 *
 * SPEC ISSUE: the header-based shim itself is for the scaffold demonstration
 * only. The Identity & Auth Spec v1.0 defines the canonical resolution path;
 * this function MUST be replaced before any production deployment. Filed
 * inline so engineering escalation per EHBG §12 catches it during the
 * Identity slice's authoring.
 */
function resolveActorId(req: FastifyRequest): string {
  // Production fail-closed: refuse to use the header shim in production
  // unless the deployment explicitly opts in. This prevents an inadvertent
  // production rollout from silently accepting forged audit actors.
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
 * marketing-copy resolution, Mode 2 contract conformance — currently
 * scaffolded as TODOs in the service; durability + supersession path is
 * implemented end-to-end).
 *
 * Path-param semantics under FORMS_ENGINE v5.2 Pattern A:
 *   `:versionId` IS the operative key — it maps directly to
 *   `forms_template.template_id` (each row is a version). `:templateId`
 *   is preserved in the URL for REST symmetry but the data model has no
 *   distinct template-family identity; handler validates both are
 *   present and uses `:versionId` as the publish target. When a future
 *   slice introduces a true template-family resource, this handler can
 *   add a `templateId` membership check without changing the URL.
 *
 * Error mapping per I-025 + ERROR_MODEL v5.1:
 *   - PUBLISH_VERSION_NOT_FOUND  → 400 (tenant-blind, not 404)
 *   - PUBLISH_VERSION_NOT_DRAFT  → 400 (I-013 immutability)
 *   Everything else propagates through the global error envelope plugin
 *   which returns the canonical { error: { code, message, request_id } }
 *   shape.
 */
export async function publishVersionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actorId = resolveActorId(req);

  const params = req.params as Record<string, unknown>;
  const templateIdParam = params['templateId'];
  const versionIdParam = params['versionId'];
  if (typeof templateIdParam !== 'string' || templateIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `templateId` is required.');
  }
  if (typeof versionIdParam !== 'string' || versionIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `versionId` is required.');
  }

  // Body is optional (just `changeNotes?`) per PublishVersionRequestSchema.
  // Default to an empty object so the schema's `.optional()` resolves to
  // `undefined` rather than 400'ing on `req.body === null` (Fastify default
  // when no body is sent).
  const parsed = PublishVersionRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  try {
    const published = await templateService.publishVersion(
      ctx,
      actorId,
      versionIdParam,
      parsed.data,
    );
    return reply.code(200).send(published);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === PUBLISH_VERSION_NOT_FOUND || message === PUBLISH_VERSION_NOT_DRAFT) {
      // Both sentinels map to the same tenant-blind 400 envelope per I-025
      // — the response MUST NOT differentiate "doesn't exist" vs "exists
      // in another tenant" vs "exists but isn't a draft." A precise
      // operator-facing error code is preserved in the envelope's `code`
      // field (mapped by the global error envelope plugin) so observability
      // tooling can distinguish; the wire-out message is uniform.
      throw req.server.httpErrors.badRequest(
        'The requested form version cannot be published in its current state.',
      );
    }
    if (message === PUBLISH_GATES_NOT_IMPLEMENTED) {
      // 503 Service Unavailable — the publish governance gates haven't
      // been implemented in this deployment, so publish is fail-closed.
      // This surfaces to operators as "publishing is not yet enabled in
      // this environment" rather than a 400 (which would suggest a
      // client-fixable problem). Codex publishVersion-r1 CRITICAL closure
      // 2026-05-03.
      throw req.server.httpErrors.serviceUnavailable(
        'Form template publishing is not yet enabled in this environment.',
      );
    }
    throw err;
  }
}
