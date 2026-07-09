/**
 * ai-provider-credential-envelope.test.ts — SI-025 unit tests for the
 * platform-scoped KMS envelope helper.
 *
 * Under NODE_ENV=test the local-dev crypto path is exercised (deterministic
 * AES-256-GCM with the TENANT_KMS_LOCAL_DEV_KEY-derived platform key). These
 * tests lock in:
 *   - round-trip: encrypt → decrypt yields the original plaintext
 *   - the 8-field envelope shape (all fields populated)
 *   - tamper detection: a mangled tag / ciphertext fails auth
 *   - non-secret metadata: last4 mask + SHA-256 fingerprint are stable,
 *     non-reversible, and the fingerprint differs for different keys
 *   - the plaintext NEVER appears in the envelope's serialized form
 *
 * Spec references:
 *   - SI-025 §3 (8-field envelope) / §7 (plaintext never at rest raw)
 *   - ADR-024 / I-026 (envelope shape)
 */

import { describe, expect, it, beforeAll } from 'vitest';

import {
  computeKeyFingerprint,
  computeKeyLast4,
  decryptAiProviderKey,
  encryptAiProviderKey,
} from '../../src/lib/ai-provider-credential-envelope.ts';

const SAMPLE_KEY = 'sk-ant-api03-EXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE-AB12';

beforeAll(() => {
  // The envelope helper derives its platform key from TENANT_KMS_LOCAL_DEV_KEY.
  // tests/setup.ts sets this, but guard here for isolated runs.
  if (
    process.env['TENANT_KMS_LOCAL_DEV_KEY'] === undefined ||
    process.env['TENANT_KMS_LOCAL_DEV_KEY'].length < 32
  ) {
    process.env['TENANT_KMS_LOCAL_DEV_KEY'] = 'test-local-dev-kms-master-key-0123456789abcdef';
  }
});

describe('SI-025 envelope — round-trip', () => {
  it('encrypt → decrypt yields the original plaintext', () => {
    const env = encryptAiProviderKey(SAMPLE_KEY);
    const plain = decryptAiProviderKey(env);
    expect(plain).toBe(SAMPLE_KEY);
  });

  it('produces all 8 envelope fields populated', () => {
    const env = encryptAiProviderKey(SAMPLE_KEY);
    expect(env.ciphertext.length).toBeGreaterThan(0);
    expect(env.dekId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(env.iv.length).toBe(12);
    expect(env.tag.length).toBe(16);
    expect(env.alg).toBe('AES-256-GCM');
    expect(env.algVersion).toBe('1');
    expect(env.aad.length).toBeGreaterThan(0);
    expect(env.encryptedAt).toBeInstanceOf(Date);
  });

  it('the plaintext NEVER appears in the serialized envelope', () => {
    const env = encryptAiProviderKey(SAMPLE_KEY);
    const serialized = JSON.stringify({
      ciphertext: env.ciphertext.toString('hex'),
      dekId: env.dekId,
      iv: env.iv.toString('hex'),
      tag: env.tag.toString('hex'),
      alg: env.alg,
      algVersion: env.algVersion,
      aad: env.aad.toString('hex'),
    });
    expect(serialized).not.toContain(SAMPLE_KEY);
    expect(serialized).not.toContain('sk-ant-api03');
  });

  it('tamper detection: a mangled auth tag fails decryption', () => {
    const env = encryptAiProviderKey(SAMPLE_KEY);
    const tampered = { ...env, tag: Buffer.alloc(16, 0) };
    expect(() => decryptAiProviderKey(tampered)).toThrow();
  });
});

describe('SI-025 envelope — non-secret metadata', () => {
  it('computeKeyLast4 masks all but the last 4 chars', () => {
    const masked = computeKeyLast4(SAMPLE_KEY);
    expect(masked).toBe('sk-...AB12');
    expect(masked).not.toContain('EXAMPLE');
  });

  it('computeKeyFingerprint is a stable, non-reversible SHA-256 hex digest', () => {
    const fp1 = computeKeyFingerprint(SAMPLE_KEY);
    const fp2 = computeKeyFingerprint(SAMPLE_KEY);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    // The fingerprint does not contain the plaintext.
    expect(fp1).not.toContain('sk-');
  });

  it('different keys produce different fingerprints (rotation detection)', () => {
    const fpA = computeKeyFingerprint('sk-ant-KEY-AAAA');
    const fpB = computeKeyFingerprint('sk-ant-KEY-BBBB');
    expect(fpA).not.toBe(fpB);
  });
});
