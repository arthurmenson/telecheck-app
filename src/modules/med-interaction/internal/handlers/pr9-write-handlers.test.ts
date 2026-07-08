/**
 * pr9-write-handlers.test.ts — combined unit tests for the 4 PR 9
 * write handlers (supersede + override + resolve + expire), updated for
 * the migration 070 evidence-unlock PR.
 *
 * **Scope:** unit-mock the composition boundaries (withIdempotentExecution,
 * withTenantContext, withActorContext, withDbRole, audit emitters, tenant
 * context shim, clinician role gate) and verify each handler's canonical
 * write composition + SECDEF call signature + Cat A audit emission rules:
 *   - supersede: operational (unchanged from PR 9)
 *   - override:  OPERATIONAL since migration 070 — LAYER B clinician gate,
 *     required KMS-envelope rationale, 14-param wrapper call with envelope
 *     bytes, two-event Cat A rule on success, rejection absorption AFTER
 *     tx rollback (no audit on wrapper-rejection paths — nothing committed
 *     to attest; the structured rejection surfaces via the mapper)
 *   - resolve + expire: still FAIL-CLOSED — savepoint-recovered rejection
 *     attestation + RETURNED 503 envelope (not a throw), so the attempt
 *     audit COMMITs per I-003 bare-suppression-forbidden
 *
 * The live-PostgreSQL end-to-end pass for the unlocked override path lives
 * in tests/integration/med-interaction-override-http.test.ts.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(),
}));
vi.mock('../../../../lib/auth-context.js', () => ({
  resolveActorTenantIdForAudit: vi.fn(),
  requireClinicianActorContext: vi.fn(),
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
vi.mock('../../../../lib/idempotent-handler.js', () => ({
  withIdempotentExecution: vi.fn(),
}));
vi.mock('../../audit.js', () => ({
  emitSignalLifecycleTransitionAudit: vi.fn(),
  emitSignalOverrideRecordedAudit: vi.fn(),
}));

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import {
  requireClinicianActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import {
  emitSignalLifecycleTransitionAudit,
  emitSignalOverrideRecordedAudit,
} from '../../audit.js';

import { expireSignalHandler } from './expire-signal.js';
import { overrideSignalHandler } from './override-signal.js';
import { resolveSignalHandler } from './resolve-signal.js';
import { supersedeSignalHandler } from './supersede-signal.js';

const FAKE_TENANT_CTX = { tenantId: 'Telecheck-US', countryOfCare: 'US' };
const VALID_SIGNAL_ID = '01HXYZSGNA0000000000ABCDEF';
const VALID_REPLACEMENT_EVAL_ID = '01HXYZEVA0000000000WXYZ234';
const VALID_CLINICIAN_ID = '01HXYZCN0000000000000ABCDE';
const VALID_DISCONT_EVENT_ID = '01HXYZDSC0000000000000WXYZ';
const VALID_DEK_ID = '01HXYZDEK0000000000000ABCD';
const FAKE_IDEMPOTENCY_KEY = '01HXYZDMP00000000000000ABC';

/** A complete, well-formed 8-field wire envelope (base64 fields decode). */
function makeWireEnvelope(): Record<string, string> {
  return {
    ciphertext_b64: Buffer.from('sealed-rationale').toString('base64'),
    dek_id: VALID_DEK_ID,
    iv_b64: Buffer.from('0123456789ab').toString('base64'),
    tag_b64: Buffer.from('0123456789abcdef').toString('base64'),
    alg: 'AES-256-GCM',
    alg_version: '1',
    aad_b64: Buffer.from('Telecheck-US:override').toString('base64'),
    encrypted_at: '2026-07-08T00:00:00.000Z',
  };
}

