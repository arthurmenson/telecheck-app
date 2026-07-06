/**
 * post-crisis-sweep.test.ts — unit tests for the Sprint 2 PR 6 sweep
 * handler (operator-invoked no-acknowledgement sweep).
 *
 * Covers the handler's composition discipline + I-019 / I-025 / I-003
 * platform-floor invariants at unit scope (no real DB):
 *
 *   §1 happy path: full composition; `completed_escalated` outcome
 *      fires Cat A audit in same tx; 200 + view returned.
 *   §2 tenant guard fires before tx open.
 *   §3 admin role-gate fires before tx open.
 *   §4 path-param validation: missing / non-UUID :id → 400 before tx.
 *   §5 body validation matrix: missing/non-string scheduler_id,
 *      missing/non-string fencing_token, missing/non-int
 *      target_obligation_generation, claim_ttl_seconds wrong-type →
 *      400 before tx.
 *   §6 staff-view 0-row pre-fetch → 404 tenant-blind; wrapper NOT
 *      invoked; audit NOT emitted.
 *   §7 42501 mapping for BOTH pre-fetch (staff-reader) AND wrapper
 *      (sweep_scheduler) paths — both yield 403 via httpErrors.
 *   §8 SQLSTATE mapping at outer catch:
 *      - 02000 → 404 tenant-blind
 *      - 23514 → 404 tenant-blind
 *      - 40001 → 409 (lease conflict)
 *      - 23505 → 409 (duplicate run)
 *      - 22023 → 400 (claim_ttl_seconds out of range)
 *   §9 outcome non-`completed_escalated` (`already_completed`,
 *      `completed_no_op`, `claimed_new`, `claimed_takeover`) → 200 but
 *      audit NOT emitted (I-003 hash-chain discipline).
 *   §10 audit-emit failure on `completed_escalated` → propagates (I-003
 *      bare-suppression forbidden); tx rolls back atomically.
 *   §11 actorNonce undefined → skips withActorContext; wrapper still
 *      invoked (will fail with 42501 at the wrapper LAYER B guard in
 *      real PG, simulated here by mock).
 *   §12 fencing_token is observability-echo only: NOT passed to wrapper
 *      SQL, IS carried into audit detail + response view.
 *
 * Mocking strategy: vi.mock the lib/* helpers + the audit emitter so
 * the handler's composition is observable + assertable without standing
 * up a real DB. Mirrors the canonical PR 1 / PR 4 unit-test pattern.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/auth-context.js', () => ({
  requireAdminActorContext: vi.fn(),
  resolveActorTenantIdForAudit: vi.fn(),
}));
vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(),
}));
vi.mock('../../../../lib/db.js', () => ({
  withTransaction: vi.fn(),
}));
vi.mock('../../../../lib/rls.js', () => ({
  withTenantContext: vi.fn(),
}));
vi.mock('../../../../lib/actor-context-binding.js', () => ({
  withActorContext: vi.fn(),
}));
vi.mock('../../../../lib/with-db-role.js', () => ({
  withDbRole: vi.fn(),
}));
vi.mock('../../audit.js', () => ({
  emitCrisisNoAcknowledgementEscalationAudit: vi.fn(),
}));

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import {
  requireAdminActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withTransaction } from '../../../../lib/db.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitCrisisNoAcknowledgementEscalationAudit } from '../../audit.js';

import { postCrisisSweepHandler } from './post-crisis-sweep.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_TENANT_CTX = {
  tenantId: 'Telecheck-US',
  displayName: 'Telecheck-US',
  countryOfCare: 'US' as const,
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

const FAKE_ADMIN_ACTOR = {
  accountId: '00000000-0000-4000-8000-00000000aaaa',
  sessionId: 'sess-fake',
  tenantId: 'Telecheck-US',
  role: 'tenant_admin' as const,
  countryOfCare: 'US' as const,
  delegateId: null,
  adminTenantBinding: 'Telecheck-US',
  adminHomeTenantId: 'Telecheck-US',
};

const VALID_UUID = '11111111-2222-4333-8444-555555555555';
const VALID_PATIENT_UUID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const VALID_SWEEP_UUID = '77777777-aaaa-4bbb-8ccc-dddddddddddd';

const VALID_BODY = {
  scheduler_id: 'cron-worker-us-east-1-i-abc123',
  fencing_token: '5',
  target_obligation_generation: 3,
  claim_ttl_seconds: 30,
};

interface FakeTx {
  query: ReturnType<typeof vi.fn>;
}

function makeFakeTx(): FakeTx {
  return {
    query: vi.fn(),
  };
}

interface ForbiddenError extends Error {
  statusCode: number;
}

function makeReq(opts?: {
  params?: Record<string, unknown>;
  body?: unknown;
  actorNonce?: string | undefined;
}): FastifyRequest {
  return {
    id: 'req-fake',
    params: opts?.params ?? { id: VALID_UUID },
    body: opts?.body ?? VALID_BODY,
    actorNonce: opts?.actorNonce,
    server: {
      httpErrors: {
        badRequest: (msg: string) => {
          const e = new Error(msg) as ForbiddenError;
          e.statusCode = 400;
          return e;
        },
        notFound: (msg: string) => {
          const e = new Error(msg) as ForbiddenError;
          e.statusCode = 404;
          return e;
        },
        forbidden: (msg: string) => {
          const e = new Error(msg) as ForbiddenError;
          e.statusCode = 403;
          return e;
        },
      },
    },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply {
  const reply = {
    code: vi.fn((_: number) => reply),
    send: vi.fn((body: unknown) => body),
  };
  return reply as unknown as FastifyReply;
}

/**
 * Pre-fetch result + wrapper result helpers — the handler issues two
 * `tx.query` calls in order: (1) staff-view pre-fetch returns
 * `{ patient_id }`, (2) wrapper SELECT returns
 * `{ sweep_execution_id, fencing_token, outcome }`.
 */
