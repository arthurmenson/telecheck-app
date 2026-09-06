/**
 * Per-tenant KMS encrypt/decrypt — direct integration tests.
 *
 * Covers `src/lib/kms.ts` (`kmsEncrypt`, `kmsDecrypt`, `kms` export).
 * Until this commit had only INDIRECT coverage via forms-intake save/
 * restore tests (which exercise the encrypt-merge-decrypt round-trip
 * through the resume_state path) and zero direct coverage of the
 * fail-closed production gate, cross-tenant isolation at the auth-tag
 * layer, the AAD encryption-context binding, or malformed-ciphertext
 * surfacing.
 *
 * Why this matters:
 *   `kmsEncrypt`/`kmsDecrypt` are the layer-3 tenant-isolation
 *   boundary per I-023 + ADR-024. Production must FAIL CLOSED until
 *   classified caller context, tenant IAM binding and decrypt audits are
 *   wired around the AWS envelope primitive. The test path uses an AES-
 *   256-GCM dev cipher with tenant_id mixed into both the key
 *   derivation AND the AAD, modeling AWS KMS's
 *   encryption-context-binding behavior. Tests pin both invariants:
 *
 *     1. Production gate (NODE_ENV !== 'test') THROWS a fixed safe error;
 *        neither credentials nor a local key bypass missing integration.
 *
 *     2. Cross-tenant decrypt FAILS at the auth-tag layer. A stolen
 *        ciphertext from tenant A cannot be decrypted under tenant
 *        B's key alias even if the layer-1/2 isolation was bypassed
 *        — the auth-tag mismatch fires because B's key is derived
 *        from the master + B's tenant_id, AND the AAD bound to A's
 *        ciphertext is A's tenant_id.
 *
 * Coverage in this file:
 *   §1 — Round-trip happy path (encrypt → decrypt → original plaintext).
 *   §2 — Ciphertext layout pins (IV size, tag size, ciphertext is
 *        actually opaque vs. the plaintext).
 *   §3 — Cross-tenant decrypt rejection (AAD-binding regression
 *        guard).
 *   §4 — Production gate fails closed in non-test env.
 *   §5 — Malformed ciphertext rejection (truncated, modified, etc.).
 *   §6 — Determinism — encrypts of the same plaintext are NOT
 *        identical (random IV per call); decrypts of both still
 *        yield the same plaintext.
 *
 * Spec references:
 *   - I-023 (three-layer tenant isolation; KMS is layer 3)
 *   - ADR-024 (per-tenant KMS keys; encryption-context binding)
 *   - lib/kms.ts module header
 */

import { Buffer } from 'node:buffer';

import { KMSClient } from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';

import { kms, kmsDecrypt, kmsEncrypt } from '../../src/lib/kms.ts';

// Crypto tests need no database fixtures or global PostgreSQL setup.
const TENANT_US = 'Telecheck-US';
const TENANT_GHANA = 'Telecheck-Ghana';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimum-valid TenantContext for kms calls. The kms module
 * only reads `tenantId` from the context (other fields are reserved
 * for AWS KMS adapter wiring), so the rest of the shape is filled
 * with benign placeholder values. Cast through unknown so the test
 * doesn't have to mirror the full TenantContext type from
 * tenant-context.ts.
 */
function tenantCtx(tenantId: string): Parameters<typeof kmsEncrypt>[0] {
  return {
    tenantId,
    consumerDba: 'Heros Health Test',
    countryOfCare: 'US',
    kmsKeyAlias: `alias/telecheck-${tenantId.toLowerCase()}-data-key`,
    consumerSubdomain: `${tenantId.toLowerCase()}.heroshealth.com`,
  } as unknown as Parameters<typeof kmsEncrypt>[0];
}

// ---------------------------------------------------------------------------
// §1 — Round-trip happy path
// ---------------------------------------------------------------------------

