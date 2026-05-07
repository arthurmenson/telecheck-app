/**
 * tenant-config admin write handlers — Sprint 3 / TLC-009.
 *
 * Write-side HTTP surface stubs for Admin Backend operators. At v0.1
 * every mutation handler returns 503 Service Unavailable: the dedicated
 * Admin Backend slice v1.1 owns operator-write authoring (and the
 * ADR-024 encryption-at-rest path for adapter_configs.adapter_config
 * payloads). This skeleton lands now so:
 *
 *   1. The route boundary under /v0/admin/* is fixed (no surprise
 *      additions when the slice authors write handlers)
 *   2. Operator monitoring can probe these endpoints and see canonical
 *      503 responses (matches the pharmacy and med-interaction skeleton
 *      pattern for unimplemented surfaces)
 *   3. Premature client integration is fail-closed via 503 instead of
 *      404 — clients learn "feature exists but is not yet enabled in
 *      this environment" rather than "endpoint does not exist"
 *
 * All routes require Bearer JWT (Tier 1 via `requireActorContext`) BEFORE
 * the 503 surfaces, matching the read-handlers' auth posture so that
 * unauthenticated probes can't enumerate the mutation surface.
 *
 * Per CLAUDE.md hard rule: do NOT author request-body schemas (Zod or
 * otherwise) for these handlers. Schema authoring is the Admin Backend
 * slice v1.1's responsibility.
 *
 * Spec references:
 *   - ADR-024 (per-tenant KMS — adapter_config encryption-at-rest)
 *   - Master PRD v1.10 §17 + Glossary v5.2 C3 (admin-only surfaces)
 *   - Contracts Pack v5.1 ERROR_MODEL (canonical 503 envelope shape)
 *   - I-025 (tenant-blind error envelopes)
 *   - Pattern mirror: src/modules/pharmacy/routes.ts (TLC-001)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireActorContext } from '../../../../lib/auth-context.js';

const ADMIN_WRITE_BLOCKED_MSG =
  'Admin Backend slice v1.1 is not yet implemented in this environment. ' +
  'Mutation handlers (PATCH/POST/DELETE) under /v0/admin/* require the ' +
  'dedicated Admin Backend slice + ADR-024 encryption-at-rest wiring; ' +
  'see slice PRD Telecheck_Admin_Backend_Slice_PRD_v1_1.md for scope.';

// ---------------------------------------------------------------------------
// PATCH /v0/admin/tenant-brand
// ---------------------------------------------------------------------------

export async function patchTenantBrandHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  // JWT-auth still required BEFORE the 503 — matches read-handler posture
  // so unauthenticated probes can't enumerate the mutation surface.
  requireActorContext(req);
  throw req.server.httpErrors.serviceUnavailable(ADMIN_WRITE_BLOCKED_MSG);
}

// ---------------------------------------------------------------------------
// PATCH /v0/admin/ccr-configs/:configKey
// ---------------------------------------------------------------------------

export async function patchCcrConfigHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  requireActorContext(req);
  throw req.server.httpErrors.serviceUnavailable(ADMIN_WRITE_BLOCKED_MSG);
}

// ---------------------------------------------------------------------------
// POST /v0/admin/adapter-configs
// ---------------------------------------------------------------------------

export async function createAdapterConfigHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  requireActorContext(req);
  throw req.server.httpErrors.serviceUnavailable(ADMIN_WRITE_BLOCKED_MSG);
}

// ---------------------------------------------------------------------------
// PATCH /v0/admin/adapter-configs/:adapterId
// ---------------------------------------------------------------------------

export async function patchAdapterConfigHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  requireActorContext(req);
  throw req.server.httpErrors.serviceUnavailable(ADMIN_WRITE_BLOCKED_MSG);
}

// ---------------------------------------------------------------------------
// DELETE /v0/admin/adapter-configs/:adapterId
// ---------------------------------------------------------------------------

export async function deleteAdapterConfigHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  requireActorContext(req);
  throw req.server.httpErrors.serviceUnavailable(ADMIN_WRITE_BLOCKED_MSG);
}

// ---------------------------------------------------------------------------
// GET /v0/admin/ready — readiness probe for the admin mutation surface
// ---------------------------------------------------------------------------

/**
 * Mutation-surface readiness probe. Returns 503 while Admin Backend
 * slice v1.1 is unimplemented. Matches the pharmacy and med-interaction
 * `/ready` patterns (Kubernetes / load-balancer can use this to keep
 * traffic away from the mutation surface). The READ surface
 * (GET /v0/admin/country-profiles, /tenant-brand, /ccr-configs,
 * /adapter-configs) remains independently ready — there is no module-
 * wide /ready since reads ship at v0.1 (TLC-004) and writes don't.
 *
 * No JWT required: readiness probes are tenant-blind monitoring
 * endpoints, allowlisted in tenantContextPlugin.
 */
export async function adminWriteReadyHandler(
  _req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  return reply.code(503).send({
    status: 'not_ready',
    surface: 'admin-write',
    blocked: 'Admin Backend slice v1.1',
    blocked_message:
      'Admin write surface (PATCH/POST/DELETE under /v0/admin/*) is not yet ' +
      'implemented; awaits Admin Backend slice v1.1 + ADR-024 encryption-at-rest. ' +
      'Read surface (/v0/admin/country-profiles, /tenant-brand, /ccr-configs, ' +
      '/adapter-configs) is independently ready.',
  });
}
