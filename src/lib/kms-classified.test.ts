import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { createClassifiedKms } from './classified-kms.js';
import type { DbTransaction } from './db.js';
import type { TenantId } from './glossary.js';
import { KmsOperationError } from './kms-aws.js';
import {
  createClassifiedKeyProvider,
  type ClassifiedKeyTransport,
  type ClassifiedKeyProvider,
} from './kms-classified-aws.js';
import type { ClassifiedKmsStore } from './kms-classified-store.js';
import {
  KMS_DATA_CLASSES,
  validateBinding,
  type ClassifiedResource,
  type KmsActor,
  type TenantKeyBinding,
} from './kms-classified-types.js';
import { decryptRow, encryptRow, snapshotEnvelope } from './kms-row-envelope.js';

const tenantId = 'Telecheck-US' as TenantId;
const resource: ClassifiedResource = {
  dataClass: 'pii_sensitive_clinical',
  patientId: '01JZZZ00000000000000000001',
  resourceType: 'async_consult_intake',
  resourceId: '01JZZZ00000000000000000002',
  field: 'answers',
};
const version = '01JZZZ00000000000000000003';
const actor: KmsActor = {
  tenantId,
  accountId: resource.patientId!,
  sessionId: '01JZZZ00000000000000000004',
  role: 'patient',
  countryOfCare: 'US',
  nonce: '8989887b-b24e-4a69-917f-2338ca19eb3f',
  transactionId: '401',
};
const binding: TenantKeyBinding = {
  tenantId,
  cmkArn: 'arn:aws:kms:us-east-1:123456789012:key/0b1978c6-cb09-4da0-933e-449b5d1e1c24',
  serviceRoleArn: 'arn:aws:iam::123456789012:role/telecheck-tenant-us',
  primaryRegion: 'us-east-1',
  residencyPolicy: 'us_only',
  replicaArn: null,
};
const tx: DbTransaction = { query: async () => ({ rows: [], rowCount: 0 }) };

describe('tenant KMS infrastructure launch contract', () => {
  const template = JSON.parse(
    readFileSync(new URL('../../infra/kms/tenant-primary.template.json', import.meta.url), 'utf8'),
  ) as {
    Parameters: {
      TenantId: {
        Type: string;
        AllowedPattern?: string;
        AllowedValues?: string[];
        Default?: string;
      };
    };
  };
  const parameter = template.Parameters.TenantId;
  // CloudFormation String constraints match the entire value. These are the
  // real seeded launch tenant IDs, not invented ISO aliases or suffixes.
  it.each([
    ['Telecheck-US', true],
    ['Telecheck-Ghana', true],
    ['Telecheck-GH', false],
    ['Telecheck-US-Test', false],
    ['Telecheck-Ghana-Test', false],
    ['Telecheck-Nigeria', false],
    ['Heros', false],
  ] as const)('validates %s as %s', (value, expected) => {
    const accepted =
      (!parameter.AllowedPattern || new RegExp(`^(?:${parameter.AllowedPattern})$`).test(value)) &&
      (!parameter.AllowedValues || parameter.AllowedValues.includes(value));
    expect(accepted).toBe(expected);
  });
  it('requires an explicit operating tenant at deployment', () => {
    expect(parameter.Type).toBe('String');
    expect(parameter.Default).toBeUndefined();
  });
  it('matches the launch identifiers actually seeded by migration 001', () => {
    const migration = readFileSync(
      new URL('../../migrations/001_tenants.sql', import.meta.url),
      'utf8',
    );
    const seed = migration.slice(migration.indexOf('INSERT INTO tenants'));
    const tenants = new Set(
      [...seed.matchAll(/^\s*'(Telecheck-[A-Za-z]+)',/gm)].map((match) => match[1]),
    );
    expect(tenants.size).toBe(2);
    expect([...(parameter.AllowedValues ?? [])].sort()).toEqual([...tenants].sort());
  });
});

