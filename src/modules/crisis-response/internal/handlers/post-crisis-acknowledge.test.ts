/**
 * post-crisis-acknowledge.test.ts — unit tests for the Sprint 2 PR 3
 * mid-lifecycle write-path handler
 * `POST /v0/crisis-events/:id/acknowledge`.
 *
 * Covers handler composition discipline at unit scope (no real DB):
 *   §1 happy path: tenant + clinician role-gate + path validation +
 *      body validation + withIdempotentExecution composes withTenantContext
 *      → withActorContext → withDbRole('crisis_event_staff_reader', ...)
 *      pre-fetch (patient_id only) →
 *      withDbRole('crisis_acknowledger', ...) wrapper SELECT →
 *      claimResourceLifecycleAuditSlot → withDbRole('crisis_event_staff_reader')
 *      from_state read-back → audit emit;
 *      response is 200 + { crisis_event_id, lifecycle_transition_id }.
 *   §2 tenant guard fires before idempotency wrap / tx open.
 *   §3 clinician role-gate fires before idempotency wrap / tx open.
 *   §4 path validation: missing / non-UUID :id → 400 BEFORE idempotency wrap.
 *   §5 body validation: non-object `payload` AND non-object root body → 400
 *      BEFORE idempotency wrap.
 *   §6 pre-fetch 0-row read → tenant-blind 404; wrapper NOT called, audit NOT emitted.
 *   §7 Cat A `crisis.acknowledged` audit emitted in same tx AFTER wrapper SELECT
 *      + dedupe-slot claim; audit emit failure propagates (I-003 bare
 *      suppression forbidden); from_state echo read back from the committed
 *      transition row (NOT the pre-lock pre-fetch — Codex R1 #199 finding 1).
 *   §11 wrapper-level idempotent replay (dedupe slot already claimed) → audit
 *       NOT re-emitted (Codex R1 #199 finding 2); still 200 with same ids.
 *   §8 42501 → tenant-blind 403 via the canonical R2 MED-1 closure pattern
 *      (covers both SET LOCAL ROLE elevation failure AND wrapper LAYER B/C
 *      tenant-scope guard failure). Pre-fetch 42501 also maps to 403.
 *   §9 actorNonce undefined → skip withActorContext but still call pre-fetch
 *      + wrapper + audit emit.
 *   §10 wrapper SQLSTATE 40001 → tenant-blind 409 via mapServiceError;
 *       envelope does not echo tenant_id / crisis_event_id.
 *
 * Mocking strategy mirrors post-crisis-respond.test.ts §1-§10 pattern.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/auth-context.js', () => ({
  requireClinicianActorContext: vi.fn(),
  resolveActorTenantIdForAudit: vi.fn(),
}));
vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(),
}));
vi.mock('../../../../lib/idempotent-handler.js', () => ({
  withIdempotentExecution: vi.fn(),
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
  emitCrisisAcknowledgedAudit: vi.fn(),
}));
vi.mock('../../../../lib/audit-dedupe.js', () => ({
  claimResourceLifecycleAuditSlot: vi.fn(),
}));

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { claimResourceLifecycleAuditSlot } from '../../../../lib/audit-dedupe.js';
import {
  requireClinicianActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitCrisisAcknowledgedAudit } from '../../audit.js';

import { postCrisisAcknowledgeHandler } from './post-crisis-acknowledge.js';

// ---------------------------------------------------------------------------
// Fixtures + harness
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

const FAKE_CLINICIAN_ACTOR = {
  accountId: '00000000-0000-4000-8000-000000000001',
  sessionId: 'sess-fake',
  tenantId: 'Telecheck-US',
  role: 'clinician' as const,
  countryOfCare: 'US' as const,
  delegateId: null,
  adminTenantBinding: null,
  adminHomeTenantId: null,
};

const VALID_CRISIS_EVENT_ID = '33333333-4444-4555-8666-777777777777';
const VALID_PATIENT_ID = '11111111-2222-4333-8444-555555555555';
const RETURNED_TRANSITION_ID = '99000000000000123';

interface FakeTx {
  query: ReturnType<typeof vi.fn>;
}

function makeFakeTx(): FakeTx {
  return { query: vi.fn() };
}

/**
 * Default tx.query implementation, in handler call order:
 *   1. pre-fetch staff view → returns patient_id (no current_state; the
 *      audit from_state is NOT sourced from the pre-fetch — Codex R1 #199
 *      finding 1).
 *   2. wrapper SELECT → returns lifecycle transition id.
 *   3. post-wrapper from_state read-back from crisis_event_lifecycle_transition
 *      → returns the authoritative from_state the wrapper committed under lock.
 */