function queueQueryResults(
  tx: FakeTx,
  results: Array<{ rows: unknown[]; rowCount?: number }>,
): void {
  for (const r of results) {
    tx.query.mockImplementationOnce(async () => r);
  }
}

function installDefaultCompositionMocks(tx: FakeTx): void {
  vi.mocked(requireTenantContext).mockReturnValue(
    FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
  );
  vi.mocked(requireAdminActorContext).mockReturnValue(
    FAKE_ADMIN_ACTOR as unknown as ReturnType<typeof requireAdminActorContext>,
  );
  vi.mocked(resolveActorTenantIdForAudit).mockReturnValue('Telecheck-US');
  vi.mocked(withTransaction).mockImplementation(async (fn) =>
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withTenantContext).mockImplementation(async (_client, _tenantId, fn) =>
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withActorContext).mockImplementation(async (_tx, _nonce, fn) => fn());
  vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => fn());
  vi.mocked(emitCrisisNoAcknowledgementEscalationAudit).mockResolvedValue(
    {} as Awaited<ReturnType<typeof emitCrisisNoAcknowledgementEscalationAudit>>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// §1 — happy path: completed_escalated outcome → audit emitted + 200
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §1 — happy path completed_escalated', () => {
  it('§1a composes tx → tenant → actor → role + pre-fetch + wrapper + audit; returns 200', async () => {
    const tx = makeFakeTx();
    queueQueryResults(tx, [
      { rows: [{ patient_id: VALID_PATIENT_UUID }], rowCount: 1 },
      {
        rows: [
          {
            sweep_execution_id: VALID_SWEEP_UUID,
            fencing_token: '7',
            outcome: 'completed_escalated',
          },
        ],
        rowCount: 1,
      },
    ]);
    installDefaultCompositionMocks(tx);
    const req = makeReq({ actorNonce: 'fake-nonce' });
    const reply = makeReply();

    await postCrisisSweepHandler(req, reply);

    // Composition order assertions.
    expect(requireTenantContext).toHaveBeenCalledWith(req);
    expect(requireAdminActorContext).toHaveBeenCalledWith(req);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledWith(tx, 'Telecheck-US', expect.any(Function));
    expect(withActorContext).toHaveBeenCalledWith(tx, 'fake-nonce', expect.any(Function));
    // Two withDbRole calls: staff_reader pre-fetch + sweep_scheduler wrapper.
    expect(withDbRole).toHaveBeenCalledTimes(2);
    expect(withDbRole).toHaveBeenNthCalledWith(
      1,
      tx,
      'crisis_event_staff_reader',
      expect.any(Function),
    );
    expect(withDbRole).toHaveBeenNthCalledWith(
      2,
      tx,
      'crisis_sweep_scheduler',
      expect.any(Function),
    );

    // tx.query: 1 pre-fetch + 1 wrapper SELECT.
    expect(tx.query).toHaveBeenCalledTimes(2);
    const [preFetchSql] = tx.query.mock.calls[0]!;
    expect(preFetchSql).toContain('FROM crisis_event_current_state_v');
    const [wrapperSql, wrapperParams] = tx.query.mock.calls[1]!;
    expect(wrapperSql).toContain('execute_crisis_no_acknowledgement_sweep');
    // Wrapper receives the 5 canonical params: tenant_id, crisis_event_id,
    // target_obligation_generation, worker_id, claim_ttl_seconds.
    // fencing_token from the body is NOT passed (observability echo only).
    expect(wrapperParams).toEqual([
      'Telecheck-US',
      VALID_UUID,
      3,
      'cron-worker-us-east-1-i-abc123',
      30,
    ]);

    // Audit fires on completed_escalated.
    expect(emitCrisisNoAcknowledgementEscalationAudit).toHaveBeenCalledTimes(1);
    const [auditArgs, auditTx] = vi.mocked(emitCrisisNoAcknowledgementEscalationAudit).mock
      .calls[0]!;
    expect(auditTx).toBe(tx);
    expect(auditArgs).toMatchObject({
      tenantId: 'Telecheck-US',
      actorAccountId: FAKE_ADMIN_ACTOR.accountId,
      actorTenantId: 'Telecheck-US',
      countryOfCare: 'US',
      targetPatientId: VALID_PATIENT_UUID,
      fencingToken: '7',
      sweepOutcome: 'completed_escalated',
      targetObligationGeneration: 3,
      claimTtlSeconds: 30,
      workerId: 'cron-worker-us-east-1-i-abc123',
    });

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      crisis_event_id: VALID_UUID,
      sweep_execution_id: VALID_SWEEP_UUID,
      fencing_token: '7',
      outcome: 'completed_escalated',
      target_obligation_generation: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant guard precedes tx
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §2 — tenant guard precedes tx', () => {
  it('§2a requireTenantContext throw aborts before withTransaction', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('tenantContext absent — programming error');
    });

    await expect(postCrisisSweepHandler(makeReq(), makeReply())).rejects.toThrow(
      /tenantContext absent/,
    );

    expect(requireAdminActorContext).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — admin role-gate precedes tx
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §3 — admin role-gate precedes tx', () => {
  it('§3a requireAdminActorContext throw aborts before withTransaction', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requireAdminActorContext).mockImplementation(() => {
      throw new Error('forbidden: actor role=clinician does not satisfy admin gate');
    });

    await expect(postCrisisSweepHandler(makeReq(), makeReply())).rejects.toThrow(/forbidden/);

    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — path-param validation: missing / non-UUID :id → 400 before tx
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §4 — path-param validation precedes tx', () => {
  it('§4a missing :id → 400 envelope; tx NOT opened', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const reply = makeReply();

    await postCrisisSweepHandler(makeReq({ params: {} }), reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'internal.request.invalid' }),
      }),
    );
    expect(withTransaction).not.toHaveBeenCalled();
  });

  it('§4b non-UUID :id (ULID-shaped, garbage) → 400 before tx', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const nonUuids = ['01HXYZ123456789ABCDEFGHJK', 'not-a-uuid', '11111111-2222-3333-4444'];
    for (const bad of nonUuids) {
      const reply = makeReply();
      await postCrisisSweepHandler(makeReq({ params: { id: bad } }), reply);
      expect(reply.code).toHaveBeenCalledWith(400);
    }
    expect(withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §5 — body validation matrix
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §5 — body validation precedes tx', () => {
  // Build a body by merging VALID_BODY with overrides (as Record so we
  // can model "missing key" via `omitKeys` without fighting
  // exactOptionalPropertyTypes).
  const buildBody = (
    overrides: Record<string, unknown> = {},
    omitKeys: ReadonlyArray<string> = [],
  ): unknown => {
    const out: Record<string, unknown> = { ...VALID_BODY, ...overrides };
    for (const k of omitKeys) {
      delete out[k];
    }
    return out;
  };

  const cases: Array<[string, unknown]> = [
    ['missing scheduler_id', buildBody({}, ['scheduler_id'])],
    ['empty scheduler_id', buildBody({ scheduler_id: '' })],
    ['non-string scheduler_id', buildBody({ scheduler_id: 123 })],
    ['missing fencing_token', buildBody({}, ['fencing_token'])],
    ['empty fencing_token', buildBody({ fencing_token: '' })],
    ['missing target_obligation_generation', buildBody({}, ['target_obligation_generation'])],
    ['negative target_obligation_generation', buildBody({ target_obligation_generation: -1 })],
    ['non-integer target_obligation_generation', buildBody({ target_obligation_generation: 1.5 })],
    ['zero claim_ttl_seconds (must be positive)', buildBody({ claim_ttl_seconds: 0 })],
    ['negative claim_ttl_seconds', buildBody({ claim_ttl_seconds: -1 })],
    ['non-integer claim_ttl_seconds', buildBody({ claim_ttl_seconds: 30.5 })],
  ];

  for (const [name, body] of cases) {
    it(`§5 rejects: ${name} → 400 before tx`, async () => {
      const tx = makeFakeTx();
      installDefaultCompositionMocks(tx);
      const reply = makeReply();

      await postCrisisSweepHandler(makeReq({ body }), reply);

      expect(reply.code).toHaveBeenCalledWith(400);
      expect(reply.send).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'internal.request.invalid' }),
        }),
      );
      expect(withTransaction).not.toHaveBeenCalled();
    });
  }

  it('§5x accepts body without claim_ttl_seconds (optional → defaults to 60)', async () => {
    const tx = makeFakeTx();
    queueQueryResults(tx, [
      { rows: [{ patient_id: VALID_PATIENT_UUID }], rowCount: 1 },
      {
        rows: [
          {
            sweep_execution_id: VALID_SWEEP_UUID,
            fencing_token: '1',
            outcome: 'completed_no_op',
          },
        ],
        rowCount: 1,
      },
    ]);
    installDefaultCompositionMocks(tx);
    const reply = makeReply();
    const { claim_ttl_seconds: _omit, ...bodyNoTtl } = VALID_BODY;

    await postCrisisSweepHandler(makeReq({ body: bodyNoTtl, actorNonce: 'n' }), reply);

    expect(reply.code).toHaveBeenCalledWith(200);
    // Wrapper receives 60 as the default.
    const [, params] = tx.query.mock.calls[1]!;
    expect(params).toEqual(['Telecheck-US', VALID_UUID, 3, 'cron-worker-us-east-1-i-abc123', 60]);
  });
});

