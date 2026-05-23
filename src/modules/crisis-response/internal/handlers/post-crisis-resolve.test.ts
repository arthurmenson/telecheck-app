/**
 * post-crisis-resolve.test.ts — unit tests for the Sprint 2 PR 4
 * mid-lifecycle write-path handler `POST /v0/crisis-events/:id/resolve`.
 *
 * Mirrors the post-crisis-respond.test.ts shape (same composition stack
 * + same 4-error-class envelope discipline + same R2 MED-1 closure
 * coverage) with two adaptations:
 *   - the audit's `detail.from_state` is read back AFTER the wrapper from
 *     the committed `crisis_event_lifecycle_transition` row (NOT the
 *     pre-lock pre-fetch, which is not authoritative under a
 *     responded→escalated sweep race — Codex R1 #202). The pre-fetch
 *     projects patient_id only.
 *   - the emit is gated by claimResourceLifecycleAuditSlot keyed on the
 *     wrapper-returned transition id (per-transition replay dedupe).
 *
 * §1 happy path (from_state=responded)
 * §1b happy path (from_state=escalated)
 * §2 tenant guard precedes idempotency wrap
 * §3 clinician role-gate precedes idempotency wrap
 * §4 path validation precedes idempotency wrap
 * §5 body validation: non-object payload AND non-object root body → 400
 * §6 pre-fetch 0-row → tenant-blind 404
 * §7 Cat A audit ordering + I-003 fail-closed propagation
 * §8 42501 → tenant-blind 403 (R2 MED-1 closure pattern)
 * §9 actorNonce undefined → skip withActorContext
 * §10 wrapper SQLSTATE 40001 → tenant-blind 409
 * §11 from_state read-back: read-back `escalated` → audit.fromState='escalated';
 *     `responded` → 'responded'; out-of-range value throws (wrapper-contract guard)
 * §12 wrapper-level idempotent replay → no duplicate Cat A audit row
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
  emitCrisisResolvedAudit: vi.fn(),
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
import { emitCrisisResolvedAudit } from '../../audit.js';

import { postCrisisResolveHandler } from './post-crisis-resolve.js';

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
const RETURNED_TRANSITION_ID = '99000000000000456';

interface FakeTx {
  query: ReturnType<typeof vi.fn>;
}

function makeFakeTx(): FakeTx {
  return { query: vi.fn() };
}

/**
 * Default tx.query, in handler call order:
 *   1. pre-fetch staff view → returns patient_id only (the audit from_state
 *      is NOT sourced from the pre-fetch — Codex R1 #202).
 *   2. wrapper SELECT → returns lifecycle_transition_id.
 *   3. post-wrapper from_state read-back from crisis_event_lifecycle_transition
 *      → returns the authoritative from_state the wrapper committed under lock.
 * Default fromState = 'responded' (the most common from-state for resolution).
 */