function installDefaultQueryResponses(tx: FakeTx, fromState = 'detected'): void {
  tx.query
    .mockImplementationOnce(async () => ({
      rows: [{ patient_id: VALID_PATIENT_ID }],
      rowCount: 1,
    }))
    .mockImplementationOnce(async () => ({
      rows: [{ lifecycle_transition_id: RETURNED_TRANSITION_ID }],
      rowCount: 1,
    }))
    .mockImplementationOnce(async () => ({
      rows: [{ from_state: fromState }],
      rowCount: 1,
    }));
}

function makeReq(opts?: {
  body?: Record<string, unknown> | undefined;
  params?: Record<string, unknown> | undefined;
  actorNonce?: string | undefined;
}): FastifyRequest {
  return {
    id: 'req-fake-id',
    body: opts && 'body' in opts ? opts.body : {},
    params: opts && 'params' in opts ? opts.params : { id: VALID_CRISIS_EVENT_ID },
    actorNonce: opts?.actorNonce,
    server: {
      httpErrors: {
        forbidden: (msg: string) => {
          const e = new Error(msg);
          (e as Error & { statusCode: number }).statusCode = 403;
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

function installDefaultCompositionMocks(tx: FakeTx, fromState = 'detected'): void {
  vi.mocked(requireTenantContext).mockReturnValue(
    FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
  );
  vi.mocked(requireClinicianActorContext).mockReturnValue(
    FAKE_CLINICIAN_ACTOR as unknown as ReturnType<typeof requireClinicianActorContext>,
  );
  vi.mocked(resolveActorTenantIdForAudit).mockReturnValue('Telecheck-US');
  vi.mocked(withIdempotentExecution).mockImplementation(async (req, reply, _mapErr, body) => {
    try {
      const result = await body(
        tx as unknown as Parameters<typeof body>[0],
        { tenant_id: 'Telecheck-US' } as unknown as Parameters<typeof body>[1],
      );
      return reply.code(result.status).send(result.view);
    } catch (err) {
      const map = _mapErr as (e: unknown, r: FastifyReply, reqId: string) => boolean;
      if (map(err, reply, req.id)) return reply;
      throw err;
    }
  });
  vi.mocked(withTenantContext).mockImplementation(async (_client, _tenantId, fn) =>
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withActorContext).mockImplementation(async (_tx, _nonce, fn) => fn());
  vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => fn());
  vi.mocked(emitCrisisAcknowledgedAudit).mockResolvedValue({
    audit_id: 'aud_fake',
  } as unknown as Awaited<ReturnType<typeof emitCrisisAcknowledgedAudit>>);
  vi.mocked(claimResourceLifecycleAuditSlot).mockResolvedValue(true);
  installDefaultQueryResponses(tx, fromState);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// §1 — happy path: full composition in canonical order
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §1 — happy path composition', () => {
  it('§1a invokes the full canonical composition + audit emit; responds 200', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const req = makeReq({ actorNonce: 'fake-uuid-v4-nonce' });
    const reply = makeReply();

    await postCrisisAcknowledgeHandler(req, reply);

    expect(requireTenantContext).toHaveBeenCalledWith(req);
    expect(requireClinicianActorContext).toHaveBeenCalledWith(req);
    expect(withIdempotentExecution).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withActorContext).toHaveBeenCalledTimes(1);
    // Three withDbRole calls: pre-fetch (staff_reader), wrapper
    // (acknowledger), then the post-wrapper from_state read-back
    // (staff_reader again).
    expect(withDbRole).toHaveBeenCalledTimes(3);
    expect(withDbRole).toHaveBeenNthCalledWith(
      1,
      tx,
      'crisis_event_staff_reader',
      expect.any(Function),
    );
    expect(withDbRole).toHaveBeenNthCalledWith(2, tx, 'crisis_acknowledger', expect.any(Function));
    expect(withDbRole).toHaveBeenNthCalledWith(
      3,
      tx,
      'crisis_event_staff_reader',
      expect.any(Function),
    );

    // Three tx.query calls: pre-fetch view, wrapper SELECT, from_state
    // read-back.
    expect(tx.query).toHaveBeenCalledTimes(3);
    const [preFetchSql, preFetchParams] = tx.query.mock.calls[0]!;
    expect(preFetchSql).toContain('crisis_event_current_state_v');
    // Pre-fetch selects ONLY patient_id (no current_state column — the audit
    // from_state is read back post-wrapper). Asserted via the exact SELECT
    // clause rather than a `current_state` substring check, since the view
    // name `crisis_event_current_state_v` itself contains that substring.
    expect(preFetchSql).toContain('SELECT patient_id FROM');
    expect(preFetchParams).toEqual([VALID_CRISIS_EVENT_ID]);

    const [wrapperSql, wrapperParams] = tx.query.mock.calls[1]!;
    expect(wrapperSql).toContain('record_crisis_acknowledgement_claim');
    expect(wrapperParams).toEqual(['Telecheck-US', VALID_CRISIS_EVENT_ID, null]);

    // from_state read-back reads the committed transition row by id.
    const [fromStateSql, fromStateParams] = tx.query.mock.calls[2]!;
    expect(fromStateSql).toContain('crisis_event_lifecycle_transition');
    expect(fromStateSql).toContain('from_state');
    expect(fromStateParams).toEqual(['Telecheck-US', RETURNED_TRANSITION_ID]);

    // Audit-dedupe slot claimed once for crisis.acknowledged, anchored on
    // the wrapper-returned transition id (NOT the crisis_event id — a
    // crisis_event can be acknowledged more than once across the
    // acknowledged→escalated→acknowledged cycle; Codex R2 #199 catch).
    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledTimes(1);
    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledWith(tx, {
      tenantId: 'Telecheck-US',
      resourceType: 'crisis_event_lifecycle_transition',
      resourceId: RETURNED_TRANSITION_ID,
      auditAction: 'crisis.acknowledged',
    });

    // Audit emitted in the same tx with correct envelope.
    expect(emitCrisisAcknowledgedAudit).toHaveBeenCalledTimes(1);
    const [auditArgs, auditTx] = vi.mocked(emitCrisisAcknowledgedAudit).mock.calls[0]!;
    expect(auditTx).toBe(tx);
    expect(auditArgs.tenantId).toBe('Telecheck-US');
    expect(auditArgs.crisisEventId).toBe(VALID_CRISIS_EVENT_ID);
    expect(auditArgs.targetPatientId).toBe(VALID_PATIENT_ID);
    expect(auditArgs.lifecycleTransitionId).toBe(RETURNED_TRANSITION_ID);
    expect(auditArgs.fromState).toBe('detected');

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      crisis_event_id: VALID_CRISIS_EVENT_ID,
      lifecycle_transition_id: RETURNED_TRANSITION_ID,
    });
  });

  it('§1b passes payload through to the wrapper as JSONB when supplied', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const payload = { claim_channel: 'on_call_pager', triage_notes: 'paged at 02:14' };
    const req = makeReq({
      actorNonce: 'fake-uuid-v4-nonce',
      body: { payload },
    });

    await postCrisisAcknowledgeHandler(req, makeReply());

    const [, wrapperParams] = tx.query.mock.calls[1]!;
    expect(wrapperParams[2]).toEqual(payload);
  });

  it('§1c from_state echo follows the committed transition read-back (escalated → escalated)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx, 'escalated');
    await postCrisisAcknowledgeHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());

    const [auditArgs] = vi.mocked(emitCrisisAcknowledgedAudit).mock.calls[0]!;
    expect(auditArgs.fromState).toBe('escalated');
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant guard fires before idempotency wrap / tx open
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §2 — tenant guard precedes idempotency wrap', () => {
  it('§2a requireTenantContext throw aborts before withIdempotentExecution / clinician gate', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('tenantContext absent — programming error');
    });

    await expect(postCrisisAcknowledgeHandler(makeReq(), makeReply())).rejects.toThrow(
      /tenantContext absent/,
    );

    expect(requireClinicianActorContext).not.toHaveBeenCalled();
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — clinician role-gate fires before idempotency wrap / tx open
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §3 — clinician role-gate precedes idempotency wrap', () => {
  it('§3a requireClinicianActorContext throw aborts before withIdempotentExecution', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requireClinicianActorContext).mockImplementation(() => {
      throw new Error('forbidden: actor role=patient does not satisfy clinician gate');
    });

    await expect(postCrisisAcknowledgeHandler(makeReq(), makeReply())).rejects.toThrow(/forbidden/);

    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — path validation precedes idempotency wrap
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §4 — path validation precedes idempotency wrap', () => {
  it.each<[string, Record<string, unknown> | undefined]>([
    ['missing :id', {}],
    ['non-UUID :id', { id: 'not-a-uuid' }],
    ['empty :id', { id: '' }],
  ])('§4 returns 400 BEFORE idempotency wrap: %s', async (_label, params) => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const req = makeReq({ params });
    const reply = makeReply();
    await postCrisisAcknowledgeHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §5 — body validation: non-object `payload` → 400 BEFORE idempotency wrap
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §5 — body validation precedes idempotency wrap', () => {
  it.each<[string, unknown]>([
    ['payload is array', [{ a: 1 }]],
    ['payload is string', 'free text'],
    ['payload is number', 42],
    ['payload is boolean', true],
    ['payload is null', null],
  ])('§5 returns 400 for non-object payload: %s', async (_label, payload) => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const req = makeReq({ body: { payload } as Record<string, unknown> });
    const reply = makeReply();
    await postCrisisAcknowledgeHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });

  it('§5 undefined body is accepted (payload is optional)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    await postCrisisAcknowledgeHandler(makeReq({ body: undefined }), makeReply());
    expect(withIdempotentExecution).toHaveBeenCalledTimes(1);
  });

  // Codex R1 #199 finding 3 — a non-object root body (array / scalar) must
  // 400 up front; `'payload' in body` on a scalar throws a TypeError and
  // bypasses the 400 envelope.
  it.each<[string, unknown]>([
    ['root is array', [{ payload: { a: 1 } }]],
    ['root is string', 'free text'],
    ['root is number', 42],
    ['root is boolean', true],
  ])('§5 returns 400 for non-object root body: %s', async (_label, rawBody) => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const req = makeReq({ body: rawBody as Record<string, unknown> });
    const reply = makeReply();
    await postCrisisAcknowledgeHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §6 — pre-fetch 0-row → tenant-blind 404; wrapper not called, audit not emitted
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §6 — 404 tenant-blind on missing / cross-tenant', () => {
  it('§6a pre-fetch returns 0 rows → 404; wrapper SELECT + audit emit NEVER called', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // Override the pre-fetch to return zero rows.
    tx.query.mockReset();
    tx.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    const reply = makeReply();
    await postCrisisAcknowledgeHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    expect(reply.code).toHaveBeenCalledWith(404);
    const sentBody = vi.mocked(reply.send).mock.calls[0]?.[0] as
      | { error?: { code?: string } }
      | undefined;
    expect(sentBody?.error?.code).toBe('internal.resource.not_found');
    // tenant-blind: no tenant_id / crisis_event_id leaked
    const serialized = JSON.stringify(sentBody);
    expect(serialized).not.toContain('Telecheck-US');
    expect(serialized).not.toContain(VALID_CRISIS_EVENT_ID);

    // pre-fetch only; no wrapper call.
    expect(tx.query).toHaveBeenCalledTimes(1);
    expect(emitCrisisAcknowledgedAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §7 — Cat A audit ordering + I-003 fail-closed propagation
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §7 — Cat A audit emission in same tx', () => {
  it('§7a emitCrisisAcknowledgedAudit runs AFTER second withDbRole returns (FLOOR-020 ordering)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const callOrder: string[] = [];
    let dbRoleCallIndex = 0;
    vi.mocked(withDbRole).mockImplementation(async (_tx, role, fn) => {
      dbRoleCallIndex += 1;
      callOrder.push(`withDbRole-${role}-${dbRoleCallIndex}-enter`);
      const out = await fn();
      callOrder.push(`withDbRole-${role}-${dbRoleCallIndex}-exit`);
      return out;
    });
    vi.mocked(emitCrisisAcknowledgedAudit).mockImplementation(async () => {
      callOrder.push('audit-emit');
      return { audit_id: 'aud_fake' } as unknown as Awaited<
        ReturnType<typeof emitCrisisAcknowledgedAudit>
      >;
    });

    await postCrisisAcknowledgeHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());

    expect(callOrder).toEqual([
      'withDbRole-crisis_event_staff_reader-1-enter',
      'withDbRole-crisis_event_staff_reader-1-exit',
      'withDbRole-crisis_acknowledger-2-enter',
      'withDbRole-crisis_acknowledger-2-exit',
      'withDbRole-crisis_event_staff_reader-3-enter',
      'withDbRole-crisis_event_staff_reader-3-exit',
      'audit-emit',
    ]);
  });

  it('§7b audit emit failure propagates (I-003); response never reaches 200', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(emitCrisisAcknowledgedAudit).mockRejectedValueOnce(
      new Error('emitAudit: durable INSERT failed for crisis.acknowledged'),
    );

    const reply = makeReply();
    await expect(
      postCrisisAcknowledgeHandler(makeReq({ actorNonce: 'fake-nonce' }), reply),
    ).rejects.toThrow(/durable INSERT failed/);

    expect(reply.code).not.toHaveBeenCalledWith(200);
  });
});

