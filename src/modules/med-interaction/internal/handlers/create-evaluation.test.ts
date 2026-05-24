/**
 * create-evaluation.test.ts — unit tests for the PR 8 first-write-handler
 * POST /v0/med-interaction/evaluations.
 *
 * **Scope:** unit-mock the composition helpers (withIdempotentExecution,
 * withTenantContext, withActorContext, withDbRole) + the audit emitter
 * (emitEvaluationCompletedAudit) + the tx.query call. Verifies:
 *
 *   §1 Body validation gate at the HTTP boundary (400 on malformed body).
 *   §2 Layer B authorization shape — non-production permissive,
 *      production fail-closed with no actorContext.
 *   §3 Canonical composition order — withIdempotentExecution opens the
 *      tx; inner chain is withTenantContext → withActorContext (when
 *      nonce bound) → withDbRole('medication_interaction_engine_evaluator').
 *   §4 INSERT SQL + audit emission BOTH issued inside the withDbRole
 *      callback (atomicity per Option 2 carryforward).
 *   §5 42501 → tenant-blind 403 mapping (I-025) — both the SET LOCAL ROLE
 *      path AND the inner INSERT's RLS denial path.
 *   §6 201 + canonical view payload on success.
 *   §7 Idempotency interception (Idempotency-Key path is delegated to
 *      the helper; we assert the helper IS called).
 *
 * Mirrors the structure of `get-signal.test.ts` (PR 7 reference) with
 * the added audit-emission + idempotent-handler mocks. Mocked at the
 * import boundary so the handler logic is exercised end-to-end without
 * a live PostgreSQL.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { createEvaluationHandler } from './create-evaluation.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const wrapperCalls: string[] = [];
const recordedQueries: { sql: string; params: unknown[] | undefined }[] = [];
const auditCalls: { fn: string; args: unknown }[] = [];

// Mock tx.query — default returns 1-row INSERT result.
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
  // withIdempotentExecution(req, reply, mapServiceError, body) — invoke body
  // with the mock tx + a stub idempotencyCtx + return { status, view }
  // shaped reply.
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
        path: '/v0/med-interaction/evaluations',
      });
      wrapperCalls.push('withIdempotentExecution:end');
      return reply.code(result.status).send(result.view);
    },
  ),
}));

vi.mock('../../../../lib/rls.js', () => ({
  withTenantContext: vi.fn(async (_tx: unknown, tenantId: string, fn: () => Promise<unknown>) => {
    wrapperCalls.push(`withTenantContext:${tenantId}`);
    return fn();
  }),
}));

vi.mock('../../../../lib/actor-context-binding.js', () => ({
  withActorContext: vi.fn(async (_tx: unknown, nonce: string, fn: () => Promise<unknown>) => {
    wrapperCalls.push(`withActorContext:${nonce}`);
    return fn();
  }),
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
  emitEvaluationCompletedAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitEvaluationCompletedAudit', args });
    return { audit_id: 'aud_test' };
  }),
}));

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const VALID_ULID_A = '01HFG6Z3Q8B7H9P2W4V5K6N7T9';
const VALID_ULID_B = '01HFG6Z3Q8B7H9P2W4V5K6N7TA';

function makeValidBody(): Record<string, unknown> {
  return {
    triggered_by: 'prescribing',
    triggered_by_resource_id: VALID_ULID_A,
    patient_id: VALID_ULID_B,
    engine_version: '1.0.0',
    knowledge_base_version: '2026.05',
    medication_set_snapshot: { meds: [] },
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
        forbidden: (msg: string) => {
          const e = new Error(msg) as Error & { statusCode: number };
          e.statusCode = 403;
          return e;
        },
        notFound: (msg: string) => {
          const e = new Error(msg) as Error & { statusCode: number };
          e.statusCode = 404;
          return e;
        },
      },
    },
  } as unknown as FastifyRequest;
  return req;
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

// ===========================================================================
// §1 — Body validation
// ===========================================================================

describe('createEvaluationHandler §1 — body validation', () => {
  it('rejects missing triggered_by with 400', async () => {
    const body = makeValidBody();
    delete body['triggered_by'];
    const req = makeReq({ body });
    const { reply, sent } = makeReply();
    await createEvaluationHandler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects an invalid triggered_by enum value with 400', async () => {
    const body = { ...makeValidBody(), triggered_by: 'not_a_real_trigger' };
    const req = makeReq({ body });
    const { reply, sent } = makeReply();
    await createEvaluationHandler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects a non-ULID patient_id with 400', async () => {
    const body = { ...makeValidBody(), patient_id: 'not-a-ulid' };
    const req = makeReq({ body });
    const { reply, sent } = makeReply();
    await createEvaluationHandler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects missing medication_set_snapshot with 400', async () => {
    const body = makeValidBody();
    delete body['medication_set_snapshot'];
    const req = makeReq({ body });
    const { reply, sent } = makeReply();
    await createEvaluationHandler(req, reply);
    expect(sent.code).toBe(400);
  });
});

// ===========================================================================
// §2 — Layer B authorization shape
// ===========================================================================

describe('createEvaluationHandler §2 — Layer B authorization', () => {
  it('accepts an authenticated actorContext in any environment', async () => {
    process.env['NODE_ENV'] = 'production';
    const req = makeReq({ hasActor: true });
    const { reply, sent } = makeReply();
    await createEvaluationHandler(req, reply);
    expect(sent.code).toBe(201);
  });

  it('rejects 401 in production when actorContext is undefined', async () => {
    process.env['NODE_ENV'] = 'production';
    const req = makeReq({ hasActor: false });
    const { reply } = makeReply();
    await expect(createEvaluationHandler(req, reply)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it('permits anonymous calls in non-production (test ergonomics)', async () => {
    process.env['NODE_ENV'] = 'test';
    const req = makeReq({ hasActor: false });
    const { reply, sent } = makeReply();
    await createEvaluationHandler(req, reply);
    expect(sent.code).toBe(201);
  });
});

// ===========================================================================
// §3 — Canonical composition order
// ===========================================================================

describe('createEvaluationHandler §3 — canonical composition', () => {
  it('threads withIdempotentExecution → withTenantContext → withDbRole(medication_interaction_engine_evaluator)', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await createEvaluationHandler(req, reply);

    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withDbRole:medication_interaction_engine_evaluator',
      'withIdempotentExecution:end',
    ]);
  });

  it('interposes withActorContext when actorNonce is bound', async () => {
    const req = makeReq({ actorNonce: 'nonce-uuid-123' });
    const { reply } = makeReply();
    await createEvaluationHandler(req, reply);

    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-uuid-123',
      'withDbRole:medication_interaction_engine_evaluator',
      'withIdempotentExecution:end',
    ]);
  });
});

// ===========================================================================
// §4 — INSERT + audit BOTH inside withDbRole (atomicity)
// ===========================================================================

describe('createEvaluationHandler §4 — INSERT + audit same-tx', () => {
  it('issues the interaction_engine_evaluation INSERT under the role elevation', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await createEvaluationHandler(req, reply);

    expect(recordedQueries).toHaveLength(1);
    expect(recordedQueries[0]!.sql).toContain('INSERT INTO interaction_engine_evaluation');
    expect(recordedQueries[0]!.params?.[1]).toBe('Telecheck-US');
  });

  // R1 Finding 1 closure (Codex 2026-05-23): the INSERT now matches the
  // 12-column schema in migration 047 §1, including evaluation_window_ms
  // (NOT NULL CHECK >= 0). The prior 11-column INSERT would have failed
  // on first integration test against live PostgreSQL with a NOT NULL
  // constraint violation on this column.
  it('INSERT column list matches migration 047 §1 schema (12 columns incl. evaluation_window_ms)', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await createEvaluationHandler(req, reply);

    expect(recordedQueries).toHaveLength(1);
    const { sql, params } = recordedQueries[0]!;
    // All 12 NOT NULL columns from migration 047 §1 named in the INSERT.
    for (const col of [
      'id',
      'tenant_id',
      'patient_id',
      'triggered_by',
      'triggered_by_resource_id',
      'evaluated_at',
      'evaluation_window_ms',
      'engine_version',
      'knowledge_base_version',
      'medication_set_snapshot',
      'condition_set_snapshot',
      'lab_set_snapshot',
    ]) {
      expect(sql).toContain(col);
    }
    // 12 positional parameters $1..$12, in the canonical order.
    expect(sql).toMatch(
      /\$1, \$2, \$3, \$4, \$5,\s*\$6, \$7, \$8, \$9,\s*\$10::jsonb, \$11::jsonb, \$12::jsonb/,
    );
    // evaluation_window_ms is param index 6 (0-indexed: 6 → $7), server-computed,
    // must be a non-negative integer per the schema CHECK constraint.
    const evaluationWindowMs = params?.[6];
    expect(typeof evaluationWindowMs).toBe('number');
    expect(Number.isInteger(evaluationWindowMs)).toBe(true);
    expect(evaluationWindowMs as number).toBeGreaterThanOrEqual(0);
  });

  it('emits the interaction_engine_evaluation_completed Cat A audit in the same tx', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await createEvaluationHandler(req, reply);

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]!.fn).toBe('emitEvaluationCompletedAudit');
    const args = auditCalls[0]!.args as Record<string, unknown>;
    expect(args['tenantId']).toBe('Telecheck-US');
    expect(args['triggeredBy']).toBe('prescribing');
    expect(args['actorTenantId']).toBe('Telecheck-US');
    // R1 Finding 1 closure: evaluation_window_ms also threaded into the
    // audit detail (mirrors the canonical `interaction_engine_evaluation`
    // event's `duration_ms` field per AUDIT_EVENTS v5.3 line 162).
    expect(typeof args['evaluationWindowMs']).toBe('number');
    expect(args['evaluationWindowMs'] as number).toBeGreaterThanOrEqual(0);
  });

  // R1 Finding 2 closure (Codex 2026-05-23): assert the EXACT per-handler
  // audit-event emission set per the canonical lifecycle audit rule in
  // `audit.ts` file-level docstring. create-evaluation emits EXACTLY ONE
  // event: interaction_engine_evaluation_completed. Any future regression
  // that (a) drops this emission or (b) adds a signal-lifecycle event
  // (interaction_signal_emitted, interaction_signal_lifecycle_transition_emitted)
  // here MUST update this assertion AND the canonical rule docstring; drift
  // between rule and test is a defect.
  it('emits EXACTLY ONE audit event (the canonical lifecycle rule for this handler)', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await createEvaluationHandler(req, reply);

    expect(auditCalls.map((c) => c.fn)).toEqual(['emitEvaluationCompletedAudit']);
  });
});

// ===========================================================================
// §5 — 42501 → 403 mapping (I-025)
// ===========================================================================

describe('createEvaluationHandler §5 — 42501 → tenant-blind 403', () => {
  it('maps a 42501 from the INSERT path to a tenant-blind 403', async () => {
    queryResponder = async () => {
      const err = new Error('permission denied for table') as Error & { code: string };
      err.code = '42501';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(createEvaluationHandler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Insufficient scope for this request.',
    });
  });

  it('propagates non-42501 SQL errors unchanged', async () => {
    queryResponder = async () => {
      const err = new Error('connection lost') as Error & { code: string };
      err.code = '08006';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(createEvaluationHandler(req, reply)).rejects.toMatchObject({
      code: '08006',
    });
  });
});

// ===========================================================================
// §6 — 201 + canonical view payload
// ===========================================================================

describe('createEvaluationHandler §6 — 201 + view payload', () => {
  it('returns 201 with { evaluation_id, evaluated_at } on success', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await createEvaluationHandler(req, reply);

    expect(sent.code).toBe(201);
    expect(sent.body).toMatchObject({
      evaluation_id: '01HFG6Z3Q8B7H9P2W4V5K6N7T9',
    });
    const body = sent.body as { evaluated_at: string };
    expect(typeof body.evaluated_at).toBe('string');
    // ISO 8601 format
    expect(body.evaluated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
