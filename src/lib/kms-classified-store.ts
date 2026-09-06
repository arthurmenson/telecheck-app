/** Dedicated transactions make key creation and decrypt evidence durable. */
import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';

import { emitAudit } from './audit.js';
import { config } from './config.js';
import type { DbTransaction } from './db.js';
import { KmsOperationError } from './kms-aws.js';
import {
  validateBinding,
  type ClassKeyVersion,
  type ClassifiedResource,
  type KmsActor,
  type KmsAuditAction,
  type TenantKeyBinding,
} from './kms-classified-types.js';
import { logger } from './logger.js';

export interface ClassifiedKmsStore {
  actor(tx: DbTransaction, descriptor: ClassifiedResource): Promise<KmsActor>;
  auditActor(tx: DbTransaction): Promise<KmsActor | null>;
  binding(tx: DbTransaction, actor: KmsActor): Promise<TenantKeyBinding>;
  active(actor: KmsActor, descriptor: ClassifiedResource): Promise<ClassKeyVersion | null>;
  install(
    actor: KmsActor,
    descriptor: ClassifiedResource,
    candidate: ClassKeyVersion,
    replace: boolean,
  ): Promise<ClassKeyVersion>;
  lookup(actor: KmsActor, descriptor: ClassifiedResource, dekId: string): Promise<ClassKeyVersion>;
  audit(
    actor: KmsActor,
    descriptor: ClassifiedResource,
    binding: TenantKeyBinding | undefined,
    action: KmsAuditAction,
    detail: Record<string, unknown>,
  ): Promise<void>;
}

interface ActorRow {
  tenant_id: KmsActor['tenantId'];
  account_id: string;
  session_id: string;
  actor_role: KmsActor['role'];
  country_of_care: string;
  request_nonce: string;
  transaction_id: string;
}
interface KeyRow {
  dek_version_id: string;
  encrypted_dek_blob: Buffer;
}
async function readActor(tx: DbTransaction): Promise<KmsActor> {
  const result = await tx.query<ActorRow>('SELECT * FROM kms_current_actor_context()');
  const row = result.rows[0];
  if (!row) throw new KmsOperationError();
  return {
    tenantId: row.tenant_id,
    accountId: row.account_id,
    sessionId: row.session_id,
    role: row.actor_role,
    countryOfCare: row.country_of_care,
    nonce: row.request_nonce,
    transactionId: row.transaction_id,
  };
}
export function sameKmsActor(left: KmsActor, right: KmsActor, sameTransaction = true): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.accountId === right.accountId &&
    left.sessionId === right.sessionId &&
    left.role === right.role &&
    left.countryOfCare === right.countryOfCare &&
    left.nonce === right.nonce &&
    (!sameTransaction || left.transactionId === right.transactionId)
  );
}

type KmsConnection = DbTransaction & { release(error?: boolean): void };
export interface KmsPool {
  connect(): Promise<KmsConnection>;
}