// ---------------------------------------------------------------------------
// §8 — 42501 → tenant-blind 403 (R2 MED-1 closure pattern)
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §8 — 42501 → tenant-blind 403', () => {
  it('§8a 42501 from withDbRole SET LOCAL ROLE elevation on the WRAPPER call → 403; audit not emitted', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // First withDbRole (pre-fetch) succeeds; second (wrapper elevation) fails.
    vi.mocked(withDbRole)
      .mockImplementationOnce(async (_tx, _role, fn) => fn())
      .mockRejectedValueOnce({ code: '42501', message: 'permission denied to set role' });

    await expect(
      postCrisisAcknowledgeHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/Insufficient scope/);

    expect(emitCrisisAcknowledgedAudit).not.toHaveBeenCalled();
  });

  it('§8b 42501 from wrapper LAYER C tenant-scope guard inside callback → 403; audit not emitted', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // Override the wrapper SELECT (2nd query call) to raise 42501.
    tx.query.mockReset();
    tx.query
      .mockImplementationOnce(async () => ({
        rows: [{ patient_id: VALID_PATIENT_ID, current_state: 'detected' }],
        rowCount: 1,
      }))
      .mockImplementationOnce(async () => {
        const err: Error & { code?: string } = new Error(
          'record_crisis_acknowledgement_claim: tenant scope mismatch',
        );
        err.code = '42501';
        throw err;
      });

    await expect(
      postCrisisAcknowledgeHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/Insufficient scope/);

    expect(emitCrisisAcknowledgedAudit).not.toHaveBeenCalled();
  });

  it('§8c 42501 from pre-fetch (staff_reader elevation failure) → 403; wrapper + audit not invoked', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // First withDbRole (pre-fetch elevation) fails with 42501.
    vi.mocked(withDbRole).mockReset();
    vi.mocked(withDbRole).mockRejectedValueOnce({
      code: '42501',
      message: 'permission denied to set role crisis_event_staff_reader',
    });

    await expect(
      postCrisisAcknowledgeHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/Insufficient scope/);

    expect(emitCrisisAcknowledgedAudit).not.toHaveBeenCalled();
  });

  it('§8d non-42501 PG error propagates unchanged (e.g., undefined_function 42883)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    tx.query.mockReset();
    tx.query
      .mockImplementationOnce(async () => ({
        rows: [{ patient_id: VALID_PATIENT_ID, current_state: 'detected' }],
        rowCount: 1,
      }))
      .mockImplementationOnce(async () => {
        const err: Error & { code?: string } = new Error(
          'function record_crisis_acknowledgement_claim does not exist',
        );
        err.code = '42883';
        throw err;
      });

    await expect(
      postCrisisAcknowledgeHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/function record_crisis_acknowledgement_claim does not exist/);
  });
});