describe('kmsEncrypt + kmsDecrypt — round-trip happy path', () => {
  it('encrypts and decrypts back to the original plaintext', async () => {
    const ctx = tenantCtx(TENANT_US);
    const plaintext = Buffer.from('hello tenant US, this is a secret payload', 'utf8');
    const ciphertext = await kmsEncrypt(ctx, plaintext);
    const recovered = await kmsDecrypt(ctx, ciphertext);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('round-trips a binary (non-UTF8) plaintext', async () => {
    const ctx = tenantCtx(TENANT_US);
    // 256 bytes of 0..255, exercising every byte value at least once.
    const plaintext = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const ciphertext = await kmsEncrypt(ctx, plaintext);
    const recovered = await kmsDecrypt(ctx, ciphertext);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('round-trips an empty plaintext', async () => {
    const ctx = tenantCtx(TENANT_US);
    const plaintext = Buffer.alloc(0);
    const ciphertext = await kmsEncrypt(ctx, plaintext);
    const recovered = await kmsDecrypt(ctx, ciphertext);
    expect(recovered.equals(plaintext)).toBe(true);
    expect(recovered.length).toBe(0);
  });

  it('the convenience `kms.encrypt` / `kms.decrypt` aliases work the same', async () => {
    const ctx = tenantCtx(TENANT_US);
    const plaintext = Buffer.from('via convenience wrappers', 'utf8');
    const ciphertext = await kms.encrypt(ctx, plaintext);
    const recovered = await kms.decrypt(ctx, ciphertext);
    expect(recovered.equals(plaintext)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §2 — Ciphertext layout pins (IV + tag + ciphertext)
// ---------------------------------------------------------------------------

describe('kmsEncrypt — ciphertext layout pins (AES-256-GCM dev cipher)', () => {
  it('ciphertext is at least IV(12) + tag(16) bytes plus the plaintext length', async () => {
    const ctx = tenantCtx(TENANT_US);
    const plaintext = Buffer.from('layout pin', 'utf8');
    const ciphertext = await kmsEncrypt(ctx, plaintext);
    // Minimum overhead: 12 (IV) + 16 (auth tag) = 28 bytes.
    // For empty plaintext the ciphertext == 28 bytes; with non-empty
    // it grows by the plaintext's length (GCM is a stream cipher, so
    // ciphertext.length === plaintext.length, no padding).
    expect(ciphertext.length).toBe(28 + plaintext.length);
  });

  it('ciphertext for empty plaintext is exactly 28 bytes (IV+tag overhead, no payload)', async () => {
    const ctx = tenantCtx(TENANT_US);
    const ciphertext = await kmsEncrypt(ctx, Buffer.alloc(0));
    expect(ciphertext.length).toBe(28);
  });

  it('ciphertext is opaque vs plaintext (no naive substring pass-through)', async () => {
    // Sanity: a marker string in the plaintext must NOT appear in the
    // ciphertext. AES-GCM is a real cipher; pinning this catches a
    // hypothetical regression to a passthrough/identity stub.
    const ctx = tenantCtx(TENANT_US);
    const marker = 'CIPHER-PASSTHROUGH-LEAK-MARKER';
    const ciphertext = await kmsEncrypt(ctx, Buffer.from(marker, 'utf8'));
    expect(ciphertext.toString('utf8')).not.toContain(marker);
    // Defense-in-depth: hex representation also can't contain the
    // marker's hex (the marker happens to be all-ASCII so its hex
    // representation has predictable patterns).
    expect(ciphertext.toString('hex')).not.toContain(Buffer.from(marker, 'utf8').toString('hex'));
  });
});

// ---------------------------------------------------------------------------
// §3 — Cross-tenant decrypt rejection (AAD encryption-context binding)
// ---------------------------------------------------------------------------

describe('kmsDecrypt — cross-tenant rejection (AAD encryption-context binding)', () => {
  it('US-encrypted ciphertext FAILS to decrypt under Ghana context (auth-tag mismatch)', async () => {
    const usCtx = tenantCtx(TENANT_US);
    const ghanaCtx = tenantCtx(TENANT_GHANA);
    const plaintext = Buffer.from('US-only secret', 'utf8');
    const usCiphertext = await kmsEncrypt(usCtx, plaintext);

    // Decrypting the US ciphertext under the Ghana context MUST fail.
    // The Ghana key is derived from `master + 'Telecheck-Ghana'`, the
    // US key from `master + 'Telecheck-US'` — different keys → auth
    // tag fails to verify, GCM throws.
    await expect(kmsDecrypt(ghanaCtx, usCiphertext)).rejects.toThrow();
  });

  it('Ghana-encrypted ciphertext FAILS to decrypt under US context', async () => {
    // Inverse direction — proves the asymmetry isn't accidentally one-
    // directional.
    const usCtx = tenantCtx(TENANT_US);
    const ghanaCtx = tenantCtx(TENANT_GHANA);
    const plaintext = Buffer.from('Ghana-only secret', 'utf8');
    const ghanaCiphertext = await kmsEncrypt(ghanaCtx, plaintext);
    await expect(kmsDecrypt(usCtx, ghanaCiphertext)).rejects.toThrow();
  });

  it('SAME tenant ciphertext STILL decrypts (sanity counterpart)', async () => {
    // Defense-in-depth: the cross-tenant rejection tests above could
    // theoretically pass even if NO tenant could decrypt anything.
    // This counterpart confirms the rejection IS tenant-specific.
    const usCtx = tenantCtx(TENANT_US);
    const plaintext = Buffer.from('same-tenant decrypt works', 'utf8');
    const ciphertext = await kmsEncrypt(usCtx, plaintext);
    const recovered = await kmsDecrypt(usCtx, ciphertext);
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('cross-tenant rejection holds even when the second tenant ID is a prefix/suffix of the first', async () => {
    // Edge case: AAD binding uses the FULL tenantId string, not a
    // prefix. A bug that compared prefixes could leak across
    // tenant-name overlaps. Pinning that 'Telecheck-US' and
    // 'Telecheck-USA' (hypothetical) would NOT collide.
    const usCtx = tenantCtx(TENANT_US);
    const usaCtx = tenantCtx('Telecheck-USA' as typeof TENANT_US);
    const plaintext = Buffer.from('prefix-overlap test', 'utf8');
    const usCiphertext = await kmsEncrypt(usCtx, plaintext);
    await expect(kmsDecrypt(usaCtx, usCiphertext)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §4 — Production gate fails closed in non-test env (NEVER silently encrypts)
// ---------------------------------------------------------------------------

describe('kms — production gate (fails closed in non-test env)', () => {
  it('kmsEncrypt fails closed when mandatory runtime integration is absent', async () => {
    const original = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      const ctx = tenantCtx(TENANT_US);
      await expect(kmsEncrypt(ctx, Buffer.from('should not encrypt', 'utf8'))).rejects.toThrow(
        'Tenant encryption operation is unavailable.',
      );
    } finally {
      process.env['NODE_ENV'] = original;
    }
  });

  it('kmsDecrypt THROWS in non-test env (cannot silently decrypt with dev key either)', async () => {
    const original = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      const ctx = tenantCtx(TENANT_US);
      // The ciphertext content doesn't matter — the gate fires before
      // any decryption is attempted.
      await expect(kmsDecrypt(ctx, Buffer.from('opaque', 'utf8'))).rejects.toThrow(
        'Tenant encryption operation is unavailable.',
      );
    } finally {
      process.env['NODE_ENV'] = original;
    }
  });

  it('failure does not expose tenant identity or raw diagnostics', async () => {
    const original = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'staging';
      const ctx = tenantCtx(TENANT_US);
      try {
        await kmsEncrypt(ctx, Buffer.from('x', 'utf8'));
        expect.fail('expected throw');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(TENANT_US);
        expect(message).toBe('Tenant encryption operation is unavailable.');
        expect((err as Error).cause).toBeUndefined();
      }
    } finally {
      process.env['NODE_ENV'] = original;
    }
  });

  it('kmsEncrypt fails closed for EVERY non-test env value (development, production, staging, "")', async () => {
    const original = process.env['NODE_ENV'];
    const ctx = tenantCtx(TENANT_US);
    try {
      for (const env of ['production', 'development', 'staging', '']) {
        process.env['NODE_ENV'] = env;
        await expect(kmsEncrypt(ctx, Buffer.from('x', 'utf8'))).rejects.toThrow(
          'Tenant encryption operation is unavailable.',
        );
      }
    } finally {
      process.env['NODE_ENV'] = original;
    }
  });

  it('AWS credentials cannot activate the primitive through normal public non-test calls', async () => {
    const originalEnv = process.env['NODE_ENV'];
    const originalAccessKey = process.env['AWS_ACCESS_KEY_ID'];
    const originalSecretKey = process.env['AWS_SECRET_ACCESS_KEY'];
    const send = vi.spyOn(KMSClient.prototype, 'send');
    try {
      process.env['NODE_ENV'] = 'production';
      process.env['AWS_ACCESS_KEY_ID'] = 'synthetic-test-access-key';
      process.env['AWS_SECRET_ACCESS_KEY'] = 'synthetic-test-secret-key';
      await expect(kms.encrypt(tenantCtx(TENANT_US), Buffer.from('private'))).rejects.toThrow(
        'Tenant encryption operation is unavailable.',
      );
      await expect(kms.decrypt(tenantCtx(TENANT_US), Buffer.alloc(100))).rejects.toThrow(
        'Tenant encryption operation is unavailable.',
      );
      expect(send).not.toHaveBeenCalled();
    } finally {
      if (originalEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = originalEnv;
      if (originalAccessKey === undefined) delete process.env['AWS_ACCESS_KEY_ID'];
      else process.env['AWS_ACCESS_KEY_ID'] = originalAccessKey;
      if (originalSecretKey === undefined) delete process.env['AWS_SECRET_ACCESS_KEY'];
      else process.env['AWS_SECRET_ACCESS_KEY'] = originalSecretKey;
      send.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// §5 — Malformed ciphertext rejection
// ---------------------------------------------------------------------------

describe('kmsDecrypt — malformed ciphertext rejection', () => {
  it('rejects ciphertext shorter than the IV+tag overhead (28 bytes)', async () => {
    const ctx = tenantCtx(TENANT_US);
    // 27 bytes is one byte short of the minimum.
    await expect(kmsDecrypt(ctx, Buffer.alloc(27))).rejects.toThrow(/ciphertext too short/);
  });

  it('rejects ciphertext with tampered ciphertext body (auth-tag mismatch)', async () => {
    const ctx = tenantCtx(TENANT_US);
    const plaintext = Buffer.from('tamper test', 'utf8');
    const ciphertext = await kmsEncrypt(ctx, plaintext);
    // Flip a bit in the body (after IV+tag).
    const tampered = Buffer.from(ciphertext);
    if (tampered.length > 28) {
      tampered[28] = (tampered[28]! ^ 0xff) & 0xff;
    }
    await expect(kmsDecrypt(ctx, tampered)).rejects.toThrow();
  });

  it('rejects ciphertext with tampered auth tag', async () => {
    const ctx = tenantCtx(TENANT_US);
    const plaintext = Buffer.from('tag tamper test', 'utf8');
    const ciphertext = await kmsEncrypt(ctx, plaintext);
    // Flip a bit in the auth tag (bytes 12..27).
    const tampered = Buffer.from(ciphertext);
    tampered[12] = (tampered[12]! ^ 0xff) & 0xff;
    await expect(kmsDecrypt(ctx, tampered)).rejects.toThrow();
  });

  it('rejects ciphertext with tampered IV (auth-tag mismatch)', async () => {
    const ctx = tenantCtx(TENANT_US);
    const plaintext = Buffer.from('iv tamper test', 'utf8');
    const ciphertext = await kmsEncrypt(ctx, plaintext);
    // Flip a bit in the IV (bytes 0..11).
    const tampered = Buffer.from(ciphertext);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    await expect(kmsDecrypt(ctx, tampered)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §6 — Non-determinism + repeatable decrypt
// ---------------------------------------------------------------------------

describe('kmsEncrypt — non-determinism (random IV per call)', () => {
  it('two encrypts of the same plaintext produce DIFFERENT ciphertexts (IV randomness)', async () => {
    const ctx = tenantCtx(TENANT_US);
    const plaintext = Buffer.from('determinism check', 'utf8');
    const ct1 = await kmsEncrypt(ctx, plaintext);
    const ct2 = await kmsEncrypt(ctx, plaintext);
    expect(ct1.equals(ct2)).toBe(false);
  });

  it('both ciphertexts decrypt to the same original plaintext', async () => {
    // Counterpart to the non-determinism test: even though the two
    // ciphertexts differ, both round-trip to the same plaintext.
    const ctx = tenantCtx(TENANT_US);
    const plaintext = Buffer.from('determinism counterpart', 'utf8');
    const ct1 = await kmsEncrypt(ctx, plaintext);
    const ct2 = await kmsEncrypt(ctx, plaintext);
    const r1 = await kmsDecrypt(ctx, ct1);
    const r2 = await kmsDecrypt(ctx, ct2);
    expect(r1.equals(plaintext)).toBe(true);
    expect(r2.equals(plaintext)).toBe(true);
  });
});
