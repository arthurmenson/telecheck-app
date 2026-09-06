import { randomBytes } from 'node:crypto';

import type { GenerateDataKeyCommandOutput } from '@aws-sdk/client-kms';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { asTenantId } from './glossary.js';
import {
  createAwsTenantKms,
  KMS_MAX_PLAINTEXT_BYTES,
  KmsOperationError,
  type KmsKeyService,
} from './kms-aws.js';

const US = { tenantId: asTenantId('Telecheck-US'), kmsKeyAlias: 'alias/telecheck-us-data-key' };
const GH = { tenantId: asTenantId('Telecheck-Ghana'), kmsKeyAlias: 'alias/telecheck-gh-data-key' };

function fakeKms() {
  const stored = new Map<string, { key: Buffer; keyId: string; tenantId: string }>();
  const returnedPlaintextKeys: Uint8Array[] = [];
  const generateDataKey = vi.fn<KmsKeyService['generateDataKey']>(async (input) => {
    const key = randomBytes(32);
    const wrapped = randomBytes(80);
    stored.set(wrapped.toString('hex'), {
      key: Buffer.from(key),
      keyId: input.KeyId!,
      tenantId: input.EncryptionContext!['tenant_id']!,
    });
    returnedPlaintextKeys.push(key);
    return { Plaintext: key, CiphertextBlob: wrapped, $metadata: {} };
  });
  const decrypt = vi.fn<KmsKeyService['decrypt']>(async (input) => {
    const entry = stored.get(Buffer.from(input.CiphertextBlob!).toString('hex'));
    if (
      entry === undefined ||
      entry.keyId !== input.KeyId ||
      entry.tenantId !== input.EncryptionContext?.['tenant_id']
    ) {
      throw new Error('AWS diagnostic containing account/key/ciphertext details');
    }
    const key = Buffer.from(entry.key);
    returnedPlaintextKeys.push(key);
    return { Plaintext: key, $metadata: {} };
  });
  return { generateDataKey, decrypt, returnedPlaintextKeys, stored };
}

afterEach(() => vi.useRealTimers());

