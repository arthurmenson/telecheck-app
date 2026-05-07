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

import { requireAdminRole } from '../../../../lib/admin-role.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { CreateTemplateRequestSchema, PublishVersionRequestSchema } from '../../schemas.js';
import type { ListTemplatesCursor } from '../repositories/template-repo.js';
import {
  PUBLISH_VERSION_NOT_DRAFT,
  PUBLISH_VERSION_NOT_FOUND,
} from '../repositories/template-repo.js';
import * as templateService from '../services/template-service.js';
import { PUBLISH_GATES_NOT_IMPLEMENTED } from '../services/template-service.js';

/**
 * Module-local service-error mapper for `withIdempotentExecution`. The
 * forms-intake module currently surfaces preconditions as string-sentinel
 * Error objects, which are caught + remapped to Fastify httpErrors INSIDE
 * the body callback (so the surrounding tx rolls back and the reservation
 * is purged). No domain-specific Error classes flow up to this mapper, so
 * it is a deliberate no-op — unmapped errors propagate to Fastify's global
 * error handler. Same shape as async-consult's mapper, just no cases.
 */
function mapServiceError(): boolean {
  return false;
}

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
  // Tier 1: req.actorContext (JWT-resolved via authContextPlugin;
  // landed 2d45f98). Real auth — preferred path going forward.
  if (req.actorContext !== undefined) {
    return req.actorContext.accountId;
  }

  // Tier 2: header shim. Production fail-closed: refuse the shim in
  // production unless the deployment explicitly opts in. This prevents
  // an inadvertent production rollout from silently accepting forged
  // audit actors.
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
  requireAdminRole(req);

  const parsed = CreateTemplateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const template = await templateService.createDraftTemplate(ctx, actorId, parsed.data, tx);
    return { status: 201, view: template };
  });
}

/**
 * GET /v0/forms/templates — list templates for the active tenant.
 *
 * Paginated via keyset cursor (Codex forms-admin-r1 MEDIUM closure
 * 2026-05-03; cursor opaque-tuple closure verify-r1 MEDIUM 2026-05-03).
 * Query params:
 *   - `limit` (1..200, default 50) — page size.
 *   - `cursor` (opaque base64url-encoded JSON tuple from prior page's
 *     `next_cursor`). Encodes (program_id, country_of_care,
 *     template_version, template_id). Pagination resumes from this
 *     position regardless of whether the cursor's original row still
 *     exists — a delete/archive between page fetches will not silently
 *     truncate the stream.
 *
 * Returns the projection type `FormTemplateSummary` (no JSONB layer
 * payloads). Detail (full FormTemplate) is fetched via
 * `GET /v0/forms/templates/:templateId`.
 *
 * Response shape: `{ items: FormTemplateSummary[], next_cursor: string | null }`.
 * `next_cursor` is null when the page came back shorter than `limit`
 * (caller has reached the end); otherwise it's the encoded tuple for
 * the next page.
 */
const LIST_TEMPLATES_DEFAULT_LIMIT = 50;
const LIST_TEMPLATES_MAX_LIMIT = 200;

function encodeCursor(payload: ListTemplatesCursor): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

