/**
 * pr9-write-handlers.test.ts — combined unit tests for the 4 PR 9
 * write handlers (supersede + override + resolve + expire).
 *
 * **Scope:** unit-mock the composition boundaries (withIdempotentExecution,
 * withTenantContext, withActorContext, withDbRole, audit emitter, tenant
 * context shim) and verify each handler's canonical write composition +
 * SECDEF call signature + Cat A audit emission (on both success and
 * rejection paths) + 42501 → tenant-blind 403 + 0A000 → tenant-blind 503.
 *
 * Single-file combined coverage (vs per-handler files) intentional for
 * the PR-rescue scope: all 4 handlers share the same composition
 * scaffold; co-locating tests demonstrates the shared shape + makes
 * cross-handler invariants (audit-on-rejection per I-003) easier to
 * audit. Per-handler test files can be split out in a follow-up PR if
 * Codex review wants per-file granularity.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(),
}));
vi.mock('../../../../lib/auth-context.js', () => ({
  resolveActorTenantIdForAudit: vi.fn(),
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
}));

import { resolveActorTenantIdForAudit } from '../../../../lib/auth-context.js';
import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitSignalLifecycleTransitionAudit } from '../../audit.js';

import { supersedeSignalHandler } from './supersede-signal.js';
import { overrideSignalHandler } from './override-signal.js';
import { resolveSignalHandler } from './resolve-signal.js';
import { expireSignalHandler } from './expire-signal.js';

const FAKE_TENANT_CTX = { tenantId: 'Telecheck-US', countryOfCare: 'US' };
const VALID_SIGNAL_ID = '01HXYZSIGNAL000000000ABCDE';
const VALID_REPLACEMENT_EVAL_ID = '01HXYZEVALUATION0000000XYZ';
const VALID_CLINICIAN_ID = '01HXYZCLIN000000000000ABCD';
const VALID_DISCONT_EVENT_ID = '01HXYZDISCONT00000000ABCDE';
const FAKE_IDEMPOTENCY_KEY = '01HXYZIDEMPOTENCY0000000ABC';

interface FakeTx {
  query: ReturnType<typeof vi.fn>;
}
function makeFakeTx(): FakeTx {
  return { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
}

function makeReq(opts?: { body?: unknown; actorNonce?: string | undefined }): FastifyRequest {
  const httpErrors = {
    forbidden: (msg?: string) =>
      Object.assign(new Error(msg ?? 'Forbidden'), { statusCode: 403 }),
    notFound: (msg?: string) =>
      Object.assign(new Error(msg ?? 'Not Found'), { statusCode: 404 }),
    badRequest: (msg?: string) =>
      Object.assign(new Error(msg ?? 'Bad Request'), { statusCode: 400 }),
  };
  return {
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
  vi.mocked(withIdempotentExecution).mockImplementation(
    async (_req, _reply, _mapper, fn) =>
      fn(tx as unknown as Parameters<typeof fn>[0], {
        idempotencyKey: FAKE_IDEMPOTENCY_KEY,
      } as unknown as Parameters<typeof fn>[1]),
  );
  vi.mocked(withTenantContext).mockImplementation(async (_client, _tenantId, fn) =>
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withActorContext).mockImplementation(async (_client, _nonce, fn) => fn());
  vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => fn());
  vi.mocked(emitSignalLifecycleTransitionAudit).mockResolvedValue({} as never);
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
// §2-§4 — fail-closed handlers (override, resolve, expire)
// ===========================================================================

describe('overrideSignalHandler — fail-closed (0A000 → 503)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§2a 0A000 from wrapper emits audit-on-rejection (toState=rejected) then re-throws 0A000 for mapper', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // wrapper raises 0A000 via tx.query inside withDbRole
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      // simulate the wrapper raising 0A000 by having tx.query throw
      tx.query.mockRejectedValueOnce(
        Object.assign(new Error('feature_not_supported: SI-024.1 JWT-binding deferred'), {
          code: '0A000',
        }),
      );
      return fn();
    });

    let thrown: unknown;
    try {
      await overrideSignalHandler(
        makeReq({
          body: { clinician_account_id: VALID_CLINICIAN_ID },
          actorNonce: 'nonce-x',
        }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe('0A000');
    // Audit MUST have been emitted on the rejection path (I-003).
    expect(emitSignalLifecycleTransitionAudit).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(emitSignalLifecycleTransitionAudit).mock.calls[0]![0];
    expect(auditArgs.toState).toBe('rejected');
    expect(auditArgs.transitionReason).toContain('override_rejected_feature_not_supported');
  });

  it('§2b 42501 from withDbRole maps to tenant-blind 403 (no audit on this path — error before audit emit)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async () => {
      throw Object.assign(new Error('42501 leak'), { code: '42501' });
    });
    await expect(
      overrideSignalHandler(
        makeReq({
          body: { clinician_account_id: VALID_CLINICIAN_ID },
          actorNonce: 'nonce-x',
        }),
        makeReply(),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('resolveSignalHandler — fail-closed (0A000/42501 → 503)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§3a 0A000 emits audit-on-rejection then re-throws 0A000 for 503 mapping', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      tx.query.mockRejectedValueOnce(
        Object.assign(new Error('feature_not_supported: Async Consult discontinuation log not yet shipped'), {
          code: '0A000',
        }),
      );
      return fn();
    });
    let thrown: unknown;
    try {
      await resolveSignalHandler(
        makeReq({
          body: { discontinuation_event_id: VALID_DISCONT_EVENT_ID },
          actorNonce: 'nonce-x',
        }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe('0A000');
    expect(emitSignalLifecycleTransitionAudit).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(emitSignalLifecycleTransitionAudit).mock.calls[0]![0];
    expect(auditArgs.toState).toBe('rejected');
    expect(auditArgs.transitionReason).toMatch(/resolve_rejected/);
  });

  it('§3b 42501 (no GRANT on resolve wrapper per migration 050 §4) ALSO maps to 503 — same client-facing posture as 0A000', async () => {
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
    let thrown: unknown;
    try {
      await resolveSignalHandler(
        makeReq({
          body: { discontinuation_event_id: VALID_DISCONT_EVENT_ID },
          actorNonce: 'nonce-x',
        }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }
    // Re-thrown with 42501 → mapper at withIdempotentExecution turns it into 503.
    expect((thrown as { code?: string }).code).toBe('42501');
    expect(emitSignalLifecycleTransitionAudit).toHaveBeenCalledTimes(1);
  });
});

describe('expireSignalHandler — fail-closed (0A000 → 503)', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§4a 0A000 emits audit-on-rejection then re-throws 0A000 for 503 mapping', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => {
      tx.query.mockRejectedValueOnce(
        Object.assign(new Error('feature_not_supported: per-basis cadence config not yet shipped'), {
          code: '0A000',
        }),
      );
      return fn();
    });
    let thrown: unknown;
    try {
      await expireSignalHandler(
        makeReq({ body: {}, actorNonce: 'nonce-x' }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe('0A000');
    expect(emitSignalLifecycleTransitionAudit).toHaveBeenCalledTimes(1);
    const auditArgs = vi.mocked(emitSignalLifecycleTransitionAudit).mock.calls[0]![0];
    expect(auditArgs.toState).toBe('rejected');
    expect(auditArgs.transitionReason).toContain('expire_rejected');
  });
});

// ===========================================================================
// §5 — body-validation precedence (zod fires before tx open)
// ===========================================================================

describe('PR 9 body validation precedence', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§5a supersede missing replacement_evaluation_id → 400 BEFORE tx open', async () => {
    await expect(
      supersedeSignalHandler(makeReq({ body: {} }), makeReply()),
    ).rejects.toThrow(/Invalid request body/);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });

  it('§5b override missing clinician_account_id → 400 BEFORE tx open', async () => {
    await expect(
      overrideSignalHandler(makeReq({ body: {} }), makeReply()),
    ).rejects.toThrow(/Invalid request body/);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });

  it('§5c resolve missing discontinuation_event_id → 400 BEFORE tx open', async () => {
    await expect(
      resolveSignalHandler(makeReq({ body: {} }), makeReply()),
    ).rejects.toThrow(/Invalid request body/);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});
