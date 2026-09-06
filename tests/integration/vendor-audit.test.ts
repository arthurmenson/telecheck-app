/**
 * These tests deliberately use committed fixtures and separate physical PG
 * connections. The normal setup remains responsible for migrations, but its
 * nested-savepoint pool cannot prove an audit survives a business rollback.
 * Only this file's withTransaction adapter is replaced with a real pool;
 * production recorder SQL, emitAudit, RLS and hash-chain triggers all run.
 */
import { createHash, randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../src/lib/db.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { ulid } from '../../src/lib/ulid.ts';
import type {
  LLMCompletionRequest,
  LLMProvider,
} from '../../src/modules/ai-service/internal/providers/types.ts';
import {
  recordVendorDecision,
  type VendorAuditContext,
} from '../../src/modules/ai-service/internal/providers/vendor-audit.ts';
import {
  VendorAuditUnavailableError,
  VendorEgressBlockedError,
  withVendorBoundary,
  type VendorBoundaryDecision,
} from '../../src/modules/ai-service/internal/providers/vendor-boundary.ts';
import { assertAuditChainIntact } from '../helpers/audit-assertions.ts';
import { getTestClient } from '../setup.ts';

const realTransactions = vi.hoisted(() => ({
  run: null as null | (<T>(fn: (tx: DbTransaction) => Promise<T>) => Promise<T>),
}));

vi.mock('../../src/lib/db.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/db.ts')>();
  return {
    ...actual,
    withTransaction: <T>(fn: (tx: DbTransaction) => Promise<T>) => {
      if (realTransactions.run === null)
        throw new Error('real transaction harness not initialized');
      return realTransactions.run(fn);
    },
  };
});

let pool: Pool;
let context: VendorAuditContext;
let failAuditInsert = false;
let loseCommitAcknowledgement = false;
let crossExpiryDuringClaim = false;
const auditBackendPids = new Set<number>();

async function connect(): Promise<PoolClient> {
  const client = await pool.connect();
  // Exercise FORCE RLS and append-only behavior as the existing non-superuser
  // test app role, exactly as tests/setup.ts does for its shared connection.
  await client.query('SET SESSION AUTHORIZATION telecheck_test_app');
  return client;
}

async function realTransaction<T>(fn: (tx: DbTransaction) => Promise<T>): Promise<T> {
  const client = await connect();
  try {
    await client.query('BEGIN');
    const pid = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    auditBackendPids.add(pid.rows[0]!.pid);
    const wrapped: DbTransaction = {
      async query<R>(sql: string, values?: ReadonlyArray<unknown>) {
        if (crossExpiryDuringClaim && /DELETE FROM audit_dedupe_markers/.test(sql)) {
          // Deterministic fixture: live at this audit transaction's NOW(),
          // expired by its INSERT. This reproduces the inter-statement race
          // without depending on worker scheduling before the transaction.
          await client.query(
            "UPDATE audit_dedupe_markers SET expires_at = NOW() + INTERVAL '50 milliseconds' WHERE tenant_id = $1",
            [context.tenantId],
          );
        }
        if (crossExpiryDuringClaim && /INSERT INTO audit_dedupe_markers/.test(sql)) {
          crossExpiryDuringClaim = false;
          await client.query('SELECT pg_sleep(0.1)');
        }
        if (failAuditInsert && /INSERT INTO (?:public\.)?audit_records/.test(sql)) {
          failAuditInsert = false;
          // A real SQL error AFTER marker claim aborts the transaction; a
          // JS-only mocked emitter would miss PostgreSQL abort semantics.
          await client.query('SELECT 1 / 0');
        }
        const result = await client.query(sql, values as unknown[] | undefined);
        return { rows: result.rows as R[], rowCount: result.rowCount };
      },
    };
    const result = await fn(wrapped);
    await client.query('COMMIT');
    if (loseCommitAcknowledgement) {
      loseCommitAcknowledgement = false;
      throw new Error('synthetic lost COMMIT acknowledgement');
    }
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function freshContext(): Promise<VendorAuditContext> {
  const suffix = randomUUID()
    .replaceAll('-', '')
    .replace(/[0-9]/g, (digit) => String.fromCharCode(71 + Number(digit)));
  const tenantId = asTenantId(`Telecheck-Vendor${suffix}`);
  const client = await connect();
  try {
    // Autocommit is deliberate. The independent audit connection must see
    // its tenant FK, and an observer must see durable evidence after rollback.
    await client.query(
      `INSERT INTO tenants
         (id, display_name, consumer_dba, legal_entity, consumer_subdomain,
          country_of_care, kms_key_alias, status)
       VALUES ($1, $1, 'Heros Health Test', 'Synthetic Test', $2,
               'US', 'alias/synthetic-vendor-test', 'active')`,
      [tenantId, `${suffix}.invalid`],
    );
  } finally {
    client.release();
  }
  const patientId = ulid();
  return {
    tenantId,
    countryOfCare: 'US',
    patientId,
    conversationId: randomUUID(),
    messageId: randomUUID(),
    idempotency: {
      tenantId,
      idempotencyKey: ulid(),
      endpoint: '/v0/ai/chat',
      actorId: patientId,
      bodyHash: createHash('sha256').update('synthetic request').digest('hex'),
    },
    reservationExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
  };
}

interface AuditRow {
  tenant_id: string;
  actor_type: string;
  actor_id: string;
  actor_tenant_id: string;
  category: string;
  audit_sensitivity_level: string;
  target_patient_id: string | null;
  resource_type: string;
  resource_id: string;
  country_of_care: string;
  action: string;
  ai_workload_type: string;
  autonomy_level: string;
  payload: Record<string, unknown>;
}

async function audits(ctx = context): Promise<AuditRow[]> {
  return realTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
    const result = await tx.query<AuditRow>(
      'SELECT * FROM audit_records WHERE tenant_id = $1 ORDER BY sequence_number',
      [ctx.tenantId],
    );
    return result.rows;
  });
}