// ---------------------------------------------------------------------------
// §6 — staff-view pre-fetch 0 rows → 404 tenant-blind; wrapper NOT invoked
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §6 — pre-fetch 404 → wrapper NOT invoked', () => {
  it('§6a 0-row pre-fetch returns 404 envelope; wrapper SQL never runs; audit NOT emitted', async () => {
    const tx = makeFakeTx();
    queueQueryResults(tx, [{ rows: [], rowCount: 0 }]);
    installDefaultCompositionMocks(tx);
    const reply = makeReply();

    await postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), reply);

    expect(tx.query).toHaveBeenCalledTimes(1); // only the pre-fetch ran
    expect(reply.code).toHaveBeenCalledWith(404);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'internal.resource.not_found' }),
      }),
    );
    expect(emitCrisisNoAcknowledgementEscalationAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §7 — 42501 mapping → 403 for BOTH pre-fetch and wrapper paths
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §7 — 42501 → tenant-blind 403', () => {
  it('§7a pre-fetch 42501 → 403 via httpErrors.forbidden; wrapper NOT invoked', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const pgErr = Object.assign(new Error('insufficient_privilege'), { code: '42501' });
    tx.query.mockImplementationOnce(async () => {
      throw pgErr;
    });

    await expect(postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), makeReply())).rejects.toThrow(
      /Insufficient scope/,
    );
    expect(emitCrisisNoAcknowledgementEscalationAudit).not.toHaveBeenCalled();
  });

  it('§7b wrapper-SELECT 42501 → 403 via httpErrors.forbidden; audit NOT emitted', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    queueQueryResults(tx, [{ rows: [{ patient_id: VALID_PATIENT_UUID }], rowCount: 1 }]);
    const pgErr = Object.assign(new Error('insufficient_privilege'), { code: '42501' });
    tx.query.mockImplementationOnce(async () => {
      throw pgErr;
    });

    await expect(postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), makeReply())).rejects.toThrow(
      /Insufficient scope/,
    );
    expect(emitCrisisNoAcknowledgementEscalationAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §8 — outer SQLSTATE mapping
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §8 — outer SQLSTATE → tenant-blind envelopes', () => {
  function setupAndThrow(code: string): { tx: FakeTx; reply: FastifyReply } {
    const tx = makeFakeTx();
    queueQueryResults(tx, [{ rows: [{ patient_id: VALID_PATIENT_UUID }], rowCount: 1 }]);
    installDefaultCompositionMocks(tx);
    const pgErr = Object.assign(new Error(`pg ${code}`), { code });
    tx.query.mockImplementationOnce(async () => {
      throw pgErr;
    });
    return { tx, reply: makeReply() };
  }

  it('§8a 02000 → 404', async () => {
    const { reply } = setupAndThrow('02000');
    await postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), reply);
    expect(reply.code).toHaveBeenCalledWith(404);
    expect(emitCrisisNoAcknowledgementEscalationAudit).not.toHaveBeenCalled();
  });

  it('§8b 23514 → 404', async () => {
    const { reply } = setupAndThrow('23514');
    await postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), reply);
    expect(reply.code).toHaveBeenCalledWith(404);
  });

  it('§8c 40001 → 409 (lease conflict)', async () => {
    const { reply } = setupAndThrow('40001');
    await postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), reply);
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'internal.resource.conflict',
          message: expect.stringContaining('Sweep lease conflict'),
        }),
      }),
    );
  });

  it('§8d 23505 → 409 (duplicate run)', async () => {
    const { reply } = setupAndThrow('23505');
    await postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), reply);
    expect(reply.code).toHaveBeenCalledWith(409);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'internal.resource.conflict',
          message: expect.stringContaining('duplicate sweep submission'),
        }),
      }),
    );
  });

  it('§8e 22023 → 400 (claim_ttl_seconds out of range)', async () => {
    const { reply } = setupAndThrow('22023');
    await postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), reply);
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'internal.request.invalid',
          message: expect.stringContaining('claim_ttl_seconds out of allowed'),
        }),
      }),
    );
  });

  it('§8f unmapped SQLSTATE → propagates (500 via global envelope)', async () => {
    const { reply } = setupAndThrow('XX000');
    await expect(postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), reply)).rejects.toThrow(
      /pg XX000/,
    );
  });
});

