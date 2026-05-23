/**
 * post-evaluation.test.ts — unit tests for the PR 8 first write-handler
 * POST /v0/med-interaction/evaluations.
 *
 * **Scope:** unit-mock the tx pattern at the `withTransaction` /
 * `withTenantContext` / `withActorContext` / `withDbRole` boundaries + the
 * underlying `tx.query` calls + the audit emitter. Verifies:
 *
 *   §1 Body validation gate at the HTTP boundary (400 on malformed body).
 *   §2 Layer B authorization shape — non-production permissive, production
 *      fail-closed with no actorContext.
 *   §3 Canonical write composition — INSERT runs under withDbRole(
 *      medication_interaction_engine_evaluator); audit emission runs AFTER the
 *      role callback returns; both inside the same withTransaction +
 *      withTenantContext scope.
 *   §4 201 + { evaluation_id } payload with a server-assigned ULID.
 *
 * **Out of scope (covered by future integration tests):**
 *   - Real PostgreSQL execution of the INSERT + RLS WITH CHECK enforcement.
 *   - Real audit_records persistence + hash-chain.
 *   - Cross-tenant isolation.
 *   These land in tests/integration alongside the broader SI-019 write-handler
 *   integration harness (seeded migration 047 entities).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { postEvaluationHandler } from './post-evaluation.js';

// ---------------------------------------------------------------------------
// Foundation-helper mocks (mirrors get-signal.test.ts). Records wrapper order
// + queries so we can assert the composition shape without a live DB.
// ---------------------------------------------------------------------------

const recordedQueries: { sql: string; params: unknown[] | undefined }[] = [];
const wrapperCalls: string[] = [];
const auditCalls: unknown[] = [];

vi.mock('../../../../lib/db.js', () => ({
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    wrapperCalls.push('withTransaction:start');
    const mockTx = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        recordedQueries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
    };
    const result = await fn(mockTx);
    wrapperCalls.push('withTransaction:end');
    return result;
  }),
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
    wrapperCalls.push(`withDbRole:start:${role}`);
    const r = await fn();
    wrapperCalls.push(`withDbRole:end:${role}`);
    return r;
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

vi.mock('../../audit.js', () => ({
  emitEngineEvaluationCompletedAudit: vi.fn(async (args: unknown) => {
    wrapperCalls.push('emitAudit');
    auditCalls.push(args);
    return { audit_id: 'aud_test' };
  }),
}));

// Deterministic ULID so we can assert the returned evaluation_id.
vi.mock('../../../../lib/ulid.js', () => ({
  ulid: vi.fn(() => '01HZZZZZZZZZZZZZZZZZZZZZZZZ'),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PATIENT_ID = '01HFG6Z3Q8B7H9P2W4V5K6N7T9';
const VALID_RESOURCE_ID = '01HFG6Z3Q8B7H9P2W4V5K6N8AB';
const GENERATED_EVAL_ID = '01HZZZZZZZZZZZZZZZZZZZZZZZZ';

function validBody(): Record<string, unknown> {
  return {
    patient_id: VALID_PATIENT_ID,
    triggered_by: 'prescribing',
    triggered_by_resource_id: VALID_RESOURCE_ID,
    evaluation_window_ms: 42,
    engine_version: '1.2.0',
    knowledge_base_version: '2026.05.01',
    medication_set_snapshot: { medications: ['rxnorm:1234'] },
    condition_set_snapshot: { conditions: [] },
    lab_set_snapshot: { labs: [] },
  };
}

function makeReq(opts?: {
  body?: unknown;
  hasActor?: boolean;
  actorNonce?: string | undefined;
}): FastifyRequest {
  const hasActor = opts?.hasActor ?? true;
  const req = {
    body: opts?.body ?? validBody(),
    actorContext: hasActor ? { accountId: 'acct_test', role: 'clinician' as const } : undefined,
    actorNonce: opts?.actorNonce,
    server: {
      httpErrors: {
        badRequest: (msg: string) => {
          const e = new Error(msg) as Error & { statusCode: number };
          e.statusCode = 400;
          return e;
        },
        unauthorized: (msg: string) => {
          const e = new Error(msg) as Error & { statusCode: number };
          e.statusCode = 401;
          return e;
        },
      },
    },
  } as unknown as FastifyRequest;
  return req;
}

function makeReply(): { reply: FastifyReply; sent: { code?: number; body?: unknown } } {
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
  recordedQueries.length = 0;
  wrapperCalls.length = 0;
  auditCalls.length = 0;
  delete process.env['NODE_ENV'];
});

afterEach(() => {
  delete process.env['NODE_ENV'];
});

// ===========================================================================
// §1 — body validation
// ===========================================================================

describe('postEvaluationHandler §1 — body validation', () => {
  it('rejects a missing patient_id with 400', async () => {
    const body = validBody();
    delete body['patient_id'];
    const { reply } = makeReply();
    await expect(postEvaluationHandler(makeReq({ body }), reply)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects a non-ULID patient_id with 400', async () => {
    const body = validBody();
    body['patient_id'] = 'not-a-ulid';
    const { reply } = makeReply();
    await expect(postEvaluationHandler(makeReq({ body }), reply)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('patient_id'),
    });
  });

  it('rejects an out-of-enum triggered_by with 400', async () => {
    const body = validBody();
    body['triggered_by'] = 'made_up_trigger';
    const { reply } = makeReply();
    await expect(postEvaluationHandler(makeReq({ body }), reply)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects a negative evaluation_window_ms with 400', async () => {
    const body = validBody();
    body['evaluation_window_ms'] = -1;
    const { reply } = makeReply();
    await expect(postEvaluationHandler(makeReq({ body }), reply)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects a missing snapshot with 400', async () => {
    const body = validBody();
    delete body['lab_set_snapshot'];
    const { reply } = makeReply();
    await expect(postEvaluationHandler(makeReq({ body }), reply)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

// ===========================================================================
// §2 — Layer B authorization
// ===========================================================================

describe('postEvaluationHandler §2 — Layer B authorization', () => {
  it('accepts an authenticated actorContext in any environment', async () => {
    process.env['NODE_ENV'] = 'production';
    const { reply, sent } = makeReply();
    await postEvaluationHandler(makeReq({ hasActor: true }), reply);
    expect(sent.code).toBe(201);
  });

  it('rejects 401 in production when actorContext is undefined', async () => {
    process.env['NODE_ENV'] = 'production';
    const { reply } = makeReply();
    await expect(
      postEvaluationHandler(makeReq({ hasActor: false }), reply),
    ).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining('Actor identity'),
    });
  });

  it('permits anonymous writes in non-production (test ergonomics)', async () => {
    process.env['NODE_ENV'] = 'test';
    const { reply, sent } = makeReply();
    await postEvaluationHandler(makeReq({ hasActor: false }), reply);
    expect(sent.code).toBe(201);
  });
});

// ===========================================================================
// §3 — canonical write composition
// ===========================================================================

describe('postEvaluationHandler §3 — write composition', () => {
  it('runs the INSERT under withDbRole(medication_interaction_engine_evaluator), then emits audit after the role callback returns', async () => {
    const { reply } = makeReply();
    await postEvaluationHandler(makeReq(), reply);

    // Audit must come AFTER withDbRole:end (restored app role), and both must
    // be inside the same withTransaction + withTenantContext scope.
    expect(wrapperCalls).toEqual([
      'withTransaction:start',
      'withTenantContext:Telecheck-US',
      'withDbRole:start:medication_interaction_engine_evaluator',
      'withDbRole:end:medication_interaction_engine_evaluator',
      'emitAudit',
      'withTransaction:end',
    ]);
  });

  it('issues the interaction_engine_evaluation INSERT with the generated ULID + tenant + body params', async () => {
    const { reply } = makeReply();
    await postEvaluationHandler(makeReq(), reply);

    expect(recordedQueries).toHaveLength(1);
    expect(recordedQueries[0]!.sql).toContain('INSERT INTO interaction_engine_evaluation');
    const params = recordedQueries[0]!.params!;
    expect(params[0]).toBe(GENERATED_EVAL_ID);
    expect(params[1]).toBe('Telecheck-US');
    expect(params[2]).toBe(VALID_PATIENT_ID);
    expect(params[3]).toBe('prescribing');
    expect(params[4]).toBe(VALID_RESOURCE_ID);
    // Snapshots are JSON-stringified for ::jsonb binding.
    expect(params[8]).toBe(JSON.stringify({ medications: ['rxnorm:1234'] }));
  });

  it('passes the canonical audit args (tenant, evaluation_id, patient_id, country_of_care)', async () => {
    const { reply } = makeReply();
    await postEvaluationHandler(makeReq(), reply);

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]).toMatchObject({
      tenantId: 'Telecheck-US',
      evaluationId: GENERATED_EVAL_ID,
      patientId: VALID_PATIENT_ID,
      countryOfCare: 'US',
      triggeredBy: 'prescribing',
    });
  });

  it('threads withActorContext into the chain when actorNonce is bound', async () => {
    const { reply } = makeReply();
    await postEvaluationHandler(makeReq({ actorNonce: 'nonce-uuid-123' }), reply);

    expect(wrapperCalls).toEqual([
      'withTransaction:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-uuid-123',
      'withDbRole:start:medication_interaction_engine_evaluator',
      'withDbRole:end:medication_interaction_engine_evaluator',
      'emitAudit',
      'withTransaction:end',
    ]);
  });
});

// ===========================================================================
// §4 — 201 + payload
// ===========================================================================

describe('postEvaluationHandler §4 — 201 + evaluation_id payload', () => {
  it('returns 201 with the server-assigned evaluation_id', async () => {
    const { reply, sent } = makeReply();
    await postEvaluationHandler(makeReq(), reply);

    expect(sent.code).toBe(201);
    expect(sent.body).toEqual({ evaluation_id: GENERATED_EVAL_ID });
  });
});
