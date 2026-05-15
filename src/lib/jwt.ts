/**
 * jwt.ts — Identity slice access-token issuance + verification.
 *
 * Implements a minimal HMAC-SHA256 JWT (HS256) for the v1.0 access-token
 * surface per Identity & Authentication Spec §3.3:
 *
 *   "Access token: Short-lived JWT containing user_id, role,
 *    active_delegation (if acting as delegate), country_of_care,
 *    session_id. Included in every API request."
 *
 * Why a hand-rolled minimal implementation:
 *   - Zero new runtime dependencies (the platform is dependency-conservative
 *     per ADR-022 native-first / open-source-first principles)
 *   - Surface kept tiny: issueAccessToken + verifyAccessToken; no support
 *     for nbf, jti, encrypted (JWE), or asymmetric algorithms at v1.0
 *   - When key rotation infrastructure lands (post-launch), this module
 *     swaps to the platform's chosen library (jose / @fastify/jwt) +
 *     RSA/ECDSA via JWKS — the surface above stays the same
 *
 * Spec references:
 *   - Identity & Authentication Spec v1.0 §3.3 (access token claims)
 *   - I-023 (tenant_id is a JWT claim; verified before tenant-scoped writes)
 *   - I-027 (audit records carry the actor's tenant_id resolved from JWT)
 *   - ADR-022 (native-first; minimal deps)
 */

import crypto from 'node:crypto';

import type { TenantId } from './glossary.js';

// ---------------------------------------------------------------------------
// Token shape
// ---------------------------------------------------------------------------

/**
/**
 * Canonical access-token role enum. The set of role names the JWT layer
 * accepts. v1.0: patient + clinician (TLC-058 / PR for migration 027
 * 2026-05-13). Phase 2 (2026-05-15) widens to include tenant_admin +
 * platform_admin so the forms-intake admin handlers (templates,
 * variants, deployments) can resolve admin identity from JWT instead
 * of the legacy `x-actor-roles` header shim. Additional roles
 * (pharmacist, operator, research data steward) land with their
 * respective slices.
 *
 * The verify path validates incoming `claims.role` against this set and
 * rejects with reason='invalid_payload' on any unknown value — defense
 * against a future bug in the issuer that mints out-of-enum roles.
 */
export type AccessTokenRole = 'patient' | 'clinician' | 'tenant_admin' | 'platform_admin';

const VALID_ACCESS_TOKEN_ROLES: ReadonlySet<AccessTokenRole> = new Set<AccessTokenRole>([
  'patient',
  'clinician',
  'tenant_admin',
  'platform_admin',
]);

/**
 * Access token claims per Identity Spec §3.3. Fields:
 *   - sub         : account_id (subject; the actor's account)
 *   - tenant_id   : operating-tenant identifier ('Telecheck-{Country}')
 *   - session_id  : the server-side session row binding this token
 *   - role        : 'patient' | 'clinician' | 'tenant_admin' |
 *                   'platform_admin' (Phase 2 admin widening
 *                   2026-05-15). Future v1.x adds pharmacist,
 *                   operator, research_data_steward.
 *   - country_of_care: ISO 3166-1 alpha-2 (drives CCR resolution)
 *   - delegate_id : non-null when a patient is acting as a delegate
 *                   (does NOT apply to clinician/admin roles)
 *   - admin_tenant_binding : non-null only for `tenant_admin` role;
 *                   carries the tenant_id this admin is authorized to
 *                   administer. authContextPlugin verifies this matches
 *                   the request's resolved tenant context — without a
 *                   match the actor is rejected (cross-tenant admin
 *                   forge defense). For `platform_admin` this field
 *                   MUST be null (or undefined); for `tenant_admin`
 *                   this field MUST be non-null and verify-rejected
 *                   otherwise. For `patient` / `clinician` this field
 *                   is unused.
 *   - iat         : issued-at (seconds since epoch)
 *   - exp         : expires-at (seconds since epoch; iat + ACCESS_TTL_SEC)
 */
export interface AccessTokenClaims {
  sub: string;
  tenant_id: TenantId;
  session_id: string;
  role: AccessTokenRole;
  country_of_care: 'US' | 'GH';
  delegate_id?: string | null;
  admin_tenant_binding?: string | null;
  iat: number;
  exp: number;
}

