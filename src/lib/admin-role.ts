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
  // Resolved tenant for THIS request. The handler always runs
  // requireTenantContext() before this shim, so calling it here is a
  // safe property read on the decorated request.
  const ctxTenantId: TenantId = requireTenantContext(req).tenantId;

  // Phase 2 admin widening (2026-05-15; v0.2 R1 HIGH closure
  // 2026-05-15): Tier 1 JWT-based admin identity. If the request
  // carries a verified JWT (req.actorContext present), the JWT IS
  // authoritative — there is NO fall-through to the legacy
  // x-actor-roles header shim. Closes Codex R1 HIGH:
  // "Verified non-admin JWT can fall through to trusted admin headers"
  // — without this fail-closed rule, a request with a verified
  // patient/clinician JWT + a forged `x-actor-roles: platform_admin`
  // header would authorize as admin in any environment with
  // ALLOW_ACTOR_HEADER_AUTH=true. The JWT identity boundary MUST
  // dominate.
  //
  // The JWT verify path + authContextPlugin have already enforced:
  //   - HS256 signature integrity
  //   - exp > now
  //   - role enum validation
  //   - role/admin_tenant_binding consistency
  //   - tenant_admin's admin_tenant_binding === resolved tenantCtx.tenantId
  //     (cross-tenant admin defense; rejected at authContextPlugin so
  //     req.actorContext is undefined for a wrong-tenant tenant_admin)
  // So: if req.actorContext.role is tenant_admin or platform_admin
  // HERE, we can trust the actor is authorized for the resolved tenant.
  const actorCtx = req.actorContext;
  if (actorCtx !== undefined) {
    if (actorCtx.role === PLATFORM_ADMIN_ROLE) {
      return PLATFORM_ADMIN_ROLE;
    }
    if (actorCtx.role === TENANT_SCOPED_ADMIN_ROLE) {
      // Defense-in-depth: re-check the binding here even though the
      // authContextPlugin already enforced it.
      if (actorCtx.adminTenantBinding === ctxTenantId) {
        return TENANT_SCOPED_ADMIN_ROLE;
      }
      // tenant_admin with wrong binding → 403 (fail closed, NO header
      // fall-through). The authContextPlugin would normally reject a
      // wrong-binding tenant_admin BEFORE this point (leaving
      // actorContext undefined), so reaching here means an internal
      // invariant broke; refuse anyway.
      throw req.server.httpErrors.forbidden(
        'This action requires an administrative role.',
      );
    }
    // Authenticated as patient or clinician — does NOT authorize admin
    // surfaces. JWT is authoritative; fail closed. Do NOT fall through
    // to header shim (closes Codex R1 HIGH where a verified non-admin
    // JWT could be elevated by a forged x-actor-roles header in
    // ALLOW_ACTOR_HEADER_AUTH=true environments).
    throw req.server.httpErrors.forbidden(
      'This action requires an administrative role.',
    );
  }

  // Tier 2 (legacy header shim): ONLY when no JWT was presented. Used
  // by tests that haven't migrated to JWT-based admin yet AND by
  // local-dev opt-in flows. Production requires ALLOW_ACTOR_HEADER_AUTH
  // opt-in; without it, unauthenticated requests get 401.
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
