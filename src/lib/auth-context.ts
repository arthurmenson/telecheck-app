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
import type { PoolClient } from 'pg';

import { type BindActorRole, bindActorContextForRequest } from './actor-context-binding.js';
import { config } from './config.js';
import { getBindActorContextPool } from './db.js';
import type { TenantId } from './glossary.js';
import { verifyAccessToken } from './jwt.js';
import { lookupActiveTenantById } from './tenant-context.js';

/**
 * Phase 2 F-2 R1 MEDIUM closure (2026-05-15): canonical tenant_id
 * format validator. Rejects whitespace-padded, empty, lowercase, and
 * any value not matching `Telecheck-{Country}` (one uppercase letter
 * followed by letters). Tightens the DB-lookup boundary so a
 * malformed JWT claim cannot probe the tenants table.
 *
 * Matches the format pattern from `glossary.ts asTenantId()`, kept
 * local to avoid pulling in the validation error path (auth hook
 * silently leaves actorContext undefined on failure).
 */
const CANONICAL_TENANT_ID_PATTERN = /^Telecheck-[A-Z][A-Za-z]+$/;
function isCanonicalTenantIdFormat(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  if (raw.trim() !== raw) return false; // reject leading/trailing whitespace
  return CANONICAL_TENANT_ID_PATTERN.test(raw);
}

// ---------------------------------------------------------------------------
// ActorContext type
// ---------------------------------------------------------------------------

/**
 * Request-scoped actor identity. Populated by `authContextPlugin` when a
 * valid JWT is presented; remains undefined for pre-auth endpoints.
 */
export interface ActorContext {
  /** Account ID = the authenticated actor. */
  accountId: string;
  /** The session row backing this token. */
  sessionId: string;
  /** Tenant ID from the token (matches request's tenant context). */
  tenantId: TenantId;
  /**
   * Actor role. Phase 2 (2026-05-15) widens beyond patient + clinician
   * to include tenant_admin + platform_admin. Operator / pharmacist /
   * research-data-steward etc. land with their respective slices
   * (RBAC v1.1). The authContextPlugin populates this from the verified
   * JWT's role claim; the JWT verify path rejects any out-of-enum value,
   * so a handler receiving an actorContext can trust that role is one
   * of the canonical AccessTokenRole values.
   *
   * Cross-tenant admin defense: for role='tenant_admin', the
   * authContextPlugin ALSO verifies the JWT's admin_tenant_binding claim
   * matches the request's resolved tenant context. A binding mismatch
   * leaves actorContext undefined (handler will 401, response stays
   * tenant-blind per I-025). platform_admin is global (no binding).
   */
  role: 'patient' | 'clinician' | 'tenant_admin' | 'platform_admin';
  /** Country of care from token. */
  countryOfCare: 'US' | 'GH';
  /** Delegate context when the patient is acting as a delegate. */
  delegateId: string | null;
  /**
   * Phase 2 admin widening: for role='tenant_admin', the tenant_id the
   * admin is authorized to administer (already verified to match
   * tenantId at JWT-verify time). null for all other roles.
   */
  adminTenantBinding: string | null;
  /**
   * Phase 2 R3 HIGH closure (2026-05-15): for role='platform_admin',
   * the admin's HOME tenant (the tenant_id claim from the JWT). Used
   * for audit attribution showing which admin acted, distinct from the
   * RESOURCE tenant (which is the resolved request tenant carried by
   * `tenantId` above). null for all other roles.
   *
   * Why this exists: platform_admin is GLOBAL — a platform_admin
   * issued under Telecheck-US CAN administer Telecheck-Ghana
   * resources via JWT. The resource side scopes via
   * `actorContext.tenantId` (= resolved request tenant). The actor
   * side is attributed via `adminHomeTenantId` so audit records can
   * trace which admin's home tenant the cross-tenant action came from.
   */
  adminHomeTenantId: string | null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const authContextPluginImpl: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.decorateRequest('actorContext', undefined);
  fastify.decorateRequest('bearerTokenPresented', false);
  // SI-010 actor-context nonce — populated in a successor PR's onRequest
  // hook update once the dedicated bind-pool wiring lands. Decorated
  // here with the default-undefined value so the type augmentation in
  // this file accurately reflects request runtime shape.
  fastify.decorateRequest('actorNonce', undefined);

