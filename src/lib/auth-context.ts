/**
 * auth-context.ts — Request-scoped actor context populated by the JWT
 * verification hook from the Identity slice.
 *
 * Replaces the forms-intake module's `x-actor-id` / `x-patient-id`
 * header stubs (gated by ALLOW_ACTOR_HEADER_AUTH config) with a
 * canonical JWT-resolved actor identity.
 *
 * Lifecycle:
 *   1. Tenant context resolved from Host header (tenant-context.ts plugin)
 *   2. Authorization header parsed: `Bearer <jwt>`
 *   3. JWT verified via jwt.ts verifyAccessToken (HS256 + alg-confusion
 *      defense; signature compare; expiry check)
 *   4. JWT claims' tenant_id MUST match the request's tenant context
 *      tenant_id (cross-tenant token forge defense — claim mismatch
 *      yields 401, NOT 403, to keep the response tenant-blind)
 *   5. ActorContext populated on req.actorContext for handlers
 *
 * The hook is REGISTERED but does NOT enforce by default — handlers
 * that need authn opt in via `requireActorContext(req)`. Endpoints
 * that are intentionally pre-auth (e.g., POST /registration/start,
 * POST /login/start) skip the require call.
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §3.3 (token claims)
 *   - I-023 (tenant_id is a claim AND is verified against the request's
 *     resolved tenant context)
 *   - I-025 (tenant-blind 401 envelope)
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { config } from './config.js';
import type { TenantId } from './glossary.js';
import { verifyAccessToken } from './jwt.js';

// ---------------------------------------------------------------------------
// ActorContext type
// ---------------------------------------------------------------------------

/**
 * Request-scoped actor identity. Populated by `authContextPlugin` when a
 * valid JWT is presented; remains undefined for pre-auth endpoints.
 */
export interface ActorContext {
  /** Account ID = the authenticated patient. */
  accountId: string;
  /** The session row backing this token. */
  sessionId: string;
  /** Tenant ID from the token (matches request's tenant context). */
  tenantId: TenantId;
  /**
   * Actor role at v1.0: patient | clinician. Operator / admin / research-
   * data-steward / etc. land with their respective slices (RBAC v1.1).
   * Widened from 'patient'-only at TLC-058 / 2026-05-13 to unblock the
   * pharmacy clinician-write surface (TLC-055 PR E onward). The
   * authContextPlugin populates this from the verified JWT's role claim;
   * the JWT verify path rejects any out-of-enum value, so a handler
   * receiving an actorContext can trust that role is one of the
   * canonical AccessTokenRole values.
   */
  role: 'patient' | 'clinician';
  /** Country of care from token. */
  countryOfCare: 'US' | 'GH';
  /** Delegate context when the patient is acting as a delegate. */
  delegateId: string | null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const authContextPluginImpl: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.decorateRequest('actorContext', undefined);

  fastify.addHook('onRequest', async (request, _reply) => {
    // Authorization header parsing. Tolerant: missing header is FINE
    // (pre-auth endpoints rely on this); malformed header is also FINE
    // (we silently leave actorContext undefined, and handlers that
    // require it will 401 via requireActorContext()).
    const authHeader = request.headers.authorization;
    if (typeof authHeader !== 'string') return;
    if (!authHeader.startsWith('Bearer ')) return;
    const token = authHeader.slice(7).trim();
    if (token.length === 0) return;

    const result = verifyAccessToken(token, config.jwtSigningKey);
    if (!result.ok) return;

    const claims = result.claims;

    // Cross-tenant token-forge defense: if the request's resolved tenant
    // context (from Host header) doesn't match the JWT's tenant_id
    // claim, the token was issued for a different tenant. Reject by
    // leaving actorContext undefined; handlers that require auth will
    // 401, response stays tenant-blind per I-025.
    const tenantCtx = request.tenantContext;
    if (tenantCtx === undefined) return; // allowlisted endpoint; no tenant → no actor
    if (tenantCtx.tenantId !== claims.tenant_id) return;

    request.actorContext = {
      accountId: claims.sub,
      sessionId: claims.session_id,
      tenantId: claims.tenant_id,
      role: claims.role,
      countryOfCare: claims.country_of_care,
      delegateId: claims.delegate_id ?? null,
    };
  });
};

export const authContextPlugin = fp(authContextPluginImpl, {
  name: 'auth-context',
  fastify: '5.x',
  // Depend on tenant-context plugin so request.tenantContext is populated
  // before this hook runs (we use it for the cross-tenant token-forge check).
  dependencies: ['tenant-context'],
});

// ---------------------------------------------------------------------------
// Module augmentation for req.actorContext
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Populated by `authContextPlugin` on requests presenting a valid
     * Bearer JWT whose tenant_id claim matches the resolved tenant
     * context. Undefined on pre-auth endpoints / missing-header / invalid
     * token / cross-tenant token forge.
     *
     * Handlers requiring authentication MUST call `requireActorContext()`.
     */
    actorContext: ActorContext | undefined;
  }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/**
 * Assert that `req.actorContext` is populated and return it. Mirror of
 * `requireTenantContext()`. Used by handlers that need authentication.
 *
 * Throws a typed error so the global error handler can map to a
 * tenant-blind 401 envelope (the throw bubbles to Fastify's error
 * lifecycle which the error-envelope plugin translates).
 */