// ---------------------------------------------------------------------------
// §9 — actorNonce undefined → skip withActorContext but still query wrapper
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §9 — missing actorNonce skips withActorContext', () => {
  it('§9a undefined actorNonce skips withActorContext but still pre-fetches + wraps + audits', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await postCrisisAcknowledgeHandler(makeReq({ actorNonce: undefined }), makeReply());

    expect(withActorContext).not.toHaveBeenCalled();
    expect(withDbRole).toHaveBeenCalledTimes(3);
    expect(tx.query).toHaveBeenCalledTimes(3);
    expect(emitCrisisAcknowledgedAudit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §10 — wrapper SQLSTATE 40001 → tenant-blind 409
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §10 — 40001 → tenant-blind 409', () => {
  it('§10a wrapper raises 40001 → 409 with stable code; envelope omits tenant_id + crisis_event_id', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    tx.query.mockReset();
    tx.query
      .mockImplementationOnce(async () => ({
        rows: [{ patient_id: VALID_PATIENT_ID, current_state: 'responded' }],
        rowCount: 1,
      }))
      .mockImplementationOnce(async () => {
        const err: Error & { code?: string } = new Error(
          'record_crisis_acknowledgement_claim: cannot acknowledge crisis_event ' +
            'from state responded; allowed from-states are detected, escalated',
        );
        err.code = '40001';
        throw err;
      });

    const reply = makeReply();
    await postCrisisAcknowledgeHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    expect(reply.code).toHaveBeenCalledWith(409);
    const sentBody = vi.mocked(reply.send).mock.calls[0]?.[0] as
      | { error?: { code?: string } }
      | undefined;
    expect(sentBody?.error?.code).toBe('internal.resource.conflict');
    const serialized = JSON.stringify(sentBody);
    expect(serialized).not.toContain('Telecheck-US');
    expect(serialized).not.toContain(VALID_CRISIS_EVENT_ID);
    // audit not emitted on rejection path
    expect(emitCrisisAcknowledgedAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §11 — wrapper-level idempotent replay → no duplicate Cat A audit row
//        (Codex R1 #199 finding 2)
// ---------------------------------------------------------------------------

describe('postCrisisAcknowledgeHandler §11 — replay dedupe (no duplicate audit)', () => {
  it('§11a dedupe slot already claimed (replay) → audit NOT emitted; no from_state read-back; still 200 + same ids', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // A same-actor wrapper replay: the wrapper returns the existing
    // transition id, and the dedupe marker for crisis.acknowledged was
    // already committed by the originating tx → claim returns false.
    vi.mocked(claimResourceLifecycleAuditSlot).mockResolvedValue(false);

    const reply = makeReply();
    await postCrisisAcknowledgeHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    // Dedupe slot was probed exactly once.
    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledTimes(1);
    // Audit NOT re-emitted on replay.
    expect(emitCrisisAcknowledgedAudit).not.toHaveBeenCalled();
    // Only two tx.query calls (pre-fetch + wrapper); the from_state
    // read-back is gated behind the claim and is skipped on replay.
    expect(tx.query).toHaveBeenCalledTimes(2);
    // Two withDbRole calls only (pre-fetch + wrapper); no read-back role.
    expect(withDbRole).toHaveBeenCalledTimes(2);
    // Response is still the canonical 200 with the same ids the
    // originating tx returned.
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      crisis_event_id: VALID_CRISIS_EVENT_ID,
      lifecycle_transition_id: RETURNED_TRANSITION_ID,
    });
  });
});
