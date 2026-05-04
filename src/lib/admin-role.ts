/**
 * admin-role.ts — placeholder admin-role authorization shim for tenant-admin
 * surfaces in modules that have not yet wired full RBAC.
 *
 * **Why this exists (Codex deployments-http-r1 closure 2026-05-03):** the
 * existing `resolveActorId` shim in each module's handler file proves
 * IDENTITY (the request carried an `x-actor-id`) but NOT AUTHORIZATION
 * (the actor has admin scope). Codex correctly flagged that admin
 * surfaces — templates, deployments, variants, and similar — could be
 * read by any authenticated tenant-network actor, including non-admin
 * patient or clinician actors who happen to have a valid `x-actor-id`
 * for some other API surface.
 *
 * This shim closes the gap with a thin role check that:
 *   - Reads `x-actor-roles` (comma-separated). Production fail-closed
 *     unless `ALLOW_ACTOR_HEADER_AUTH=true` (same env discipline as
 *     `resolveActorId`).
 *   - Throws 403 (NOT 401) when `x-actor-id` is present but no admin
 *     role is in the set. The 401 case (no actor identity at all) is
 *     handled separately by `resolveActorId` which callers run first.
 *   - Returns the matched role on success so the caller can audit which
 *     admin scope authorized the call.
 *
 * **Identity & Auth slice replaces this** when it lands. RBAC v1.1
 * roles include: `platform_admin`, `tenant_admin`, `clinician`,
 * `pharmacist`, `patient`, `delegate`. The admin endpoints accept the
 * first two. The shim's role-name set is forward-compatible with the
 * canonical RBAC roles.
 *
 * **Why a single shared shim instead of duplicating per handler:**
 * unlike `resolveActorId` (which the handler files deliberately
 * duplicate to keep each file's auth boundary obvious), the role check
 * is a derived predicate over the actor identity. Centralizing here
 * means a single change point when RBAC arrives. A handler-file
 * comment notes both shims work together: `resolveActorId` then
 * `requireAdminRole`.
 */

import type { FastifyRequest } from 'fastify';

/**
 * Canonical admin role names that satisfy a tenant-admin authorization
 * gate. Sourced from RBAC v1.1 — the Identity & Auth slice will
 * replace this hard-coded set with a permissions matrix lookup.
 */
const ADMIN_ROLES = new Set<string>(['platform_admin', 'tenant_admin']);

/**
 * Asserts the request carries one of the canonical admin roles via the
 * `x-actor-roles` header (comma-separated). Returns the matched role
 * on success.
 *
 * **Call ordering:** run AFTER `resolveActorId` in the handler. If the
 * actor identity isn't present, `resolveActorId` throws 401 first; this
 * function then runs and asserts the actor's role membership.
 *
 * @throws req.server.httpErrors.unauthorized — production env without
 *   `ALLOW_ACTOR_HEADER_AUTH=true`. Fail-closed; mirrors `resolveActorId`.
 * @throws req.server.httpErrors.forbidden — actor identity present but
 *   no admin role in the set.
 */
export function requireAdminRole(req: FastifyRequest): string {
  const isProd = process.env['NODE_ENV'] === 'production';
  const optIn = process.env['ALLOW_ACTOR_HEADER_AUTH'] === 'true';
  if (isProd && !optIn) {
    throw req.server.httpErrors.unauthorized(
      'Actor authorization could not be verified for this request.',
    );
  }

  const rolesHeader = req.headers['x-actor-roles'];
  const rolesRaw = typeof rolesHeader === 'string' ? rolesHeader : '';
  const roles = rolesRaw
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  for (const role of roles) {
    if (ADMIN_ROLES.has(role)) {
      return role;
    }
  }

  // Identity present (handler ran resolveActorId first) but role missing.
  // 403 — Forbidden, not 401 — to distinguish from no-identity.
  throw req.server.httpErrors.forbidden('This action requires an administrative role.');
}