describe('AWS tenant envelope encryption', () => {
  it.each([0, 1, 256, 4097, 128 * 1024])(
    'round-trips %i bytes without sending payload to KMS',
    async (size) => {
      const service = fakeKms();
      const adapter = createAwsTenantKms(service);
      const plain = randomBytes(size);
      const original = Buffer.from(plain);
      const encrypted = await adapter.encrypt(US, plain);
      expect(encrypted.subarray(0, 8).toString()).toBe('TCKMS001');
      expect(encrypted.equals(plain)).toBe(false);
      expect(service.generateDataKey).toHaveBeenCalledWith(
        {
          KeyId: US.kmsKeyAlias,
          KeySpec: 'AES_256',
          EncryptionContext: { tenant_id: US.tenantId },
        },
        expect.any(AbortSignal),
      );
      const recovered = await adapter.decrypt(US, encrypted);
      expect(recovered).toEqual(original);
      expect(plain).toEqual(original);
      expect(service.decrypt.mock.calls[0]![0]).toEqual({
        KeyId: US.kmsKeyAlias,
        CiphertextBlob: encrypted.subarray(10, 90),
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        EncryptionContext: { tenant_id: US.tenantId },
      });
      for (const key of service.returnedPlaintextKeys)
        expect(key.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('generates a new data key and IV per encryption', async () => {
    const service = fakeKms();
    const adapter = createAwsTenantKms(service);
    const first = await adapter.encrypt(US, Buffer.from('same input'));
    const second = await adapter.encrypt(US, Buffer.from('same input'));
    expect(service.generateDataKey).toHaveBeenCalledTimes(2);
    expect(first.subarray(10, 90)).not.toEqual(second.subarray(10, 90));
    expect(first.subarray(90, 102)).not.toEqual(second.subarray(90, 102));
    expect(await adapter.decrypt(US, first)).toEqual(await adapter.decrypt(US, second));
  });

  it('binds both tenant context and the trusted tenant key, never an envelope-selected key', async () => {
    const service = fakeKms();
    const adapter = createAwsTenantKms(service);
    const encrypted = await adapter.encrypt(US, Buffer.from('private'));
    await expect(adapter.decrypt(GH, encrypted)).rejects.toThrow(KmsOperationError);
    expect(service.decrypt.mock.calls[0]![0].KeyId).toBe(GH.kmsKeyAlias);
    await expect(
      adapter.decrypt({ ...US, kmsKeyAlias: GH.kmsKeyAlias }, encrypted),
    ).rejects.toThrow(KmsOperationError);
    // Equal CMK configuration cannot bypass the encryption-context distinction.
    await expect(
      adapter.decrypt({ ...GH, kmsKeyAlias: US.kmsKeyAlias }, encrypted),
    ).rejects.toThrow(KmsOperationError);
  });

  it('local AAD rejects another tenant even if a defective KMS transport ignores context', async () => {
    const service = fakeKms();
    const adapter = createAwsTenantKms(service);
    const encrypted = await adapter.encrypt(US, Buffer.from('private'));
    const entry = [...service.stored.values()][0]!;
    const key = Buffer.from(entry.key);
    service.decrypt.mockResolvedValueOnce({ Plaintext: key, $metadata: {} });
    await expect(adapter.decrypt(GH, encrypted)).rejects.toThrow(KmsOperationError);
    expect(key.every((byte) => byte === 0)).toBe(true);
  });

  it.each([10, 89, 90, 101, 102, 117, 118])(
    'rejects tampering at envelope byte %i and wipes returned data keys',
    async (offset) => {
      const service = fakeKms();
      const adapter = createAwsTenantKms(service);
      const encrypted = await adapter.encrypt(US, Buffer.from('private binary content'));
      encrypted[offset] = encrypted[offset]! ^ 1;
      await expect(adapter.decrypt(US, encrypted)).rejects.toThrow(KmsOperationError);
      for (const key of service.returnedPlaintextKeys)
        expect(key.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('rejects old formats, unknown versions and malformed lengths before calling KMS', async () => {
    const service = fakeKms();
    const adapter = createAwsTenantKms(service);
    const valid = await adapter.encrypt(US, Buffer.from('hello'));
    const unknownVersion = Buffer.from(valid);
    unknownVersion[7] = '2'.charCodeAt(0);
    const zeroKey = Buffer.from(valid);
    zeroKey.writeUInt16BE(0, 8);
    const oversizedKey = Buffer.from(valid);
    oversizedKey.writeUInt16BE(6145, 8);
    const truncated = valid.subarray(0, 100);
    for (const value of [
      Buffer.alloc(0),
      Buffer.alloc(50),
      unknownVersion,
      zeroKey,
      oversizedKey,
      truncated,
    ]) {
      await expect(adapter.decrypt(US, value)).rejects.toThrow(KmsOperationError);
    }
    expect(service.decrypt).not.toHaveBeenCalled();
  });

  it('rejects oversized plaintext/ciphertext and malformed tenant/key references before KMS', async () => {
    const service = fakeKms();
    const adapter = createAwsTenantKms(service);
    await expect(adapter.encrypt(US, Buffer.alloc(KMS_MAX_PLAINTEXT_BYTES + 1))).rejects.toThrow(
      KmsOperationError,
    );
    await expect(adapter.decrypt(US, Buffer.alloc(KMS_MAX_PLAINTEXT_BYTES + 7000))).rejects.toThrow(
      KmsOperationError,
    );
    for (const kmsKeyAlias of [
      '',
      'alias/contains secret spaces',
      'https://evil.example/key',
      'x'.repeat(2049),
    ]) {
      await expect(adapter.encrypt({ ...US, kmsKeyAlias }, Buffer.alloc(1))).rejects.toThrow(
        KmsOperationError,
      );
    }
    await expect(
      adapter.encrypt({ ...US, tenantId: 'patient-secret' as typeof US.tenantId }, Buffer.alloc(1)),
    ).rejects.toThrow(KmsOperationError);
    expect(service.generateDataKey).not.toHaveBeenCalled();
    expect(service.decrypt).not.toHaveBeenCalled();
  });

  it.each([0, 16, 31, 33])(
    'erases malformed %i-byte data keys when encryption rejects the response',
    async (size) => {
      const service = fakeKms();
      const key = Buffer.alloc(size, 0xab);
      service.generateDataKey.mockResolvedValueOnce({
        Plaintext: key,
        CiphertextBlob: Buffer.alloc(80),
        $metadata: {},
      });
      await expect(createAwsTenantKms(service).encrypt(US, Buffer.from('private'))).rejects.toThrow(
        KmsOperationError,
      );
      expect(key.every((byte) => byte === 0)).toBe(true);
    },
  );

  it.each([undefined, Buffer.alloc(0), Buffer.alloc(6145)])(
    'erases data key when wrapped-key response is malformed',
    async (wrapped) => {
      const service = fakeKms();
      const key = Buffer.alloc(32, 0xab);
      service.generateDataKey.mockResolvedValueOnce({
        Plaintext: key,
        CiphertextBlob: wrapped,
        $metadata: {},
      });
      await expect(createAwsTenantKms(service).encrypt(US, Buffer.from('private'))).rejects.toThrow(
        KmsOperationError,
      );
      expect(key.every((byte) => byte === 0)).toBe(true);
    },
  );

  it('erases malformed decrypted keys and does not return bytes', async () => {
    const service = fakeKms();
    const adapter = createAwsTenantKms(service);
    const encrypted = await adapter.encrypt(US, Buffer.from('private'));
    const key = Buffer.alloc(31, 0xab);
    service.decrypt.mockResolvedValueOnce({ Plaintext: key, $metadata: {} });
    await expect(adapter.decrypt(US, encrypted)).rejects.toThrow(KmsOperationError);
    expect(key.every((byte) => byte === 0)).toBe(true);
  });

  it('returns only a fixed safe error without a raw cause on AWS failures', async () => {
    const service = fakeKms();
    service.generateDataKey.mockRejectedValueOnce(
      new Error('secret ARN key plaintext credential diagnosis'),
    );
    const error = await createAwsTenantKms(service)
      .encrypt(US, Buffer.from('private'))
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(KmsOperationError);
    expect((error as Error).message).toBe('Tenant encryption operation is unavailable.');
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain('secret');
  });

  it('snapshots caller-owned plaintext and tenant before asynchronous key generation', async () => {
    const service = fakeKms();
    const generate = service.generateDataKey.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.generateDataKey.mockImplementation(async (input, signal) => {
      await gate;
      return generate(input, signal);
    });
    const adapter = createAwsTenantKms(service);
    const tenant = { ...US };
    const plain = Buffer.from('original');
    const pending = adapter.encrypt(tenant, plain);
    tenant.tenantId = GH.tenantId;
    tenant.kmsKeyAlias = GH.kmsKeyAlias;
    plain.fill(0);
    release();
    const encrypted = await pending;
    expect(await adapter.decrypt(US, encrypted)).toEqual(Buffer.from('original'));
  });

  it('snapshots ciphertext before asynchronous unwrap', async () => {
    const service = fakeKms();
    const adapter = createAwsTenantKms(service);
    const encrypted = await adapter.encrypt(US, Buffer.from('original'));
    const decrypt = service.decrypt.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.decrypt.mockImplementation(async (input, signal) => {
      await gate;
      return decrypt(input, signal);
    });
    const pending = adapter.decrypt(US, encrypted);
    encrypted.fill(0);
    release();
    expect(await pending).toEqual(Buffer.from('original'));
  });

  it('aborts a timed-out request and erases data keys delivered after cancellation', async () => {
    vi.useFakeTimers();
    const service = fakeKms();
    let resolve!: (response: GenerateDataKeyCommandOutput) => void;
    let observedSignal: AbortSignal | undefined;
    service.generateDataKey.mockImplementation((_input, signal) => {
      observedSignal = signal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const adapter = createAwsTenantKms(service, 50);
    const pending = adapter.encrypt(US, Buffer.from('private'));
    const rejected = expect(pending).rejects.toThrow(KmsOperationError);
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(observedSignal?.aborted).toBe(true);
    const lateKey = Buffer.alloc(32, 0xab);
    resolve({ Plaintext: lateKey, CiphertextBlob: Buffer.alloc(80), $metadata: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateKey.every((byte) => byte === 0)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