  fastify.addHook('onRequest', async (request, _reply) => {
    // Authorization header parsing. Tolerant: missing header is FINE
    // (pre-auth endpoints rely on this); malformed header is also FINE
    // (we silently leave actorContext undefined, and handlers that
    // require it will 401 via requireActorContext()).
    //
    // Phase 2 R5 HIGH-1 closure (2026-05-15): parse the auth scheme
    // CASE-INSENSITIVELY per RFC 7235 §2.1 ("the scheme name is
    // case-insensitive"). Original `.startsWith('Bearer ')` rejected
    // `authorization: bearer <token>` (lowercase b) — leaving both
    // actorContext undefined AND bearerTokenPresented false, which on
    // admin routes with ALLOW_ACTOR_HEADER_AUTH=true would let a forged
    // `x-actor-roles: platform_admin` header elevate via the legacy
    // shim (the fail-closed boundary added at R2 only triggers when
    // bearerTokenPresented=true). Case-insensitive parsing closes the
    // header-casing-based bypass.
    const authHeader = request.headers.authorization;
    if (typeof authHeader !== 'string') return;
    // Match "Bearer " case-insensitively (anchor: 6-char scheme + 1 space)
    if (authHeader.length < 7) return;
    const scheme = authHeader.slice(0, 7);
    if (scheme.toLowerCase() !== 'bearer ') return;
    const token = authHeader.slice(7).trim();
    if (token.length === 0) return;

    // Phase 2 R2 HIGH closure (2026-05-15): record that a Bearer token
    // was presented BEFORE attempting verification. This lets
    // downstream auth gates (requireAdminRole) distinguish
    // "no JWT attempted" (header shim acceptable) from "JWT attempted
    // but rejected" (header shim MUST NOT be used; the rejection is
    // authoritative). Without this flag, an invalid/expired/wrong-
    // tenant/wrong-binding JWT combined with a forged x-actor-roles
    // header would silently elevate via the legacy path.
    request.bearerTokenPresented = true;

    const result = verifyAccessToken(token, config.jwtSigningKey);
    if (!result.ok) return;

    const claims = result.claims;

    // Resolve request tenant context (set by tenant-context plugin from
    // Host header). For pre-auth / allowlisted endpoints this is
    // undefined; without a tenant we can't run any cross-tenant check,
    // so leave actorContext undefined.
    const tenantCtx = request.tenantContext;
    if (tenantCtx === undefined) return;

    // Phase 2 R3 HIGH closure (2026-05-15): tenant-scope validation
    // varies by role:
    //
    //   - patient / clinician / tenant_admin: the actor is tenant-scoped.
    //     The JWT's tenant_id claim MUST equal the resolved request
    //     tenant. Mismatch = cross-tenant token forge attempt → reject.
    //
    //   - platform_admin: the actor is GLOBAL. The JWT's tenant_id
    //     claim is the admin's HOME tenant (used for audit attribution
    //     showing which admin acted) but does NOT need to match the
    //     resolved request tenant. A platform_admin issued under
    //     Telecheck-US CAN administer Telecheck-Ghana resources via JWT.
    //
    // Closes Codex R3 HIGH: "Global platform_admin JWTs are still
    // tenant-pinned by the auth hook" — the original implementation
    // enforced tenant_id match for every role, making platform_admin
    // unusable across tenants and defeating the documented global
    // scope.
    let trustedHomeCountryOfCare: 'US' | 'GH' | null = null;
    if (claims.role !== 'platform_admin') {
      if (tenantCtx.tenantId !== claims.tenant_id) return;
    } else {
      // Phase 2 R4 HIGH-2 + R5 HIGH-2 + F-2 R1+R2 closure
      // (2026-05-15): platform_admin is global, but the JWT's
      // home-tenant claim MUST be a DB-active tenant AND its
      // country_of_care claim MUST match the DB row's country.
      // Closes F-2 R2 HIGH: "Platform admin DB validation does not
      // bind country_of_care to the validated tenant." Without this
      // bind, a JWT could carry a stale country_of_care that flowed
      // into ActorContext unchecked.
      //
      // Admin auth is fail-closed on every uncertainty:
      //   - format validation rejects whitespace/non-canonical IDs
      //   - DB 'inactive_or_unknown' → fail closed
      //   - DB 'unreachable' → fail closed (closes R1 HIGH; unlike
      //     host resolution, admin auth has higher criticality than
      //     availability)
      //   - country_of_care claim ≠ DB row → fail closed
      if (!isCanonicalTenantIdFormat(claims.tenant_id)) return;
      // F-2 R3 HIGH closure (2026-05-15): a reachable-DB SQL/schema/
      // permission error from lookupActiveTenantById re-throws by
      // design (caller-discretion semantics; same pattern as
      // resolveHostFromDb). For the AUTH BOUNDARY here, that would
      // escape and turn admin requests into 500s instead of
      // tenant-blind 401s. Wrap with try/catch + fail closed, but
      // still log the underlying error so operators can triage
      // schema drift / permission regressions without losing the
      // signal. Connection failures and 'inactive_or_unknown' both
      // fall through to the unified fail-closed path below.
      let dbResult: Awaited<ReturnType<typeof lookupActiveTenantById>>;
      try {
        dbResult = await lookupActiveTenantById(claims.tenant_id);
      } catch (err) {
        request.log?.error?.(
          { err, tenant_id: claims.tenant_id, sub: claims.sub },
          'auth-context: lookupActiveTenantById threw for platform_admin JWT — failing closed',
        );
        return;
      }
      if (dbResult.kind !== 'active') return;
      // Country binding: the JWT's country_of_care claim MUST match
      // the validated home tenant's country in the tenants row.
      if (claims.country_of_care !== dbResult.country_of_care) return;
      trustedHomeCountryOfCare = dbResult.country_of_care;
    }

    // Phase 2 admin widening (2026-05-15): cross-tenant admin defense
    // for tenant_admin. The JWT's admin_tenant_binding claim MUST
    // match the resolved request tenant. Without that match, the
    // actor is rejected (response stays tenant-blind per I-025).
    // platform_admin has no binding (global; enforced by verify path
    // that requires binding to be absent/null for platform_admin).
    if (claims.role === 'tenant_admin') {
      // verifyAccessToken already enforced binding is a non-empty string
      // for tenant_admin; this is the request-side scope check.
      if (claims.admin_tenant_binding !== tenantCtx.tenantId) return;
      // Also enforce binding === JWT's tenant_id (defense in depth;
      // tenant_id === resolved tenantCtx.tenantId is already enforced
      // above for non-platform_admin roles, so this is logically
      // equivalent, but readers shouldn't have to reason about
      // transitive equality).
      if (claims.admin_tenant_binding !== claims.tenant_id) return;
    }

    // actorContext.tenantId:
    //   - For tenant-scoped roles, this === resolved tenantCtx.tenantId
    //     (already enforced equal to claims.tenant_id above).
    //   - For platform_admin, this is set to the RESOLVED request
    //     tenant — the tenant the admin is currently acting on —
    //     because handlers + audit emission scope to actorContext.tenantId
    //     when writing tenant-scoped resources. The admin's home
    //     tenant from claims.tenant_id is retained as
    //     adminHomeTenantId for audit-attribution purposes.
    const effectiveTenantId =
      claims.role === 'platform_admin' ? tenantCtx.tenantId : claims.tenant_id;

    // F-2 R2 HIGH closure: for platform_admin, prefer the DB-trusted
    // country (which equals the JWT claim after the equality check
    // above — but using the DB value defensively kills any path where
    // a later refactor relaxes the equality check and the claim still
    // flows through).
    const effectiveCountryOfCare =
      claims.role === 'platform_admin' && trustedHomeCountryOfCare !== null
        ? trustedHomeCountryOfCare
        : claims.country_of_care;

    request.actorContext = {
      accountId: claims.sub,
      sessionId: claims.session_id,
      tenantId: effectiveTenantId,
      role: claims.role,
      countryOfCare: effectiveCountryOfCare,
      delegateId: claims.delegate_id ?? null,
      adminTenantBinding:
        claims.role === 'tenant_admin' ? (claims.admin_tenant_binding ?? null) : null,
      adminHomeTenantId: claims.role === 'platform_admin' ? claims.tenant_id : null,
    };

    // SI-010: bind a per-request actor identity row in
    // _session_actor_context so DB-side SECURITY DEFINER procedures
    // (SI-005 record_consult_clinician_decision, SI-008
    // record_workflow_pointer_swap, SI-009
    // record_consult_escalation_target_swap, etc.) can resolve the
    // authenticated actor via current_actor_*() helpers — without
    // trusting caller-supplied parameters or GUC values.
    //
    // Trust model (per docs/SI-010 §"Trust model"):
    //   - The bind invocation runs on a DEDICATED bind pool (config.
    //     bindActorContextDatabaseUrl) whose session_user is
    //     bind_actor_context_role, NOT telecheck_app_role.
    //   - The migration's session_user gate inside bind_actor_context()
    //     refuses calls whose session_user is telecheck_app_role.
    //   - The nonce is high-entropy UUIDv4, generated server-side,
    //     NEVER logged (LOG_REDACT_PATHS covers req.actorNonce).
    //
    // Fail-closed posture:
    //   - When the bind pool is not configured (dev/test), skip the
    //     bind. Requests proceed without actorNonce; DB-side helpers
    //     raise actor_context_unbound if invoked, which is correct
    //     fail-closed behavior at the procedure boundary.
    //   - When the bind pool is configured but the invocation throws
    //     (DB unreachable, session_user gate triggered by misconfig,
    //     malformed inputs), CLEAR actorContext + leave actorNonce
    //     undefined. The request flows to handlers without an
    //     authenticated identity — requireActorContext() will 401
    //     via the canonical tenant-blind envelope. The thrown error
    //     is logged (without the nonce value) for ops triage.
    const bindPool = getBindActorContextPool();
    if (bindPool !== null) {
      // pg.PoolClient is the precise type from `bindPool.connect()`.
      let bindClient: PoolClient | null = null;
      try {
        bindClient = await bindPool.connect();
        // Role mapping mirrors the migration's CHECK constraint.
        // `delegate` is currently not minted by the JWT scaffold but is
        // included in BindActorRole for future delegated-access flows
        // (Consent slice).
        const bindRole: BindActorRole = claims.role;
        const adminHome = claims.role === 'platform_admin' ? claims.tenant_id : null;
        const bound = await bindActorContextForRequest(bindClient, {
          actorAccountId: claims.sub,
          actorAccountTenantId: claims.tenant_id,
          actorRole: bindRole,
          actorAdminHomeTenantId: adminHome,
          sessionId: claims.session_id,
        });
        request.actorNonce = bound.nonce;
      } catch (err) {
        // Fail closed: clear actorContext so the request is effectively
        // unauthenticated. Log with shallow error context only — do NOT
        // include the (never-set) nonce. The logger's redact paths
        // cover req.actorNonce anyway; this is belt-and-suspenders.
        request.log?.error?.(
          {
            err,
            sub: claims.sub,
            role: claims.role,
            tenant_id: claims.tenant_id,
          },
          'auth-context: SI-010 bind_actor_context failed — failing closed (actorContext cleared)',
        );
        request.actorContext = undefined;
        request.actorNonce = undefined;
      } finally {
        if (bindClient !== null) {
          try {
            bindClient.release();
          } catch {
            // Best-effort release; swallow to avoid masking the
            // primary error path above.
          }
        }
      }
    }
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

    /**
     * Phase 2 R2 HIGH closure (2026-05-15): true if the request's
     * `Authorization: Bearer <token>` header carried a non-empty
     * token VALUE — set BEFORE JWT verification. This decouples
     * "client attempted JWT auth" from "JWT verified successfully":
     *
     *   - bearerTokenPresented=false + actorContext=undefined: client
     *     did not attempt JWT auth. Legacy header shim is acceptable.
     *   - bearerTokenPresented=true + actorContext=undefined: client
     *     attempted JWT auth but verification rejected (invalid
     *     signature / expired / wrong tenant / wrong binding /
     *     malformed). Legacy header shim MUST NOT authorize this
     *     request — the rejection is authoritative.
     *   - bearerTokenPresented=true + actorContext=ActorContext: JWT
     *     verified successfully.
     *
     * Used by `requireAdminRole` to fail closed when a JWT was
     * presented but rejected, even if a forged `x-actor-roles` header
     * is also present.
     */
    bearerTokenPresented: boolean;

    /**
     * SI-010 per-request actor-context nonce. Populated by the
     * authContextPlugin onRequest hook AFTER successful JWT
     * verification AND successful `bind_actor_context()` invocation
     * on the dedicated bind pool (added in a successor PR in the
     * Phase A track of the Master Completion Plan v1.0).
     *
     * Treated as a request-bound shared secret (nonce-as-secret per
     * SI-010 R3 closure):
     *   - High-entropy UUIDv4 (122 bits).
     *   - Generated server-side; never accepted from client input.
     *   - NEVER logged. `LOG_REDACT_PATHS` includes `req.actorNonce`
     *     and any field path leading to it.
     *   - TTL 5 minutes (matches the DB row's expires_at).
     *
     * Handlers that need server-derived actor identity in DB
     * procedures use `withActorContext(tx, req.actorNonce, ...)`
     * (from `actor-context-binding.ts`) inside their existing
     * `withTransaction` wrapper.
     *
     * Undefined when the request was not authenticated OR when the
     * bind step failed (in which case authContextPlugin fails closed
     * by leaving both actorContext AND actorNonce undefined).
     */
    actorNonce: string | undefined;
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

export type ActorRole = 'patient' | 'clinician' | 'tenant_admin' | 'platform_admin';

export class UnauthorizedRoleError extends Error {
  readonly statusCode = 403;
  readonly code = 'internal.auth.insufficient_scope';
  constructor(
    public readonly required: ActorRole | ReadonlyArray<ActorRole>,
    public readonly observed: ActorRole,
  ) {
    const requiredStr = Array.isArray(required) ? required.join('|') : String(required);
    super(`This endpoint requires role=${requiredStr}; actor role=${observed}.`);
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

// ---------------------------------------------------------------------------
// SI-022 `crisis_initiator` slice-role gate (Codex R1 #201 finding 2 closure
// 2026-05-24)
// ---------------------------------------------------------------------------

/**
 * SI-022 §7 ratified `crisis_initiator` slice-role membership. Per the
 * spec these actors are entitled to initiate a crisis_event via
 * `record_crisis_initiation()`:
 *
 *   - clinician                — clinical staff acting in their own
 *                                 tenant
 *   - on_call_clinician        — on-call clinician (cross-shift /
 *                                 escalation-rotation member)
 *   - ai_mode1_service         — Mode 1 AI Service handler service
 *                                 account (autonomous initiation from
 *                                 platform-floor crisis detection per
 *                                 I-019 + FLOOR-020)
 *
 * Returned by `requireCrisisInitiatorActorContext` so the caller can
 * thread it into `emitCrisisDetectedAudit`'s `crisisInitiatorIdentity`
 * arg — that emitter derives the canonical `actor_type` from this
 * identity (clinician / on_call_clinician → 'clinician',
 * ai_mode1_service → 'ai_workload') via its `CRISIS_INITIATOR_ACTOR_TYPE`
 * map. Single-source-of-truth for the slice-role → ActorType
 * derivation lives at the emitter; this gate's job is asserting the
 * caller's eligibility + returning the bound identity.
 */
export type CrisisInitiatorIdentity =
  | 'clinician'
  | 'on_call_clinician'
  | 'ai_mode1_service';

/**
 * Narrowed ActorContext extension for callers of
 * `requireCrisisInitiatorActorContext`. The `crisisInitiatorIdentity`
 * field carries the bound SI-022 §7 slice-role identity used for
 * audit attribution + future SQL-side role acquisition (when the
 * JWT-role → DB-slice-role mapping lands).
 */
export interface CrisisInitiatorActorContext extends ActorContext {
  crisisInitiatorIdentity: CrisisInitiatorIdentity;
}

/**
 * Assert that the request carries an authenticated actor that is a
 * member of the SI-022 §7 `crisis_initiator` slice role, and return
 * the bound identity for audit attribution.
 *
 * **Eligibility (closest-available Layer B gate):** Sprint 2 PR 2
 * (this PR) accepts JWT role='clinician' only. The on_call_clinician
 * + ai_mode1_service branches are wired through this function's
 * return type + the emitter's `CRISIS_INITIATOR_ACTOR_TYPE` map so
 * the future expansion (when the JWT-role → DB-slice-role mapping
 * lands — Phase A successor to SI-010 / SI-024.1) is a one-line
 * change here without any call-site refactor:
 *
 *   1. Add an `on_call_clinician` ActorRole variant (or a JWT claim
 *      distinguishing on-call from regular clinician) + branch here
 *      to set `crisisInitiatorIdentity: 'on_call_clinician'`.
 *   2. Add an `ai_mode1_service` ActorRole variant (or a service-
 *      account principal pattern) + branch here to set
 *      `crisisInitiatorIdentity: 'ai_mode1_service'`.
 *
 * Until then, every legitimate caller is `role='clinician'` + binds
 * to `crisisInitiatorIdentity: 'clinician'`.
 *
 * **Defense-in-depth at the SQL boundary:** even if a non-clinician
 * actor bypassed this gate, the DB layer fails closed — the request's
 * bound role (`telecheck_app_role`) is NOINHERIT-member of
 * `crisis_initiator` per migration 051, and `record_crisis_initiation()`
 * is EXECUTE-granted ONLY to `crisis_initiator` per migration 036 §3.
 * The Fastify gate is a usability layer (correct 403 envelope; pre-
 * `withDbRole` short-circuit); the SQL boundary is the security floor.
 *
 * **Distinction from `requireClinicianActorContext`:** the generic
 * clinician gate returns `ActorContext & { role: 'clinician' }`
 * (typed-narrowed to the JWT role); this gate ALSO binds the SI-022
 * slice-role identity used for audit attribution. Callers in the
 * crisis-response slice MUST use this gate — the slice-role identity
 * is part of the SI-022 §3 `crisis.detected` audit-row contract.
 *
 * Throws:
 *   - UnauthenticatedError (401) on missing/invalid JWT
 *   - UnauthorizedRoleError (403) on role outside crisis_initiator
 *     membership (currently: any role !== 'clinician'; expanded
 *     when on_call_clinician / ai_mode1_service JWT identity is
 *     wired)
 */
export function requireCrisisInitiatorActorContext(
  req: FastifyRequest,
): CrisisInitiatorActorContext {
  const actor = requireActorContext(req);
  // Closest-available Layer B gate: only 'clinician' is currently
  // wired through the JWT into a SI-022 §7 crisis_initiator slice-role
  // identity. Expand the accepted roles + the identity-derivation
  // switch when on_call_clinician / ai_mode1_service JWT identity
  // lands.
  if (actor.role !== 'clinician') {
    throw new UnauthorizedRoleError('clinician', actor.role);
  }
  // The slice-role identity is the canonical attribution value the
  // emitter consumes; today's clinician JWT maps to the 'clinician'
  // branch of CrisisInitiatorIdentity.
  const crisisInitiatorIdentity: CrisisInitiatorIdentity = 'clinician';
  return Object.assign({}, actor, { crisisInitiatorIdentity });
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
 * **Phase 2 admin widening note (2026-05-15):** Phase 2 lands the proper
 * admin-role gate via `requireAdminActorContext` (below). New admin
 * handlers SHOULD use that gate; this legacy helper is preserved for
 * back-compat with handlers that haven't migrated yet but no longer
 * blocks tenant_admin / platform_admin actors (they pass the legacy
 * "anyone-not-clinician" floor).
 */
export function rejectClinicianOnAdminRoute(req: FastifyRequest): ActorContext {
  const actor = requireActorContext(req);
  if (actor.role === 'clinician') {
    throw new UnauthorizedRoleError('patient', 'clinician');
  }
  return actor;
}

// ---------------------------------------------------------------------------
// Phase 2 admin-role gates (2026-05-15)
//
// `requireTenantAdminActorContext` and `requirePlatformAdminActorContext`
// land alongside the AccessTokenRole widening so admin handlers can adopt
// JWT-based admin identity (replacing the legacy `x-actor-roles` header
// shim + `requireAdminRole`). `requireAdminActorContext` accepts EITHER
// admin role — the right gate for endpoints that don't need to distinguish
// (e.g., forms-intake admin CRUD where both tenant_admin and platform_admin
// can manage templates).
// ---------------------------------------------------------------------------

/**
 * Assert that the request carries an authenticated TENANT_ADMIN actor.
 * Mirror of requirePatientActorContext.
 *
 * Throws:
 *   - UnauthenticatedError (401) on missing/invalid JWT
 *   - UnauthorizedRoleError (403) on role !== 'tenant_admin'
 *
 * NOTE: the cross-tenant binding check (the tenant_admin's
 * admin_tenant_binding === resolved tenantCtx.tenantId) is already
 * enforced by authContextPlugin before this guard runs. A handler
 * receiving the returned actor can trust the binding has been verified.
 */
export function requireTenantAdminActorContext(
  req: FastifyRequest,
): ActorContext & { role: 'tenant_admin' } {
  const actor = requireActorContext(req);
  if (actor.role !== 'tenant_admin') {
    throw new UnauthorizedRoleError('tenant_admin', actor.role);
  }
  return actor as ActorContext & { role: 'tenant_admin' };
}

/**
 * Assert that the request carries an authenticated PLATFORM_ADMIN actor.
 * Mirror of requireTenantAdminActorContext. platform_admin is global —
 * authorized in any tenant context.
 *
 * Throws:
 *   - UnauthenticatedError (401) on missing/invalid JWT
 *   - UnauthorizedRoleError (403) on role !== 'platform_admin'
 */
export function requirePlatformAdminActorContext(
  req: FastifyRequest,
): ActorContext & { role: 'platform_admin' } {
  const actor = requireActorContext(req);
  if (actor.role !== 'platform_admin') {
    throw new UnauthorizedRoleError('platform_admin', actor.role);
  }
  return actor as ActorContext & { role: 'platform_admin' };
}

/**
 * Assert that the request carries an authenticated admin actor — EITHER
 * tenant_admin OR platform_admin. Use this on admin endpoints that don't
 * need to distinguish (e.g., forms-intake template CRUD).
 *
 * Throws:
 *   - UnauthenticatedError (401) on missing/invalid JWT
 *   - UnauthorizedRoleError (403) on role !== 'tenant_admin' && role !== 'platform_admin'
 */
export function requireAdminActorContext(
  req: FastifyRequest,
): ActorContext & { role: 'tenant_admin' | 'platform_admin' } {
  const actor = requireActorContext(req);
  if (actor.role !== 'tenant_admin' && actor.role !== 'platform_admin') {
    throw new UnauthorizedRoleError(['tenant_admin', 'platform_admin'], actor.role);
  }
  return actor as ActorContext & { role: 'tenant_admin' | 'platform_admin' };
}

// ---------------------------------------------------------------------------
// F-4 platform_admin audit attribution helper (Phase 2 R6 HIGH-2 closure;
// 2026-05-15)
//
// Closes Codex R6 HIGH-2: "Cross-tenant platform-admin actions are audited
// under the resource tenant, not the admin home tenant." Handlers that emit
// audit records pass actor_tenant_id to the audit envelope. Pre-F-4
// convention was to pass ctx.tenantId (the resolved resource tenant) —
// which is correct for tenant-scoped actors (patient/clinician/tenant_admin
// all act within their home tenant) but WRONG for platform_admin acting
// cross-tenant: a US platform_admin administering a Telecheck-Ghana
// resource would be audited as a Ghana actor, hiding the cross-tenant
// administrative access.
//
// resolveActorTenantId returns the correct actor_tenant_id for audit:
//   - platform_admin → adminHomeTenantId (the admin's home tenant; the
//     audit row's tenant_id is still the resource tenant via ctx.tenantId,
//     but actor_tenant_id traces back to the admin's home)
//   - tenant_admin → tenantId (== adminTenantBinding == resource tenant;
//     all equal by the authContextPlugin's binding check)
//   - patient / clinician → tenantId (actor's home tenant, which is also
//     the resource tenant for these tenant-scoped roles)
//   - unauthenticated → throws UnauthenticatedError (401)
//
// Handlers call this BEFORE the service-layer audit emission and thread
// the result to the service, which in turn passes it to the audit
// envelope's actor_tenant_id field. Services that hardcoded
// `actorTenantId: ctx.tenantId` are migrated to accept actorTenantId
// from the caller.
// ---------------------------------------------------------------------------

export function resolveActorTenantId(req: FastifyRequest): string {
  const actor = requireActorContext(req);
  if (actor.role === 'platform_admin') {
    // Defense-in-depth: adminHomeTenantId is populated by
    // authContextPlugin for platform_admin and is the JWT's tenant_id
    // claim post-DB-validation (F-2). If for any reason it's null,
    // refuse — better to surface a hard error than mis-attribute the
    // audit row.
    if (actor.adminHomeTenantId === null || actor.adminHomeTenantId.length === 0) {
      throw new Error(
        'resolveActorTenantId: platform_admin actor has null/empty adminHomeTenantId. ' +
          'authContextPlugin should have populated this from the JWT claim. ' +
          'This is a programming error; investigate.',
      );
    }
    return actor.adminHomeTenantId;
  }
  // patient / clinician / tenant_admin — actor's tenant equals the
  // resource tenant (enforced at JWT verify + tenant-claim equality
  // check for non-platform_admin roles).
  return actor.tenantId;
}

/**
 * Transition-aware wrapper around `resolveActorTenantId` for handlers
 * that may receive non-JWT requests during the Tier 2 retirement
 * transition. When `req.actorContext` is populated, delegates to
 * `resolveActorTenantId` (returns adminHomeTenantId for platform_admin,
 * tenantId for tenant-scoped roles). When actorContext is undefined
 * (legacy x-actor-id header-shim path), returns the supplied fallback
 * — typically `ctx.tenantId`, which preserves pre-F-4 behavior for
 * non-JWT actors.
 *
 * Used by admin handlers that still accept the Tier 2 header shim per
 * src/lib/admin-role.ts's `requireAdminRole` no-JWT-attempted branch.
 * Once ALLOW_ACTOR_HEADER_AUTH is removed entirely (cleanup blocked on
 * all admin endpoints migrating to JWT-only), callers can switch
 * directly to `resolveActorTenantId(req)`.
 */
export function resolveActorTenantIdForAudit(
  req: FastifyRequest,
  fallbackTenantId: string,
): string {
  if (req.actorContext === undefined) {
    // F-4 R5 HIGH closure (Codex 2026-05-15): the legacy header-shim
    // path for `x-actor-roles: platform_admin` has NO trusted home-
    // tenant source (no JWT claim, no DB-validated actor binding).
    // Falling back to fallbackTenantId would attribute a cross-tenant
    // header-shim platform_admin action to the resource tenant —
    // recreating the exact F-4 misattribution this work is closing.
    //
    // Reject the legacy platform_admin path entirely. The Phase 2
    // admin migration trilogy (PRs #142/#143/#144) migrated admin
    // endpoint tests to JWT-only, so this rejection only blocks
    // environments still relying on the Tier 2 header shim for
    // platform_admin specifically. Tenant-scoped legacy roles
    // (tenant_admin via `x-actor-roles: tenant_admin` +
    // `x-actor-admin-tenant`) continue to work — for them, the
    // header shim's tenant-binding check already verified
    // actorTenantId == resource tenant.
    const rawRoles = req.headers['x-actor-roles'];
    const rolesHeader = typeof rawRoles === 'string' ? rawRoles : '';
    const claimsPlatformAdmin = rolesHeader
      .split(',')
      .map((r) => r.trim())
      .includes('platform_admin');
    if (claimsPlatformAdmin) {
      throw new Error(
        'resolveActorTenantIdForAudit: legacy x-actor-roles platform_admin path ' +
          'has no trusted actor home-tenant source. Audit attribution would default ' +
          'to the resource tenant, recreating the F-4 misattribution. Migrate this ' +
          'admin endpoint to JWT-based admin identity (Phase 2 F-1) before emitting ' +
          'audits for header-shim platform_admin actors.',
      );
    }
    return fallbackTenantId;
  }
  return resolveActorTenantId(req);
}