// ---------------------------------------------------------------------------
// §9 — non-completed_escalated outcomes → 200 but audit NOT emitted
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §9 — non-escalation outcomes skip audit', () => {
  const skipCases: Array<string> = [
    'already_completed',
    'completed_no_op',
    'claimed_new',
    'claimed_takeover',
  ];

  for (const outcome of skipCases) {
    it(`§9 outcome=${outcome} → 200 but audit NOT emitted (I-003 hash-chain)`, async () => {
      const tx = makeFakeTx();
      queueQueryResults(tx, [
        { rows: [{ patient_id: VALID_PATIENT_UUID }], rowCount: 1 },
        {
          rows: [
            {
              sweep_execution_id: VALID_SWEEP_UUID,
              fencing_token: '2',
              outcome,
            },
          ],
          rowCount: 1,
        },
      ]);
      installDefaultCompositionMocks(tx);
      const reply = makeReply();

      await postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), reply);

      expect(reply.code).toHaveBeenCalledWith(200);
      expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ outcome }));
      expect(emitCrisisNoAcknowledgementEscalationAudit).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// §10 — audit-emit failure on completed_escalated → propagates (I-003)
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §10 — audit-emit failure propagates per I-003', () => {
  it('§10a audit emitter throws → handler re-throws; surrounding tx rolls back atomically', async () => {
    const tx = makeFakeTx();
    queueQueryResults(tx, [
      { rows: [{ patient_id: VALID_PATIENT_UUID }], rowCount: 1 },
      {
        rows: [
          {
            sweep_execution_id: VALID_SWEEP_UUID,
            fencing_token: '7',
            outcome: 'completed_escalated',
          },
        ],
        rowCount: 1,
      },
    ]);
    installDefaultCompositionMocks(tx);
    vi.mocked(emitCrisisNoAcknowledgementEscalationAudit).mockRejectedValueOnce(
      new Error('audit emit failed — FLOOR-020 fail-closed'),
    );
    const reply = makeReply();

    await expect(postCrisisSweepHandler(makeReq({ actorNonce: 'n' }), reply)).rejects.toThrow(
      /audit emit failed/,
    );
  });
});

