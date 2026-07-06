/**
 * get-consult-v1.test.ts — unit tests for GET /v1/async-consults/:consult_id.
 *
 * Verifies: caller-class routing (patient → patient view under
 * async_consult_patient_reader; staff → staff view under
 * async_consult_staff_reader; NO cross-class access), tenant-blind 404 on
 * zero rows (I-025), 42501 → 403, 400 on malformed consult_id, and
 * 200 + row on success.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { getConsultV1Handler } from './get-consult-v1.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const wrapperCalls: string[] = [];
const recordedQueries: { sql: string; params: unknown[] | undefined }[] = [];

let queryResponder: (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount: number | null }> = async () => ({
  rows: [],
  rowCount: 0,
});

const mockTx = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    recordedQueries.push({ sql, params });
    return queryResponder(sql, params);
  }),
};

vi.mock('../../../../lib/db.js', () => ({
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    wrapperCalls.push('withTransaction:start');
    const result = await fn(mockTx);
    wrapperCalls.push('withTransaction:end');
    return result;
  }),
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
  requireActorContext: vi.fn((req: { actorContext?: unknown }) => {
    if (req.actorContext === undefined) {
      const e = new Error('Authentication is required.') as Error & { statusCode: number };
      e.statusCode = 401;
      throw e;
    }
    return req.actorContext;
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACTOR_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TG';
const CONSULT_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TD';

function makeReq(opts?: {
  role?: string | null;
  consultId?: string;
  actorNonce?: string;
}): FastifyRequest {
  const role = opts?.role === undefined ? 'patient' : opts.role;
  return {
    id: 'req_test',
    params: { consult_id: opts?.consultId ?? CONSULT_ULID },
    headers: {},
    actorContext:
      role === null
        ? undefined
        : {
            accountId: ACTOR_ULID,
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
  queryResponder = async () => ({ rows: [], rowCount: 0 });
});

// ===========================================================================
// §1 — Caller-class routing (NO cross-class access)
// ===========================================================================

describe('getConsultV1Handler §1 — caller-class routing', () => {
  it('patient caller reads the PATIENT view under async_consult_patient_reader', async () => {
    const req = makeReq({ role: 'patient' });
    const { reply } = makeReply();
    await getConsultV1Handler(req, reply);
    expect(wrapperCalls).toContain('withDbRole:async_consult_patient_reader');
    expect(recordedQueries[0]!.sql).toContain('async_consult_patient_summary_v');
    expect(recordedQueries[0]!.sql).not.toContain('staff_summary');
  });

  it.each(['clinician', 'tenant_admin', 'platform_admin'])(
    '%s caller reads the STAFF view under async_consult_staff_reader',
    async (role) => {
      const req = makeReq({ role });
      const { reply } = makeReply();
      await getConsultV1Handler(req, reply);
      expect(wrapperCalls).toContain('withDbRole:async_consult_staff_reader');
      expect(recordedQueries[0]!.sql).toContain('async_consult_staff_summary_v');
      expect(recordedQueries[0]!.sql).not.toContain('patient_summary');
    },
  );

  it('rejects 401 when unauthenticated', async () => {
    const req = makeReq({ role: null });
    const { reply } = makeReply();
    await expect(getConsultV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects 400 on a malformed consult_id', async () => {
    const req = makeReq({ consultId: 'nope' });
    const { reply, sent } = makeReply();
    await getConsultV1Handler(req, reply);
    expect(sent.code).toBe(400);
    expect(wrapperCalls).toEqual([]); // rejected before any DB work
  });
});

// ===========================================================================
// §2 — Tenant-blind 404 (I-025)
// ===========================================================================

describe('getConsultV1Handler §2 — tenant-blind 404', () => {
  it('returns 404 with a tenant-blind envelope on zero rows', async () => {
    queryResponder = async () => ({ rows: [], rowCount: 0 });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await getConsultV1Handler(req, reply);
    expect(sent.code).toBe(404);
    const body = sent.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe('internal.resource.not_found');
    expect(body.error.message).toBe('Consult not found.');
    expect(JSON.stringify(sent.body)).not.toContain('Telecheck-US');
  });
});

// ===========================================================================
// §3 — Success + 42501
// ===========================================================================

describe('getConsultV1Handler §3 — success + 42501', () => {
  it('returns 200 + the summary row (tenant_id never projected)', async () => {
    const row = {
      consult_id: CONSULT_ULID,
      patient_id: ACTOR_ULID,
      consult_type: 'general',
      created_at: '2026-07-06T00:00:00.000Z',
      current_state: 'under_review',
      decision_type: null,
      prescribing_count: '0',
      follow_up_message_count: '1',
      last_transition_at: '2026-07-06T01:00:00.000Z',
    };
    queryResponder = async () => ({ rows: [row], rowCount: 1 });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await getConsultV1Handler(req, reply);
    expect(sent.code).toBe(200);
    expect(sent.body).toEqual(row);
    expect(recordedQueries[0]!.sql).not.toContain('tenant_id');
    expect(recordedQueries[0]!.params).toEqual([CONSULT_ULID]);
  });

  it('maps 42501 to a tenant-blind 403', async () => {
    queryResponder = async () => {
      const err = new Error('permission denied') as Error & { code: string };
      err.code = '42501';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(getConsultV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Insufficient scope for this request.',
    });
  });
});
