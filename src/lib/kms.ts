/**
 * kms.ts — per-tenant KMS key resolution per ADR-024.
 *
 * Purpose:
 *   Resolves the AWS KMS key alias for a given tenant context, then provides
 *   encrypt/decrypt operations against that key. Per ADR-024 multi-tenancy
 *   Model A, every tenant has its own KMS key for data encryption at rest;
 *   cross-tenant decryption is impossible at the KMS layer (AWS rejects with
 *   AccessDenied), providing a third layer of tenant isolation alongside
 *   RLS (DB) and app-layer filtering (middleware) per I-023.
 *
 * Spec references:
 *   - ADR-024 (country-driven config + per-tenant KMS keys): every tenant
 *     row carries `kms_key_alias` (e.g., `alias/telecheck-us-data-key`)
 *     pointing at an AWS KMS key. The application layer never holds the
 *     plaintext key material; AWS KMS enforces.
 *   - I-023 (three-layer isolation): KMS is layer 3. RLS rejects rows from
 *     other tenants; app-layer middleware filters in queries; KMS rejects
 *     decrypt requests for ciphertext from another tenant.
 *
 * Status:
 *   v0.1 STUB — production AWS KMS integration is not yet wired. This module
 *   provides the API surface so slice authors can call kms.encrypt() /
 *   kms.decrypt() against their tenant context, but in non-test
 *   environments it THROWS rather than silently passing. Per the security
 *   discipline established in i029-gate.ts and audit.ts, a stub that
 *   silently passes production traffic is itself an invariant violation.
 *
 * Open questions for Engineering Lead:
 *   - When does the AWS KMS integration land? Likely as part of the Identity
 *     & Auth slice or a dedicated infrastructure slice. Until then, slice
 *     work that requires PHI encryption must either run under NODE_ENV=test
 *     (which gates the dev key) or wait for the real implementation.
 *   - Encryption context: AWS KMS supports an "encryption context" key-value
 *     pair that's bound to the ciphertext. We MUST set `tenant_id` as
 *     encryption context on every encrypt call so a stolen ciphertext from
 *     tenant A can't be decrypted under tenant B's key alias even if the
 *     KMS policy is misconfigured. The signatures below carry tenantId.
 */

import crypto from 'crypto';

import { config } from './config.js';
import type { TenantContext } from './tenant-context.js';

// ---------------------------------------------------------------------------
// Encryption / decryption API
// ---------------------------------------------------------------------------

/**
 * Encrypt plaintext under the tenant's KMS key.
 *
 * @param tenant   Resolved tenant context (carries kmsKeyAlias)
 * @param plain    Plaintext bytes to encrypt
 * @returns        Ciphertext bytes (KMS envelope-encrypted; opaque to caller)
 *
 * @throws In non-test environments until the AWS KMS integration lands.
 *         Per the security discipline, a stub that silently passes
 *         production traffic would itself be an isolation-layer violation.
 */
export async function kmsEncrypt(
  tenant: TenantContext,
  plain: Buffer,
): Promise<Buffer> {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error(
      `kms.kmsEncrypt: AWS KMS integration not yet wired. The application ` +
        `layer cannot encrypt data for tenant '${tenant.tenantId}' until the ` +
        `AWS KMS adapter (TODO: src/lib/kms-aws.ts) is authored. This stub ` +
        `THROWS in non-test environments rather than silently encrypt with a ` +
        `dev key — per ADR-024 + I-023 layer-3 enforcement.`,
    );
  }

  // Test path: deterministic AES-256-GCM with the static dev key, scoped by
  // tenant_id so tests can verify cross-tenant ciphertext isolation.
  return localDevEncrypt(tenant.tenantId, plain);
}

/**
 * Decrypt ciphertext under the tenant's KMS key.
 *
 * Tenant context is required so the encryption context check (which AWS KMS
 * will perform in production) can be modeled in the test stub too.
 *
 * @throws Same as kmsEncrypt in non-test environments.
 */
export async function kmsDecrypt(
  tenant: TenantContext,
  cipher: Buffer,
): Promise<Buffer> {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error(
      `kms.kmsDecrypt: AWS KMS integration not yet wired. Cannot decrypt for ` +
        `tenant '${tenant.tenantId}' until the AWS KMS adapter is authored.`,
    );
  }

  return localDevDecrypt(tenant.tenantId, cipher);
}

// ---------------------------------------------------------------------------
// Local dev / test crypto (NEVER reached in non-test environments)
// ---------------------------------------------------------------------------

/**
 * Derive a per-tenant 32-byte key from the local dev master key. Encryption
 * context (tenant_id) is mixed into the derivation so cross-tenant
 * ciphertext decrypt fails with auth-tag mismatch — modeling the AWS KMS
 * encryption-context-binding behavior.
 */
function deriveTenantKey(tenantId: string): Buffer {
  const master = config.tenantKmsLocalDevKey;
  if (master === undefined || master.length < 32) {
    throw new Error(
      `kms.deriveTenantKey: TENANT_KMS_LOCAL_DEV_KEY env must be set to a ` +
        `string of at least 32 chars in test environments.`,
    );
  }
  return crypto.createHash('sha256').update(`${master}:${tenantId}`).digest();
}

function localDevEncrypt(tenantId: string, plain: Buffer): Buffer {
  const key = deriveTenantKey(tenantId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(tenantId, 'utf8'));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: [iv(12) | tag(16) | ciphertext(...)]
  return Buffer.concat([iv, tag, ct]);
}

function localDevDecrypt(tenantId: string, cipherBuf: Buffer): Buffer {
  if (cipherBuf.length < 12 + 16) {
    throw new Error('kms.localDevDecrypt: ciphertext too short');
  }
  const key = deriveTenantKey(tenantId);
  const iv = cipherBuf.subarray(0, 12);
  const tag = cipherBuf.subarray(12, 28);
  const ct = cipherBuf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(tenantId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

export const kms = {
  encrypt: kmsEncrypt,
  decrypt: kmsDecrypt,
};
