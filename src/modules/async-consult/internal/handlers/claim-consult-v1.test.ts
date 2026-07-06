/**
 * claim-consult-v1.test.ts — unit tests for
 * POST /v1/async-consults/:consult_id/claim.
 *
 * Verifies: clinician-only gate, canonical composition under
 * withDbRole('async_consult_clinician_reviewer'), 8-param wrapper call
 * with actor-bound clinician id, the auto-release Cat B path (wrapper
 * returned a released prior-claim id → Cat B claim_expired_auto_released
 * emitted BEFORE Cat C case_claimed), the always-on Cat C emission,
 * error mapping (55006 → 409 claim_already_held; P0002 → 404;
 * 42501 → 403), and the 201 view carrying auto_released_claim_id.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { claimConsultV1Handler } from './claim-consult-v1.js';

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
  rows: [{ released_claim_id: null }],
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
  emitAsyncConsultCaseClaimedAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitAsyncConsultCaseClaimedAudit', args });
    return { audit_id: 'aud_c' };
  }),
  emitAsyncConsultClaimExpiredAutoReleasedAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push({ fn: 'emitAsyncConsultClaimExpiredAutoReleasedAudit', args });
    return { audit_id: 'aud_b' };
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLINICIAN_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TG';
const CONSULT_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TD';
const RELEASED_CLAIM_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TK';

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
    body: opts?.body ?? {},
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
  queryResponder = async () => ({ rows: [{ released_claim_id: null }], rowCount: 1 });
});

// ===========================================================================
// §1 — Guards
// ===========================================================================

describe('claimConsultV1Handler §1 — guards', () => {
  it('rejects 401 when unauthenticated', async () => {
    const req = makeReq({ role: null });
    const { reply } = makeReply();
    await expect(claimConsultV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects 403 for a patient caller', async () => {
    const req = makeReq({ role: 'patient' });
    const { reply } = makeReply();
    await expect(claimConsultV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects 400 on a malformed consult_id', async () => {
    const req = makeReq({ consultId: 'nope' });
    const { reply, sent } = makeReply();
    await claimConsultV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 on a past claim_expires_at override', async () => {
    const req = makeReq({ body: { claim_expires_at: '2020-01-01T00:00:00.000Z' } });
    const { reply, sent } = makeReply();
    await claimConsultV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });
});

// ===========================================================================
// §2 — Composition + wrapper call
// ===========================================================================

describe('claimConsultV1Handler §2 — composition + wrapper', () => {
  it('threads the canonical composition under withDbRole(async_consult_clinician_reviewer)', async () => {
    const req = makeReq({ actorNonce: 'nonce-2' });
    const { reply } = makeReply();
    await claimConsultV1Handler(req, reply);
    expect(wrapperCalls).toEqual([
      'withIdempotentExecution:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-2',
      'withDbRole:async_consult_clinician_reviewer',
      'withIdempotentExecution:end',
    ]);
  });

  it('calls claim_consult_for_review with 8 params; clinician id bound to the actor', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await claimConsultV1Handler(req, reply);
    expect(recordedQueries).toHaveLength(1);
    const { sql, params } = recordedQueries[0]!;
    expect(sql).toContain('claim_consult_for_review');
    expect(params).toHaveLength(8);
    expect(params?.[1]).toBe('Telecheck-US');
    expect(params?.[2]).toBe(CONSULT_ULID);
    expect(params?.[3]).toBe(CLINICIAN_ULID); // claiming clinician == actor
    expect(params?.[7]).toBe('clinician'); // p_actor_role
  });
});

// ===========================================================================
// §3 — Audit emission (Cat C always; Cat B on auto-release, FIRST)
// ===========================================================================

describe('claimConsultV1Handler §3 — audit emission', () => {
  it('emits ONLY async_consult.case_claimed when no prior claim was auto-released', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await claimConsultV1Handler(req, reply);
    expect(auditCalls.map((c) => c.fn)).toEqual(['emitAsyncConsultCaseClaimedAudit']);
    expect(sent.code).toBe(201);
    expect((sent.body as { auto_released_claim_id: string | null }).auto_released_claim_id).toBe(
      null,
    );
  });

  it('emits Cat B claim_expired_auto_released BEFORE Cat C case_claimed on the auto-release path', async () => {
    queryResponder = async () => ({
      rows: [{ released_claim_id: RELEASED_CLAIM_ULID }],
      rowCount: 1,
    });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await claimConsultV1Handler(req, reply);

    expect(auditCalls.map((c) => c.fn)).toEqual([
      'emitAsyncConsultClaimExpiredAutoReleasedAudit',
      'emitAsyncConsultCaseClaimedAudit',
    ]);
    const catB = auditCalls[0]!.args as Record<string, unknown>;
    expect(catB['releasedClaimId']).toBe(RELEASED_CLAIM_ULID);
    expect(catB['consultId']).toBe(CONSULT_ULID);
    expect(sent.code).toBe(201);
    expect((sent.body as { auto_released_claim_id: string | null }).auto_released_claim_id).toBe(
      RELEASED_CLAIM_ULID,
    );
  });
});

// ===========================================================================
// §4 — Error mapping
// ===========================================================================

describe('claimConsultV1Handler §4 — error mapping', () => {
  it('maps 42501 to a tenant-blind 403', async () => {
    queryResponder = async () => {
      const err = new Error('claiming clinician must be the calling actor') as Error & {
        code: string;
      };
      err.code = '42501';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(claimConsultV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Insufficient scope for this request.',
    });
  });

  it('mapServiceError maps 55006 to 409 with reason claim_already_held', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await claimConsultV1Handler(req, reply);
    expect(capturedMapServiceError).not.toBeNull();

    const { reply: mapReply, sent } = makeReply();
    const err = new Error('claim_already_held') as Error & { code: string };
    err.code = '55006';
    expect(capturedMapServiceError!(err, mapReply, 'req_test')).toBe(true);
    expect(sent.code).toBe(409);
    const body = sent.body as { reason: string; error: { code: string } };
    expect(body.reason).toBe('claim_already_held');
    expect(body.error.code).toBe('internal.resource.conflict');
  });

  it('mapServiceError maps P0002 (no_data_found) to a tenant-blind 404', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await claimConsultV1Handler(req, reply);

    const { reply: mapReply, sent } = makeReply();
    const err = new Error('consult not found') as Error & { code: string };
    err.code = 'P0002';
    expect(capturedMapServiceError!(err, mapReply, 'req_test')).toBe(true);
    expect(sent.code).toBe(404);
    const body = sent.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal.resource.not_found');
    expect(body.error.message).toBe('Consult not found.');
  });

  it('mapServiceError leaves unknown SQLSTATEs unmapped', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await claimConsultV1Handler(req, reply);
    const { reply: mapReply } = makeReply();
    const err = new Error('serialization failure') as Error & { code: string };
    err.code = '40001';
    expect(capturedMapServiceError!(err, mapReply, 'req_test')).toBe(false);
  });
});
