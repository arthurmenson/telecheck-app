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
 *     pointing at an AWS KMS key. The master key never leaves KMS; a fresh
 *     plaintext data key is erased after each envelope operation.
 *   - I-023 (three-layer isolation): KMS is layer 3. RLS rejects rows from
 *     other tenants; app-layer middleware filters in queries; KMS rejects
 *     decrypt requests for ciphertext from another tenant.
 *
 * The AWS envelope primitive is implemented in kms-aws.ts. Non-test entry
 * remains fail-closed until mandatory caller data-class, tenant IAM/STS/CMK
 * binding and decrypt-audit integration is supplied. Credentials or an env
 * toggle cannot substitute for that integration. The legacy local format is
 * retained strictly for tests.
 */

import crypto from 'crypto';

import { config } from './config.js';
import { KmsOperationError } from './kms-aws.js';
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
 * @throws If the tenant key, request or KMS operation is unavailable/invalid.
 */
export async function kmsEncrypt(tenant: TenantContext, plain: Buffer): Promise<Buffer> {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new KmsOperationError();
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
 * @throws Same as kmsEncrypt; tampered and legacy local ciphertext fail closed.
 */
export async function kmsDecrypt(tenant: TenantContext, cipher: Buffer): Promise<Buffer> {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new KmsOperationError();
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
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(tenantId, 'utf8'));
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Layout: [iv(12) | tag(16) | ciphertext(...)]
    return Buffer.concat([iv, tag, ct]);
  } finally {
    key.fill(0);
  }
}

function localDevDecrypt(tenantId: string, cipherBuf: Buffer): Buffer {
  if (cipherBuf.length < 12 + 16) {
    throw new Error('kms.localDevDecrypt: ciphertext too short');
  }
  const key = deriveTenantKey(tenantId);
  let unverifiedPlaintext: Buffer | undefined;
  try {
    const iv = cipherBuf.subarray(0, 12);
    const tag = cipherBuf.subarray(12, 28);
    const ct = cipherBuf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(tenantId, 'utf8'));
    decipher.setAuthTag(tag);
    unverifiedPlaintext = decipher.update(ct);
    return Buffer.concat([unverifiedPlaintext, decipher.final()]);
  } finally {
    key.fill(0);
    unverifiedPlaintext?.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Convenience exports
// ---------------------------------------------------------------------------

export const kms = {
  encrypt: kmsEncrypt,
  decrypt: kmsDecrypt,
};