/**
 * Identity Spec §3.2: access-token TTL is 15 minutes. Service-layer
 * constant; when a tenant-config knob lands for this, change here.
 */
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

// ---------------------------------------------------------------------------
// Base64url helpers
// ---------------------------------------------------------------------------

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function base64urlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

// ---------------------------------------------------------------------------
// HS256 sign / verify
// ---------------------------------------------------------------------------

const JWT_HEADER_HS256 = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function hmacSign(signingInput: string, key: string): string {
  return base64urlEncode(crypto.createHmac('sha256', key).update(signingInput).digest());
}

// ---------------------------------------------------------------------------
// issueAccessToken
// ---------------------------------------------------------------------------

export interface IssueAccessTokenInput {
  account_id: string;
  tenant_id: TenantId;
  session_id: string;
  /**
   * The actor's role for this session. Required at v1.0 — the lib does
   * NOT default to 'patient' so callers can't accidentally widen
   * patient JWTs to carry a stale-default 'patient' label when issuing
   * a clinician session. The session-service `issueSession` resolves
   * this from `accounts.account_type` at session creation time so the
   * mapping is centralized at one site (TLC-058 / 2026-05-13).
   */
  role: AccessTokenRole;
  country_of_care: 'US' | 'GH';
  delegate_id?: string | null;
  /**
   * Phase 2 admin widening (2026-05-15): when role='tenant_admin', this
   * MUST be set to the tenant_id the admin is authorized to administer
   * (typically === tenant_id but the values are kept separate so a
   * platform_admin or pseudo-tenant token can later carry distinct
   * binding semantics). When role='platform_admin', MUST be null.
   * For 'patient' | 'clinician', MUST be null. issueAccessToken
   * enforces the role/binding consistency at runtime — rejecting any
   * mismatch with a thrown Error so misuse fails at issue time, not
   * verify time.
   */
  admin_tenant_binding?: string | null;
}

/**
 * Issue a fresh JWT access token. The caller (typically the login-verify
 * handler via session-service.issueSession) MUST:
 *   1. Persist the session row server-side BEFORE calling this — the
 *      JWT references session_id by claim, and the verify path will
 *      validate that the session is still active.
 *   2. Pass the canonical role for the actor (resolved from
 *      accounts.account_type by the session-service; this lib never
 *      defaults).
 */
