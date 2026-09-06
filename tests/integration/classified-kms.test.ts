/** Real physical connections and COMMIT; no nested-savepoint test pool. */
import { randomBytes, randomUUID } from 'node:crypto';

import pg, { type PoolClient } from 'pg';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bindActorContextForRequest } from '../../src/lib/actor-context-binding.js';
import { createClassifiedKms } from '../../src/lib/classified-kms.js';
import type { TenantId } from '../../src/lib/glossary.js';
import { KmsOperationError } from '../../src/lib/kms-aws.js';
import type { ClassifiedKeyProvider } from '../../src/lib/kms-classified-aws.js';
import { createClassifiedKmsStore, type KmsPool } from '../../src/lib/kms-classified-store.js';
import type { ClassifiedResource } from '../../src/lib/kms-classified-types.js';

const databaseUrl = process.env.KMS_INTEGRATION_DATABASE_URL;
const enabled = databaseUrl !== undefined;
const tenant = 'Telecheck-US' as TenantId;
const cmk = 'arn:aws:kms:us-east-1:123456789012:key/0b1978c6-cb09-4da0-933e-449b5d1e1c24';
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

async function asRole(role: 'telecheck_app_role' | 'kms_service_role' | 'bind_actor_context_role') {
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
async function fixture(role: 'patient' | 'clinician' | 'tenant_admin' = 'patient') {
  const patientId = ulid(),
    accountId = role === 'patient' ? patientId : ulid(),
    sessionId = ulid();
  const connection = await admin.connect();
  try {
    for (const [id, type] of role === 'patient'
      ? [[patientId, 'patient']]
      : [
          [patientId, 'patient'],
          [accountId, role],
        ]) {
      await connection.query(
        `INSERT INTO accounts (account_id, tenant_id, phone_e164, first_name, last_name, date_of_birth,
        gender, country_of_residence, country_of_care, account_type, status, cohort_classification)
        VALUES ($1,$2,$3,'Synthetic','KMS','1990-01-01','prefer_not_to_say','US','US',$4,'active','baseline')`,
        [
          id,
          tenant,
          '+1' +
            String(BigInt('0x' + randomBytes(6).toString('hex')) % 10_000_000_000n).padStart(
              10,
              '0',
            ),
          type,
        ],
      );
    }
    await connection.query(
      "INSERT INTO sessions (session_id, tenant_id, account_id, refresh_token_hash, expires_at) VALUES ($1,$2,$3,$4,clock_timestamp() + INTERVAL '1 hour')",
      [sessionId, tenant, accountId, randomBytes(32).toString('hex')],
    );
  } finally {
    connection.release();
  }
  const binder = await asRole('bind_actor_context_role');
  let nonce: string;
  try {
    nonce = (
      await bindActorContextForRequest(binder, {
        actorAccountId: accountId,
        actorAccountTenantId: tenant,
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
  await business.query('SELECT set_tenant_context($1)', [tenant]);
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
    await admin.query(
      "INSERT INTO tenant_kms_bindings (tenant_id, cmk_arn, service_role_arn, residency_policy) VALUES ($1,$2,$3,'us_only') ON CONFLICT DO NOTHING",
      [tenant, cmk, 'arn:aws:iam::123456789012:role/telecheck-tenant-us'],
    );
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
                sql.startsWith('INSERT INTO audit_records') &&
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
});
