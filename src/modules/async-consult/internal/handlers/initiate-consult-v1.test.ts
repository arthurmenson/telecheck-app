/**
 * initiate-consult-v1.test.ts — unit tests for POST /v1/async-consults.
 *
 * Scope: unit-mock the composition helpers + audit emitter + tx.query
 * (med-interaction create-evaluation.test.ts style). Verifies:
 *   §1 guard precedence — tenant ctx → Layer B (401/403/delegate 403) →
 *      body validation 400
 *   §2 canonical composition order (withIdempotentExecution →
 *      withTenantContext → [withActorContext] →
 *      withDbRole('async_consult_patient_initiator'))
 *   §3 wrapper call shape (15 params; patient anchor from actor identity)
 *      + same-tx Cat C async_consult.initiated audit
 *   §4 42501 → tenant-blind 403 (I-025)
 *   §5 201 + { consult_id } view
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { initiateConsultV1Handler } from './initiate-consult-v1.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
    kmsKeyAlias: 'alias/telecheck-us-data-key',
    consumerDba: 'Heros Health',
  })),
}));

// Faithful auth-context mock: role gate + delegate passthrough mirror the
// real requirePatientActorContext semantics (401 unauthenticated / 403
// role mismatch) without importing the real module graph.
vi.mock('../../../../lib/auth-context.js', () => ({
  requirePatientActorContext: vi.fn((req: { actorContext?: { role?: string } }) => {
    const actor = req.actorContext;
    if (actor === undefined) {
      const e = new Error('Authentication is required.') as Error & { statusCode: number };
      e.statusCode = 401;
      throw e;
    }
    if (actor.role !== 'patient') {
      const e = new Error('This endpoint requires role=patient.') as Error & {
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
  emitAsyncConsultInitiatedAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitAsyncConsultInitiatedAudit', args });
    return { audit_id: 'aud_test' };
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATIENT_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TB';
const PAYMENT_INTENT_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TC';

function makeValidBody(): Record<string, unknown> {
  return {
    consult_type: 'general',
    initiation_source: 'care_tab',
    consult_fee_cents: 4900,
    currency: 'USD',
    payment_provider: 'stripe',
    payment_intent_id: PAYMENT_INTENT_ULID,
    expected_turnaround_at: '2026-07-08T12:00:00.000Z',
  };
}

function makeReq(opts?: {
  body?: unknown;
  actor?: { role: string; delegateId?: string | null } | null;
  actorNonce?: string;
}): FastifyRequest {
  const actorSpec = opts?.actor === undefined ? { role: 'patient', delegateId: null } : opts.actor;
  return {
    id: 'req_test',
    body: opts?.body ?? makeValidBody(),
    headers: {},
    actorContext:
      actorSpec === null
        ? undefined
        : {
            accountId: PATIENT_ULID,
            sessionId: 'sess_test',
            tenantId: 'Telecheck-US',
            role: actorSpec.role,
            countryOfCare: 'US',
            delegateId: actorSpec.delegateId ?? null,
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
  queryResponder = async () => ({ rows: [], rowCount: 1 });
});

// ===========================================================================
// §1 — Guard precedence
// ===========================================================================

describe('initiateConsultV1Handler §1 — guard precedence', () => {
  it('rejects 401 when unauthenticated (before body validation)', async () => {
    const req = makeReq({ actor: null, body: { nonsense: true } });
    const { reply } = makeReply();
    await expect(initiateConsultV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 401 });
    expect(wrapperCalls).toEqual([]);
  });

  it('rejects 403 when the actor is a clinician (patient-only endpoint)', async () => {
    const req = makeReq({ actor: { role: 'clinician' } });
    const { reply } = makeReply();
    await expect(initiateConsultV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects 403 when the patient actor carries delegate context (documented deferral)', async () => {
    const req = makeReq({ actor: { role: 'patient', delegateId: PAYMENT_INTENT_ULID } });
    const { reply } = makeReply();
    await expect(initiateConsultV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Delegate-initiated consults are not yet supported on this endpoint.',
    });
  });

  it('rejects 400 on an invalid initiation_source enum value', async () => {
    const req = makeReq({ body: { ...makeValidBody(), initiation_source: 'walk_in' } });
    const { reply, sent } = makeReply();
    await initiateConsultV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 when program_id is missing for consult_type=program_pathway', async () => {
    const req = makeReq({ body: { ...makeValidBody(), consult_type: 'program_pathway' } });
    const { reply, sent } = makeReply();
    await initiateConsultV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 when program_id is supplied for consult_type=general', async () => {
    const req = makeReq({ body: { ...makeValidBody(), program_id: 'glp1-us' } });
    const { reply, sent } = makeReply();
    await initiateConsultV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 on a negative consult_fee_cents', async () => {
    const req = makeReq({ body: { ...makeValidBody(), consult_fee_cents: -1 } });
    const { reply, sent } = makeReply();
    await initiateConsultV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 on a malformed expected_turnaround_at', async () => {
    const req = makeReq({ body: { ...makeValidBody(), expected_turnaround_at: 'tomorrow' } });
    const { reply, sent } = makeReply();
    await initiateConsultV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });
});

// ===========================================================================
// §2 — Composition order
// ===========================================================================

describe('initiateConsultV1Handler §2 — canonical composition', () => {
  it('threads withIdempotentExecution → withTenantContext → withDbRole(async_consult_patient_initiator)', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await initiateConsultV1Handler(req, reply);
    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withDbRole:async_consult_patient_initiator',
      'withIdempotentExecution:end',
    ]);
  });

  it('interposes withActorContext when actorNonce is bound', async () => {
    const req = makeReq({ actorNonce: 'nonce-uuid-123' });
    const { reply } = makeReply();
    await initiateConsultV1Handler(req, reply);
    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-uuid-123',
      'withDbRole:async_consult_patient_initiator',
      'withIdempotentExecution:end',
    ]);
  });
});

// ===========================================================================
// §3 — Wrapper call + audit emission
// ===========================================================================

describe('initiateConsultV1Handler §3 — wrapper call + same-tx audit', () => {
  it('calls record_consult_initiation with 15 params; patient anchor from actor identity, delegate NULL', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await initiateConsultV1Handler(req, reply);

    expect(recordedQueries).toHaveLength(1);
    const { sql, params } = recordedQueries[0]!;
    expect(sql).toContain('record_consult_initiation');
    expect(params).toHaveLength(15);
    expect(params?.[1]).toBe('Telecheck-US'); // p_tenant_id
    expect(params?.[2]).toBe(PATIENT_ULID); // p_patient_id — trust anchor
    expect(params?.[3]).toBeNull(); // p_delegate_id — patient-principal-only
    expect(params?.[14]).toBe('patient'); // p_actor_role
  });

  it('emits EXACTLY ONE audit event: async_consult.initiated (Cat C emitter)', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await initiateConsultV1Handler(req, reply);

    expect(auditCalls.map((c) => c.fn)).toEqual(['emitAsyncConsultInitiatedAudit']);
    const args = auditCalls[0]!.args as Record<string, unknown>;
    expect(args['tenantId']).toBe('Telecheck-US');
    expect(args['patientId']).toBe(PATIENT_ULID);
    expect(args['actorTenantId']).toBe('Telecheck-US');
    expect(args['initiationSource']).toBe('care_tab');
  });
});

// ===========================================================================
// §4 — 42501 → tenant-blind 403
// ===========================================================================

describe('initiateConsultV1Handler §4 — 42501 → tenant-blind 403', () => {
  it('maps a wrapper-raised 42501 to a tenant-blind 403', async () => {
    queryResponder = async () => {
      const err = new Error(
        'record_consult_initiation: tenant scope mismatch for tenant Telecheck-US',
      ) as Error & { code: string };
      err.code = '42501';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(initiateConsultV1Handler(req, reply)).rejects.toMatchObject({
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
    await expect(initiateConsultV1Handler(req, reply)).rejects.toMatchObject({ code: '08006' });
  });
});

// ===========================================================================
// §5 — Success view
// ===========================================================================

describe('initiateConsultV1Handler §5 — 201 + view payload', () => {
  it('returns 201 with { consult_id } and no tenant_id in the view', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await initiateConsultV1Handler(req, reply);
    expect(sent.code).toBe(201);
    const view = sent.body as Record<string, unknown>;
    expect(typeof view['consult_id']).toBe('string');
    expect(view['tenant_id']).toBeUndefined();
  });
});