interface FakeTx {
  query: ReturnType<typeof vi.fn>;
}
function makeFakeTx(): FakeTx {
  return { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
}

function makeReq(opts?: { body?: unknown; actorNonce?: string | undefined }): FastifyRequest {
  const httpErrors = {
    forbidden: (msg?: string) => Object.assign(new Error(msg ?? 'Forbidden'), { statusCode: 403 }),
    notFound: (msg?: string) => Object.assign(new Error(msg ?? 'Not Found'), { statusCode: 404 }),
    badRequest: (msg?: string) =>
      Object.assign(new Error(msg ?? 'Bad Request'), { statusCode: 400 }),
  };
  return {
    id: 'req-fake-1',
    body: opts?.body ?? {},
    params: { id: VALID_SIGNAL_ID },
    headers: {},
    actorNonce: opts?.actorNonce,
    actorContext: { accountId: 'evaluator-acct-fake' },
    server: { httpErrors },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply {
  const reply = {
    code: vi.fn(),
    send: vi.fn(),
  } as unknown as FastifyReply;
  (reply.code as unknown as ReturnType<typeof vi.fn>).mockReturnValue(reply);
  return reply;
}

function installDefaultCompositionMocks(tx: FakeTx): void {
  vi.mocked(requireTenantContext).mockReturnValue(
    FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
  );
  vi.mocked(resolveActorTenantIdForAudit).mockReturnValue('Telecheck-US');
  vi.mocked(requireClinicianActorContext).mockReturnValue({
    accountId: VALID_CLINICIAN_ID,
    role: 'clinician',
  } as unknown as ReturnType<typeof requireClinicianActorContext>);
  vi.mocked(withIdempotentExecution).mockImplementation(async (_req, _reply, _mapper, fn) =>
    fn(
      tx as unknown as Parameters<typeof fn>[0],
      {
        idempotencyKey: FAKE_IDEMPOTENCY_KEY,
      } as unknown as Parameters<typeof fn>[1],
    ),
  );
  vi.mocked(withTenantContext).mockImplementation(async (_client, _tenantId, fn) =>
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withActorContext).mockImplementation(async (_client, _nonce, fn) => fn());
  vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => fn());
  vi.mocked(emitSignalLifecycleTransitionAudit).mockResolvedValue({} as never);
  vi.mocked(emitSignalOverrideRecordedAudit).mockResolvedValue({} as never);
}

// ===========================================================================
// §1 — supersede (operational)
// ===========================================================================

describe('supersedeSignalHandler — operational', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§1a happy path: withDbRole(medication_interaction_engine_evaluator) + SECDEF call + audit (toState=superseded)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    await supersedeSignalHandler(
      makeReq({
        body: { replacement_evaluation_id: VALID_REPLACEMENT_EVAL_ID, metadata: {} },
        actorNonce: 'nonce-x',
      }),
      makeReply(),
    );
    expect(withDbRole).toHaveBeenCalledWith(
      tx,
      'medication_interaction_engine_evaluator',
      expect.any(Function),
    );
    const dbRoleCallback = vi.mocked(withDbRole).mock.calls[0]![2]!;
    await dbRoleCallback();
    expect(tx.query).toHaveBeenCalledWith(
      'SELECT record_signal_supersession($1, $2, $3, $4, $5, $6::jsonb)',
      [
        FAKE_IDEMPOTENCY_KEY,
        'Telecheck-US',
        VALID_SIGNAL_ID,
        VALID_REPLACEMENT_EVAL_ID,
        'evaluator-acct-fake',
        JSON.stringify({}),
      ],
    );
    expect(emitSignalLifecycleTransitionAudit).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(emitSignalLifecycleTransitionAudit).mock.calls[0]![0];
    expect(auditArgs.toState).toBe('superseded');
    expect(auditArgs.transitionReason).toBe('supersession');
  });

  it('§1b 42501 from withDbRole maps to tenant-blind 403', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async () => {
      throw Object.assign(new Error('tenant scope mismatch — Telecheck-US vs Telecheck-Ghana'), {
        code: '42501',
      });
    });
    let thrown: unknown;
    try {
      await supersedeSignalHandler(
        makeReq({
          body: { replacement_evaluation_id: VALID_REPLACEMENT_EVAL_ID },
          actorNonce: 'nonce-x',
        }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }
    const errObj = thrown as { statusCode?: number; message?: string };
    expect(errObj.statusCode).toBe(403);
    expect(errObj.message ?? '').not.toContain('Telecheck-US');
    expect(errObj.message ?? '').not.toContain('Telecheck-Ghana');
  });
});

// ===========================================================================
// §2 — override (OPERATIONAL since migration 070)
// ===========================================================================