export class UnauthenticatedError extends Error {
  readonly statusCode = 401;
  readonly code = 'internal.auth.unauthenticated';
  constructor() {
    super('Authentication is required.');
    this.name = 'UnauthenticatedError';
  }
}

export function requireActorContext(req: FastifyRequest): ActorContext {
  if (!req.actorContext) {
    throw new UnauthenticatedError();
  }
  return req.actorContext;
}

// ---------------------------------------------------------------------------
// Role-gated guards (TLC-058 / 2026-05-13)
//
// `requireActorContext()` returns ANY authenticated actor regardless of role.
// Patient-only and clinician-only handlers MUST opt in to a typed role gate
// so a clinician JWT can't drive patient-self-service routes (and vice
// versa). Closes Codex PR-118 R1 HIGH: widening ActorContext.role to
// include 'clinician' without role gates would let clinician accounts call
// async-consult initiate / consent grant / pharmacy patient-self-discontinue
// using their own clinician account_id as the patient anchor, creating
// patient workflow data under a non-patient identity. Both new helpers
// throw UnauthorizedRoleError → 403 on role mismatch (NOT 401 — auth IS
// presented; the issue is the actor's role is wrong for this endpoint).
//
// Migration discipline: every existing patient-only handler should swap
// `requireActorContext` for `requirePatientActorContext` so the role gate
// is enforced at the SAME point where actor identity is asserted. PR-E
// (pharmacy clinician writes) adds `requireClinicianActorContext` on its
// new clinician-only handlers. Routes that legitimately accept multiple
// roles (e.g., admin surfaces) stay on the generic `requireActorContext`
// and bring their own per-route role logic.
// ---------------------------------------------------------------------------

export class UnauthorizedRoleError extends Error {
  readonly statusCode = 403;
  readonly code = 'internal.auth.insufficient_scope';
  constructor(
    public readonly required: 'patient' | 'clinician',
    public readonly observed: 'patient' | 'clinician',
  ) {
    super(`This endpoint requires role=${required}; actor role=${observed}.`);
    this.name = 'UnauthorizedRoleError';
  }
}

/**
 * Assert that the request carries an authenticated PATIENT actor.
 * Returns a narrowed ActorContext typed as `role: 'patient'` so
 * downstream handlers can use `actor.accountId` as the patient anchor
 * with TypeScript-level confidence the actor IS a patient.
 *
 * Throws:
 *   - UnauthenticatedError (401) on missing/invalid JWT
 *   - UnauthorizedRoleError (403) on role !== 'patient'
 */
export function requirePatientActorContext(
  req: FastifyRequest,
): ActorContext & { role: 'patient' } {
  const actor = requireActorContext(req);
  if (actor.role !== 'patient') {
    throw new UnauthorizedRoleError('patient', actor.role);
  }
  return actor as ActorContext & { role: 'patient' };
}

/**
 * Assert that the request carries an authenticated CLINICIAN actor.
 * Mirror of requirePatientActorContext; lands ahead of TLC-055 PR E so
 * the new clinician write handlers can adopt this pattern day-1.
 *
 * Throws:
 *   - UnauthenticatedError (401) on missing/invalid JWT
 *   - UnauthorizedRoleError (403) on role !== 'clinician'
 */
export function requireClinicianActorContext(
  req: FastifyRequest,
): ActorContext & { role: 'clinician' } {
  const actor = requireActorContext(req);
  if (actor.role !== 'clinician') {
    throw new UnauthorizedRoleError('clinician', actor.role);
  }
  return actor as ActorContext & { role: 'clinician' };
}

/**
 * Reject CLINICIAN actors from admin routes (Codex PR-118 R7 HIGH closure
 * 2026-05-13). The full admin-role mechanism (tenant_admin / platform_admin
 * tokens) lands with a future Admin Backend slice; until then, admin
 * routes accept any authenticated actor by historical convention — a
 * pre-existing role-gap that exists on main. TLC-058 widens AccessTokenRole
 * to include 'clinician', which would let clinician JWTs reach those
 * admin routes too. This guard closes the NEW attack surface introduced
 * by clinician JWT issuance: clinician → 403; patient still passes
 * (pre-existing gap, tracked as a separate follow-on for the admin-role
 * gate PR).
 *
 * The narrow scope is deliberate: this PR's mission is the clinician role
 * mechanism. Closing the pre-existing patient gap on admin routes
 * properly requires authoring the admin-role token + admin-role
 * mapping in identity, which is its own PR.
 */
export function rejectClinicianOnAdminRoute(req: FastifyRequest): ActorContext {
  const actor = requireActorContext(req);
  if (actor.role === 'clinician') {
    throw new UnauthorizedRoleError('patient', 'clinician');
  }
  return actor;
}