function installDefaultQueryResponses(tx: FakeTx, fromState: string = 'responded'): void {
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

function installDefaultCompositionMocks(tx: FakeTx, fromState: string = 'responded'): void {
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
  vi.mocked(emitCrisisResolvedAudit).mockResolvedValue({
    audit_id: 'aud_fake',
  } as unknown as Awaited<ReturnType<typeof emitCrisisResolvedAudit>>);
  vi.mocked(claimResourceLifecycleAuditSlot).mockResolvedValue(true);
  installDefaultQueryResponses(tx, fromState);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// §1 — happy path (from_state=responded)
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §1 — happy path (from_state=responded)', () => {
  it('§1a invokes the full canonical composition + audit emit; responds 200; audit carries fromState=responded', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx, 'responded');
    const req = makeReq({ actorNonce: 'fake-uuid-v4-nonce' });
    const reply = makeReply();

    await postCrisisResolveHandler(req, reply);

    // Three withDbRole calls: pre-fetch (staff_reader), wrapper (resolver),
    // then the post-wrapper from_state read-back (staff_reader again).
    expect(withDbRole).toHaveBeenCalledTimes(3);
    expect(withDbRole).toHaveBeenNthCalledWith(
      1,
      tx,
      'crisis_event_staff_reader',
      expect.any(Function),
    );
    expect(withDbRole).toHaveBeenNthCalledWith(2, tx, 'crisis_resolver', expect.any(Function));
    expect(withDbRole).toHaveBeenNthCalledWith(
      3,
      tx,
      'crisis_event_staff_reader',
      expect.any(Function),
    );

    // Three tx.query calls: pre-fetch view, wrapper SELECT, from_state read-back.
    expect(tx.query).toHaveBeenCalledTimes(3);
    const [preFetchSql] = tx.query.mock.calls[0]!;
    expect(preFetchSql).toContain('crisis_event_current_state_v');
    // Pre-fetch selects ONLY patient_id (asserted via the exact SELECT clause
    // rather than a `current_state` substring check — the view name
    // `crisis_event_current_state_v` itself contains that substring).
    expect(preFetchSql).toContain('SELECT patient_id FROM');
    const [wrapperSql, wrapperParams] = tx.query.mock.calls[1]!;
    expect(wrapperSql).toContain('record_crisis_resolution');
    expect(wrapperParams).toEqual(['Telecheck-US', VALID_CRISIS_EVENT_ID, null]);

    // from_state read-back reads the committed transition row by id.
    const [fromStateSql, fromStateParams] = tx.query.mock.calls[2]!;
    expect(fromStateSql).toContain('crisis_event_lifecycle_transition');
    expect(fromStateSql).toContain('from_state');
    expect(fromStateParams).toEqual(['Telecheck-US', RETURNED_TRANSITION_ID]);

    // Audit-dedupe slot claimed once, anchored on the transition id
    // (Codex R1 #202 finding 1).
    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledTimes(1);
    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledWith(tx, {
      tenantId: 'Telecheck-US',
      resourceType: 'crisis_event_lifecycle_transition',
      resourceId: RETURNED_TRANSITION_ID,
      auditAction: 'crisis.resolved',
    });

    expect(emitCrisisResolvedAudit).toHaveBeenCalledTimes(1);
    const [auditArgs, auditTx] = vi.mocked(emitCrisisResolvedAudit).mock.calls[0]!;
    expect(auditTx).toBe(tx);
    expect(auditArgs.tenantId).toBe('Telecheck-US');
    expect(auditArgs.crisisEventId).toBe(VALID_CRISIS_EVENT_ID);
    expect(auditArgs.targetPatientId).toBe(VALID_PATIENT_ID);
    expect(auditArgs.lifecycleTransitionId).toBe(RETURNED_TRANSITION_ID);
    expect(auditArgs.fromState).toBe('responded');

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      crisis_event_id: VALID_CRISIS_EVENT_ID,
      lifecycle_transition_id: RETURNED_TRANSITION_ID,
    });
  });

  it('§1b happy path (from_state=escalated) — audit carries fromState=escalated', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx, 'escalated');

    await postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());

    const [auditArgs] = vi.mocked(emitCrisisResolvedAudit).mock.calls[0]!;
    expect(auditArgs.fromState).toBe('escalated');
  });

  it('§1c passes payload through to the wrapper as JSONB when supplied', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const payload = { resolution_notes: 'Patient stable, follow-up scheduled.' };
    const req = makeReq({ actorNonce: 'fake-nonce', body: { payload } });

    await postCrisisResolveHandler(req, makeReply());

    const [, wrapperParams] = tx.query.mock.calls[1]!;
    expect(wrapperParams[2]).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant guard precedes idempotency wrap
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §2 — tenant guard precedes idempotency wrap', () => {
  it('§2a requireTenantContext throw aborts before withIdempotentExecution', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('tenantContext absent');
    });

    await expect(postCrisisResolveHandler(makeReq(), makeReply())).rejects.toThrow(
      /tenantContext absent/,
    );

    expect(requireClinicianActorContext).not.toHaveBeenCalled();
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — clinician role-gate precedes idempotency wrap
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §3 — clinician role-gate precedes idempotency wrap', () => {
  it('§3a requireClinicianActorContext throw aborts before withIdempotentExecution', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requireClinicianActorContext).mockImplementation(() => {
      throw new Error('forbidden: actor role=patient');
    });

    await expect(postCrisisResolveHandler(makeReq(), makeReply())).rejects.toThrow(/forbidden/);

    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — path validation precedes idempotency wrap
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §4 — path validation precedes idempotency wrap', () => {
  it.each<[string, Record<string, unknown> | undefined]>([
    ['missing :id', {}],
    ['non-UUID :id', { id: 'not-a-uuid' }],
    ['empty :id', { id: '' }],
  ])('§4 returns 400 BEFORE idempotency wrap: %s', async (_label, params) => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const req = makeReq({ params });
    const reply = makeReply();
    await postCrisisResolveHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §5 — body validation: non-object payload → 400
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §5 — body validation precedes idempotency wrap', () => {
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
    await postCrisisResolveHandler(req, reply);

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });

  // Codex R1 #202 finding 2 — non-object root body (array / scalar) → 400.
  it.each<[string, unknown]>([
    ['root is array', [{ payload: { a: 1 } }]],
    ['root is string', 'free text'],
    ['root is number', 42],
    ['root is boolean', true],
  ])('§5 returns 400 for non-object root body: %s', async (_label, rawBody) => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const reply = makeReply();
    await postCrisisResolveHandler(makeReq({ body: rawBody as Record<string, unknown> }), reply);
    expect(reply.code).toHaveBeenCalledWith(400);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §6 — pre-fetch 0-row → tenant-blind 404
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §6 — 404 tenant-blind on missing / cross-tenant', () => {
  it('§6a pre-fetch returns 0 rows → 404; wrapper + audit NEVER called', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    tx.query.mockReset();
    tx.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

    const reply = makeReply();
    await postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    expect(reply.code).toHaveBeenCalledWith(404);
    const sentBody = vi.mocked(reply.send).mock.calls[0]?.[0] as
      | { error?: { code?: string } }
      | undefined;
    expect(sentBody?.error?.code).toBe('internal.resource.not_found');
    const serialized = JSON.stringify(sentBody);
    expect(serialized).not.toContain('Telecheck-US');
    expect(serialized).not.toContain(VALID_CRISIS_EVENT_ID);

    expect(tx.query).toHaveBeenCalledTimes(1);
    expect(emitCrisisResolvedAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §7 — Cat A audit ordering + I-003 fail-closed propagation
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §7 — Cat A audit emission in same tx', () => {
  it('§7a emitCrisisResolvedAudit runs AFTER second withDbRole returns (FLOOR-020 ordering)', async () => {
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
    vi.mocked(emitCrisisResolvedAudit).mockImplementation(async () => {
      callOrder.push('audit-emit');
      return { audit_id: 'aud_fake' } as unknown as Awaited<
        ReturnType<typeof emitCrisisResolvedAudit>
      >;
    });

    await postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());

    expect(callOrder).toEqual([
      'withDbRole-crisis_event_staff_reader-1-enter',
      'withDbRole-crisis_event_staff_reader-1-exit',
      'withDbRole-crisis_resolver-2-enter',
      'withDbRole-crisis_resolver-2-exit',
      'withDbRole-crisis_event_staff_reader-3-enter',
      'withDbRole-crisis_event_staff_reader-3-exit',
      'audit-emit',
    ]);
  });

  it('§7b audit emit failure propagates (I-003); response never reaches 200', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(emitCrisisResolvedAudit).mockRejectedValueOnce(
      new Error('emitAudit: durable INSERT failed for crisis.resolved'),
    );

    const reply = makeReply();
    await expect(
      postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), reply),
    ).rejects.toThrow(/durable INSERT failed/);

    expect(reply.code).not.toHaveBeenCalledWith(200);
  });
});