describe('overrideSignalHandler — operational (migration 070 evidence-unlock)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§2a happy path: clinician gate + withDbRole(override_recorder) + 14-param wrapper call with envelope bytes + TWO audits (cause then effect)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const result = (await overrideSignalHandler(
      makeReq({
        body: { override_rationale_envelope: makeWireEnvelope(), metadata: { note: 'x' } },
        actorNonce: 'nonce-x',
      }),
      makeReply(),
    )) as { status: number; view: { signal_id: string; override_id: string; status: string } };

    // LAYER B gate consulted.
    expect(requireClinicianActorContext).toHaveBeenCalledTimes(1);

    // Elevation to the override recorder role (NOT the evaluator role).
    expect(withDbRole).toHaveBeenCalledWith(
      tx,
      'medication_interaction_override_recorder',
      expect.any(Function),
    );

    // 14-param wrapper call: clinician id DERIVED from the actor; the 8
    // envelope params carry the decoded bytes (no NULLs — migration 047 §3
    // columns are NOT NULL).
    const wrapperCall = tx.query.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'string' &&
        (c[0] as string).startsWith('SELECT record_interaction_signal_override'),
    );
    expect(wrapperCall).toBeDefined();
    const params = wrapperCall![1] as unknown[];
    expect(params).toHaveLength(14);
    expect(params[0]).toBe(FAKE_IDEMPOTENCY_KEY); // override id ← idempotency key
    expect(params[1]).toBe(`${FAKE_IDEMPOTENCY_KEY.slice(0, 25)}T`); // transition id
    expect(params[2]).toBe('Telecheck-US');
    expect(params[3]).toBe(VALID_SIGNAL_ID);
    expect(params[4]).toBe(VALID_CLINICIAN_ID); // from the actor context, not the body
    expect(Buffer.isBuffer(params[5])).toBe(true); // ciphertext
    expect(params[6]).toBe(VALID_DEK_ID);
    expect(Buffer.isBuffer(params[7])).toBe(true); // iv
    expect(Buffer.isBuffer(params[8])).toBe(true); // tag
    expect(params[9]).toBe('AES-256-GCM');
    expect(params[10]).toBe('1');
    expect(Buffer.isBuffer(params[11])).toBe(true); // aad
    expect(params[12]).toBe('2026-07-08T00:00:00.000Z');

    // Two-event Cat A rule: canonical override attestation FIRST (cause),
    // lifecycle transition SECOND (effect).
    expect(emitSignalOverrideRecordedAudit).toHaveBeenCalledTimes(1);
    expect(emitSignalLifecycleTransitionAudit).toHaveBeenCalledTimes(1);
    const overrideOrder = vi.mocked(emitSignalOverrideRecordedAudit).mock.invocationCallOrder[0]!;
    const lifecycleOrder = vi.mocked(emitSignalLifecycleTransitionAudit).mock
      .invocationCallOrder[0]!;
    expect(overrideOrder).toBeLessThan(lifecycleOrder);
    const overrideAudit = vi.mocked(emitSignalOverrideRecordedAudit).mock.calls[0]![0];
    expect(overrideAudit.clinicianAccountId).toBe(VALID_CLINICIAN_ID);
    expect(overrideAudit.overrideId).toBe(FAKE_IDEMPOTENCY_KEY);
    const lifecycleAudit = vi.mocked(emitSignalLifecycleTransitionAudit).mock.calls[0]![0];
    expect(lifecycleAudit.toState).toBe('overridden');
    expect(lifecycleAudit.transitionReason).toBe('override');

    expect(result.status).toBe(201);
    expect(result.view.status).toBe('overridden');
    expect(result.view.override_id).toBe(FAKE_IDEMPOTENCY_KEY);
  });

  it('§2b wrapper rejection (42501 unauthorized_role) propagates with NO audit — absorbed after tx rollback per Sub-decision 8 caller discipline', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      tx.query.mockRejectedValueOnce(
        Object.assign(new Error('unauthorized_role: not an active clinician account'), {
          code: '42501',
        }),
      );
      return fn();
    });
    await expect(
      overrideSignalHandler(
        makeReq({
          body: { override_rationale_envelope: makeWireEnvelope() },
          actorNonce: 'nonce-x',
        }),
        makeReply(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(emitSignalOverrideRecordedAudit).not.toHaveBeenCalled();
    expect(emitSignalLifecycleTransitionAudit).not.toHaveBeenCalled();
  });

  it('§2c wrapper rejection (55000 medication_not_on_list) propagates for the 409 mapper with NO audit', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      tx.query.mockRejectedValueOnce(
        Object.assign(new Error('medication_not_on_list: 1 of 2 medications_involved'), {
          code: '55000',
        }),
      );
      return fn();
    });
    await expect(
      overrideSignalHandler(
        makeReq({
          body: { override_rationale_envelope: makeWireEnvelope() },
          actorNonce: 'nonce-x',
        }),
        makeReply(),
      ),
    ).rejects.toMatchObject({ code: '55000' });
    expect(emitSignalOverrideRecordedAudit).not.toHaveBeenCalled();
    expect(emitSignalLifecycleTransitionAudit).not.toHaveBeenCalled();
  });

  it('§2d non-clinician actor is rejected by the LAYER B gate BEFORE any tx work', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(requireClinicianActorContext).mockImplementation(() => {
      throw Object.assign(new Error('Actor role is not authorized for this endpoint.'), {
        statusCode: 403,
      });
    });
    await expect(
      overrideSignalHandler(
        makeReq({
          body: { override_rationale_envelope: makeWireEnvelope() },
          actorNonce: 'nonce-x',
        }),
        makeReply(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });

  it('§2e missing override_rationale_envelope → 400 BEFORE tx open (migration 047 §3 NOT NULL envelope)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    await expect(
      overrideSignalHandler(makeReq({ body: {}, actorNonce: 'nonce-x' }), makeReply()),
    ).rejects.toThrow(/override_rationale_envelope/);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });

  it('§2f partial envelope (missing tag_b64) → 400 BEFORE tx open', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const partial = makeWireEnvelope();
    delete (partial as Record<string, unknown>)['tag_b64'];
    await expect(
      overrideSignalHandler(
        makeReq({ body: { override_rationale_envelope: partial }, actorNonce: 'nonce-x' }),
        makeReply(),
      ),
    ).rejects.toThrow(/override_rationale_envelope/);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });

  it('§2g body-supplied clinician_account_id is REJECTED (strict body — the clinician is the authenticated actor)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    await expect(
      overrideSignalHandler(
        makeReq({
          body: {
            clinician_account_id: VALID_CLINICIAN_ID,
            override_rationale_envelope: makeWireEnvelope(),
          },
          actorNonce: 'nonce-x',
        }),
        makeReply(),
      ),
    ).rejects.toThrow(/Invalid request body/);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// §3-§4 — fail-closed handlers (resolve, expire) — savepoint-recovered
