/**
 * med-interaction/internal/handlers/kms-envelope.ts — 8-field KMS envelope
 * wire decode for the override-rationale ciphertext.
 *
 * Mirrors the async-consult `v1-shared.ts` precedent VERBATIM (same wire
 * shape, same canonical-base64 round-trip check, same all-or-nothing
 * rejection). Replicated rather than imported because `v1-shared.ts` is
 * async-consult module-PRIVATE (internal/) and ADR-001 forbids
 * cross-module imports of internal code. TODO(cross-slice hardening, per
 * med-interaction README "Cross-slice shared utilities" item): hoist a
 * single decode helper into src/lib/ when the third consumer appears.
 *
 * **KMS envelope posture:** the override rationale arrives PRE-ENCRYPTED
 * from the clinician-console boundary as the 8-field envelope; plaintext
 * rationale never transits this server (mirrors SI-019 R4 HIGH-2 closure:
 * the plaintext `override_rationale` column was REMOVED from
 * interaction_signal_override — envelope-only persistence; migration 047
 * §3 columns are all NOT NULL so every field is REQUIRED on this wire
 * surface).
 *
 * Spec references:
 *   - migrations/047 §3 (interaction_signal_override 8-column envelope)
 *   - migrations/070 §1 (operational override wrapper binding these params)
 *   - SI-019 Sub-decision 8 + R4 HIGH-2 closure (envelope-only rationale)
 *   - async-consult v1-shared.ts (canonical wire-shape precedent; I-026)
 */

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isUlid(v: unknown): v is string {
  return typeof v === 'string' && ULID_PATTERN.test(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function parseIsoTimestamp(v: unknown): Date | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function decodeBase64(v: unknown): Buffer | null {
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

/**
 * Wire shape for a pre-encrypted KMS envelope. BYTEA fields are
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
 * fields is missing or malformed (the migration 047 §3 columns are all
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