function decodeCursor(raw: string): ListTemplatesCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf-8');
    const obj: unknown = JSON.parse(json);
    if (
      typeof obj === 'object' &&
      obj !== null &&
      'program_id' in obj &&
      'country_of_care' in obj &&
      'template_version' in obj &&
      'template_id' in obj &&
      typeof (obj as Record<string, unknown>)['program_id'] === 'string' &&
      typeof (obj as Record<string, unknown>)['country_of_care'] === 'string' &&
      typeof (obj as Record<string, unknown>)['template_version'] === 'number' &&
      typeof (obj as Record<string, unknown>)['template_id'] === 'string'
    ) {
      const r = obj as Record<string, unknown>;
      return {
        program_id: r['program_id'] as string,
        country_of_care: r['country_of_care'] as string,
        template_version: r['template_version'] as number,
        template_id: r['template_id'] as string,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function listTemplatesHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  // Admin-read auth gate (Codex variants-resume-http-r1 closure pattern
  // applied preemptively to templates 2026-05-03). Templates list is a
  // tenant-admin surface; even read endpoints require authenticated
  // actor identity. Without `x-actor-id` the shim returns 401 before
  // any DB access runs.
  void resolveActorId(req);
  requireAdminRole(req);

  const query = req.query as Record<string, unknown> | undefined;
  const rawLimit = query?.['limit'];
  const rawCursor = query?.['cursor'];

  let limit = LIST_TEMPLATES_DEFAULT_LIMIT;
  if (rawLimit !== undefined && rawLimit !== '') {
    const parsed = typeof rawLimit === 'string' ? Number.parseInt(rawLimit, 10) : NaN;
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > LIST_TEMPLATES_MAX_LIMIT) {
      throw req.server.httpErrors.badRequest(
        `Query param 'limit' must be an integer in [1, ${LIST_TEMPLATES_MAX_LIMIT}].`,
      );
    }
    limit = parsed;
  }

  let cursor: ListTemplatesCursor | null = null;
  if (typeof rawCursor === 'string' && rawCursor.length > 0) {
    cursor = decodeCursor(rawCursor);
    if (cursor === null) {
      throw req.server.httpErrors.badRequest(
        "Query param 'cursor' is not a valid pagination token.",
      );
    }
  }

  const items = await templateService.listTemplates(ctx, { limit, cursor });
  // The page is "exhausted" when the result is shorter than the requested
  // limit — there's no further page. Otherwise, encode the tuple of the
  // last item as the cursor for the next request.
  const nextCursor =
    items.length === limit && items.length > 0
      ? encodeCursor({
          program_id: items[items.length - 1]!.program_id,
          country_of_care: items[items.length - 1]!.country_of_care,
          template_version: items[items.length - 1]!.template_version,
          template_id: items[items.length - 1]!.template_id,
        })
      : null;
  return reply.code(200).send({ items, next_cursor: nextCursor });
}

/**
 * GET /v0/forms/templates/:templateId — read a single template.
 *
 * Returns 200 + body on hit. Returns 404 (tenant-blind per I-025) when
 * the template doesn't exist in this tenant — the response shape is the
 * same whether the template is genuinely absent or exists in another
 * tenant the caller can't see (RLS filtered).
 */
export async function getTemplateHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  // Admin-read auth gate (Codex variants-resume-http-r1 closure pattern
  // applied preemptively to templates 2026-05-03).
  void resolveActorId(req);
  requireAdminRole(req);

  const params = req.params as Record<string, unknown>;
  const templateIdParam = params['templateId'];
  if (typeof templateIdParam !== 'string' || templateIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `templateId` is required.');
  }

  const template = await templateService.getTemplate(ctx, templateIdParam);
  if (template === null) {
    throw req.server.httpErrors.notFound('Form template not found.');
  }
  return reply.code(200).send(template);
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
  requireAdminRole(req);

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

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    try {
      const published = await templateService.publishVersion(
        ctx,
        actorId,
        versionIdParam,
        parsed.data,
        tx,
      );
      return { status: 200, view: published };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === PUBLISH_VERSION_NOT_FOUND || message === PUBLISH_VERSION_NOT_DRAFT) {
        // Both sentinels map to the same tenant-blind 400 envelope per I-025
        // — the response MUST NOT differentiate "doesn't exist" vs "exists
        // in another tenant" vs "exists but isn't a draft." A precise
        // operator-facing error code is preserved in the envelope's `code`
        // field (mapped by the global error envelope plugin) so observability
        // tooling can distinguish; the wire-out message is uniform.
        // Throw inside body() so the surrounding tx rolls back and the
        // idempotency reservation is purged — clean retry possible.
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
  });
}