// rejection attestation + RETURNED 503 (committed audit)
// ===========================================================================

describe('resolveSignalHandler — fail-closed (savepoint-recovered 503)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§3a 0A000: ROLLBACK TO SAVEPOINT + audit-on-rejection + RETURNED 503 envelope (no throw — attestation must commit)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      tx.query.mockRejectedValueOnce(
        Object.assign(new Error('feature_not_supported: washout-period config not yet shipped'), {
          code: '0A000',
        }),
      );
      return fn();
    });
    const result = (await resolveSignalHandler(
      makeReq({
        body: { discontinuation_event_id: VALID_DISCONT_EVENT_ID },
        actorNonce: 'nonce-x',
      }),
      makeReply(),
    )) as { status: number; view: { error: { code: string } } };

    // Savepoint discipline: SAVEPOINT before the attempt, ROLLBACK TO on
    // the rejection (recovers the tx so the attestation can commit).
    const sqlCalls = tx.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(sqlCalls).toContain('SAVEPOINT med_interaction_wrapper_attempt');
    expect(sqlCalls).toContain('ROLLBACK TO SAVEPOINT med_interaction_wrapper_attempt');

    expect(emitSignalLifecycleTransitionAudit).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(emitSignalLifecycleTransitionAudit).mock.calls[0]![0];
    expect(auditArgs.toState).toBe('rejected');
    expect(auditArgs.transitionReason).toMatch(/resolve_rejected_feature_not_supported/);

    expect(result.status).toBe(503);
    expect(result.view.error.code).toBe('med_interaction.resolution_capability_not_yet_available');
  });

  it('§3b 42501 (no GRANT on resolve wrapper per migration 050 §4) converges to the same RETURNED 503 with committed attestation', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      tx.query.mockRejectedValueOnce(
        Object.assign(new Error('EXECUTE permission denied for record_signal_resolution'), {
          code: '42501',
        }),
      );
      return fn();
    });
    const result = (await resolveSignalHandler(
      makeReq({
        body: { discontinuation_event_id: VALID_DISCONT_EVENT_ID },
        actorNonce: 'nonce-x',
      }),
      makeReply(),
    )) as { status: number; view: { error: { code: string } } };
    expect(result.status).toBe(503);
    expect(emitSignalLifecycleTransitionAudit).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(emitSignalLifecycleTransitionAudit).mock.calls[0]![0];
    expect(auditArgs.transitionReason).toMatch(/resolve_rejected_execute_not_granted/);
  });

  it('§3c unexpected errors (e.g. 02000) still propagate to the mapper after the savepoint rollback', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      tx.query.mockRejectedValueOnce(
        Object.assign(new Error('signal_not_found'), { code: '02000' }),
      );
      return fn();
    });
    await expect(
      resolveSignalHandler(
        makeReq({
          body: { discontinuation_event_id: VALID_DISCONT_EVENT_ID },
          actorNonce: 'nonce-x',
        }),
        makeReply(),
      ),
    ).rejects.toMatchObject({ code: '02000' });
    expect(emitSignalLifecycleTransitionAudit).not.toHaveBeenCalled();
  });
});

