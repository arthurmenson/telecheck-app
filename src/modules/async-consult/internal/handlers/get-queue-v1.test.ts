/**
 * get-queue-v1.test.ts — unit tests for GET /v1/async-consults/queue.
 *
 * Verifies: staff-only Layer B gate (patient 403; unauthenticated 401),
 * pagination validation + caps, canonical read composition
 * (withTransaction → withTenantContext → [withActorContext] →
 * withDbRole('async_consult_staff_reader')), tenant_id never projected,
 * 42501 → tenant-blind 403, and 200 + rows payload.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { getQueueV1Handler } from './get-queue-v1.js';

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

vi.mock('../../../../lib/auth-context.js', () => {
  // Declared inside the factory — vi.mock is hoisted above top-level
  // declarations, so the class cannot live at module scope.
  class MockUnauthorizedRoleError extends Error {
    readonly statusCode = 403;
    constructor() {
      super('Insufficient role for this endpoint.');
    }
  }
  return {
    requireActorContext: vi.fn((req: { actorContext?: unknown }) => {
      if (req.actorContext === undefined) {
        const e = new Error('Authentication is required.') as Error & { statusCode: number };
        e.statusCode = 401;
        throw e;
      }
      return req.actorContext;
    }),
    UnauthorizedRoleError: MockUnauthorizedRoleError,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CLINICIAN_ULID = '01HFG6Z3Q8B7H9P2W4V5K6N7TG';

function makeReq(opts?: {
  role?: string | null;
  query?: Record<string, string>;
  actorNonce?: string;
}): FastifyRequest {
  const role = opts?.role === undefined ? 'clinician' : opts.role;
  return {
    id: 'req_test',
    query: opts?.query ?? {},
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
  queryResponder = async () => ({ rows: [], rowCount: 0 });
});

// ===========================================================================
// §1 — Layer B caller-class gate
// ===========================================================================

describe('getQueueV1Handler §1 — staff-only gate', () => {
  it('rejects 401 when unauthenticated', async () => {
    const req = makeReq({ role: null });
    const { reply } = makeReply();
    await expect(getQueueV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects 403 for a patient caller (no cross-class queue access)', async () => {
    const req = makeReq({ role: 'patient' });
    const { reply } = makeReply();
    await expect(getQueueV1Handler(req, reply)).rejects.toMatchObject({ statusCode: 403 });
    expect(wrapperCalls).toEqual([]); // rejected BEFORE any DB work
  });

  it.each(['clinician', 'tenant_admin', 'platform_admin'])('accepts role=%s', async (role) => {
    const req = makeReq({ role });
    const { reply, sent } = makeReply();
    await getQueueV1Handler(req, reply);
    expect(sent.code).toBe(200);
  });
});

// ===========================================================================
// §2 — Pagination validation
// ===========================================================================

describe('getQueueV1Handler §2 — pagination', () => {
  it('rejects 400 when limit exceeds the cap (100)', async () => {
    const req = makeReq({ query: { limit: '101' } });
    const { reply, sent } = makeReply();
    await getQueueV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 on a negative offset', async () => {
    const req = makeReq({ query: { offset: '-1' } });
    const { reply, sent } = makeReply();
    await getQueueV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('rejects 400 on a non-integer limit', async () => {
    const req = makeReq({ query: { limit: 'ten' } });
    const { reply, sent } = makeReply();
    await getQueueV1Handler(req, reply);
    expect(sent.code).toBe(400);
  });

  it('defaults to limit=25 offset=0 and binds them as SELECT params', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await getQueueV1Handler(req, reply);
    expect(sent.code).toBe(200);
    expect(recordedQueries[0]!.params).toEqual([25, 0]);
    expect((sent.body as { limit: number; offset: number }).limit).toBe(25);
  });
});

// ===========================================================================
// §3 — Composition + projection
// ===========================================================================

describe('getQueueV1Handler §3 — composition + projection', () => {
  it('threads withTransaction → withTenantContext → withDbRole(async_consult_staff_reader)', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await getQueueV1Handler(req, reply);
    expect(wrapperCalls).toEqual([
      'withTransaction:start',
      'withTenantContext:Telecheck-US',
      'withDbRole:async_consult_staff_reader',
      'withTransaction:end',
    ]);
  });

  it('interposes withActorContext when actorNonce is bound', async () => {
    const req = makeReq({ actorNonce: 'nonce-9' });
    const { reply } = makeReply();
    await getQueueV1Handler(req, reply);
    expect(wrapperCalls).toEqual([
      'withTransaction:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-9',
      'withDbRole:async_consult_staff_reader',
      'withTransaction:end',
    ]);
  });

  it('reads from async_consult_staff_summary_v and does NOT project tenant_id', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await getQueueV1Handler(req, reply);
    const sql = recordedQueries[0]!.sql;
    expect(sql).toContain('async_consult_staff_summary_v');
    expect(sql).not.toContain('tenant_id');
  });

  it('returns 200 + rows verbatim from the view', async () => {
    const row = {
      consult_id: '01HFG6Z3Q8B7H9P2W4V5K6N7TH',
      patient_id: '01HFG6Z3Q8B7H9P2W4V5K6N7TJ',
      consult_type: 'general',
      created_at: '2026-07-06T00:00:00.000Z',
      current_state: 'queued',
      decision_type: null,
      prescribing_count: '0',
      follow_up_message_count: '0',
      last_transition_at: '2026-07-06T00:05:00.000Z',
    };
    queryResponder = async () => ({ rows: [row], rowCount: 1 });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await getQueueV1Handler(req, reply);
    expect(sent.code).toBe(200);
    expect((sent.body as { rows: unknown[] }).rows).toEqual([row]);
  });
});

// ===========================================================================
// §4 — 42501 → tenant-blind 403
// ===========================================================================

describe('getQueueV1Handler §4 — 42501 → 403', () => {
  it('maps a reader-role 42501 to a tenant-blind 403', async () => {
    queryResponder = async () => {
      const err = new Error('permission denied for view') as Error & { code: string };
      err.code = '42501';
      throw err;
    };
    const req = makeReq();
    const { reply } = makeReply();
    await expect(getQueueV1Handler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: 'Insufficient scope for this request.',
    });
  });
});
