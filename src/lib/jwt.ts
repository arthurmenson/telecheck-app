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
 * Access token claims per Identity Spec §3.3. Fields:
 *   - sub         : account_id (subject; the patient's account)
 *   - tenant_id   : operating-tenant identifier ('Telecheck-{Country}')
 *   - session_id  : the server-side session row binding this token
 *   - role        : 'patient' (v1.0; expanded when clinician/operator
 *                   slices land)
 *   - country_of_care: ISO 3166-1 alpha-2 (drives CCR resolution)
 *   - delegate_id : non-null when the patient is acting as a delegate
 *   - iat         : issued-at (seconds since epoch)
 *   - exp         : expires-at (seconds since epoch; iat + ACCESS_TTL_SEC)
 */
export interface AccessTokenClaims {
  sub: string;
  tenant_id: TenantId;
  session_id: string;
  role: 'patient';
  country_of_care: 'US' | 'GH';
  delegate_id?: string | null;
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
  country_of_care: 'US' | 'GH';
  delegate_id?: string | null;
}

/**
 * Issue a fresh JWT access token. The caller (typically the login-verify
 * handler) MUST persist the session row server-side BEFORE calling this
 * — the JWT references session_id by claim, and the verify path will
 * validate that the session is still active.
 */
export function issueAccessToken(input: IssueAccessTokenInput, signingKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: AccessTokenClaims = {
    sub: input.account_id,
    tenant_id: input.tenant_id,
    session_id: input.session_id,
    role: 'patient',
    country_of_care: input.country_of_care,
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    ...(input.delegate_id !== undefined ? { delegate_id: input.delegate_id } : {}),
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

  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, claims };
}