describe('expireSignalHandler — fail-closed (savepoint-recovered 503)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§4a 0A000: ROLLBACK TO SAVEPOINT + audit-on-rejection + RETURNED 503 envelope', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      tx.query.mockRejectedValueOnce(
        Object.assign(
          new Error('feature_not_supported: per-basis cadence config not yet shipped'),
          { code: '0A000' },
        ),
      );
      return fn();
    });
    const result = (await expireSignalHandler(
      makeReq({ body: {}, actorNonce: 'nonce-x' }),
      makeReply(),
    )) as { status: number; view: { error: { code: string } } };

    const sqlCalls = tx.query.mock.calls.map((c: unknown[]) => c[0]);
    expect(sqlCalls).toContain('SAVEPOINT med_interaction_wrapper_attempt');
    expect(sqlCalls).toContain('ROLLBACK TO SAVEPOINT med_interaction_wrapper_attempt');

    expect(emitSignalLifecycleTransitionAudit).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(emitSignalLifecycleTransitionAudit).mock.calls[0]![0];
    expect(auditArgs.toState).toBe('rejected');
    expect(auditArgs.transitionReason).toContain('expire_rejected');

    expect(result.status).toBe(503);
    expect(result.view.error.code).toBe('med_interaction.expiry_capability_not_yet_available');
  });

  it('§4b 42501 propagates to the mapper (403) after the savepoint rollback — no audit', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      tx.query.mockRejectedValueOnce(
        Object.assign(new Error('tenant scope mismatch'), { code: '42501' }),
      );
      return fn();
    });
    await expect(
      expireSignalHandler(makeReq({ body: {}, actorNonce: 'nonce-x' }), makeReply()),
    ).rejects.toMatchObject({ code: '42501' });
    expect(emitSignalLifecycleTransitionAudit).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// §5 — body-validation precedence (zod fires before tx open)
// ===========================================================================

describe('PR 9 body validation precedence', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§5a supersede missing replacement_evaluation_id → 400 BEFORE tx open', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    await expect(supersedeSignalHandler(makeReq({ body: {} }), makeReply())).rejects.toThrow(
      /Invalid request body/,
    );
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });

  it('§5b resolve missing discontinuation_event_id → 400 BEFORE tx open', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    await expect(resolveSignalHandler(makeReq({ body: {} }), makeReply())).rejects.toThrow(
      /Invalid request body/,
    );
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});
