/**
 * get-signal.test.ts — unit tests for the PR 7 first-real-handler
 * GET /v0/med-interaction/signals/:id.
 *
 * **Scope:** unit-mock the tx pattern at the `withTransaction` /
 * `withTenantContext` / `withActorContext` / `withDbRole` boundaries +
 * the underlying `tx.query` calls. Verifies:
 *
 *   §1 ULID validation gate at the HTTP boundary (400 on malformed :id).
 *   §2 Tenant context fail-closed (programming-error throw if absent —
 *      tenantContextPlugin would have already 400'd in real traffic).
 *   §3 Layer B authorization shape — non-production permissive,
 *      production fail-closed with no actorContext.
 *   §4 SECDEF function call shape — correct SQL, correct parameter
 *      binding, correct role elevation via withDbRole.
 *   §5 Tenant-blind 404 envelope on 0 rows.
 *   §6 200 + canonical view payload on 1 row (snake_case fields,
 *      ISO-8601 `as_of`).
 *
 * **Out of scope (covered by future integration tests):**
 *   - Real PostgreSQL execution of `get_interaction_signal_current_state`.
 *   - Cross-tenant isolation (RLS at the SECDEF function predicate level).
 *   - End-to-end Fastify route registration + buildApp + inject.
 *   These land in `tests/integration/med-interaction-get-signal-http.test.ts`
 *   alongside the PR 8 first write-handler when the integration-test
 *   harness wires SI-019 fixtures (seeded migration 047 entities + a
 *   refreshed MV).
 *
 * **Why unit-only at PR 7:** no other handler in the codebase ships a
 * unit-test sibling — all handler coverage is integration-test driven.
 * PR 7 is the FIRST handler using the Option B `withDbRole` composition,
 * so the unit harness pins the composition shape (which role is elevated,
 * which SQL is issued, which envelope is returned) at a layer that does
 * not require a live PostgreSQL with migrations 046-051 applied. The
 * matching integration test lands in PR 8 when (a) the test harness gains
 * a seeded interaction_signal_current_state_mv row + (b) the write
 * handlers' integration tests exercise the same Option B composition.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { getSignalHandler } from './get-signal.js';

// ---------------------------------------------------------------------------
// Mocks for the foundation helpers. We exercise the handler against an
// in-memory tx whose query method records every call; the four wrappers
// are mocked to just thread their callbacks through (preserving order
// for assertion). This mirrors `src/lib/with-db-role.test.ts`'s mockTx
// pattern but adds the surrounding tenant + actor context wrappers.
// ---------------------------------------------------------------------------

const recordedQueries: { sql: string; params: unknown[] | undefined }[] = [];
const wrapperCalls: string[] = [];

vi.mock('../../../../lib/db.js', () => ({
  // withTransaction(fn) — invoke fn with the mock tx.
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    wrapperCalls.push('withTransaction:start');
    const mockTx = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        recordedQueries.push({ sql, params });
        // Default behaviour: zero rows. Individual tests override via
        // queryResponder below.
        return queryResponder(sql, params);
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
  withDbRole: vi.fn(
    async (_tx: unknown, role: string, fn: () => Promise<unknown>) => {
      wrapperCalls.push(`withDbRole:${role}`);
      return fn();
    },
  ),
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

// Per-test responder for the SECDEF function call. Default returns zero rows.
let queryResponder: (
  sql: string,
  params?: unknown[],
) => { rows: unknown[]; rowCount: number | null } = () => ({
  rows: [],
  rowCount: 0,
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// Valid ULID (Crockford base32; uppercase; 26 chars).
const VALID_SIGNAL_ID = '01HFG6Z3Q8B7H9P2W4V5K6N7T9';

function makeReq(opts?: {
  id?: string;
  hasActor?: boolean;
  actorNonce?: string | undefined;
}): FastifyRequest {
  const id = opts?.id ?? VALID_SIGNAL_ID;
  const hasActor = opts?.hasActor ?? true;
  const actorNonce = opts?.actorNonce;
  const req = {
    params: { id },
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
    actorNonce,
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
        forbidden: (msg?: string) => {
          const e = new Error(msg ?? 'Forbidden') as Error & {
            statusCode: number;
          };
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
  recordedQueries.length = 0;
  wrapperCalls.length = 0;
  queryResponder = () => ({ rows: [], rowCount: 0 });
  delete process.env['NODE_ENV'];
});

afterEach(() => {
  delete process.env['NODE_ENV'];
});

// ===========================================================================
// §1 — ULID validation gate
// ===========================================================================

describe('getSignalHandler §1 — ULID validation', () => {
  it('rejects a missing :id with 400', async () => {
    const req = makeReq({ id: undefined as unknown as string });
    // Override params to have no id.
    (req as unknown as { params: Record<string, unknown> }).params = {};
    const { reply } = makeReply();
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('`id` is required'),
    });
  });

  it('rejects an empty :id with 400', async () => {
    const req = makeReq({ id: '' });
    const { reply } = makeReply();
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects a non-26-char :id with 400', async () => {
    const req = makeReq({ id: '01HFG6Z3Q8B7H9P2W4V5K6N7' }); // 24 chars
    const { reply } = makeReply();
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('Crockford-base32 ULID'),
    });
  });

  it('rejects an id with forbidden Crockford chars (I, L, O, U) with 400', async () => {
    const req = makeReq({ id: '01HFG6Z3Q8B7H9P2W4V5K6N7TI' }); // 26 chars but ends in I
    const { reply } = makeReply();
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects a lowercase id with 400 (canonical ULIDs are uppercase)', async () => {
    const req = makeReq({ id: '01hfg6z3q8b7h9p2w4v5k6n7t9' });
    const { reply } = makeReply();
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('accepts a valid 26-char Crockford ULID and proceeds past validation', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    // Default queryResponder returns zero rows → 404. The fact that we
    // reach the DB call at all proves validation passed.
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(recordedQueries).toHaveLength(1);
  });
});

// ===========================================================================
// §2 — Layer B authorization shape (deferred-permissive at PR 7)
// ===========================================================================

describe('getSignalHandler §2 — Layer B authorization', () => {
  it('accepts an authenticated actorContext in any environment', async () => {
    process.env['NODE_ENV'] = 'production';
    const req = makeReq({ hasActor: true });
    const { reply } = makeReply();
    // 404 on default zero-rows responder; the fact that we proceed past
    // assertLayerBAuthorized is what we are asserting here.
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('rejects 401 in production when actorContext is undefined', async () => {
    process.env['NODE_ENV'] = 'production';
    const req = makeReq({ hasActor: false });
    const { reply } = makeReply();
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 401,
      message: expect.stringContaining('Actor identity'),
    });
  });

  it('permits anonymous reads in non-production environments (test ergonomics)', async () => {
    process.env['NODE_ENV'] = 'test';
    const req = makeReq({ hasActor: false });
    const { reply } = makeReply();
    // 404 on default zero-rows responder; the fact that we did NOT
    // throw 401 is the assertion (anonymous reads are permitted under
    // NODE_ENV=test for fixtureless smoke testing).
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

// ===========================================================================
// §3 — Canonical composition + SECDEF call shape
// ===========================================================================

describe('getSignalHandler §3 — canonical composition + SECDEF call', () => {
  it('threads withTransaction → withTenantContext → withDbRole(medication_interaction_signal_viewer) before issuing the SECDEF SELECT', async () => {
    queryResponder = () => ({
      rows: [
        {
          signal_id: VALID_SIGNAL_ID,
          current_state: 'emitted',
          as_of: new Date('2026-05-23T12:00:00Z'),
          transition_reason: 'engine_evaluation',
        },
      ],
      rowCount: 1,
    });
    const req = makeReq();
    const { reply } = makeReply();
    await getSignalHandler(req, reply);

    // Wrapper order: withTransaction:start → withTenantContext:Telecheck-US
    // → withDbRole:medication_interaction_signal_viewer → withTransaction:end.
    // withActorContext is NOT in the chain because actorNonce is undefined
    // in this test (the handler skips withActorContext when no nonce is
    // bound — defensive composition for the read path).
    expect(wrapperCalls).toEqual([
      'withTransaction:start',
      'withTenantContext:Telecheck-US',
      'withDbRole:medication_interaction_signal_viewer',
      'withTransaction:end',
    ]);
  });

  it('issues exactly the SECDEF SELECT with the signalId as $1', async () => {
    queryResponder = () => ({
      rows: [
        {
          signal_id: VALID_SIGNAL_ID,
          current_state: 'emitted',
          as_of: new Date('2026-05-23T12:00:00Z'),
          transition_reason: 'engine_evaluation',
        },
      ],
      rowCount: 1,
    });
    const req = makeReq();
    const { reply } = makeReply();
    await getSignalHandler(req, reply);

    expect(recordedQueries).toHaveLength(1);
    expect(recordedQueries[0]!.sql).toBe(
      'SELECT signal_id, current_state, as_of, transition_reason FROM get_interaction_signal_current_state($1)',
    );
    expect(recordedQueries[0]!.params).toEqual([VALID_SIGNAL_ID]);
  });

  it('threads withActorContext into the chain when actorNonce is bound', async () => {
    queryResponder = () => ({ rows: [], rowCount: 0 });
    const req = makeReq({ actorNonce: 'nonce-uuid-123' });
    const { reply } = makeReply();
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 404,
    });
    // With a nonce, withActorContext is interposed BEFORE withDbRole per
    // the file-level composition order. (Order test confirms the placement.)
    expect(wrapperCalls).toEqual([
      'withTransaction:start',
      'withTenantContext:Telecheck-US',
      'withActorContext:nonce-uuid-123',
      'withDbRole:medication_interaction_signal_viewer',
      'withTransaction:end',
    ]);
  });
});

// ===========================================================================
// §4 — Tenant-blind 404 on zero rows
// ===========================================================================

describe('getSignalHandler §4 — tenant-blind 404 (I-025)', () => {
  it('throws 404 with a tenant-blind message when the SECDEF function returns zero rows', async () => {
    queryResponder = () => ({ rows: [], rowCount: 0 });
    const req = makeReq();
    const { reply } = makeReply();
    await expect(getSignalHandler(req, reply)).rejects.toMatchObject({
      statusCode: 404,
      message: 'Interaction signal not found.',
    });
    // Tenant-blind: the message MUST NOT differentiate "doesn't exist
    // anywhere" from "exists in another tenant." Both flow through the
    // same envelope.
  });
});

// ===========================================================================
// §5 — 200 + canonical view payload on hit
// ===========================================================================

describe('getSignalHandler §5 — 200 + view payload', () => {
  it('returns 200 with snake_case fields + ISO-8601 as_of when the function returns one row', async () => {
    const asOf = new Date('2026-05-23T12:00:00.000Z');
    queryResponder = () => ({
      rows: [
        {
          signal_id: VALID_SIGNAL_ID,
          current_state: 'active',
          as_of: asOf,
          transition_reason: 'engine_evaluation',
        },
      ],
      rowCount: 1,
    });
    const req = makeReq();
    const { reply, sent } = makeReply();
    await getSignalHandler(req, reply);

    expect(sent.code).toBe(200);
    expect(sent.body).toEqual({
      signal_id: VALID_SIGNAL_ID,
      current_state: 'active',
      as_of: '2026-05-23T12:00:00.000Z',
      transition_reason: 'engine_evaluation',
    });
  });
});

// ===========================================================================
// §6 — wrapper / SECDEF error mapping (42501 → tenant-blind 403 per I-025)
//
// PR 7.1 hotfix coverage backfill 2026-05-23: mirrors sibling Admin Sprint 2
// PR 1 §4a + §4b coverage (`get-crisis-operational-health.test.ts`). The
// hotfix at commit 7112411 wrapped the withDbRole call in a try/catch that
// maps PG SQLSTATE 42501 ("insufficient_privilege") to a Fastify forbidden
// envelope with a tenant-blind message. PostgreSQL can raise 42501 in TWO
// places (per get-signal.ts §5 docstring):
//   (1) Inside withDbRole's SET LOCAL ROLE pre-callback step.
//   (2) Inside the SECDEF function's body or RLS evaluation.
// The catch is OUTSIDE withDbRole so both paths are covered. Without this
// mapping, a 42501 with a tenant-id-leaky message would escape past the
// inner SELECT and reach the global envelope as a 500 with the raw PG
// message exposed in non-prod — violating I-025.
//
// Non-42501 errors MUST propagate UNCHANGED so they (a) flow through the
// global envelope's 5xx default-message + rollback path and (b) preserve
// the original `.code` for downstream observability. The identity-preserve
// assertion catches regressions that would re-wrap the error (losing .code
// or attaching a 4xx statusCode the global envelope would then treat as
// client-facing).
// ===========================================================================

describe('getSignalHandler §6 — wrapper / SECDEF error mapping (42501 → 403)', () => {
  it('§6a wrapper-side 42501 (tenant-scope mismatch / missing actor) maps to 403 tenant-blind; raw PG message + tenant IDs are NOT leaked', async () => {
    // Simulate wrapper LAYER C / SECDEF raise: tenant scope mismatch with
    // a message containing tenant identifiers + the raw '42501' / 'tenant
    // scope mismatch' strings that I-025 forbids leaking to the client.
    queryResponder = () => {
      const wrapperError = Object.assign(
        new Error(
          'get_interaction_signal_current_state: tenant scope mismatch — actor tenant Telecheck-US does not match wrapper p_tenant_id Telecheck-Ghana; cross-tenant read rejected',
        ),
        { code: '42501' },
      );
      throw wrapperError;
    };

    const req = makeReq({ actorNonce: 'fake-nonce' });
    const { reply } = makeReply();

    let thrown: unknown;
    try {
      await getSignalHandler(req, reply);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    // Asserted as Fastify forbidden — statusCode 403, tenant-blind message.
    const errObj = thrown as { statusCode?: number; message?: string };
    expect(errObj.statusCode).toBe(403);
    // Critical I-025 invariant: message must NOT contain tenant identifiers
    // or raw SQLSTATE / wrapper details from the upstream PG error.
    expect(errObj.message ?? '').not.toContain('Telecheck-US');
    expect(errObj.message ?? '').not.toContain('Telecheck-Ghana');
    expect(errObj.message ?? '').not.toContain('tenant scope mismatch');
    expect(errObj.message ?? '').not.toContain('42501');
    // The generic message can mention "scope" but no tenant ids.
    expect(errObj.message ?? '').toMatch(/scope|forbidden|insufficient/i);
  });

  it('§6b non-42501 PG errors propagate UNCHANGED — identity-preserved, code intact, no 4xx statusCode added', async () => {
    // Simulate a non-42501 PG error (admin_shutdown) — the handler must
    // NOT re-wrap or otherwise mutate the error; it must propagate to the
    // global envelope unchanged so the 5xx default-message + rollback +
    // tenant-blind 500 replacement path runs as designed.
    const otherPgError = Object.assign(
      new Error('connection terminated unexpectedly'),
      { code: '57P01' }, // admin_shutdown
    );
    queryResponder = () => {
      throw otherPgError;
    };

    const req = makeReq({ actorNonce: 'fake-nonce' });
    const { reply } = makeReply();

    let thrown: unknown;
    try {
      await getSignalHandler(req, reply);
    } catch (e) {
      thrown = e;
    }

    // Identity-preservation + code intact: a regression that re-wrapped
    // the error (losing .code, adding a 4xx statusCode that the global
    // envelope would then treat as client-facing) would have passed a
    // looser toThrow(/connection terminated/) assertion. The identity
    // check is what catches that class of regression.
    expect(thrown).toBe(otherPgError);
    expect((thrown as { code?: string }).code).toBe('57P01');
    // Must NOT have a 4xx statusCode added (would defeat the 5xx rollback
    // + tenant-blind 500 default-message replacement in the global envelope).
    expect((thrown as { statusCode?: number }).statusCode).toBeUndefined();
  });
});
