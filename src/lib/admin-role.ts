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
 * **Tenant-scope enforcement (Codex admin-auth-r1 closure 2026-05-03):**
 * the role check now also verifies tenant scope. `platform_admin` is
 * authorized in any tenant context (global). `tenant_admin` is bound
 * to a specific tenant via the `x-actor-admin-tenant` header — without
 * a binding header, or with a tenant_id mismatch, tenant_admin does
 * NOT authorize the request. Closes the cross-tenant-administration
 * hole where a tenant_admin for tenant A could otherwise admin tenant B.
 *
 * **Identity & Auth slice replaces this** when it lands. RBAC v1.1
 * roles include: `platform_admin`, `tenant_admin`, `clinician`,
 * `pharmacist`, `patient`, `delegate`. The admin endpoints accept the
 * first two. The shim's role-name set + tenant-scope semantics are
 * forward-compatible with the canonical RBAC v1.1 model.
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

import type { TenantId } from './glossary.js';
import { requireTenantContext } from './tenant-context.js';

/**
 * Canonical admin role names per RBAC v1.1.
 *
 * - `platform_admin`: global scope. Authorized in any tenant context.
 * - `tenant_admin`: tenant-scoped. The role assignment is bound to a
 *   specific tenant; the actor cannot admin any other tenant even if
 *   they hold tenant_admin in their home tenant.
 */
const TENANT_SCOPED_ADMIN_ROLE = 'tenant_admin';
const PLATFORM_ADMIN_ROLE = 'platform_admin';
const ADMIN_ROLES = new Set<string>([PLATFORM_ADMIN_ROLE, TENANT_SCOPED_ADMIN_ROLE]);

/**
 * Asserts the request carries an admin role authorized for the resolved
 * tenant context. Returns the matched role on success.
 *
 * **Call ordering:** run AFTER `resolveActorId` in the handler so the 401
 * for no-identity fires first; this function then asserts role + scope.
 *
 * **Tenant-scope enforcement:**
 *   - `platform_admin` is authorized in ANY tenant context (global).
 *   - `tenant_admin` is authorized ONLY when the role's tenant binding
 *     matches the request's resolved tenant context. The binding is
 *     supplied via the `x-actor-admin-tenant` header (placeholder until
 *     Identity & Auth supplies the scope from a verified JWT claim).
 *     Without the header (or with a mismatched tenant_id), tenant_admin
 *     does NOT authorize.
 *
 * The header-supplied tenant binding is INTENTIONALLY trust-on-first-use
 * under the existing `ALLOW_ACTOR_HEADER_AUTH` env opt-in — same
 * discipline as `resolveActorId`. Production fail-closed; the Identity
 * & Auth slice replaces the header with a verified RBAC permissions
 * lookup keyed off the JWT subject.
 *
 * @throws req.server.httpErrors.unauthorized — production env without
 *   `ALLOW_ACTOR_HEADER_AUTH=true`. Mirrors `resolveActorId`.
 * @throws req.server.httpErrors.forbidden — actor identity present but
 *   no admin role authorized for the resolved tenant.
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

  // Resolved tenant for THIS request. The handler always runs
  // requireTenantContext() before this shim, so calling it here is a
  // safe property read on the decorated request.
  const ctxTenantId: TenantId = requireTenantContext(req).tenantId;

  for (const role of roles) {
    if (!ADMIN_ROLES.has(role)) continue;

    // platform_admin is global — no tenant scope check needed.
    if (role === PLATFORM_ADMIN_ROLE) {
      return role;
    }

    // tenant_admin must be scoped to the resolved tenant. The
    // x-actor-admin-tenant header carries the role's tenant binding;
    // without it (or with mismatch) tenant_admin does NOT authorize
    // this request.
    if (role === TENANT_SCOPED_ADMIN_ROLE) {
      const adminTenantHeader = req.headers['x-actor-admin-tenant'];
      const adminTenantId =
        typeof adminTenantHeader === 'string' && adminTenantHeader.length > 0
          ? adminTenantHeader
          : null;
      if (adminTenantId === null) continue;
      if (adminTenantId !== ctxTenantId) continue;
      return role;
    }
  }

  // Either no admin role at all, or the only admin role was tenant_admin
  // for a different tenant. 403 Forbidden either way — distinguishes
  // from no-identity 401.
  throw req.server.httpErrors.forbidden('This action requires an administrative role.');
}