export function issueAccessToken(input: IssueAccessTokenInput, signingKey: string): string {
  // Defense-in-depth on the issuer side. The type system already
  // restricts callers to the AccessTokenRole enum, but the runtime
  // check catches any `as` cast that crept past static analysis.
  if (!VALID_ACCESS_TOKEN_ROLES.has(input.role)) {
    throw new Error(
      `issueAccessToken: role ${String(input.role)} is not a valid AccessTokenRole. ` +
        'Valid values: patient | clinician | tenant_admin | platform_admin. ' +
        'Update VALID_ACCESS_TOKEN_ROLES + the AccessTokenRole union when ' +
        'widening (RBAC v1.1 §1.2).',
    );
  }

  // Phase 2 admin widening (2026-05-15): enforce admin_tenant_binding
  // consistency with role at ISSUE time so misuse fails fast (not at
  // verify time where the failure mode is silent).
  if (input.role === 'tenant_admin') {
    if (input.admin_tenant_binding == null || input.admin_tenant_binding.length === 0) {
      throw new Error(
        'issueAccessToken: role=tenant_admin requires non-null admin_tenant_binding ' +
          '(the tenant_id this admin is authorized to administer).',
      );
    }
  } else if (input.admin_tenant_binding != null) {
    // platform_admin, patient, clinician — admin_tenant_binding MUST be
    // null/undefined. A non-null binding for these roles is a caller bug.
    throw new Error(
      `issueAccessToken: role=${input.role} must NOT carry admin_tenant_binding. ` +
        'admin_tenant_binding applies ONLY to role=tenant_admin.',
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    sub: input.account_id,
    tenant_id: input.tenant_id,
    session_id: input.session_id,
    role: input.role,
    country_of_care: input.country_of_care,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    ...(input.delegate_id !== undefined ? { delegate_id: input.delegate_id } : {}),
    ...(input.admin_tenant_binding !== undefined
      ? { admin_tenant_binding: input.admin_tenant_binding }
      : {}),
  };

  const payload = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${JWT_HEADER_HS256}.${payload}`;
  const signature = hmacSign(signingInput, signingKey);
  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// verifyAccessToken
// ---------------------------------------------------------------------------

export type VerifyAccessTokenResult =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: 'malformed' | 'invalid_signature' | 'expired' | 'invalid_payload' };

/**
 * Verify a JWT access token. Returns the parsed claims on success or a
 * discriminated reason on failure. The caller (typically the JWT-verify
 * Fastify hook) should map every failure to a tenant-blind 401 envelope
 * — clients learn only that authentication failed, not which check tripped.
 *
 * Verification steps:
 *   1. Three-segment split (header.payload.signature)
 *   2. HMAC-SHA256 signature recompute (constant-time compare)
 *   3. Payload JSON-parse
 *   4. exp > now (token not expired)
 *
 * Does NOT verify session liveness against the DB (the JWT verify hook
 * does that as a follow-up — this is a pure stateless JWT check).
 */
export function verifyAccessToken(token: string, signingKey: string): VerifyAccessTokenResult {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return { ok: false, reason: 'malformed' };
  }

  const [headerB64, payloadB64, sigB64] = segments;
  if (
    headerB64 === undefined ||
    payloadB64 === undefined ||
    sigB64 === undefined ||
    headerB64.length === 0 ||
    payloadB64.length === 0 ||
    sigB64.length === 0
  ) {
    return { ok: false, reason: 'malformed' };
  }

  // Recompute signature and constant-time compare. The header is fixed
  // (HS256 only at v1.0); we DON'T accept the caller's claimed alg —
  // that prevents the classic alg=none forge.
  const signingInput = `${JWT_HEADER_HS256}.${payloadB64}`;
  const expectedSig = hmacSign(signingInput, signingKey);

  // Reject any non-HS256 header at the outset — if the header doesn't
  // match exactly, signature recompute will mismatch anyway, but pin
  // explicitly to make the algorithm-confusion defense visible.
  if (headerB64 !== JWT_HEADER_HS256) {
    return { ok: false, reason: 'invalid_signature' };
  }

  const sigBuf = base64urlDecode(sigB64);
  const expectedSigBuf = base64urlDecode(expectedSig);
  if (sigBuf.length !== expectedSigBuf.length) {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (!crypto.timingSafeEqual(sigBuf, expectedSigBuf)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  // Parse payload + check expiry
  let claims: AccessTokenClaims;
  try {
    const payloadJson = base64urlDecode(payloadB64).toString('utf8');
    claims = JSON.parse(payloadJson) as AccessTokenClaims;
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }

  if (
    typeof claims.sub !== 'string' ||
    typeof claims.tenant_id !== 'string' ||
    typeof claims.session_id !== 'string' ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number'
  ) {
    return { ok: false, reason: 'invalid_payload' };
  }

  // Role enum validation (TLC-058 / 2026-05-13; Phase 2 admin widening
  // 2026-05-15). Reject any role outside the canonical AccessTokenRole
  // set so a buggy or compromised issuer can't mint tokens with arbitrary
  // role strings that downstream RBAC checks would have to enumerate
  // defensively. Failure maps to invalid_payload so the JWT verify hook
  // treats it as a malformed token (caller stays unauthenticated, 401).
  if (typeof claims.role !== 'string' || !VALID_ACCESS_TOKEN_ROLES.has(claims.role)) {
    return { ok: false, reason: 'invalid_payload' };
  }

  // Phase 2 admin widening (2026-05-15): verify-side role/binding
  // consistency. Defense-in-depth: the issuer enforces this too, but the
  // verify path MUST also reject mismatches in case a token was forged
  // or modified in transit. tenant_admin MUST carry a non-empty
  // admin_tenant_binding; platform_admin / patient / clinician MUST NOT
  // carry a non-empty binding.
  if (claims.role === 'tenant_admin') {
    if (
      typeof claims.admin_tenant_binding !== 'string' ||
      claims.admin_tenant_binding.length === 0
    ) {
      return { ok: false, reason: 'invalid_payload' };
    }
  } else if (
    claims.admin_tenant_binding != null &&
    (typeof claims.admin_tenant_binding !== 'string' || claims.admin_tenant_binding.length > 0)
  ) {
    return { ok: false, reason: 'invalid_payload' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, claims };
}
