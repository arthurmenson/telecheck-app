/**
 * ai-provider-credential-envelope.ts — SI-025 platform-scoped KMS envelope
 *   helper for AI provider API keys.
 *
 * **Why a dedicated module (not src/lib/kms.ts):**
 *   kms.ts is the TENANT-scoped PHI encryption path (per ADR-024 every PHI
 *   record is enveloped under the tenant's KMS key; the API takes a
 *   `TenantContext`). The AI provider credential is PLATFORM-scoped (SI-025
 *   ratified fork 2 — one key set resolved for every tenant) so it has no
 *   tenant context to key on. This module produces + consumes the SAME
 *   8-field envelope shape (I-026 / ADR-024) but over a PLATFORM secret,
 *   using a fixed platform AAD rather than a tenant_id.
 *
 * **Server-side encryption (unlike async-consult intake):**
 *   The async-consult intake path accepts a PRE-ENCRYPTED envelope from an
 *   internal boundary (the caller seals the fields). Here the admin PUTs the
 *   PLAINTEXT key and this module envelope-encrypts SERVER-SIDE before the
 *   handler INSERTs. The plaintext lives in memory only for the duration of
 *   the encrypt call and is never logged / returned / audited.
 *
 * **Local-dev-KMS posture (staging-buildable now):**
 *   Per SI-025 fork 1, storage is App-DB KMS-enveloped and buildable on
 *   staging with the local-dev key (TENANT_KMS_LOCAL_DEV_KEY), exactly like
 *   the async-consult smoke path. In non-test/non-dev-key environments the
 *   encrypt/decrypt THROW rather than silently pass (same discipline as
 *   kms.ts: a stub that silently encrypts production secrets with a dev key
 *   is itself a security violation).
 *
 *   **PRE-GO-LIVE AWS-KMS MIGRATION NOTE:** before customer ship this store
 *   MUST migrate to AWS Secrets Manager / AWS KMS (travels with the existing
 *   "KMS local-dev -> AWS KMS" hardening item). Any key entered under the
 *   local-dev key MUST be rotated (old one revoked) after the migration.
 *   The 8-field envelope shape is chosen precisely so the at-rest columns do
 *   not change when the KMS backend swaps — only this module's
 *   encrypt/decrypt internals do.
 *
 * Spec references:
 *   - SI-025 Admin-Managed AI Provider Credentials v0.1 §3 (8-field envelope)
 *     + §7 (security posture: plaintext never stored/logged/returned/audited)
 *   - ADR-024 / I-026 (KMS envelope shape)
 *   - src/lib/kms.ts (the tenant-scoped sibling; same crypto primitives,
 *     different scope)
 */

import crypto from 'crypto';

import { config } from './config.js';
import { ulid } from './ulid.js';

// ---------------------------------------------------------------------------
// Envelope constants
// ---------------------------------------------------------------------------

/** Fixed platform AAD — binds the ciphertext to this credential class so a
 *  ciphertext lifted from another enveloped column can't be decrypted here
 *  (models the AWS KMS encryption-context binding, platform-scoped). */
const PLATFORM_CREDENTIAL_AAD = 'ai_provider_credential';

/** Canonical algorithm label + version (matches the async-consult envelope
 *  convention: alg='AES-256-GCM', alg_version='1'). */
const ENVELOPE_ALG = 'AES-256-GCM';
const ENVELOPE_ALG_VERSION = '1';

// ---------------------------------------------------------------------------
// 8-field envelope shape (I-026) — decoded (Buffers), maps 1:1 to the
// ai_provider_credential KMS-envelope columns.
// ---------------------------------------------------------------------------

export interface AiProviderKeyEnvelope {
  ciphertext: Buffer;
  dekId: string; // ULID
  iv: Buffer;
  tag: Buffer;
  alg: string;
  algVersion: string;
  aad: Buffer;
  encryptedAt: Date;
}

// ---------------------------------------------------------------------------
// Local-dev key derivation (NEVER reached in non-dev-key environments)
// ---------------------------------------------------------------------------

/**
 * Derive the platform 32-byte credential-encryption key from the local dev
 * master key. The platform AAD is mixed into the derivation so a ciphertext
 * from a different envelope class fails auth-tag verification (models AWS KMS
 * encryption-context binding).
 */
