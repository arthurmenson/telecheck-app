/**
 * emit-signal.test.ts — unit tests for the PR 8 write handler
 * POST /v0/med-interaction/signals.
 *
 * Mirrors create-evaluation.test.ts structure. Verifies the canonical
 * composition + same-tx audit pattern + 42501 → 403 mapping. Adds
 * coverage for the wrapper's 02000 (no_data) → 404 mapping branch
 * for cross-tenant evaluation_id rejection.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { emitSignalHandler } from './emit-signal.js';

const wrapperCalls: string[] = [];
const recordedQueries: { sql: string; params: unknown[] | undefined }[] = [];
const auditCalls: { fn: string; args: unknown }[] = [];

let queryResponder: (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount: number | null }> = async () => ({
  rows: [],
  rowCount: 1,
});

const mockTx = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    recordedQueries.push({ sql, params });
    return queryResponder(sql, params);
  }),
};

vi.mock('../../../../lib/idempotent-handler.js', () => ({
  withIdempotentExecution: vi.fn(
    async (
      _req: unknown,
      reply: { code: (n: number) => { send: (b: unknown) => unknown } },
      _mapServiceError: unknown,
      body: (tx: unknown, ctx: unknown) => Promise<{ status: number; view: unknown }>,
    ) => {
      wrapperCalls.push('withIdempotentExecution:start');
      const result = await body(mockTx, {
        tenantId: 'Telecheck-US',
        accountId: 'acct_test',
        requestBodyHash: 'hash_test',
        idempotencyKey: 'idem_test',
        method: 'POST',
        path: '/v0/med-interaction/signals',
      });
      wrapperCalls.push('withIdempotentExecution:end');
      return reply.code(result.status).send(result.view);
    },
  ),
}));

vi.mock('../../../../lib/rls.js', () => ({
  withTenantContext: vi.fn(
    async (_tx: unknown, tenantId: string, fn: () => Promise<unknown>) => {
      wrapperCalls.push(`withTenantContext:${tenantId}`);
      return fn();
    },
  ),
}));

vi.mock('../../../../lib/actor-context-binding.js', () => ({
  withActorContext: vi.fn(
    async (_tx: unknown, nonce: string, fn: () => Promise<unknown>) => {
      wrapperCalls.push(`withActorContext:${nonce}`);
      return fn();
    },
  ),
}));

vi.mock('../../../../lib/with-db-role.js', () => ({
  withDbRole: vi.fn(async (_tx: unknown, role: string, fn: () => Promise<unknown>) => {
    wrapperCalls.push(`withDbRole:${role}`);
    return fn();
  }),
}));

vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(() => ({
    tenantId: 'Telecheck-US',
    displayName: 'Telecheck-US',
    countryOfCare: 'US' as const,
    kmsKeyAlias: 'alias/telecheck-us-data-key',
    consumerDba: 'Heros Health',
    legalEntity: 'Telecheck Health LLC',
    consumerSubdomain: 'heroshealth.com',
  })),
}));

vi.mock('../../../../lib/auth-context.js', () => ({
  resolveActorTenantIdForAudit: vi.fn(() => 'Telecheck-US'),
}));

vi.mock('../../../../lib/ulid.js', () => ({
  ulid: vi.fn(() => '01HFG6Z3Q8B7H9P2W4V5K6N7T9'),
}));

vi.mock('../../audit.js', () => ({
  emitSignalEmittedAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitSignalEmittedAudit', args });
    return { audit_id: 'aud_test' };
  }),
}));

const VALID_ULID_A = '01HFG6Z3Q8B7H9P2W4V5K6N7T9';
const VALID_ULID_B = '01HFG6Z3Q8B7H9P2W4V5K6N7TA';
const VALID_ULID_C = '01HFG6Z3Q8B7H9P2W4V5K6N7TB';

function makeValidBody(): Record<string, unknown> {
  return {
    evaluation_id: VALID_ULID_A,
    patient_id: VALID_ULID_B,
    check_class: 'drug_drug',
    severity: 'major',
    recommended_action: 'warn',
    medications_involved: [VALID_ULID_C],
    evidence_sources: { citation: 'KB-1' },
    signal_payload: { description: 'test' },
  };
}

function makeReq(opts?: {
  body?: unknown;
  hasActor?: boolean;
  actorNonce?: string | undefined;
}): FastifyRequest {
  const hasActor = opts?.hasActor ?? true;
  return {
    id: 'req_test',
    body: opts?.body ?? makeValidBody(),
    actorContext: hasActor
      ? {
          accountId: 'acct_test',
          sessionId: 'sess_test',
          tenantId: 'Telecheck-US',
          role: 'clinician' as const,
          countryOfCare: 'US' as const,
          delegateId: null,
          adminTenantBinding: null,
          adminHomeTenantId: null,
        }
      : undefined,
    actorNonce: opts?.actorNonce,
    server: {
      httpErrors: {
        badRequest: (msg: string) => Object.assign(new Error(msg), { statusCode: 400 }),
        unauthorized: (msg: string) => Object.assign(new Error(msg), { statusCode: 401 }),
        forbidden: (msg: string) => Object.assign(new Error(msg), { statusCode: 403 }),
        notFound: (msg: string) => Object.assign(new Error(msg), { statusCode: 404 }),
      },
    },
  } as unknown as FastifyRequest;
}

function makeReply(): {
  reply: FastifyReply;
  sent: { code?: number; body?: unknown };
} {
  const sent: { code?: number; body?: unknown } = {};
  const reply = {
    code: (n: number) => {
      sent.code = n;
      return reply;
    },
    send: (body: unknown) => {
      sent.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, sent };
}

beforeEach(() => {
  wrapperCalls.length = 0;
  recordedQueries.length = 0;
  auditCalls.length = 0;
  queryResponder = async () => ({ rows: [], rowCount: 1 });
  delete process.env['NODE_ENV'];
});

afterEach(() => {
  delete process.env['NODE_ENV'];
});

describe('emitSignalHandler §1 — body validation', () => {
  it('rejects invalid check_class with 400', async () => {
    const body = { ...makeValidBody(), check_class: 'bogus' };
    const req = makeReq({ body });
    const { reply, sent } = makeReply();
    await emitSignalHandler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects invalid severity with 400', async () => {
    const body = { ...makeValidBody(), severity: 'extreme' };
    const req = makeReq({ body });
    const { reply, sent } = makeReply();
    await emitSignalHandler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects non-ULID in medications_involved with 400', async () => {
    const body = { ...makeValidBody(), medications_involved: ['not-ulid'] };
    const req = makeReq({ body });
    const { reply, sent } = makeReply();
    await emitSignalHandler(req, reply);
    expect(sent.code).toBe(400);
  });
});

describe('emitSignalHandler §2 — Layer B authorization', () => {
  it('accepts authenticated actor in production', async () => {
    process.env['NODE_ENV'] = 'production';
    const req = makeReq({ hasActor: true });
    const { reply, sent } = makeReply();
    await emitSignalHandler(req, reply);
    expect(sent.code).toBe(201);
  });

  it('rejects 401 in production without actorContext', async () => {
    process.env['NODE_ENV'] = 'production';
    const req = makeReq({ hasActor: false });
    const { reply } = makeReply();
    await expect(emitSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

describe('emitSignalHandler §3 — canonical composition', () => {
  it('threads withIdempotentExecution → withTenantContext → withDbRole', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await emitSignalHandler(req, reply);

    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withDbRole:medication_interaction_engine_evaluator',
      'withIdempotentExecution:end',
    ]);
  });

  it('interposes withActorContext when nonce bound', async () => {
    const req = makeReq({ actorNonce: 'nonce-xyz' });
    const { reply } = makeReply();
    await emitSignalHandler(req, reply);
    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-xyz',
      'withDbRole:medication_interaction_engine_evaluator',
      'withIdempotentExecution:end',
    ]);
  });
});

describe('emitSignalHandler §4 — INSERT + wrapper + audit same-tx', () => {
  it('issues the interaction_signal INSERT, then the SECDEF wrapper, then the audit (in order)', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await emitSignalHandler(req, reply);

    expect(recordedQueries).toHaveLength(2);
    expect(recordedQueries[0]!.sql).toContain('INSERT INTO interaction_signal');
    expect(recordedQueries[1]!.sql).toContain('record_signal_emission');
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]!.fn).toBe('emitSignalEmittedAudit');
  });

  it('emits Cat A audit with the canonical action ID via the audit emitter', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await emitSignalHandler(req, reply);
    const args = auditCalls[0]!.args as Record<string, unknown>;
    expect(args['tenantId']).toBe('Telecheck-US');
    expect(args['checkClass']).toBe('drug_drug');
    expect(args['severity']).toBe('major');
    expect(args['recommendedAction']).toBe('warn');
  });
});

describe('emitSignalHandler §5 — error mapping (I-025)', () => {
  it('maps 42501 from SQL to a tenant-blind 403', async () => {
    queryResponder = async () => {
      const err = new Error('permission denied') as Error & { code: string };
      err.code = '42501';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(emitSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Insufficient scope for this request.',
    });
  });

  it('maps wrapper SQLSTATE 02000 (no_data; paired_signal_not_found) to tenant-blind 404', async () => {
    let callCount = 0;
    queryResponder = async () => {
      callCount += 1;
      if (callCount === 1) {
        return { rows: [], rowCount: 1 }; // INSERT succeeds
      }
      const err = new Error('paired_signal_not_found') as Error & { code: string };
      err.code = '02000';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(emitSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Interaction signal not found.',
    });
  });

  it('propagates unrelated PG errors unchanged', async () => {
    queryResponder = async () => {
      const err = new Error('connection lost') as Error & { code: string };
      err.code = '08006';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(emitSignalHandler(req, reply)).rejects.toMatchObject({ code: '08006' });
  });
});

describe('emitSignalHandler §6 — 201 + view payload', () => {
  it('returns 201 with { signal_id, emitted_at } on success', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await emitSignalHandler(req, reply);
    expect(sent.code).toBe(201);
    expect(sent.body).toMatchObject({ signal_id: '01HFG6Z3Q8B7H9P2W4V5K6N7T9' });
  });
});