// ---------------------------------------------------------------------------
// §8 — 42501 → tenant-blind 403 (R2 MED-1 closure pattern)
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §8 — 42501 → tenant-blind 403', () => {
  it('§8a 42501 from withDbRole SET LOCAL ROLE on the WRAPPER call → 403; audit not emitted', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole)
      .mockImplementationOnce(async (_tx, _role, fn) => fn())
      .mockRejectedValueOnce({ code: '42501', message: 'permission denied to set role' });

    await expect(
      postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/Insufficient scope/);

    expect(emitCrisisResolvedAudit).not.toHaveBeenCalled();
  });

  it('§8b 42501 from wrapper LAYER C inside callback → 403; audit not emitted', async () => {
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
          'record_crisis_resolution: tenant scope mismatch',
        );
        err.code = '42501';
        throw err;
      });

    await expect(
      postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/Insufficient scope/);

    expect(emitCrisisResolvedAudit).not.toHaveBeenCalled();
  });

  it('§8c 42501 from pre-fetch elevation → 403; wrapper + audit not invoked', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockReset();
    vi.mocked(withDbRole).mockRejectedValueOnce({
      code: '42501',
      message: 'permission denied to set role crisis_event_staff_reader',
    });

    await expect(
      postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/Insufficient scope/);

    expect(emitCrisisResolvedAudit).not.toHaveBeenCalled();
  });

  it('§8d non-42501 PG error propagates unchanged', async () => {
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
          'function record_crisis_resolution does not exist',
        );
        err.code = '42883';
        throw err;
      });

    await expect(
      postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/function record_crisis_resolution does not exist/);
  });
});