export function createClassifiedKmsStore(pool: KmsPool): ClassifiedKmsStore {
  async function independent<T>(
    actor: KmsActor,
    revalidate: boolean,
    work: (tx: DbTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    let broken = false;
    try {
      const role = await client.query<{ session_user: string }>('SELECT session_user');
      if (role.rows[0]?.session_user !== 'kms_service_role') throw new KmsOperationError();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT set_tenant_context($1)', [actor.tenantId]);
      await client.query("SELECT set_config('app.request_nonce', $1, true)", [actor.nonce]);
      if (revalidate && !sameKmsActor(actor, await readActor(client), false))
        throw new KmsOperationError();
      const result = await work(client);
      if (revalidate && !sameKmsActor(actor, await readActor(client), false))
        throw new KmsOperationError();
      await client.query('COMMIT');
      return result;
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true;
      }
      throw new KmsOperationError();
    } finally {
      client.release(broken);
    }
  }
  async function event(
    tx: DbTransaction,
    actor: KmsActor,
    descriptor: ClassifiedResource,
    binding: TenantKeyBinding | undefined,
    action: KmsAuditAction,
    detail: Record<string, unknown>,
  ): Promise<void> {
    const provisioning = action === 'kms.dek_created' || action === 'kms.dek_rotation_started';
    await emitAudit(
      {
        timestamp: new Date().toISOString(),
        tenant_id: actor.tenantId,
        actor_type: actor.role === 'tenant_admin' ? 'operator' : actor.role,
        actor_id: actor.accountId,
        actor_tenant_id: actor.tenantId,
        target_patient_id: provisioning ? null : descriptor.patientId,
        delegate_context: null,
        action,
        category: action === 'kms.dek_lookup' ? 'C' : 'A',
        audit_sensitivity_level: 'standard',
        resource_type: descriptor.resourceType,
        resource_id: descriptor.resourceId,
        detail: {
          tenant_id: actor.tenantId,
          data_class: descriptor.dataClass,
          cmk_arn: binding?.cmkArn ?? null,
          encryption_context_hash: createHash('sha256')
            .update(JSON.stringify({ tenant_id: actor.tenantId, data_class: descriptor.dataClass }))
            .digest('hex'),
          requesting_session_id: actor.sessionId,
          requesting_role: actor.role,
          field: descriptor.field,
          ...detail,
        },
        engine_versions: null,
        ai_workload_type: null,
        autonomy_level: null,
        agent_id: null,
        agent_version: null,
        tool_call_id: null,
        memory_read_set_id: null,
        memory_write_set_id: null,
        supervising_policy_id: null,
        knowledge_source_versions: null,
        signals: null,
        override: null,
        linked_events: [],
        compliance_flags: [],
        country_of_care: actor.countryOfCare,
        break_glass: null,
      },
      tx,
    );
  }
  const key = (row: KeyRow | undefined): ClassKeyVersion | null =>
    row ? { dekId: row.dek_version_id, encryptedDek: Buffer.from(row.encrypted_dek_blob) } : null;
  async function active(tx: DbTransaction, actor: KmsActor, descriptor: ClassifiedResource) {
    return key(
      (
        await tx.query<KeyRow>(
          `SELECT k.dek_version_id, k.encrypted_dek_blob FROM kms_active_class_keys a
      JOIN kms_dek_keyring k USING (tenant_id, data_class, dek_version_id)
      WHERE a.tenant_id = $1 AND a.data_class = $2`,
          [actor.tenantId, descriptor.dataClass],
        )
      ).rows[0],
    );
  }
  return {
    async actor(tx, descriptor) {
      const savepoint = `kms_actor_${randomUUID().replaceAll('-', '')}`;
      await tx.query(`SAVEPOINT ${savepoint}`);
      try {
        const actor = await readActor(tx);
        await tx.query('SELECT kms_assert_patient_scope($1)', [descriptor.patientId]);
        // Refuse before opening another connection: callers must order crypto
        // before audit/keyring advisory locks, preventing self-deadlock.
        const locks = await tx.query<{ held: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted
      ) AS held`);
        if (locks.rows[0]?.held !== false) throw new KmsOperationError();
        await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
        return actor;
      } catch {
        await tx.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await tx.query(`RELEASE SAVEPOINT ${savepoint}`);
        throw new KmsOperationError();
      }
    },
    async auditActor(tx) {
      try {
        const row = (await tx.query<ActorRow>('SELECT * FROM kms_request_audit_context()')).rows[0];
        return row
          ? {
              tenantId: row.tenant_id,
              accountId: row.account_id,
              sessionId: row.session_id,
              role: row.actor_role,
              countryOfCare: row.country_of_care,
              nonce: row.request_nonce,
              transactionId: row.transaction_id,
            }
          : null;
      } catch {
        return null;
      }
    },
    async binding(tx, actor) {
      const result = await tx.query<{
        cmk_arn: string;
        service_role_arn: string;
        primary_region: 'us-east-1';
        residency_policy: TenantKeyBinding['residencyPolicy'];
        replica_arn: string | null;
      }>(
        'SELECT cmk_arn, service_role_arn, primary_region, residency_policy, replica_arn FROM tenant_kms_bindings WHERE tenant_id = $1',
        [actor.tenantId],
      );
      const row = result.rows[0];
      if (!row) throw new KmsOperationError();
      return validateBinding({
        tenantId: actor.tenantId,
        cmkArn: row.cmk_arn,
        serviceRoleArn: row.service_role_arn,
        primaryRegion: row.primary_region,
        residencyPolicy: row.residency_policy,
        replicaArn: row.replica_arn,
      });
    },
    active: (actor, descriptor) =>
      independent(actor, true, async (tx) => active(tx, actor, descriptor)),
    install: (actor, descriptor, candidate, replace) =>
      independent(actor, true, async (tx) => {
        if (replace && actor.role !== 'tenant_admin') throw new KmsOperationError();
        await tx.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('kms-key:' || $1 || ':' || $2, 0))",
          [actor.tenantId, descriptor.dataClass],
        );
        const existing = await active(tx, actor, descriptor);
        if (existing && !replace) return existing;
        if (replace && !existing) throw new KmsOperationError();
        await tx.query(
          'INSERT INTO kms_dek_keyring (tenant_id, data_class, dek_version_id, encrypted_dek_blob) VALUES ($1, $2, $3, $4)',
          [actor.tenantId, descriptor.dataClass, candidate.dekId, candidate.encryptedDek],
        );
        await tx.query(
          `INSERT INTO kms_active_class_keys (tenant_id, data_class, dek_version_id) VALUES ($1, $2, $3)
        ON CONFLICT (tenant_id, data_class) DO UPDATE SET dek_version_id = EXCLUDED.dek_version_id`,
          [actor.tenantId, descriptor.dataClass, candidate.dekId],
        );
        const binding = await thisBinding(tx, actor);
        await event(
          tx,
          actor,
          descriptor,
          binding,
          existing ? 'kms.dek_rotation_started' : 'kms.dek_created',
          {
            dek_version_id: candidate.dekId,
            previous_dek_version_id: existing?.dekId ?? null,
            rewrap_complete: false,
          },
        );
        return { dekId: candidate.dekId, encryptedDek: Buffer.from(candidate.encryptedDek) };
      }),
    lookup: (actor, descriptor, dekId) =>
      independent(actor, true, async (tx) => {
        const found = key(
          (
            await tx.query<KeyRow>(
              'SELECT dek_version_id, encrypted_dek_blob FROM kms_dek_keyring WHERE tenant_id = $1 AND data_class = $2 AND dek_version_id = $3',
              [actor.tenantId, descriptor.dataClass, dekId],
            )
          ).rows[0],
        );
        if (!found) throw new KmsOperationError();
        await event(tx, actor, descriptor, await thisBinding(tx, actor), 'kms.dek_lookup', {
          dek_version_id: dekId,
          cache_hit: false,
        });
        return found;
      }),
    audit: (actor, descriptor, binding, action, detail) =>
      independent(actor, action !== 'kms.decrypt_failed', async (tx) => {
        await event(tx, actor, descriptor, binding, action, detail);
      }),
  };
  // Binding is immutable; this fresh view also proves provisioning committed.
  async function thisBinding(tx: DbTransaction, actor: KmsActor): Promise<TenantKeyBinding> {
    const row = (
      await tx.query<{
        cmk_arn: string;
        service_role_arn: string;
        primary_region: 'us-east-1';
        residency_policy: TenantKeyBinding['residencyPolicy'];
        replica_arn: string | null;
      }>(
        'SELECT cmk_arn, service_role_arn, primary_region, residency_policy, replica_arn FROM tenant_kms_bindings WHERE tenant_id = $1',
        [actor.tenantId],
      )
    ).rows[0];
    if (!row) throw new KmsOperationError();
    return validateBinding({
      tenantId: actor.tenantId,
      cmkArn: row.cmk_arn,
      serviceRoleArn: row.service_role_arn,
      primaryRegion: row.primary_region,
      residencyPolicy: row.residency_policy,
      replicaArn: row.replica_arn,
    });
  }
}

let pool: pg.Pool | undefined;
export function defaultClassifiedKmsStore(): ClassifiedKmsStore {
  if (!config.kmsDatabaseUrl) throw new KmsOperationError();
  if (pool === undefined) {
    pool = new pg.Pool({
      connectionString: config.kmsDatabaseUrl,
      max: 2,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 30_000,
      ssl: config.dbSslMode === 'require' ? { rejectUnauthorized: true } : false,
    });
    pool.on('error', () => {
      // pg removes failed idle clients itself. Handle the event without copying
      // database diagnostics or connection secrets into structured logs.
      logger.error(
        { event: 'kms.pool.unavailable' },
        'Tenant encryption database connection failed',
      );
    });
  }
  return createClassifiedKmsStore(pool);
}
export async function closeClassifiedKmsPool(): Promise<void> {
  const previous = pool;
  pool = undefined;
  await previous?.end();
}