// ---------------------------------------------------------------------------
// §11 — actorNonce undefined → skips withActorContext
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §11 — actorNonce undefined path', () => {
  it('§11a actorNonce undefined → withActorContext NOT invoked; pre-fetch + wrapper still run', async () => {
    const tx = makeFakeTx();
    queueQueryResults(tx, [
      { rows: [{ patient_id: VALID_PATIENT_UUID }], rowCount: 1 },
      {
        rows: [
          {
            sweep_execution_id: VALID_SWEEP_UUID,
            fencing_token: '1',
            outcome: 'completed_no_op',
          },
        ],
        rowCount: 1,
      },
    ]);
    installDefaultCompositionMocks(tx);
    const reply = makeReply();

    await postCrisisSweepHandler(makeReq({ actorNonce: undefined }), reply);

    expect(withActorContext).not.toHaveBeenCalled();
    expect(reply.code).toHaveBeenCalledWith(200);
  });
});

// ---------------------------------------------------------------------------
// §12 — fencing_token observability-echo discipline
// ---------------------------------------------------------------------------

describe('postCrisisSweepHandler §12 — fencing_token echo (not wrapper input)', () => {
  it('§12a body fencing_token NOT included in wrapper SQL params; wrapper-returned fencing IS in audit + view', async () => {
    const tx = makeFakeTx();
    queueQueryResults(tx, [
      { rows: [{ patient_id: VALID_PATIENT_UUID }], rowCount: 1 },
      {
        rows: [
          {
            sweep_execution_id: VALID_SWEEP_UUID,
            fencing_token: '42', // wrapper-side canonical
            outcome: 'completed_escalated',
          },
        ],
        rowCount: 1,
      },
    ]);
    installDefaultCompositionMocks(tx);
    const reply = makeReply();
    // Body carries a DIFFERENT echo value than what the wrapper returns.
    const bodyWithEcho = { ...VALID_BODY, fencing_token: 'echo-stale-99' };

    await postCrisisSweepHandler(makeReq({ body: bodyWithEcho, actorNonce: 'n' }), reply);

    // Wrapper SQL params: tenant, crisis_event_id, generation, worker, ttl —
    // 5 positional params; NO fencing_token.
    const [, wrapperParams] = tx.query.mock.calls[1]!;
    expect(wrapperParams).toHaveLength(5);
    expect(wrapperParams).not.toContain('echo-stale-99');

    // Audit + view carry the WRAPPER-RETURNED fencing token, NOT the
    // body's stale echo.
    const [auditArgs] = vi.mocked(emitCrisisNoAcknowledgementEscalationAudit).mock.calls[0]!;
    expect(auditArgs.fencingToken).toBe('42');

    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ fencing_token: '42' }));
  });
});
