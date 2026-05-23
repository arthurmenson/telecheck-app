/**
 * activate-signal.test.ts — unit tests for the PR 8 write handler
 * POST /v0/med-interaction/signals/:id/activate.
 *
 * Mirrors emit-signal.test.ts structure. Additional coverage: the
 * 23514 (check_violation) → tenant-blind 404 mapping for the wrapper's
 * signal_not_emitted / activation_blocked_by_override rejection path.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { activateSignalHandler } from './activate-signal.js';

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
        path: '/v0/med-interaction/signals/:id/activate',
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
  ulid: vi.fn(() => '01HFG6Z3Q8B7H9P2W4V5K6N7TT'),
}));

vi.mock('../../audit.js', () => ({
  emitSignalLifecycleTransitionAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitSignalLifecycleTransitionAudit', args });
    return { audit_id: 'aud_test' };
  }),
}));

const VALID_SIGNAL_ID = '01HFG6Z3Q8B7H9P2W4V5K6N7T9';

function makeReq(opts?: {
  id?: string;
  body?: unknown;
  hasActor?: boolean;
  actorNonce?: string | undefined;
}): FastifyRequest {
  const hasActor = opts?.hasActor ?? true;
  return {
    id: 'req_test',
    params: { id: opts?.id ?? VALID_SIGNAL_ID },
    body: opts?.body ?? {},
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

describe('activateSignalHandler §1 — path/body validation', () => {
  it('rejects missing :id with 400', async () => {
    const req = makeReq();
    (req as unknown as { params: Record<string, unknown> }).params = {};
    const { reply } = makeReply();
    await expect(activateSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects malformed :id with 400', async () => {
    const req = makeReq({ id: 'not-a-ulid' });
    const { reply } = makeReply();
    await expect(activateSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects invalid patient_id in body with 400', async () => {
    const req = makeReq({ body: { patient_id: 'not-ulid' } });
    const { reply, sent } = makeReply();
    await activateSignalHandler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects non-object metadata with 400', async () => {
    const req = makeReq({ body: { metadata: 'not-an-object' } });
    const { reply, sent } = makeReply();
    await activateSignalHandler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('accepts empty {} body (both fields optional)', async () => {
    const req = makeReq({ body: {} });
    const { reply, sent } = makeReply();
    await activateSignalHandler(req, reply);
    expect(sent.code).toBe(200);
  });
});

describe('activateSignalHandler §2 — Layer B authorization', () => {
  it('rejects 401 in production without actorContext', async () => {
    process.env['NODE_ENV'] = 'production';
    const req = makeReq({ hasActor: false });
    const { reply } = makeReply();
    await expect(activateSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

describe('activateSignalHandler §3 — canonical composition', () => {
  it('threads composition order with no nonce', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await activateSignalHandler(req, reply);
    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withDbRole:medication_interaction_engine_evaluator',
      'withIdempotentExecution:end',
    ]);
  });

  it('interposes withActorContext when nonce bound', async () => {
    const req = makeReq({ actorNonce: 'nonce-abc' });
    const { reply } = makeReply();
    await activateSignalHandler(req, reply);
    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-abc',
      'withDbRole:medication_interaction_engine_evaluator',
      'withIdempotentExecution:end',
    ]);
  });
});

describe('activateSignalHandler §4 — SECDEF wrapper + audit same-tx', () => {
  it('issues record_signal_activation under the role + emits lifecycle audit', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await activateSignalHandler(req, reply);

    expect(recordedQueries).toHaveLength(1);
    expect(recordedQueries[0]!.sql).toContain('record_signal_activation');
    // Parameters: [transitionId, tenantId, signalId, actorId, metadata]
    expect(recordedQueries[0]!.params?.[1]).toBe('Telecheck-US');
    expect(recordedQueries[0]!.params?.[2]).toBe(VALID_SIGNAL_ID);

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]!.fn).toBe('emitSignalLifecycleTransitionAudit');
    const args = auditCalls[0]!.args as Record<string, unknown>;
    expect(args['fromState']).toBe('emitted');
    expect(args['toState']).toBe('active');
    expect(args['transitionReason']).toBe('activation');
  });
});

describe('activateSignalHandler §5 — error mapping (I-025)', () => {
  it('maps 42501 to tenant-blind 403', async () => {
    queryResponder = async () => {
      const err = new Error('insufficient_privilege') as Error & { code: string };
      err.code = '42501';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(activateSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Insufficient scope for this request.',
    });
  });

  it('maps wrapper SQLSTATE 23514 (signal_not_emitted / blocked_by_override) to tenant-blind 404', async () => {
    queryResponder = async () => {
      const err = new Error('signal_not_emitted: current_state=overridden') as Error & {
        code: string;
      };
      err.code = '23514';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(activateSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Interaction signal not found.',
    });
  });
});

describe('activateSignalHandler §6 — 200 + view payload', () => {
  it('returns 200 with { signal_id, transition_id, activated_at } on success', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await activateSignalHandler(req, reply);
    expect(sent.code).toBe(200);
    expect(sent.body).toMatchObject({
      signal_id: VALID_SIGNAL_ID,
      transition_id: '01HFG6Z3Q8B7H9P2W4V5K6N7TT',
    });
  });
});