async function markers(ctx = context) {
  return realTransaction(async (tx) => {
    const result = await tx.query<{ dedupe_key: string; expires_at: Date }>(
      'SELECT dedupe_key, expires_at FROM audit_dedupe_markers WHERE tenant_id = $1',
      [ctx.tenantId],
    );
    return result.rows;
  });
}

function decision(overrides: Partial<VendorBoundaryDecision> = {}): VendorBoundaryDecision {
  return {
    action: 'block',
    reason: 'high_confidence_match',
    patternIds: ['email'],
    hitCount: 1,
    candidateFingerprint: createHash('sha256').update('synthetic candidate').digest('hex'),
    ...overrides,
  };
}

function request(content: string): LLMCompletionRequest {
  return {
    tenant_id: context.tenantId,
    workload_type: 'conversational_assistant',
    messages: [{ role: 'user', content }],
    max_output_tokens: 100,
    temperature: 0,
  };
}

function wrappedProvider(sendCompletion: LLMProvider['sendCompletion']) {
  return withVendorBoundary(
    { name: 'anthropic', healthcheck: async () => ({ healthy: true }), sendCompletion },
    (value) => recordVendorDecision(context, 'anthropic', value),
  );
}

beforeAll(() => {
  pool = new Pool({
    connectionString: process.env['TEST_DATABASE_URL'],
    max: 5,
    connectionTimeoutMillis: 5_000,
  });
  realTransactions.run = realTransaction;
});

beforeEach(async () => {
  failAuditInsert = false;
  loseCommitAcknowledgement = false;
  crossExpiryDuringClaim = false;
  auditBackendPids.clear();
  context = await freshContext();
});

afterAll(async () => {
  realTransactions.run = null;
  await pool.end();
  // These uniquely named committed fixtures live only in the ephemeral test
  // DB. Do not disable append-only triggers or delete their audit evidence.
});

