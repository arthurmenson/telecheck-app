/** Real physical connections and COMMIT; no nested-savepoint test pool. */
import { randomBytes, randomUUID } from 'node:crypto';

import pg, { type PoolClient } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { bindActorContextForRequest } from '../../src/lib/actor-context-binding.js';
import { createClassifiedKms } from '../../src/lib/classified-kms.js';
import type { TenantId } from '../../src/lib/glossary.js';
import { KmsOperationError } from '../../src/lib/kms-aws.js';
import type { ClassifiedKeyProvider } from '../../src/lib/kms-classified-aws.js';
import { createClassifiedKmsStore, type KmsPool } from '../../src/lib/kms-classified-store.js';
import type { ClassifiedResource } from '../../src/lib/kms-classified-types.js';
import { logger } from '../../src/lib/logger.js';

const databaseUrl = process.env.KMS_INTEGRATION_DATABASE_URL;
const enabled = databaseUrl !== undefined;
const tenant = 'Telecheck-US' as TenantId;
const cmk = 'arn:aws:kms:us-east-1:123456789012:key/0b1978c6-cb09-4da0-933e-449b5d1e1c24';
const launchBindings = [
  {
    tenantId: tenant,
    country: 'US',
    cmkArn: cmk,
    serviceRoleArn: 'arn:aws:iam::123456789012:role/telecheck-tenant-us',
  },
  {
    tenantId: 'Telecheck-Ghana' as TenantId,
    country: 'GH',
    cmkArn: cmk.replace('0b1978c6', '1b1978c6'),
    serviceRoleArn: 'arn:aws:iam::123456789012:role/telecheck-tenant-ghana',
  },
] as const;
let admin: pg.Pool;
let auditPool: KmsPool;
const decryptedKeys: Buffer[] = [];
const materials = new Map<string, Buffer>();
const provider: ClassifiedKeyProvider = {
  async generate() {
    const key = randomBytes(32),
      id = randomUUID();
    materials.set(id, Buffer.from(key));
    decryptedKeys.push(key);
    return { plaintext: key, encrypted: Buffer.from(id) };
  },
  async decrypt(_binding, _class, wrapped) {
    const key = materials.get(wrapped.toString());
    if (!key) throw new KmsOperationError();
    const copy = Buffer.from(key);
    decryptedKeys.push(copy);
    return copy;
  },
};