// ---------------------------------------------------------------------------
// §9 — actorNonce undefined → skip withActorContext
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §9 — missing actorNonce skips withActorContext', () => {
  it('§9a undefined actorNonce skips withActorContext but still pre-fetches + wraps + audits', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await postCrisisResolveHandler(makeReq({ actorNonce: undefined }), makeReply());

    expect(withActorContext).not.toHaveBeenCalled();
    expect(withDbRole).toHaveBeenCalledTimes(3);
    expect(tx.query).toHaveBeenCalledTimes(3);
    expect(emitCrisisResolvedAudit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §10 — wrapper SQLSTATE 40001 → tenant-blind 409
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §10 — 40001 → tenant-blind 409', () => {
  it('§10a wrapper raises 40001 → 409 with stable code; envelope omits tenant_id + crisis_event_id', async () => {
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
          'record_crisis_resolution: cannot resolve from state detected',
        );
        err.code = '40001';
        throw err;
      });

    const reply = makeReply();
    await postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    expect(reply.code).toHaveBeenCalledWith(409);
    const sentBody = vi.mocked(reply.send).mock.calls[0]?.[0] as
      | { error?: { code?: string } }
      | undefined;
    expect(sentBody?.error?.code).toBe('internal.resource.conflict');
    const serialized = JSON.stringify(sentBody);
    expect(serialized).not.toContain('Telecheck-US');
    expect(serialized).not.toContain(VALID_CRISIS_EVENT_ID);
    expect(emitCrisisResolvedAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §11 — from_state narrowing
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §11 — from_state read-back', () => {
  it.each<[string, 'responded' | 'escalated']>([
    ['read-back escalated → audit.fromState=escalated', 'escalated'],
    ['read-back responded → audit.fromState=responded', 'responded'],
  ])('§11 %s', async (_label, fromState) => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx, fromState);

    await postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply());

    const [auditArgs] = vi.mocked(emitCrisisResolvedAudit).mock.calls[0]!;
    expect(auditArgs.fromState).toBe(fromState);
  });

  it('§11c read-back of an out-of-range from_state throws (wrapper-contract guard); audit not emitted', async () => {
    // The committed transition row should only ever carry `responded` or
    // `escalated` for a resolve. If the read-back surfaces anything else
    // (a wrapper-contract violation), the handler throws rather than
    // emitting a mislabeled audit — Codex R1 #202 read-back closure.
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx, 'acknowledged'); // not responded, not escalated

    await expect(
      postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), makeReply()),
    ).rejects.toThrow(/unexpected from_state 'acknowledged'/);

    expect(emitCrisisResolvedAudit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §12 — wrapper-level idempotent replay → no duplicate Cat A audit row
//        (Codex R1 #202 finding 1)
// ---------------------------------------------------------------------------

describe('postCrisisResolveHandler §12 — replay dedupe (no duplicate audit)', () => {
  it('§12a dedupe slot already claimed (replay) → audit NOT emitted; no from_state read-back; still 200 + same ids', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(claimResourceLifecycleAuditSlot).mockResolvedValue(false);

    const reply = makeReply();
    await postCrisisResolveHandler(makeReq({ actorNonce: 'fake-nonce' }), reply);

    expect(claimResourceLifecycleAuditSlot).toHaveBeenCalledTimes(1);
    expect(emitCrisisResolvedAudit).not.toHaveBeenCalled();
    // Only two tx.query calls (pre-fetch + wrapper); read-back is gated
    // behind the claim and skipped on replay.
    expect(tx.query).toHaveBeenCalledTimes(2);
    expect(withDbRole).toHaveBeenCalledTimes(2);
    expect(reply.code).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith({
      crisis_event_id: VALID_CRISIS_EVENT_ID,
      lifecycle_transition_id: RETURNED_TRANSITION_ID,
    });
  });
});