describe('Layer 4 audit durability on independent PostgreSQL connections', () => {
  it('commits the exact metadata-only governance envelope on the existing PLATFORM chain', async () => {
    await recordVendorDecision(
      context,
      'anthropic',
      decision({ patternIds: ['us_ssn', 'email', 'email'], hitCount: 3 }),
    );
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: context.tenantId,
      actor_type: 'system',
      actor_id: 'system:ai_mode_1',
      actor_tenant_id: context.tenantId,
      category: 'B',
      audit_sensitivity_level: 'standard',
      target_patient_id: null,
      resource_type: 'ai_chat_session',
      resource_id: context.conversationId,
      country_of_care: 'US',
      action: 'pii.screener.egress_block',
      ai_workload_type: 'conversational_assistant',
      autonomy_level: 'advisory',
    });
    expect(rows[0]!.payload).toEqual({
      layer: 4,
      provider: 'anthropic',
      patient_id: context.patientId,
      message_id: context.messageId,
      pattern_ids: ['email', 'us_ssn'],
      hit_count: 3,
      reason: 'high_confidence_match',
    });
    const [marker] = await markers();
    expect(marker!.expires_at.toISOString()).toBe(context.reservationExpiresAt);
    expect(marker!.dedupe_key).toMatch(/^[0-9a-f]{64}$/);
    await getTestClient().query('SELECT set_tenant_context($1)', [context.tenantId]);
    await assertAuditChainIntact(context.tenantId);
  });

  it('retains block evidence after a different connection rolls back business state', async () => {
    const outer = await connect();
    const send = vi.fn<LLMProvider['sendCompletion']>();
    try {
      await outer.query('BEGIN');
      const pid = await outer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await outer.query('SELECT set_tenant_context($1)', [context.tenantId]);
      await outer.query('UPDATE tenants SET notes = $2 WHERE id = $1', [
        context.tenantId,
        'rollback',
      ]);
      await expect(
        wrappedProvider(send).sendCompletion(request('synthetic@example.test')),
      ).rejects.toBeInstanceOf(VendorEgressBlockedError);
      expect(auditBackendPids.has(pid.rows[0]!.pid)).toBe(false);
      await outer.query('ROLLBACK');
      expect(send).not.toHaveBeenCalled();
      expect(await audits()).toHaveLength(1);
      expect(await markers()).toHaveLength(1);
      const result = await outer.query<{ notes: string | null }>(
        'SELECT notes FROM tenants WHERE id = $1',
        [context.tenantId],
      );
      expect(result.rows[0]!.notes).toBeNull();
    } finally {
      await outer.query('ROLLBACK');
      outer.release();
    }
  });

  it('commits redaction before dispatch and survives later provider failure and business rollback', async () => {
    const outer = await connect();
    const providerError = new Error('synthetic provider failure');
    const send = vi.fn<LLMProvider['sendCompletion']>(async (outbound) => {
      expect(outbound.messages[0]!.content).toBe('[REDACTED:PII]');
      expect((await audits())[0]!.action).toBe('pii.screener.egress_redact');
      throw providerError;
    });
    try {
      await outer.query('BEGIN');
      await expect(wrappedProvider(send).sendCompletion(request('192.0.2.1'))).rejects.toBe(
        providerError,
      );
      await outer.query('ROLLBACK');
      expect(send).toHaveBeenCalledOnce();
      expect(await audits()).toHaveLength(1);
      expect(await markers()).toHaveLength(1);
    } finally {
      await outer.query('ROLLBACK');
      outer.release();
    }
  });

  it('rolls back the marker with a failed audit INSERT, sends nothing, then retries successfully', async () => {
    const send = vi.fn<LLMProvider['sendCompletion']>(async () => {
      throw new Error('stop after dispatch');
    });
    failAuditInsert = true;
    await expect(wrappedProvider(send).sendCompletion(request('192.0.2.1'))).rejects.toBeInstanceOf(
      VendorAuditUnavailableError,
    );
    expect(send).not.toHaveBeenCalled();
    expect(await audits()).toHaveLength(0);
    expect(await markers()).toHaveLength(0);
    await expect(wrappedProvider(send).sendCompletion(request('192.0.2.1'))).rejects.toThrow(
      'stop after dispatch',
    );
    expect(send).toHaveBeenCalledOnce();
    expect(await audits()).toHaveLength(1);
    expect(await markers()).toHaveLength(1);
  });

  it('fails closed on lost COMMIT acknowledgement and reuses the committed evidence on retry', async () => {
    loseCommitAcknowledgement = true;
    await expect(recordVendorDecision(context, 'anthropic', decision())).rejects.toBeInstanceOf(
      VendorAuditUnavailableError,
    );
    expect(await audits()).toHaveLength(1);
    expect(await markers()).toHaveLength(1);
    await recordVendorDecision(context, 'anthropic', decision());
    expect(await audits()).toHaveLength(1);
    expect(await markers()).toHaveLength(1);
  });

  it('serializes concurrent equivalent claims to one committed marker and event', async () => {
    await Promise.all(
      Array.from({ length: 4 }, () => recordVendorDecision(context, 'anthropic', decision())),
    );
    expect(auditBackendPids.size).toBeGreaterThan(1);
    expect(await audits()).toHaveLength(1);
    expect(await markers()).toHaveLength(1);
    await getTestClient().query('SELECT set_tenant_context($1)', [context.tenantId]);
    await assertAuditChainIntact(context.tenantId);
  });

  it('does not extend a live marker when a rolled-back request receives a later reservation', async () => {
    await recordVendorDecision(context, 'anthropic', decision());
    await recordVendorDecision(
      {
        ...context,
        reservationExpiresAt: new Date(
          Date.parse(context.reservationExpiresAt) + 60_000,
        ).toISOString(),
      },
      'anthropic',
      decision(),
    );
    expect(await audits()).toHaveLength(1);
    expect((await markers())[0]!.expires_at.toISOString()).toBe(context.reservationExpiresAt);
  });

  it('preserves the reservation cutoff to PostgreSQL microsecond precision', async () => {
    const precise = {
      ...context,
      reservationExpiresAt: context.reservationExpiresAt.replace('Z', '456+00:00'),
    };
    await recordVendorDecision(precise, 'anthropic', decision());
    const stored = await realTransaction((tx) =>
      tx.query<{ exact: boolean }>(
        'SELECT expires_at = $2::timestamptz AS exact FROM audit_dedupe_markers WHERE tenant_id = $1',
        [context.tenantId, precise.reservationExpiresAt],
      ),
    );
    expect(stored.rows[0]!.exact).toBe(true);
  });

  it('uses a stable claim window when marker expiry crosses between DELETE and INSERT', async () => {
    await recordVendorDecision(context, 'anthropic', decision());
    crossExpiryDuringClaim = true;
    await recordVendorDecision(context, 'anthropic', decision());
    expect(await audits()).toHaveLength(1);
    // A subsequent transaction starts after expiry and owns the new claim.
    await recordVendorDecision(context, 'anthropic', decision());
    expect(await audits()).toHaveLength(2);
    expect(await markers()).toHaveLength(1);
  });

  it('reclaims expired evidence for a new accepted reservation without a cleanup job', async () => {
    await recordVendorDecision(context, 'anthropic', decision());
    await realTransaction((tx) =>
      tx.query(
        "UPDATE audit_dedupe_markers SET expires_at = NOW() - INTERVAL '1 second' WHERE tenant_id = $1",
        [context.tenantId],
      ),
    );
    await Promise.all(
      Array.from({ length: 3 }, () => recordVendorDecision(context, 'anthropic', decision())),
    );
    expect(await audits()).toHaveLength(2);
    expect(await markers()).toHaveLength(1);
    expect((await markers())[0]!.expires_at.toISOString()).toBe(context.reservationExpiresAt);
  });

  it('does not treat an already expired reservation as durable equivalent evidence', async () => {
    const expired = {
      ...context,
      reservationExpiresAt: new Date(Date.now() - 1_000).toISOString(),
    };
    await recordVendorDecision(expired, 'anthropic', decision());
    await recordVendorDecision(expired, 'anthropic', decision());
    expect(await audits()).toHaveLength(2);
    expect(await markers()).toHaveLength(0);
  });

  it('keeps changed body, authenticated actor, action, candidate and provider decisions distinct', async () => {
    await recordVendorDecision(context, 'anthropic', decision());
    await recordVendorDecision(
      { ...context, idempotency: { ...context.idempotency, bodyHash: 'b'.repeat(64) } },
      'anthropic',
      decision(),
    );
    const otherPatient = ulid();
    await recordVendorDecision(
      {
        ...context,
        patientId: otherPatient,
        idempotency: { ...context.idempotency, actorId: otherPatient },
      },
      'anthropic',
      decision(),
    );
    await recordVendorDecision(
      context,
      'anthropic',
      decision({ action: 'redact', reason: 'low_confidence_redacted', patternIds: ['ipv4'] }),
    );
    await recordVendorDecision(
      context,
      'anthropic',
      decision({ candidateFingerprint: 'c'.repeat(64) }),
    );
    await recordVendorDecision(context, 'bedrock_claude', decision());
    expect(await audits()).toHaveLength(6);
    expect(await markers()).toHaveLength(6);
    await getTestClient().query('SELECT set_tenant_context($1)', [context.tenantId]);
    await assertAuditChainIntact(context.tenantId);
  });

  it('does not suppress another tenant using the same other identity fields', async () => {
    const otherTenant = (await freshContext()).tenantId;
    const other = {
      ...context,
      tenantId: otherTenant,
      idempotency: { ...context.idempotency, tenantId: otherTenant },
    };
    await Promise.all([
      recordVendorDecision(context, 'anthropic', decision()),
      recordVendorDecision(other, 'anthropic', decision()),
    ]);
    expect(await audits()).toHaveLength(1);
    expect(await audits(other)).toHaveLength(1);
    expect(await markers()).toHaveLength(1);
    expect(await markers(other)).toHaveLength(1);
  });

  it('records unknown screening counts as null and never equates unassessed candidates', async () => {
    const unassessed = decision({
      reason: 'screening_failed',
      patternIds: [],
      hitCount: 0,
      candidateFingerprint: null,
    });
    await recordVendorDecision(context, 'anthropic', unassessed);
    await recordVendorDecision(context, 'anthropic', unassessed);
    const rows = await audits();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.payload).toMatchObject({
      pattern_ids: [],
      hit_count: null,
      reason: 'screening_failed',
    });
    expect(await markers()).toHaveLength(0);
  });

  it('rejects conflicting attribution and malformed decision metadata without evidence or dispatch', async () => {
    await expect(
      recordVendorDecision({ ...context, countryOfCare: 'GH' }, 'anthropic', decision()),
    ).rejects.toBeInstanceOf(VendorAuditUnavailableError);
    await expect(
      recordVendorDecision(
        { ...context, idempotency: { ...context.idempotency, tenantId: 'Telecheck-Ghana' } },
        'anthropic',
        decision(),
      ),
    ).rejects.toBeInstanceOf(VendorAuditUnavailableError);
    await expect(recordVendorDecision(context, 'null', decision())).rejects.toBeInstanceOf(
      VendorAuditUnavailableError,
    );
    await expect(
      recordVendorDecision(
        context,
        'anthropic',
        decision({ patternIds: ['arbitrary-private-value'] }),
      ),
    ).rejects.toBeInstanceOf(VendorAuditUnavailableError);
    await expect(
      recordVendorDecision(
        context,
        'anthropic',
        decision({ action: 'redact', reason: 'low_confidence_redacted' }),
      ),
    ).rejects.toBeInstanceOf(VendorAuditUnavailableError);
    await expect(
      recordVendorDecision(context, 'anthropic', decision({ hitCount: 0 })),
    ).rejects.toBeInstanceOf(VendorAuditUnavailableError);
    expect(await audits()).toHaveLength(0);
    expect(await markers()).toHaveLength(0);
  });

  it('bounds an independent audit blocked by another transaction and leaves no false marker', async () => {
    await recordVendorDecision(context, 'anthropic', decision());
    // An unexpired conflict can use DO NOTHING without locking the row. Make
    // the marker reclaimable so DELETE must acquire the held row lock.
    await realTransaction((tx) =>
      tx.query(
        "UPDATE audit_dedupe_markers SET expires_at = NOW() - INTERVAL '1 second' WHERE tenant_id = $1",
        [context.tenantId],
      ),
    );
    const outer = await connect();
    try {
      await outer.query('BEGIN');
      await outer.query(
        'SELECT dedupe_key FROM audit_dedupe_markers WHERE tenant_id = $1 FOR UPDATE',
        [context.tenantId],
      );
      const started = Date.now();
      await expect(recordVendorDecision(context, 'anthropic', decision())).rejects.toBeInstanceOf(
        VendorAuditUnavailableError,
      );
      expect(Date.now() - started).toBeLessThan(8_000);
      await outer.query('ROLLBACK');
      expect(await audits()).toHaveLength(1);
      expect(await markers()).toHaveLength(1);
      await recordVendorDecision(context, 'anthropic', decision());
      expect(await audits()).toHaveLength(2);
    } finally {
      await outer.query('ROLLBACK');
      outer.release();
    }
  });

  it('fails closed within the existing pool acquisition limit under saturation', async () => {
    const held = await Promise.all(Array.from({ length: 5 }, () => connect()));
    try {
      const started = Date.now();
      await expect(recordVendorDecision(context, 'anthropic', decision())).rejects.toBeInstanceOf(
        VendorAuditUnavailableError,
      );
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      for (const client of held) client.release();
    }
    expect(await audits()).toHaveLength(0);
    expect(await markers()).toHaveLength(0);
    await recordVendorDecision(context, 'anthropic', decision());
    expect(await audits()).toHaveLength(1);
  });

  it('times out an outer transaction holding the PLATFORM chain, rolling back its new marker', async () => {
    const outer = await connect();
    try {
      await outer.query('BEGIN');
      await outer.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${context.tenantId}:PLATFORM`,
      ]);
      const started = Date.now();
      await expect(recordVendorDecision(context, 'anthropic', decision())).rejects.toBeInstanceOf(
        VendorAuditUnavailableError,
      );
      expect(Date.now() - started).toBeLessThan(8_000);
      await outer.query('ROLLBACK');
      expect(await audits()).toHaveLength(0);
      expect(await markers()).toHaveLength(0);
      await recordVendorDecision(context, 'anthropic', decision());
      expect(await audits()).toHaveLength(1);
    } finally {
      await outer.query('ROLLBACK');
      outer.release();
    }
  });
});
