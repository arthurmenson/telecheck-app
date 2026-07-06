/**
 * async-consult/internal/handlers/v1-shared.ts — shared validation +
 * envelope helpers for the Sprint 10 PR 6 /v1/async-consults handler
 * surface (P-038 canonical entities; migrations 055-060).
 *
 * Kept module-private (internal/) per ADR-001; nothing here is exported
 * from the module's index.ts.
 *
 * **KMS envelope posture (PR 6):** the two ciphertext-bearing endpoints
 * (intake + decision) accept the 8-column KMS envelope PRE-ENCRYPTED from
 * an internal service boundary — the caller (Forms-Intake orchestration /
 * clinician console BFF) performs the ADR-024 per-tenant KMS envelope
 * encryption and forwards the sealed fields. This mirrors the crisis
 * intake precedent (crisis-response Sprint 2 deferred app-side KMS
 * envelope wiring to a hardening sprint; unlike crisis, the migration 056
 * columns are NOT NULL so the fields are REQUIRED on this wire surface
 * rather than omitted). TODO(async-consult hardening): when the app-side
 * KMS envelope helper lands (src/lib/kms.ts currently exposes only the
 * dev-mode kmsEncrypt/kmsDecrypt pair, not the 8-column envelope
 * builder), move encryption server-side and accept plaintext payloads
 * over an internal-only channel.
 *
 * Spec references:
 *   - migrations/056 (§2 intake + §5 decision KMS envelope columns; I-026)
 *   - migrations/059 (wrapper signatures the handlers bind to)
 *   - I-025 (tenant-blind error envelopes)
 */

// ---------------------------------------------------------------------------
// ULID + primitive validation
// ---------------------------------------------------------------------------

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(v: unknown): v is string {
  return typeof v === 'string' && ULID_PATTERN.test(v);
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Parse an ISO 8601 timestamp string. Returns the Date on success or
 * null on malformed input (boundary validation before the DB type-cast
 * error path).
 */
export function parseIsoTimestamp(v: unknown): Date | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Decode a base64 string into a Buffer. Returns null when the input is
 * not a string, is empty, or is not canonical base64 (round-trip check
 * defeats silently-truncated decodes).
 */
export function decodeBase64(v: unknown): Buffer | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const buf = Buffer.from(v, 'base64');
  if (buf.length === 0) return null;
  // Canonical round-trip check (padding-insensitive) — defeats silently
  // truncated decodes of non-base64 input, which Buffer.from tolerates.
  if (buf.toString('base64').replace(/=+$/, '') !== v.replace(/=+$/, '')) {
    return null;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// 8-column KMS envelope (wire shape → wrapper params)
// ---------------------------------------------------------------------------

/**
 * Wire shape for a pre-encrypted KMS envelope (I-026). BYTEA fields are
 * base64-encoded on the wire; `encrypted_at` is ISO 8601.
 */
export interface KmsEnvelopeWire {
  ciphertext_b64?: string;
  dek_id?: string;
  iv_b64?: string;
  tag_b64?: string;
  alg?: string;
  alg_version?: string;
  aad_b64?: string;
  encrypted_at?: string;
}

/** Decoded envelope ready to bind as wrapper params. */
export interface KmsEnvelopeDecoded {
  ciphertext: Buffer;
  dekId: string;
  iv: Buffer;
  tag: Buffer;
  alg: string;
  algVersion: string;
  aad: Buffer;
  encryptedAt: Date;
}

/**
 * Validate + decode a wire KMS envelope. Returns null when any of the 8
 * fields is missing or malformed (the migration 056 columns are all
 * NOT NULL — partial envelopes are rejected at the HTTP boundary).
 */
export function decodeKmsEnvelope(v: unknown): KmsEnvelopeDecoded | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const e = v as KmsEnvelopeWire;
  const ciphertext = decodeBase64(e.ciphertext_b64);
  const iv = decodeBase64(e.iv_b64);
  const tag = decodeBase64(e.tag_b64);
  const aad = decodeBase64(e.aad_b64);
  const encryptedAt = parseIsoTimestamp(e.encrypted_at);
  if (
    ciphertext === null ||
    iv === null ||
    tag === null ||
    aad === null ||
    encryptedAt === null ||
    !isUlid(e.dek_id) ||
    !isNonEmptyString(e.alg) ||
    !isNonEmptyString(e.alg_version)
  ) {
    return null;
  }
  return {
    ciphertext,
    dekId: e.dek_id,
    iv,
    tag,
    alg: e.alg,
    algVersion: e.alg_version,
    aad,
    encryptedAt,
  };
}

// ---------------------------------------------------------------------------
// Error envelope helper (mirrors crisis-response / consent handler pattern)
// ---------------------------------------------------------------------------

export interface ErrorEnvelopeBody {
  error: { code: string; message: string; request_id: string };
}

export function makeErrorEnvelope(reqId: string, code: string, message: string): ErrorEnvelopeBody {
  return { error: { code, message, request_id: reqId } };
}

// ---------------------------------------------------------------------------
// PG error-code probe
// ---------------------------------------------------------------------------

export function pgErrorCode(err: unknown): string | null {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}
