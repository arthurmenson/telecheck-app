/**
 * record-decision-v1.test.ts — unit tests for
 * POST /v1/async-consults/:consult_id/decision.
 *
 * Verifies: clinician-only gate, decision-shape validation (enums +
 * prescription-iff-prescribe + referral-iff-refer + envelope), canonical
 * composition under withDbRole('async_consult_clinician_reviewer'),
 * 23-param wrapper call, the audit-emission SET per decision shape
 * (decision_recorded always; + prescribing_recorded on prescribe;
 * + rationale_disagreement on disagreed; all three when both), error
 * mapping (42501 → 403; 23503/23514 → 409), and the 201 view.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { recordDecisionV1Handler } from './record-decision-v1.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const wrapperCalls: string[] = [];
const recordedQueries: { sql: string; params: unknown[] | undefined }[] = [];
const auditCalls: { fn: string; args: unknown }[] = [];
let capturedMapServiceError:
  | ((err: unknown, reply: FastifyReply, reqId: string) => boolean)
  | null = null;

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
      mapServiceError: (err: unknown, reply: FastifyReply, reqId: string) => boolean,
      body: (tx: unknown, ctx: unknown) => Promise<{ status: number; view: unknown }>,
    ) => {
      capturedMapServiceError = mapServiceError;
      wrapperCalls.push('withIdempotentExecution:start');
      const result = await body(mockTx, { tenantId: 'Telecheck-US' });
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
    countryOfCare: 'US' as const,
  })),
}));

vi.mock('../../../../lib/auth-context.js', () => ({
  requireClinicianActorContext: vi.fn((req: { actorContext?: { role?: string } }) => {
    const actor = req.actorContext;
    if (actor === undefined) {
      const e = new Error('Authentication is required.') as Error & { statusCode: number };
      e.statusCode = 401;
      throw e;
    }
    if (actor.role !== 'clinician') {
      const e = new Error('This endpoint requires role=clinician.') as Error & {
        statusCode: number;
      };
      e.statusCode = 403;
      throw e;
    }
    return actor;
  }),
  resolveActorTenantIdForAudit: vi.fn(() => 'Telecheck-US'),
}));

let ulidCounter = 0;
vi.mock('../../../../lib/ulid.js', () => ({
  ulid: vi.fn(() => `01HFG6Z3Q8B7H9P2W4V5K6N7T${(ulidCounter++ % 10).toString()}`),
}));

vi.mock('../../audit.js', () => ({
  emitAsyncConsultClinicianDecisionRecordedAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitAsyncConsultClinicianDecisionRecordedAudit', args });
    return { audit_id: 'aud_1' };
  }),
  emitAsyncConsultPrescribingRecordedAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitAsyncConsultPrescribingRecordedAudit', args });
    return { audit_id: 'aud_2' };
  }),
  emitAsyncConsultDecisionRationaleDisagreementAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitAsyncConsultDecisionRationaleDisagreementAudit', args });
    return { audit_id: 'aud_3' };
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLINICIAN_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TG';
const CONSULT_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TD';
const PATIENT_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TB';
const CLAIM_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TK';
const SIGNAL_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TM';
const RX_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TN';
const REFERRAL_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TP';
const DEK_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TF';

function makeEnvelope(): Record<string, unknown> {
  return {
    ciphertext_b64: Buffer.from('sealed-rationale').toString('base64'),
    dek_id: DEK_ULID,
    iv_b64: Buffer.from('0123456789ab').toString('base64'),
    tag_b64: Buffer.from('0123456789abcdef').toString('base64'),
    alg: 'AES-256-GCM',
    alg_version: '1',
    aad_b64: Buffer.from('tenant:Telecheck-US').toString('base64'),
    encrypted_at: '2026-07-06T00:00:00.000Z',
  };
}

function makeValidBody(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    claim_id: CLAIM_ULID,
    patient_id: PATIENT_ULID,
    decision_type: 'recommend',
    agreement_with_ai_recommendation: 'accepted',
    decision_rationale_envelope: makeEnvelope(),
    interaction_signals_reviewed_ids: [SIGNAL_ULID],
    ...overrides,
  };
}

function makeReq(opts?: {
  role?: string | null;
  consultId?: string;
  body?: unknown;
  actorNonce?: string;
}): FastifyRequest {
  const role = opts?.role === undefined ? 'clinician' : opts.role;
  return {
    id: 'req_test',
    params: { consult_id: opts?.consultId ?? CONSULT_ULID },
    body: opts?.body ?? makeValidBody(),
    headers: {},
    actorContext:
      role === null
        ? undefined
        : {
            accountId: CLINICIAN_ULID,
            sessionId: 'sess_test',
            tenantId: 'Telecheck-US',
            role,
            countryOfCare: 'US',
            delegateId: null,
            adminTenantBinding: null,
            adminHomeTenantId: null,
          },
    actorNonce: opts?.actorNonce,
    server: {
      httpErrors: {
        forbidden: (msg: string) => {
          const e = new Error(msg) as Error & { statusCode: number };
          e.statusCode = 403;
          return e;
        },
      },
    },
  } as unknown as FastifyRequest;
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
  wrapperCalls.length = 0;
  recordedQueries.length = 0;
  auditCalls.length = 0;
  ulidCounter = 0;
  capturedMapServiceError = null;
  queryResponder = async () => ({ rows: [], rowCount: 1 });
});

// ===========================================================================
// §1 — Guards + decision-shape validation
// ===========================================================================

describe('recordDecisionV1Handler §1 — guards + validation', () => {
  it('rejects 401 when unauthenticated', async () => {
    const req = makeReq({ role: null });
    const { reply } = makeReply();
    await expect(recordDecisionV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects 403 for a patient caller', async () => {
    const req = makeReq({ role: 'patient' });
    const { reply } = makeReply();
    await expect(recordDecisionV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects 400 on an unknown decision_type', async () => {
    const req = makeReq({ body: makeValidBody({ decision_type: 'defer' }) });
    const { reply, sent } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 on an unknown agreement value', async () => {
    const req = makeReq({ body: makeValidBody({ agreement_with_ai_recommendation: 'maybe' }) });
    const { reply, sent } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 when decision_type=prescribe lacks prescription_details_id', async () => {
    const req = makeReq({ body: makeValidBody({ decision_type: 'prescribe' }) });
    const { reply, sent } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 when a non-prescribe decision carries prescription_details_id', async () => {
    const req = makeReq({ body: makeValidBody({ prescription_details_id: RX_ULID }) });
    const { reply, sent } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 when decision_type=refer lacks referral_target_id', async () => {
    const req = makeReq({ body: makeValidBody({ decision_type: 'refer' }) });
    const { reply, sent } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 on a non-array interaction_signals_reviewed_ids', async () => {
    const req = makeReq({ body: makeValidBody({ interaction_signals_reviewed_ids: 'none' }) });
    const { reply, sent } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('accepts an EMPTY interaction_signals_reviewed_ids array', async () => {
    const req = makeReq({ body: makeValidBody({ interaction_signals_reviewed_ids: [] }) });
    const { reply, sent } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(sent.code).toBe(201);
  });

  it('rejects 400 on a partial decision_rationale_envelope', async () => {
    const envelope = makeEnvelope();
    delete envelope['iv_b64'];
    const req = makeReq({ body: makeValidBody({ decision_rationale_envelope: envelope }) });
    const { reply, sent } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });
});

// ===========================================================================
// §2 — Composition + wrapper call
// ===========================================================================

describe('recordDecisionV1Handler §2 — composition + wrapper', () => {
  it('threads the canonical composition under withDbRole(async_consult_clinician_reviewer)', async () => {
    const req = makeReq({ actorNonce: 'nonce-3' });
    const { reply } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-3',
      'withDbRole:async_consult_clinician_reviewer',
      'withIdempotentExecution:end',
    ]);
  });

  it('calls record_consult_clinician_decision with 23 params; clinician bound to the actor', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(recordedQueries).toHaveLength(1);
    const { sql, params } = recordedQueries[0]!;
    expect(sql).toContain('record_consult_clinician_decision');
    expect(params).toHaveLength(23);
    expect(params?.[1]).toBe('Telecheck-US');
    expect(params?.[2]).toBe(CONSULT_ULID);
    expect(params?.[3]).toBe(PATIENT_ULID);
    expect(params?.[4]).toBe(CLAIM_ULID);
    expect(params?.[5]).toBe(CLINICIAN_ULID); // deciding clinician == actor
    expect(params?.[6]).toBe('recommend');
    expect(params?.[16]).toEqual([SIGNAL_ULID]);
    expect(params?.[17]).toBeNull(); // prescription_details_id
    expect(params?.[18]).toBeNull(); // referral_target_id
    expect(params?.[22]).toBe('clinician'); // p_actor_role
  });
});

// ===========================================================================
// §3 — Audit emission set per decision shape
// ===========================================================================

describe('recordDecisionV1Handler §3 — audit emission set', () => {
  it('recommend + accepted emits EXACTLY ONE event: clinician_decision_recorded', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(auditCalls.map((c) => c.fn)).toEqual(['emitAsyncConsultClinicianDecisionRecordedAudit']);
  });

  it('prescribe emits decision_recorded THEN prescribing_recorded', async () => {
    const req = makeReq({
      body: makeValidBody({ decision_type: 'prescribe', prescription_details_id: RX_ULID }),
    });
    const { reply } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(auditCalls.map((c) => c.fn)).toEqual([
      'emitAsyncConsultClinicianDecisionRecordedAudit',
      'emitAsyncConsultPrescribingRecordedAudit',
    ]);
    const rx = auditCalls[1]!.args as Record<string, unknown>;
    expect(rx['prescriptionDetailsId']).toBe(RX_ULID);
  });

  it('disagreed emits decision_recorded THEN rationale_disagreement', async () => {
    const req = makeReq({
      body: makeValidBody({ agreement_with_ai_recommendation: 'disagreed' }),
    });
    const { reply } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(auditCalls.map((c) => c.fn)).toEqual([
      'emitAsyncConsultClinicianDecisionRecordedAudit',
      'emitAsyncConsultDecisionRationaleDisagreementAudit',
    ]);
  });

  it('prescribe + disagreed emits ALL THREE in canonical order', async () => {
    const req = makeReq({
      body: makeValidBody({
        decision_type: 'prescribe',
        prescription_details_id: RX_ULID,
        agreement_with_ai_recommendation: 'disagreed',
      }),
    });
    const { reply } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(auditCalls.map((c) => c.fn)).toEqual([
      'emitAsyncConsultClinicianDecisionRecordedAudit',
      'emitAsyncConsultPrescribingRecordedAudit',
      'emitAsyncConsultDecisionRationaleDisagreementAudit',
    ]);
  });

  it('refer emits only decision_recorded (referral carried in the decision detail)', async () => {
    const req = makeReq({
      body: makeValidBody({ decision_type: 'refer', referral_target_id: REFERRAL_ULID }),
    });
    const { reply } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(auditCalls.map((c) => c.fn)).toEqual(['emitAsyncConsultClinicianDecisionRecordedAudit']);
    const args = auditCalls[0]!.args as Record<string, unknown>;
    expect(args['referralTargetId']).toBe(REFERRAL_ULID);
  });
});

// ===========================================================================
// §4 — Error mapping + view
// ===========================================================================

describe('recordDecisionV1Handler §4 — error mapping + view', () => {
  it('maps 42501 to a tenant-blind 403', async () => {
    queryResponder = async () => {
      const err = new Error('deciding clinician must be the calling actor') as Error & {
        code: string;
      };
      err.code = '42501';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(recordDecisionV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Insufficient scope for this request.',
    });
  });

  it('mapServiceError maps 23503 (claim FK mismatch) to a tenant-blind 409', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(capturedMapServiceError).not.toBeNull();

    const { reply: mapReply, sent } = makeReply();
    const err = new Error('violates foreign key constraint') as Error & { code: string };
    err.code = '23503';
    expect(capturedMapServiceError!(err, mapReply, 'req_test')).toBe(true);
    expect(sent.code).toBe(409);
  });

  it('mapServiceError maps 23514 (lifecycle/decision-shape guard) to a tenant-blind 409', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await recordDecisionV1Handler(req, reply);

    const { reply: mapReply, sent } = makeReply();
    const err = new Error('not in a decision-capable state') as Error & { code: string };
    err.code = '23514';
    expect(capturedMapServiceError!(err, mapReply, 'req_test')).toBe(true);
    expect(sent.code).toBe(409);
  });

  it('returns 201 with { decision_id }', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await recordDecisionV1Handler(req, reply);
    expect(sent.code).toBe(201);
    expect(typeof (sent.body as Record<string, unknown>)['decision_id']).toBe('string');
  });
});