async function asRole(
  role:
    | 'telecheck_app_role'
    | 'kms_service_role'
    | 'bind_actor_context_role'
    | 'kms_provisioner_role',
) {
  const client = await admin.connect();
  try {
    await client.query(`SET SESSION AUTHORIZATION ${role}`);
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}
async function release(client: PoolClient) {
  await client.query('ROLLBACK');
  await client.query('RESET SESSION AUTHORIZATION');
  client.release();
}
async function removeAuthority(
  f: { accountId: string; sessionId: string },
  change: 'deleted account' | 'revoked session',
) {
  if (change === 'deleted account') {
    await admin.query(
      'UPDATE public.accounts SET deleted_at=pg_catalog.clock_timestamp() WHERE account_id=$1',
      [f.accountId],
    );
  } else {
    await admin.query(
      "UPDATE public.sessions SET revoked_at=pg_catalog.clock_timestamp(), revoked_reason='admin_revoked' WHERE session_id=$1",
      [f.sessionId],
    );
  }
}
async function fixture(
  role: 'patient' | 'clinician' | 'tenant_admin' = 'patient',
  tenantId: TenantId = tenant,
) {
  const country = tenantId === 'Telecheck-Ghana' ? 'GH' : 'US';
  const patientId = ulid(),
    accountId = role === 'patient' ? patientId : ulid(),
    sessionId = ulid();
  const connection = await admin.connect();
  try {
    await connection.query('BEGIN');
    await connection.query('SELECT set_tenant_context($1)', [tenantId]);
    for (const [id, type] of role === 'patient'
      ? [[patientId, 'patient']]
      : [
          [patientId, 'patient'],
          [accountId, role],
        ]) {
      await connection.query(
        `INSERT INTO accounts (account_id, tenant_id, phone_e164, first_name, last_name, date_of_birth,
        gender, country_of_residence, country_of_care, account_type, status, cohort_classification)
        VALUES ($1,$2,$3,'Synthetic','KMS','1990-01-01','prefer_not_to_say',$5,$5,$4,'active','baseline')`,
        [
          id,
          tenantId,
          (country === 'GH' ? '+233' : '+1') +
            String(
              BigInt('0x' + randomBytes(6).toString('hex')) %
                (country === 'GH' ? 1_000_000_000n : 10_000_000_000n),
            ).padStart(country === 'GH' ? 9 : 10, '0'),
          type,
          country,
        ],
      );
    }
    await connection.query(
      "INSERT INTO sessions (session_id, tenant_id, account_id, refresh_token_hash, expires_at) VALUES ($1,$2,$3,$4,clock_timestamp() + INTERVAL '1 hour')",
      [sessionId, tenantId, accountId, randomBytes(32).toString('hex')],
    );
    await connection.query('SELECT clear_tenant_context()');
    await connection.query('COMMIT');
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
  const binder = await asRole('bind_actor_context_role');
  let nonce: string;
  try {
    nonce = (
      await bindActorContextForRequest(binder, {
        actorAccountId: accountId,
        actorAccountTenantId: tenantId,
        actorRole: role,
        actorAdminHomeTenantId: null,
        sessionId,
      })
    ).nonce;
  } finally {
    await release(binder);
  }
  const business = await asRole('telecheck_app_role');
  await business.query('BEGIN');
  await business.query('SELECT set_tenant_context($1)', [tenantId]);
  await business.query("SELECT set_config('app.request_nonce', $1, true)", [nonce]);
  const descriptor: ClassifiedResource = {
    dataClass: 'pii_sensitive_clinical',
    patientId,
    resourceType: 'async_consult_intake',
    resourceId: ulid(),
    field: 'answers',
  };
  return { business, descriptor, accountId, sessionId, nonce };
}

describe.skipIf(!enabled)('classified KMS database isolation and durable evidence', () => {
  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.includes('classified_kms'))
      throw new Error('Use a dedicated classified_kms integration database');
    admin = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 2000 });
    // Tests do not change cluster roles, disable RLS or suppress audit triggers.
    const provisioner = await asRole('kms_provisioner_role');
    try {
      for (const binding of launchBindings) {
        await provisioner.query(
          "INSERT INTO public.tenant_kms_bindings (tenant_id, cmk_arn, service_role_arn, residency_policy) VALUES ($1,$2,$3,'us_only')",
          [binding.tenantId, binding.cmkArn, binding.serviceRoleArn],
        );
      }
    } finally {
      await release(provisioner);
    }
    // Generate fresh class versions per process; an existing DB key cannot be
    // unwrapped by this process's controlled KMS service. Use an untouched DB.
    const count = await admin.query<{ count: string }>('SELECT count(*) FROM kms_dek_keyring');
    if (Number(count.rows[0]?.count) > 0)
      throw new Error('Use a freshly migrated integration database');
    auditPool = {
      async connect() {
        const client = await asRole('kms_service_role');
        return { query: client.query.bind(client), release: () => client.release(true) };
      },
    };
  });
  afterAll(async () => {
    for (const key of materials.values()) key.fill(0);
    materials.clear();
    await admin?.end();
  });

  it('signals an audit INSERT outage without details, rate limits repeats and refuses plaintext', async () => {
    const f = await fixture();
    f.descriptor.dataClass = 'pii_audit_payload';
    try {
      const envelope = await createClassifiedKms(
        createClassifiedKmsStore(auditPool),
        provider,
      ).encrypt(f.business, f.descriptor, Buffer.from('synthetic private response'));
      const outagePool: KmsPool = {
        async connect() {
          const client = await auditPool.connect();
          return {
            release: client.release,
            async query<R>(sql: string, values?: readonly unknown[]) {
              if (sql.startsWith('INSERT INTO public.audit_records'))
                throw new Error(
                  'synthetic SQL diagnostics, secret nonce and PHI must never be logged',
                );
              return client.query<R>(sql, values);
            },
          };
        },
      };
      const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
      try {
        const engine = createClassifiedKms(createClassifiedKmsStore(outagePool), provider);
        await expect(engine.decrypt(f.business, f.descriptor, envelope)).rejects.toThrow(
          KmsOperationError,
        );
        await expect(engine.decrypt(f.business, f.descriptor, envelope)).rejects.toThrow(
          KmsOperationError,
        );
        expect(error).toHaveBeenCalledExactlyOnceWith(
          { event: 'kms.audit.unavailable' },
          'Tenant encryption audit unavailable',
        );
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM public.audit_records WHERE resource_id=$1 AND action IN ('kms.decrypt_invoked','kms.decrypt_failed')",
              [f.descriptor.resourceId],
            )
          ).rows[0].n,
        ).toBe(0);
      } finally {
        error.mockRestore();
      }
    } finally {
      await release(f.business);
    }
  });
  it('commits class creation and decryption evidence independently of business rollback', async () => {
    const f = await fixture();
    try {
      const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
      const envelope = await engine.encrypt(
        f.business,
        f.descriptor,
        Buffer.from('synthetic clinical answer'),
      );
      expect((await engine.decrypt(f.business, f.descriptor, envelope)).toString()).toBe(
        'synthetic clinical answer',
      );
      await f.business.query('ROLLBACK');
      const events = await admin.query<{ action: string; category: string }>(
        'SELECT action, category FROM audit_records WHERE resource_id = $1 ORDER BY recorded_at',
        [f.descriptor.resourceId],
      );
      expect(events.rows).toEqual(
        expect.arrayContaining([
          { action: 'kms.dek_created', category: 'A' },
          { action: 'kms.dek_lookup', category: 'C' },
          { action: 'kms.decrypt_invoked', category: 'A' },
        ]),
      );
      expect(decryptedKeys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
    } finally {
      await release(f.business);
    }
  });
  it('denies direct app mutation of registry, keyring and dedicated-role assumption', async () => {
    const f = await fixture();
    try {
      for (const sql of [
        'UPDATE tenant_kms_bindings SET service_role_arn = service_role_arn',
        'DELETE FROM kms_dek_keyring',
        'SET ROLE kms_service_role',
        'SET ROLE kms_context_owner',
        'SET ROLE kms_provisioner_role',
      ]) {
        await f.business.query('SAVEPOINT denied');
        await expect(f.business.query(sql)).rejects.toThrow();
        await f.business.query('ROLLBACK TO SAVEPOINT denied');
      }
    } finally {
      await release(f.business);
    }
  });
  it('rejects patient substitution and a fabricated request nonce before KMS', async () => {
    const f = await fixture();
    try {
      const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
      await f.business.query('SAVEPOINT original');
      await expect(
        engine.encrypt(f.business, { ...f.descriptor, patientId: ulid() }, Buffer.from('x')),
      ).rejects.toThrow(KmsOperationError);
      await f.business.query('ROLLBACK TO SAVEPOINT original');
      await f.business.query("SELECT set_config('app.request_nonce', $1, true)", [randomUUID()]);
      await expect(engine.encrypt(f.business, f.descriptor, Buffer.from('x'))).rejects.toThrow(
        KmsOperationError,
      );
    } finally {
      await release(f.business);
    }
  });
  it('sees committed revocation even when business transaction started earlier', async () => {
    const f = await fixture();
    try {
      const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
      const envelope = await engine.encrypt(
        f.business,
        f.descriptor,
        Buffer.from('revocation test'),
      );
      await admin.query(
        "UPDATE sessions SET revoked_at=clock_timestamp(), revoked_reason='admin_revoked' WHERE session_id=$1",
        [f.sessionId],
      );
      await expect(engine.decrypt(f.business, f.descriptor, envelope)).rejects.toThrow(
        KmsOperationError,
      );
      const count = await admin.query<{ count: string }>(
        "SELECT count(*) FROM audit_records WHERE resource_id=$1 AND action='kms.decrypt_invoked'",
        [f.descriptor.resourceId],
      );
      expect(count.rows[0]?.count).toBe('0');
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM audit_records WHERE resource_id=$1 AND action='kms.decrypt_failed'",
            [f.descriptor.resourceId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await release(f.business);
    }
  });
  it('retains historical reads after write-version rotation and forbids retirement', async () => {
    const f = await fixture('tenant_admin');
    try {
      const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
      const old = await engine.encrypt(
        f.business,
        f.descriptor,
        Buffer.from('historical clinical record'),
      );
      const next = await engine.rotateWriteVersion(f.business, f.descriptor);
      expect(next).not.toBe(old.dekId);
      expect((await engine.decrypt(f.business, f.descriptor, old)).toString()).toBe(
        'historical clinical record',
      );
      const service = await asRole('kms_service_role');
      try {
        await service.query('SELECT set_tenant_context($1)', [tenant]);
        await expect(
          service.query('UPDATE kms_dek_keyring SET retired_at=clock_timestamp()'),
        ).rejects.toThrow();
      } finally {
        await release(service);
      }
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM audit_records WHERE resource_id=$1 AND action='kms.dek_rotation_completed'",
            [f.descriptor.resourceId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await release(f.business);
    }
  });
  it('commits authentication-failure evidence despite later business rollback', async () => {
    const f = await fixture();
    try {
      const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
      const envelope = await engine.encrypt(f.business, f.descriptor, Buffer.from('tamper test'));
      envelope.tag[0] = envelope.tag[0]! ^ 1;
      await expect(engine.decrypt(f.business, f.descriptor, envelope)).rejects.toThrow(
        KmsOperationError,
      );
      await f.business.query('ROLLBACK');
      const result = await admin.query(
        "SELECT payload->>'failure_reason' AS reason FROM audit_records WHERE resource_id=$1 AND action='kms.decrypt_failed'",
        [f.descriptor.resourceId],
      );
      expect(result.rows[0]?.reason).toBe('encryption_context_mismatch');
    } finally {
      await release(f.business);
    }
  });
  it('rejects an outer audit advisory lock before starting an independent audit', async () => {
    const f = await fixture();
    try {
      const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
      const envelope = await engine.encrypt(f.business, f.descriptor, Buffer.from('locked'));
      await f.business.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2,0))", [
        tenant,
        f.descriptor.patientId,
      ]);
      await expect(engine.decrypt(f.business, f.descriptor, envelope)).rejects.toThrow(
        KmsOperationError,
      );
    } finally {
      await release(f.business);
    }
  });
  it('does not release plaintext on lost audit COMMIT acknowledgement', async () => {
    const f = await fixture();
    try {
      let fault = false;
      const losingPool: KmsPool = {
        async connect() {
          const client = await auditPool.connect();
          let decryptAudit = false;
          return {
            release: client.release,
            async query<T>(sql: string, values?: readonly unknown[]) {
              if (
                sql.startsWith('INSERT INTO public.audit_records') &&
                values?.includes('kms.decrypt_invoked')
              )
                decryptAudit = true;
              const result = await client.query<T>(sql, values);
              if (sql === 'COMMIT' && decryptAudit && fault) {
                fault = false;
                throw new Error('commit acknowledgement lost');
              }
              return result;
            },
          };
        },
      };
      const engine = createClassifiedKms(createClassifiedKmsStore(losingPool), provider);
      const envelope = await engine.encrypt(f.business, f.descriptor, Buffer.from('not released'));
      fault = true;
      await expect(engine.decrypt(f.business, f.descriptor, envelope)).rejects.toThrow(
        KmsOperationError,
      );
      expect(decryptedKeys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
      const events = await admin.query('SELECT action FROM audit_records WHERE resource_id=$1', [
        f.descriptor.resourceId,
      ]);
      expect(events.rows.map((row) => row.action)).toContain('kms.decrypt_failed');
    } finally {
      await release(f.business);
    }
  });
  it('serializes concurrent first-write class creation without losing either row key', async () => {
    const left = await fixture(),
      right = await fixture();
    left.descriptor.dataClass = 'pii_demographic';
    right.descriptor.dataClass = 'pii_demographic';
    try {
      const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
      const [a, b] = await Promise.all([
        engine.encrypt(left.business, left.descriptor, Buffer.from('left')),
        engine.encrypt(right.business, right.descriptor, Buffer.from('right')),
      ]);
      expect(a.dekId).toBe(b.dekId);
      expect((await engine.decrypt(left.business, left.descriptor, a)).toString()).toBe('left');
      expect((await engine.decrypt(right.business, right.descriptor, b)).toString()).toBe('right');
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM kms_dek_keyring WHERE data_class='pii_demographic'",
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await release(left.business);
      await release(right.business);
    }
  });
  it('bounds independent audit contention and never releases unaudited plaintext', async () => {
    const f = await fixture(),
      blocker = await admin.connect();
    try {
      const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
      const envelope = await engine.encrypt(f.business, f.descriptor, Buffer.from('blocked audit'));
      await blocker.query('BEGIN');
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))", [
        tenant,
        f.descriptor.patientId,
      ]);
      const started = Date.now();
      await expect(engine.decrypt(f.business, f.descriptor, envelope)).rejects.toThrow(
        KmsOperationError,
      );
      expect(Date.now() - started).toBeLessThan(5000);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM audit_records WHERE resource_id=$1 AND action='kms.decrypt_invoked'",
            [f.descriptor.resourceId],
          )
        ).rows[0].n,
      ).toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await release(f.business);
    }
  });
  it('uses the real registry under temporary-table shadows and a hostile search_path', async () => {
    const f = await fixture();
    f.descriptor.dataClass = 'pii_research_consented';
    const usedArns: string[] = [];
    try {
      await f.business.query(
        'CREATE TEMP TABLE tenant_kms_bindings (LIKE public.tenant_kms_bindings INCLUDING DEFAULTS)',
      );
      await f.business.query(
        "INSERT INTO pg_temp.tenant_kms_bindings (tenant_id,cmk_arn,service_role_arn,residency_policy) VALUES ($1,$2,$3,'us_only')",
        [
          tenant,
          cmk.replace('0b1978c6', '1b1978c6'),
          'arn:aws:iam::123456789012:role/unregistered',
        ],
      );
      await f.business.query(
        'CREATE TEMP TABLE pg_locks (pid INTEGER, locktype TEXT, granted BOOLEAN)',
      );
      await f.business.query('SET LOCAL search_path = pg_temp, pg_catalog');
      const observed: ClassifiedKeyProvider = {
        generate: async (binding, dataClass) => {
          usedArns.push(binding.cmkArn);
          return provider.generate(binding, dataClass);
        },
        decrypt: async (binding, dataClass, blob) => {
          usedArns.push(binding.cmkArn);
          return provider.decrypt(binding, dataClass, blob);
        },
      };
      const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), observed);
      const envelope = await engine.encrypt(
        f.business,
        f.descriptor,
        Buffer.from('canonical registry'),
      );
      expect((await engine.decrypt(f.business, f.descriptor, envelope)).toString()).toBe(
        'canonical registry',
      );
      expect(usedArns.length).toBeGreaterThan(0);
      expect(usedArns.every((arn) => arn === cmk)).toBe(true);
    } finally {
      await release(f.business);
    }
  });
  it.each(['patient', 'clinician', 'tenant_admin'] as const)(
    'denies a soft-deleted %s actor with a live session',
    async (role) => {
      const f = await fixture(role);
      try {
        const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
        const envelope = await engine.encrypt(
          f.business,
          f.descriptor,
          Buffer.from('deleted account must not receive this'),
        );
        await admin.query(
          'UPDATE public.accounts SET deleted_at=pg_catalog.clock_timestamp() WHERE account_id=$1',
          [f.accountId],
        );
        await expect(
          engine.encrypt(f.business, f.descriptor, Buffer.from('no write')),
        ).rejects.toThrow(KmsOperationError);
        await expect(engine.decrypt(f.business, f.descriptor, envelope)).rejects.toThrow(
          KmsOperationError,
        );
        await expect(engine.rotateWriteVersion(f.business, f.descriptor)).rejects.toThrow(
          KmsOperationError,
        );
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM public.audit_records WHERE resource_id=$1 AND action='kms.decrypt_failed'",
              [f.descriptor.resourceId],
            )
          ).rows[0].n,
        ).toBe(1);
      } finally {
        await release(f.business);
      }
    },
  );
  const providerOperations = [
    ['patient', 'encrypt'],
    ['patient', 'decrypt'],
    ['clinician', 'encrypt'],
    ['clinician', 'decrypt'],
    ['tenant_admin', 'encrypt'],
    ['tenant_admin', 'decrypt'],
    ['tenant_admin', 'rotate'],
  ] as const;
  it.each(
    providerOperations.flatMap(([role, operation]) =>
      (['deleted account', 'revoked session'] as const).map((change) => ({
        role,
        operation,
        change,
      })),
    ),
  )(
    'rechecks $role $change committed during provider $operation',
    async ({ role, operation, change }) => {
      const f = await fixture(role);
      try {
        const normal = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
        const envelope = await normal.encrypt(
          f.business,
          f.descriptor,
          Buffer.from('concurrent deletion'),
        );
        const remove = () => removeAuthority(f, change);
        let providerCalls = 0;
        const concurrent: ClassifiedKeyProvider = {
          generate: async (binding, dataClass) => {
            providerCalls++;
            const result = await provider.generate(binding, dataClass);
            await remove();
            return result;
          },
          decrypt: async (binding, dataClass, blob) => {
            providerCalls++;
            const result = await provider.decrypt(binding, dataClass, blob);
            await remove();
            return result;
          },
        };
        const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), concurrent);
        const attempted =
          operation === 'encrypt'
            ? engine.encrypt(f.business, f.descriptor, Buffer.from('no write'))
            : operation === 'decrypt'
              ? engine.decrypt(f.business, f.descriptor, envelope)
              : engine.rotateWriteVersion(f.business, f.descriptor);
        await expect(attempted).rejects.toThrow(KmsOperationError);
        expect(providerCalls).toBe(1);
        expect(
          (
            await admin.query(
              "SELECT action FROM public.audit_records WHERE resource_id=$1 AND action IN ('kms.decrypt_invoked','kms.decrypt_failed','kms.dek_rotation_started')",
              [f.descriptor.resourceId],
            )
          ).rows.map((row) => row.action),
        ).toEqual(operation === 'decrypt' ? ['kms.decrypt_failed'] : []);
        expect(decryptedKeys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
      } finally {
        await release(f.business);
      }
    },
  );
  it.each(
    (['REPEATABLE READ', 'SERIALIZABLE'] as const).flatMap((isolation) =>
      (['encrypt', 'decrypt', 'rotate'] as const).flatMap((operation) =>
        (['deleted account', 'revoked session'] as const).map((change) => ({
          isolation,
          operation,
          change,
        })),
      ),
    ),
  )(
    'rejects caller $isolation before $operation provider $change without changing isolation',
    async ({ isolation, operation, change }) => {
      const f = await fixture('tenant_admin');
      try {
        const normal = createClassifiedKms(createClassifiedKmsStore(auditPool), provider);
        const envelope = await normal.encrypt(
          f.business,
          f.descriptor,
          Buffer.from('known class key'),
        );
        await f.business.query('ROLLBACK');
        await f.business.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await f.business.query('SELECT public.set_tenant_context($1)', [tenant]);
        await f.business.query("SELECT pg_catalog.set_config('app.request_nonce', $1, true)", [
          f.nonce,
        ]);
        const observed = {
          generate: vi.fn<ClassifiedKeyProvider['generate']>(async (binding, dataClass) => {
            const result = await provider.generate(binding, dataClass);
            await removeAuthority(f, change);
            return result;
          }),
          decrypt: vi.fn<ClassifiedKeyProvider['decrypt']>(async (binding, dataClass, blob) => {
            const result = await provider.decrypt(binding, dataClass, blob);
            await removeAuthority(f, change);
            return result;
          }),
        };
        const engine = createClassifiedKms(createClassifiedKmsStore(auditPool), observed);
        const before = await admin.query('SELECT count(*)::int AS n FROM public.kms_dek_keyring');
        const attempted =
          operation === 'encrypt'
            ? engine.encrypt(f.business, f.descriptor, Buffer.from('no write'))
            : operation === 'decrypt'
              ? engine.decrypt(f.business, f.descriptor, envelope)
              : engine.rotateWriteVersion(f.business, f.descriptor);
        await expect(attempted).rejects.toThrow(KmsOperationError);
        expect(observed.generate).not.toHaveBeenCalled();
        expect(observed.decrypt).not.toHaveBeenCalled();
        expect(
          (await f.business.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
        ).toBe(isolation.toLowerCase());
        expect(
          (await admin.query('SELECT count(*)::int AS n FROM public.kms_dek_keyring')).rows,
        ).toEqual(before.rows);
        expect(
          (
            await admin.query(
              "SELECT action FROM public.audit_records WHERE resource_id=$1 AND action IN ('kms.decrypt_invoked','kms.decrypt_failed','kms.dek_rotation_started')",
              [f.descriptor.resourceId],
            )
          ).rows.map((row) => row.action),
        ).toEqual(operation === 'decrypt' ? ['kms.decrypt_failed'] : []);
        expect(decryptedKeys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
        // The rejected call leaves the physical caller transaction usable. Its
        // owner can choose a fresh supported transaction; KMS never changes it.
        await f.business.query('ROLLBACK');
        await f.business.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        await f.business.query('SELECT public.set_tenant_context($1)', [tenant]);
        await f.business.query("SELECT pg_catalog.set_config('app.request_nonce', $1, true)", [
          f.nonce,
        ]);
        const recovered = await normal.decrypt(f.business, f.descriptor, envelope);
        expect(recovered.toString()).toBe('known class key');
        recovered.fill(0);
      } finally {
        await release(f.business);
      }
    },
  );
  it.each(
    (['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE'] as const).flatMap((isolation) =>
      (['deleted account', 'revoked session'] as const).map((change) => ({ isolation, change })),
    ),
  )(
    'pins dedicated default $isolation and sees $change committed after audit INSERT',
    async ({ isolation, change }) => {
      const f = await fixture();
      let changed = false;
      const observedIsolations: string[] = [];
      const defaultIsolations: string[] = [];
      const configuredPool: KmsPool = {
        async connect() {
          const client = await asRole('kms_service_role');
          try {
            await client.query(
              `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL ${isolation}`,
            );
            defaultIsolations.push(
              (await client.query('SHOW default_transaction_isolation')).rows[0]
                .default_transaction_isolation,
            );
          } catch (error) {
            client.release(true);
            throw error;
          }
          return {
            release: () => client.release(true),
            async query<R>(sql: string, values?: readonly unknown[]) {
              const result = await client.query(sql, values ? [...values] : undefined);
              if (sql.startsWith('BEGIN')) {
                observedIsolations.push(
                  (await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
                );
              }
              if (
                !changed &&
                sql.startsWith('INSERT INTO public.audit_records') &&
                values?.includes('kms.decrypt_invoked')
              ) {
                await removeAuthority(f, change);
                changed = true;
              }
              return { rows: result.rows as R[], rowCount: result.rowCount };
            },
          };
        },
      };
      try {
        const engine = createClassifiedKms(createClassifiedKmsStore(configuredPool), provider);
        const envelope = await engine.encrypt(
          f.business,
          f.descriptor,
          Buffer.from('provisional plaintext'),
        );
        await expect(engine.decrypt(f.business, f.descriptor, envelope)).rejects.toThrow(
          KmsOperationError,
        );
        expect(changed).toBe(true);
        expect(defaultIsolations.length).toBeGreaterThan(0);
        expect(defaultIsolations.every((value) => value === isolation.toLowerCase())).toBe(true);
        expect(observedIsolations.length).toBe(defaultIsolations.length);
        expect(observedIsolations.every((value) => value === 'read committed')).toBe(true);
        expect(
          (
            await admin.query(
              "SELECT action FROM public.audit_records WHERE resource_id=$1 AND action IN ('kms.decrypt_invoked','kms.decrypt_failed')",
              [f.descriptor.resourceId],
            )
          ).rows.map((row) => row.action),
        ).toEqual(['kms.decrypt_failed']);
        expect(decryptedKeys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
        const healthy = await fixture();
        try {
          const next = await engine.encrypt(
            healthy.business,
            healthy.descriptor,
            Buffer.from('fresh connection recovery'),
          );
          const plaintext = await engine.decrypt(healthy.business, healthy.descriptor, next);
          expect(plaintext.toString()).toBe('fresh connection recovery');
          plaintext.fill(0);
        } finally {
          await release(healthy.business);
        }
      } finally {
        await release(f.business);
      }
    },
  );
  it.each(launchBindings)(
    'provisions and isolates $tenantId keys and durable decrypt evidence',
    async (expected) => {
      const f = await fixture('patient', expected.tenantId);
      try {
        const store = createClassifiedKmsStore(auditPool);
        const actor = await store.actor(f.business, f.descriptor);
        expect(actor.tenantId).toBe(expected.tenantId);
        expect(actor.countryOfCare).toBe(expected.country);
        const binding = await store.binding(f.business, actor);
        expect(binding.cmkArn).toBe(expected.cmkArn);
        expect(binding.serviceRoleArn).toBe(expected.serviceRoleArn);
        const visible = await f.business.query(
          'SELECT tenant_id, cmk_arn FROM public.tenant_kms_bindings',
        );
        expect(visible.rows).toEqual([{ tenant_id: expected.tenantId, cmk_arn: expected.cmkArn }]);
        const observed: ClassifiedKeyProvider = {
          async generate(current, dataClass) {
            expect(current).toEqual(binding);
            return provider.generate(current, dataClass);
          },
          async decrypt(current, dataClass, blob) {
            expect(current).toEqual(binding);
            return provider.decrypt(current, dataClass, blob);
          },
        };
        const engine = createClassifiedKms(store, observed);
        const envelope = await engine.encrypt(
          f.business,
          f.descriptor,
          Buffer.from('synthetic tenant answer'),
        );
        const plaintext = await engine.decrypt(f.business, f.descriptor, envelope);
        expect(plaintext.toString()).toBe('synthetic tenant answer');
        plaintext.fill(0);
        expect(
          (
            await admin.query(
              "SELECT tenant_id, action FROM public.audit_records WHERE resource_id=$1 AND action='kms.decrypt_invoked'",
              [f.descriptor.resourceId],
            )
          ).rows,
        ).toEqual([{ tenant_id: expected.tenantId, action: 'kms.decrypt_invoked' }]);
        expect(decryptedKeys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
      } finally {
        await release(f.business);
      }
    },
  );
  it('rejects the invented Ghana alias at the registry foreign key', async () => {
    const provisioner = await asRole('kms_provisioner_role');
    try {
      await expect(
        provisioner.query(
          "INSERT INTO public.tenant_kms_bindings (tenant_id, cmk_arn, service_role_arn, residency_policy) VALUES ('Telecheck-GH',$1,$2,'us_only')",
          [
            `arn:aws:kms:us-east-1:123456789012:key/${randomUUID()}`,
            'arn:aws:iam::123456789012:role/telecheck-unregistered',
          ],
        ),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await release(provisioner);
    }
  });
  it('rejects a US envelope in a real Ghana session before provider access', async () => {
    const us = await fixture(),
      ghana = await fixture('patient', 'Telecheck-Ghana' as TenantId);
    try {
      const envelope = await createClassifiedKms(
        createClassifiedKmsStore(auditPool),
        provider,
      ).encrypt(us.business, us.descriptor, Buffer.from('US tenant only'));
      const observed = { generate: vi.fn(provider.generate), decrypt: vi.fn(provider.decrypt) };
      await expect(
        createClassifiedKms(createClassifiedKmsStore(auditPool), observed).decrypt(
          ghana.business,
          ghana.descriptor,
          envelope,
        ),
      ).rejects.toThrow(KmsOperationError);
      expect(observed.generate).not.toHaveBeenCalled();
      expect(observed.decrypt).not.toHaveBeenCalled();
      expect(
        (
          await admin.query(
            "SELECT tenant_id, action FROM public.audit_records WHERE resource_id=$1 AND action IN ('kms.decrypt_failed','kms.decrypt_invoked')",
            [ghana.descriptor.resourceId],
          )
        ).rows,
      ).toEqual([{ tenant_id: 'Telecheck-Ghana', action: 'kms.decrypt_failed' }]);
    } finally {
      await release(us.business);
      await release(ghana.business);
    }
  });
  it.each(['role check', 'COMMIT', 'ROLLBACK'] as const)(
    'discards a never-arriving %s reply, erases keys and recovers',
    async (fault) => {
      const f = await fixture();
      try {
        const envelope = await createClassifiedKms(
          createClassifiedKmsStore(auditPool),
          provider,
        ).encrypt(f.business, f.descriptor, Buffer.from('deadline secret'));
        let armed = true;
        const releases: boolean[] = [];
        const stalled: KmsPool = {
          async connect() {
            const client = await auditPool.connect();
            let decryptAudit = false,
              failedInsert = false;
            return {
              release: (broken = false) => {
                releases.push(broken);
                client.release(broken);
              },
              async query<R>(sql: string, values?: readonly unknown[]) {
                if (
                  sql.startsWith('INSERT INTO public.audit_records') &&
                  values?.includes('kms.decrypt_invoked')
                ) {
                  decryptAudit = true;
                  if (fault === 'ROLLBACK' && armed) {
                    failedInsert = true;
                    throw new Error('synthetic INSERT failure');
                  }
                }
                const result = await client.query<R>(sql, values);
                if (
                  armed &&
                  ((fault === 'role check' && sql === 'SELECT session_user') ||
                    (fault === 'COMMIT' && sql === 'COMMIT' && decryptAudit) ||
                    (fault === 'ROLLBACK' && sql === 'ROLLBACK' && failedInsert))
                ) {
                  armed = false;
                  return new Promise<never>(() => undefined);
                }
                return result;
              },
            };
          },
        };
        const engine = createClassifiedKms(
          createClassifiedKmsStore(stalled, { queryMs: 500, transactionMs: 4000, acquireMs: 1500 }),
          provider,
          1,
        );
        const started = Date.now();
        await expect(engine.decrypt(f.business, f.descriptor, envelope)).rejects.toThrow(
          KmsOperationError,
        );
        expect(Date.now() - started).toBeLessThan(3500);
        expect(releases).toContain(true);
        expect(decryptedKeys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
        expect((await engine.decrypt(f.business, f.descriptor, envelope)).toString()).toBe(
          'deadline secret',
        );
      } finally {
        await release(f.business);
      }
    },
  );
});