describe('classified row authentication', () => {
  it.each(KMS_DATA_CLASSES)('round-trips %s with independent random row keys', (dataClass) => {
    const key = randomBytes(32),
      descriptor = { ...resource, dataClass };
    const input = Buffer.from('clinical résumé 🔐 '.repeat(4000));
    const first = encryptRow(tenantId, descriptor, version, key, input);
    const second = encryptRow(tenantId, descriptor, version, key, input);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(decryptRow(tenantId, descriptor, first, key)).toEqual(input);
    expect(first.algVersion).toBe('2');
    key.fill(0);
  });
  it.each([
    'tenant',
    'patient',
    'class',
    'resourceType',
    'resourceId',
    'field',
    'version',
    'timestamp',
    'algorithm',
    'algorithmVersion',
    'aad',
    'wrapIv',
    'wrapTag',
    'wrappedKey',
    'dataIv',
    'dataTag',
    'data',
    'key',
  ] as const)('rejects tampering with %s', (target) => {
    let tenant = tenantId;
    const key = randomBytes(32),
      descriptor = { ...resource };
    const value = encryptRow(tenantId, resource, version, key, Buffer.from('confidential'));
    if (target === 'tenant') tenant = 'Telecheck-Ghana' as TenantId;
    if (target === 'patient') descriptor.patientId = '01JZZZ00000000000000000005';
    if (target === 'class') descriptor.dataClass = 'pii_clinical';
    if (target === 'resourceType') descriptor.resourceType = 'clinical_decision';
    if (target === 'resourceId') descriptor.resourceId = '01JZZZ00000000000000000006';
    if (target === 'field') descriptor.field = 'clinical_summary';
    if (target === 'version') value.dekId = '01JZZZ00000000000000000007';
    if (target === 'timestamp') value.encryptedAt = new Date(value.encryptedAt.getTime() + 1);
    if (target === 'algorithm') value.alg = 'AES-CBC';
    if (target === 'algorithmVersion') value.algVersion = '1';
    if (target === 'aad') value.aad[0] = 0;
    if (target === 'wrapIv') value.ciphertext[8] = value.ciphertext[8]! ^ 1;
    if (target === 'wrapTag') value.ciphertext[20] = value.ciphertext[20]! ^ 1;
    if (target === 'wrappedKey') value.ciphertext[36] = value.ciphertext[36]! ^ 1;
    if (target === 'dataIv') value.iv[0] = value.iv[0]! ^ 1;
    if (target === 'dataTag') value.tag[0] = value.tag[0]! ^ 1;
    if (target === 'data') value.ciphertext[68] = value.ciphertext[68]! ^ 1;
    if (target === 'key') key[0] = key[0]! ^ 1;
    expect(() => decryptRow(tenant, descriptor, value, key)).toThrow(KmsOperationError);
  });
  it('rejects malformed and legacy containers before cloud access', () => {
    const value = encryptRow(tenantId, resource, version, randomBytes(32), Buffer.alloc(0));
    expect(() => decryptRow(tenantId, resource, value, randomBytes(32))).toThrow(KmsOperationError);
    value.ciphertext = Buffer.from('TCKMS001');
    expect(() => snapshotEnvelope(tenantId, resource, value)).toThrow();
  });
});

function transport(activeBinding: TenantKeyBinding = binding) {
  const plaintext = randomBytes(32);
  const adapter: ClassifiedKeyTransport = {
    assumeRole: vi.fn(async () => ({
      $metadata: {},
      Credentials: {
        AccessKeyId: 'test-id',
        SecretAccessKey: 'test-secret',
        SessionToken: 'test-token',
        Expiration: new Date(Date.now() + 900_000),
      },
    })),
    generate: vi.fn(async () => ({
      $metadata: {},
      KeyId: activeBinding.cmkArn,
      Plaintext: plaintext,
      CiphertextBlob: Buffer.from('wrapped'),
    })),
    decrypt: vi.fn(async () => ({
      $metadata: {},
      KeyId: activeBinding.cmkArn,
      EncryptionAlgorithm: 'SYMMETRIC_DEFAULT' as const,
      Plaintext: plaintext,
    })),
  };
  return { adapter, plaintext };
}