function derivePlatformCredentialKey(): Buffer {
  const master = config.tenantKmsLocalDevKey;
  if (master === undefined || master.length < 32) {
    throw new Error(
      'ai-provider-credential-envelope: TENANT_KMS_LOCAL_DEV_KEY must be set to a ' +
        'string of at least 32 chars to envelope AI provider credentials under the ' +
        'local-dev KMS key. In production this path is replaced by AWS KMS / Secrets ' +
        'Manager per the pre-go-live hardening item.',
    );
  }
  return crypto.createHash('sha256').update(`${master}:${PLATFORM_CREDENTIAL_AAD}`).digest();
}

/**
 * Gate the crypto to environments that legitimately hold a local-dev key.
 * Mirrors kms.ts: throw in non-test environments unless a dev key is present
 * (staging-smoke path). This prevents silently enveloping a production
 * secret with a dev key.
 */
function assertEnvelopeAllowed(): void {
  const hasDevKey =
    typeof config.tenantKmsLocalDevKey === 'string' && config.tenantKmsLocalDevKey.length >= 32;
  if (process.env['NODE_ENV'] !== 'test' && !hasDevKey) {
    throw new Error(
      'ai-provider-credential-envelope: refusing to envelope an AI provider credential ' +
        'without a configured local-dev KMS key in a non-test environment. The AWS KMS ' +
        'adapter is not yet wired (pre-go-live hardening item). Configure ' +
        'TENANT_KMS_LOCAL_DEV_KEY on staging, or wait for the AWS KMS integration.',
    );
  }
}

// ---------------------------------------------------------------------------
// Public API — encrypt / decrypt the plaintext API key
// ---------------------------------------------------------------------------

/**
 * Envelope-encrypt a plaintext API key SERVER-SIDE. Returns the 8-field
 * envelope for INSERT into ai_provider_credential.
 *
 * The plaintext is consumed here and never retained by this module. Callers
 * MUST NOT log the plaintext; the returned envelope carries only ciphertext.
 */
export function encryptAiProviderKey(plaintextKey: string): AiProviderKeyEnvelope {
  assertEnvelopeAllowed();
  const key = derivePlatformCredentialKey();
  const iv = crypto.randomBytes(12);
  const aad = Buffer.from(PLATFORM_CREDENTIAL_AAD, 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintextKey, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext,
    dekId: ulid(),
    iv,
    tag,
    alg: ENVELOPE_ALG,
    algVersion: ENVELOPE_ALG_VERSION,
    aad,
    encryptedAt: new Date(),
  };
}

/**
 * Envelope-decrypt a stored credential back to the plaintext API key. Used
 * ONLY by the AI service at provider-construction time (after reading the
 * envelope via the SECDEF read wrapper) and by the admin /test probe. The
 * returned plaintext lives in memory for the duration of a single provider
 * call and MUST never be logged, returned by HTTP, or audited.
 */
export function decryptAiProviderKey(envelope: AiProviderKeyEnvelope): string {
  assertEnvelopeAllowed();
  const key = derivePlatformCredentialKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.iv);
  decipher.setAAD(envelope.aad);
  decipher.setAuthTag(envelope.tag);
  const plain = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

// ---------------------------------------------------------------------------
// Non-secret metadata derivation (masked reads + rotation detection)
// ---------------------------------------------------------------------------

/**
 * Compute the display-only last-4 mask for a plaintext key. Never reversible
 * to the full key; used for the masked GET row (e.g. 'sk-...AB12').
 */
export function computeKeyLast4(plaintextKey: string): string {
  const last4 = plaintextKey.slice(-4);
  return `sk-...${last4}`;
}

/**
 * Compute the SHA-256 fingerprint of a plaintext key. Non-reversible; used
 * for rotation-detection + dedup only (SI-025 §2). Per SI-025 §9 open item
 * this is NOT a plaintext-recovery vector — SHA-256 is a one-way digest and
 * an API key has far more entropy than a brute-forceable input.
 */
export function computeKeyFingerprint(plaintextKey: string): string {
  return crypto.createHash('sha256').update(plaintextKey, 'utf8').digest('hex');
}
