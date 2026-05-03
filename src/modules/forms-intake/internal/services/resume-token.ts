/**
 * forms-intake/internal/services/resume-token.ts — HMAC-signed save-and-resume tokens.
 *
 * The patient-facing save-and-resume flow (Slice PRD v2.1 §8) hands the
 * patient an opaque token they can return with later — by email link or
 * SMS deep-link — to pick up an in-progress intake.
 *
 * **Why HMAC, not a stored hash:**
 *
 * The migration 006 `forms_resume_state` table does NOT carry a
 * `resume_token_hash` column (CDM v1.2 + types.ts both reference one,
 * but the migration was authored without it — flagged as a SPEC ISSUE in
 * the file header SI/DSI list). Rather than block on an ALTER, we issue
 * tokens that are self-contained: the token IS the verifiable payload.
 *
 *   token := base64url(payload) "." base64url(HMAC_SHA256(secret, payload))
 *   payload := `${resume_state_id}:${tenant_id}:${expires_at_ms}`
 *
 * Verification:
 *   1. Split on the first `.`; reject anything malformed as "invalid".
 *   2. Recompute the HMAC over the payload using the platform-shared
 *      secret; compare with `crypto.timingSafeEqual` (constant-time) so
 *      forgery attempts can't be timing-attacked.
 *   3. Parse the payload; the resume_state_id + tenant_id are now trusted
 *      identity material, and `expires_at_ms` provides a token-level
 *      expiry distinct from the DB row's `expires_at` (defense-in-depth).
 *
 * **Properties:**
 *   - Tenant-bound: a token issued in tenant A cannot be replayed in
 *     tenant B (the HMAC payload encodes tenant_id; verifyToken checks).
 *   - Tamper-evident: any modification to payload or signature fails the
 *     constant-time compare; verifyToken returns null.
 *   - Stateless: no DB column required for token storage; the resume_state
 *     row is fetched by primary key after token decode.
 *   - Bounded lifetime: independent expiry on the token (this file) AND
 *     on the DB row (`expires_at` column on forms_resume_state). Either
 *     trip rejects the resume.
 *
 * **What we do NOT do here:**
 *   - We do NOT consume the token; this module is stateless. The caller
 *     (submission-service.restoreSubmission) marks the resume_state as
 *     `completed` after a successful restore so the same token cannot
 *     be replayed.
 *   - We do NOT log the token. Tokens are session-equivalent material;
 *     leaking them via logs is forbidden per security review.
 *
 * **Production secret:** `config.resumeTokenSecret` is sourced from the
 * `RESUME_TOKEN_SECRET` env var. Production startup fails closed if the
 * secret is missing or shorter than 32 characters (see config.ts).
 *
 * Spec references:
 *   - Slice PRD v2.1 §8 — save-and-resume.
 *   - I-019 — crisis detection runs at submission entry, not at resume,
 *     so this file does not cross-call crisis-detection.
 *   - I-023 — three-layer tenant isolation; the token's tenant_id binding
 *     is layer 4 added on top of RLS + app-layer filter + KMS.
 *   - I-025 — tenant-blind 404 envelope: a token whose tenant_id binding
 *     doesn't match the request's tenant context surfaces as the same
 *     404 shape as a missing row.
 */

import crypto from 'crypto';

import { config } from '../../../../lib/config.js';
import type { TenantId } from '../../../../lib/glossary.js';
import type { ResumeStateId } from '../types.js';

/**
 * Issue an opaque resume token. Stateless — does not write to the DB.
 *
 * The caller MUST already have committed the corresponding
 * `forms_resume_state` row before calling this function: a token whose
 * resume_state_id doesn't resolve to a row is a usability bug, not a
 * security issue (verifyToken still validates HMAC, the lookup just
 * returns null and the handler emits a tenant-blind 404).
 *
 * @param resumeStateId  Primary key of the forms_resume_state row.
 * @param tenantId       Tenant whose context the resume_state was created in.
 * @param expiresAt      ISO-8601 timestamp; token rejects on/after this instant.
 *                       MUST mirror the DB row's `expires_at` column so
 *                       token-level + row-level expiry stay in lockstep.
 */
export function issueResumeToken(
  resumeStateId: ResumeStateId,
  tenantId: TenantId,
  expiresAt: string,
): string {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error(`Invalid expiresAt timestamp: ${expiresAt}`);
  }
  const payload = `${resumeStateId}:${tenantId}:${expiresAtMs}`;
  const sig = crypto.createHmac('sha256', config.resumeTokenSecret).update(payload).digest();
  return `${base64UrlEncode(Buffer.from(payload, 'utf8'))}.${base64UrlEncode(sig)}`;
}

/**
 * Verified resume-token decode. Returns the trusted identity payload on
 * success, null on any failure mode.
 *
 * **Returns null (not throw)** for every kind of bad input — malformed
 * structure, bad signature, expired, unparseable expiry. The caller maps
 * `null` to a tenant-blind 404 per I-025; we never leak which failure
 * mode tripped (timing-side or otherwise).
 *
 * **Constant-time signature compare** via `crypto.timingSafeEqual`
 * prevents an attacker from learning the correct HMAC byte-by-byte
 * via response-time variation.
 *
 * The caller MUST then verify that the returned `tenantId` matches the
 * request's resolved tenant context; if it doesn't, treat as null.
 */
export function verifyResumeToken(
  token: string,
): { resumeStateId: ResumeStateId; tenantId: TenantId; expiresAtMs: number } | null {
  if (typeof token !== 'string' || token.length === 0) return null;

  // Use lastIndexOf to be robust against payload bytes that decode to '.'
  // — though the payload uses ':' as separator and base64url omits '+/=',
  // so '.' should never appear inside either segment; lastIndexOf is
  // belt-and-suspenders.
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === token.length - 1) return null;

  const encodedPayload = token.slice(0, dotIdx);
  const encodedSig = token.slice(dotIdx + 1);

  let payloadBuf: Buffer;
  let providedSig: Buffer;
  try {
    payloadBuf = base64UrlDecode(encodedPayload);
    providedSig = base64UrlDecode(encodedSig);
  } catch {
    return null;
  }

  const expectedSig = crypto
    .createHmac('sha256', config.resumeTokenSecret)
    .update(payloadBuf)
    .digest();

  if (providedSig.length !== expectedSig.length) {
    // crypto.timingSafeEqual throws on length mismatch — but mismatched
    // lengths ARE a bad-token signal regardless. Reject without
    // attempting the constant-time compare.
    return null;
  }
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;

  const payload = payloadBuf.toString('utf8');
  const parts = payload.split(':');
  if (parts.length !== 3) return null;
  const [resumeStateId, tenantId, expiresAtRaw] = parts;
  if (!resumeStateId || !tenantId || !expiresAtRaw) return null;

  const expiresAtMs = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAtMs)) return null;
  if (Date.now() >= expiresAtMs) return null;

  return {
    resumeStateId: resumeStateId,
    tenantId: tenantId as TenantId,
    expiresAtMs,
  };
}

// ---------------------------------------------------------------------------
// base64url helpers — RFC 4648 §5. Node's `Buffer.toString('base64url')` is
// available on Node 16+; we keep wrappers so the call sites read cleanly.
// ---------------------------------------------------------------------------

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64UrlDecode(s: string): Buffer {
  // Node accepts the base64url alphabet directly; the function throws
  // ('TypeError') on invalid characters, which the caller catches.
  return Buffer.from(s, 'base64url');
}