describe('classified STS and KMS boundary', () => {
  it.each([
    binding,
    {
      ...binding,
      tenantId: 'Telecheck-Ghana' as TenantId,
      cmkArn: binding.cmkArn.replace('0b1978c6', '1b1978c6'),
      serviceRoleArn: 'arn:aws:iam::123456789012:role/telecheck-tenant-ghana',
    },
  ])(
    'uses $tenantId registered key/role and exact tenant/class context; erases AWS key response',
    async (activeBinding) => {
      const { adapter, plaintext } = transport(activeBinding);
      const expected = Buffer.from(plaintext);
      const result = await createClassifiedKeyProvider(adapter).generate(
        activeBinding,
        resource.dataClass,
      );
      expect(result.plaintext).toEqual(expected);
      expect(plaintext).toEqual(Buffer.alloc(32));
      const request = vi.mocked(adapter.assumeRole).mock.calls[0]![0];
      expect(request.RoleArn).toBe(activeBinding.serviceRoleArn);
      expect(request.Tags).toEqual([{ Key: 'tenant_id', Value: activeBinding.tenantId }]);
      expect(request.DurationSeconds).toBe(900);
      expect(JSON.stringify(request)).not.toContain(resource.patientId);
      expect(vi.mocked(adapter.generate).mock.calls[0]![2]).toEqual({
        KeyId: activeBinding.cmkArn,
        KeySpec: 'AES_256',
        EncryptionContext: { tenant_id: activeBinding.tenantId, data_class: resource.dataClass },
      });
    },
  );
  it.each(['key', 'algorithm', 'length', 'credentialExpiry', 'blob'] as const)(
    'rejects an invalid AWS %s response',
    async (fault) => {
      const { adapter, plaintext } = transport();
      if (fault === 'key')
        vi.mocked(adapter.decrypt).mockResolvedValue({
          $metadata: {},
          KeyId: 'arn:aws:kms:us-west-2:123456789012:key/0b1978c6-cb09-4da0-933e-449b5d1e1c24',
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          Plaintext: plaintext,
        });
      if (fault === 'algorithm')
        vi.mocked(adapter.decrypt).mockResolvedValue({
          $metadata: {},
          KeyId: binding.cmkArn,
          EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
          Plaintext: plaintext,
        });
      if (fault === 'length')
        vi.mocked(adapter.decrypt).mockResolvedValue({
          $metadata: {},
          KeyId: binding.cmkArn,
          EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
          Plaintext: Buffer.alloc(31),
        });
      if (fault === 'credentialExpiry')
        vi.mocked(adapter.assumeRole).mockResolvedValue({
          $metadata: {},
          Credentials: {
            AccessKeyId: 'x',
            SecretAccessKey: 'y',
            SessionToken: 'z',
            Expiration: new Date(0),
          },
        });
      if (fault === 'blob')
        await expect(
          createClassifiedKeyProvider(adapter).decrypt(
            binding,
            resource.dataClass,
            Buffer.alloc(6145),
          ),
        ).rejects.toThrow(KmsOperationError);
      else
        await expect(
          createClassifiedKeyProvider(adapter).decrypt(
            binding,
            resource.dataClass,
            Buffer.from('wrapped'),
          ),
        ).rejects.toThrow(KmsOperationError);
      if (fault === 'key' || fault === 'algorithm') expect(plaintext).toEqual(Buffer.alloc(32));
    },
  );
  it('times out, bounds pending operations and wipes keys from a late response', async () => {
    const { adapter, plaintext } = transport();
    let release!: () => void;
    vi.mocked(adapter.generate).mockImplementation(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return {
        $metadata: {},
        KeyId: binding.cmkArn,
        Plaintext: plaintext,
        CiphertextBlob: Buffer.from('blob'),
      };
    });
    const provider = createClassifiedKeyProvider(adapter, 20, 1);
    await expect(provider.generate(binding, resource.dataClass)).rejects.toThrow(KmsOperationError);
    await expect(provider.generate(binding, resource.dataClass)).rejects.toThrow(KmsOperationError);
    expect(adapter.generate).toHaveBeenCalledTimes(1);
    release();
    await new Promise((r) => setImmediate(r));
    expect(plaintext).toEqual(Buffer.alloc(32));
  });
  it.each([
    { ...binding, cmkArn: 'alias/telecheck-us' },
    { ...binding, primaryRegion: 'us-west-2' },
    { ...binding, serviceRoleArn: 'arn:aws:iam::999999999999:role/foreign' },
    { ...binding, replicaArn: binding.cmkArn },
    { ...binding, residencyPolicy: 'us_with_dr_fallback' },
  ])('rejects noncanonical registry binding %#', (bad) =>
    expect(() => validateBinding(bad as TenantKeyBinding)).toThrow(),
  );
});

function engineFixture() {
  const key = randomBytes(32),
    returnedKeys: Buffer[] = [];
  const records = new Map([[version, Buffer.from('wrapped-v1')]]);
  let current = version;
  const provider: ClassifiedKeyProvider = {
    generate: vi.fn(async () => {
      const owned = Buffer.from(key);
      returnedKeys.push(owned);
      return { plaintext: owned, encrypted: Buffer.from('wrapped-next') };
    }),
    decrypt: vi.fn(async () => {
      const owned = Buffer.from(key);
      returnedKeys.push(owned);
      return owned;
    }),
  };
  const store: ClassifiedKmsStore = {
    auditActor: vi.fn(async () => null),
    actor: vi.fn(async () => ({ ...actor })),
    binding: vi.fn(async () => ({ ...binding })),
    active: vi.fn(async () => ({ dekId: current, encryptedDek: records.get(current)! })),
    install: vi.fn(async (_actor, _descriptor, candidate) => {
      records.set(candidate.dekId, candidate.encryptedDek);
      current = candidate.dekId;
      return candidate;
    }),
    lookup: vi.fn(async (_actor, _descriptor, id) => {
      const blob = records.get(id);
      if (!blob) throw new KmsOperationError();
      return { dekId: id, encryptedDek: blob };
    }),
    audit: vi.fn(async () => undefined),
  };
  return { key, returnedKeys, provider, store, engine: createClassifiedKms(store, provider) };
}

describe('classified engine release and version semantics', () => {
  it('commits success evidence before returning bytes; wipes class keys', async () => {
    const f = engineFixture();
    const envelope = await f.engine.encrypt(tx, resource, Buffer.from('patient answer'));
    const promise = f.engine.decrypt(tx, resource, envelope);
    const result = await promise;
    expect(result.toString()).toBe('patient answer');
    expect(f.store.audit).toHaveBeenCalledWith(
      expect.anything(),
      resource,
      binding,
      'kms.decrypt_invoked',
      { dek_version_id: version, decrypted_byte_count: 14 },
    );
    expect(f.returnedKeys.every((value) => value.equals(Buffer.alloc(32)))).toBe(true);
  });
  it('rejects plaintext release when success audit fails, then records failure', async () => {
    const f = engineFixture();
    const envelope = encryptRow(tenantId, resource, version, f.key, Buffer.from('never release'));
    vi.mocked(f.store.audit).mockRejectedValueOnce(
      new Error('INSERT or COMMIT secret database value'),
    );
    await expect(f.engine.decrypt(tx, resource, envelope)).rejects.toThrow(
      'Tenant encryption operation is unavailable.',
    );
    expect(f.store.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      resource,
      binding,
      'kms.decrypt_failed',
      expect.objectContaining({ failure_reason: 'kms_service_error' }),
    );
    expect(f.returnedKeys.every((value) => value.equals(Buffer.alloc(32)))).toBe(true);
  });
  it('audits malformed envelope failure without calling KMS', async () => {
    const f = engineFixture();
    const envelope = encryptRow(tenantId, resource, version, f.key, Buffer.from('answer'));
    envelope.aad[0] = 0;
    await expect(f.engine.decrypt(tx, resource, envelope)).rejects.toThrow(KmsOperationError);
    expect(f.provider.decrypt).not.toHaveBeenCalled();
    expect(f.store.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      resource,
      binding,
      'kms.decrypt_failed',
      expect.objectContaining({ failure_reason: 'encryption_context_mismatch' }),
    );
  });
  it.each(['sessionId', 'transactionId', 'tenantId', 'role'] as const)(
    'rejects changed live %s before release',
    async (field) => {
      const f = engineFixture();
      const envelope = encryptRow(tenantId, resource, version, f.key, Buffer.from('answer'));
      vi.mocked(f.store.actor)
        .mockResolvedValueOnce({ ...actor })
        .mockResolvedValue({ ...actor, [field]: 'different' });
      await expect(f.engine.decrypt(tx, resource, envelope)).rejects.toThrow(KmsOperationError);
      expect(f.store.audit).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'kms.decrypt_invoked',
        expect.anything(),
      );
    },
  );
  it('keeps old versions readable after active write rotation', async () => {
    const f = engineFixture();
    vi.mocked(f.store.actor).mockResolvedValue({ ...actor, role: 'tenant_admin' });
    const old = await f.engine.encrypt(tx, resource, Buffer.from('historical'));
    const next = await f.engine.rotateWriteVersion(tx, resource);
    expect(next).not.toBe(old.dekId);
    expect((await f.engine.encrypt(tx, resource, Buffer.from('new'))).dekId).toBe(next);
    expect((await f.engine.decrypt(tx, resource, old)).toString()).toBe('historical');
  });
  it('denies ordinary callers write-version rotation', async () => {
    const f = engineFixture();
    await expect(f.engine.rotateWriteVersion(tx, resource)).rejects.toThrow(KmsOperationError);
    expect(f.provider.generate).not.toHaveBeenCalled();
  });
  it('snapshots envelope and descriptor before yielding to caller mutation', async () => {
    const f = engineFixture(),
      descriptor = { ...resource };
    const envelope = encryptRow(tenantId, resource, version, f.key, Buffer.from('stable'));
    const pending = f.engine.decrypt(tx, descriptor, envelope);
    descriptor.field = 'swapped';
    envelope.ciphertext.fill(0);
    envelope.aad.fill(0);
    expect((await pending).toString()).toBe('stable');
  });
});
