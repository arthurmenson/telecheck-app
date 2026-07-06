/**
 * post-forms-template-decision.test.ts — unit tests for the Sprint 2 PR 3
 * second WRITE handler:
 *   POST /v1/admin/templates/:template_id/reviews/:review_id/decision
 *
 * **Scope:** unit-mock the composition boundaries (withIdempotentExecution,
 * withTransaction-via-helper, withTenantContext, withActorContext,
 * withDbRole, audit emitter, role + tenant context shims) so the handler's
 * canonical write composition + 42501 error mapping + audit emission are
 * observable + assertable without a real DB.
 *
 * Coverage sections mirror post-forms-template-submit.test.ts §1-§7 plus
 * the decision-specific assertions:
 *
 *   §1 happy path — approve: full composition; withDbRole called with
 *       'admin_template_reviewer' (DIFFERENT from PR 2's
 *       'admin_basic_operator'); SECDEF call uses 5 params including
 *       resolved Idempotency-Key; audit detail carries decision='approve'.
 *   §2 tenant guard fires before idempotency / tx open.
 *   §3 admin-role guard fires before idempotency / tx open.
 *   §4 wrapper-raised 42501 maps to tenant-blind 403 — no tenant ids
 *       leak in the message.
 *   §5 audit emission carries the canonical SI-023 §3 row 3 payload
 *       shape including decision + decision_payload echo.
 *   §6 mapServiceError integration via withIdempotentExecution — 02000
 *       → 404, 40001 → 409, 22023 → 400, 23502 → 400, 42501 → 403; all
 *       envelopes generic + no tenant_id leak.
 *   §7 decision-value branch: approve, reject, request_revision each
 *       flow through correctly; unknown values rejected at zod layer
 *       (400 before tx open).
 *
 * **Out of scope (covered by future integration tests):**
 *   - Real PostgreSQL execution of record_forms_template_admin_decision.
 *   - Real audit_records persistence + hash-chain.
 *   - Cross-tenant isolation under real RLS.
 *   - Real idempotency cache table read/replay.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock hoists ABOVE imports.
vi.mock('../../../../lib/tenant-context.js', () => ({
  requireTenantContext: vi.fn(),
}));
vi.mock('../../../../lib/admin-role.js', () => ({
  requireAdminRole: vi.fn(),
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
  emitTemplateReviewDecisionAudit: vi.fn(),
}));

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requireAdminRole } from '../../../../lib/admin-role.js';
import { resolveActorTenantIdForAudit } from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitTemplateReviewDecisionAudit } from '../../audit.js';

import { postFormsTemplateDecisionHandler } from './post-forms-template-decision.js';

// ---------------------------------------------------------------------------
// Test fixtures.
// ---------------------------------------------------------------------------

const FAKE_TENANT_CTX = {
  tenantId: 'Telecheck-US',
  countryOfCare: 'US',
};
const VALID_TEMPLATE_ID = '01HXYZABCDEFGHJKMNPQRSTVWX'; // 26-char Crockford-base32 ULID
const VALID_REVIEW_ID = '00000000-0000-0000-0000-000000000abc'; // UUID 8-4-4-4-12
const FAKE_IDEMPOTENCY_KEY = '01HXYZIDEMPOTENCYKEY123456';

interface FakeTx {
  query: ReturnType<typeof vi.fn>;
}

function makeFakeTx(): FakeTx {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  };
}

function makeReq(opts?: {
  body?: unknown;
  actorNonce?: string | undefined;
  actorAccountId?: string;
}): FastifyRequest {
  const httpErrors = {
    forbidden: (msg?: string) => Object.assign(new Error(msg ?? 'Forbidden'), { statusCode: 403 }),
    notFound: (msg?: string) => Object.assign(new Error(msg ?? 'Not Found'), { statusCode: 404 }),
    badRequest: (msg?: string) =>
      Object.assign(new Error(msg ?? 'Bad Request'), { statusCode: 400 }),
  };
  return {
    body: opts?.body ?? { decision: 'approve', decision_payload: { review_notes: 'ok' } },
    params: { template_id: VALID_TEMPLATE_ID, review_id: VALID_REVIEW_ID },
    headers: {},
    actorNonce: opts?.actorNonce,
    actorContext: opts?.actorAccountId
      ? { accountId: opts.actorAccountId }
      : { accountId: 'admin-account-fake-id' },
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
  vi.mocked(requireAdminRole).mockReturnValue('platform_admin');
  vi.mocked(resolveActorTenantIdForAudit).mockReturnValue('Telecheck-US');
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
  vi.mocked(emitTemplateReviewDecisionAudit).mockResolvedValue({} as never);
}

// ---------------------------------------------------------------------------
// §1 — happy path (approve)
// ---------------------------------------------------------------------------

describe('postFormsTemplateDecisionHandler §1 — happy path approve', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§1a composes withIdempotentExecution → withTenantContext → withActorContext → withDbRole(admin_template_reviewer) → SECDEF call → audit', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    await postFormsTemplateDecisionHandler(makeReq({ actorNonce: 'nonce-x' }), makeReply());

    expect(requireTenantContext).toHaveBeenCalledTimes(1);
    expect(requireAdminRole).toHaveBeenCalledTimes(1);
    expect(withIdempotentExecution).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withActorContext).toHaveBeenCalledTimes(1);
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(withDbRole).toHaveBeenCalledWith(
      tx,
      'admin_template_reviewer', // critical: distinct from PR 2's admin_basic_operator
      expect.any(Function),
    );
    // SECDEF call inside the withDbRole callback.
    const dbRoleCallback = vi.mocked(withDbRole).mock.calls[0]![2]!;
    await dbRoleCallback();
    expect(tx.query).toHaveBeenCalledWith(
      'SELECT record_forms_template_admin_decision($1, $2, $3, $4::jsonb, $5)',
      [
        'Telecheck-US',
        VALID_REVIEW_ID,
        'approve',
        JSON.stringify({ review_notes: 'ok' }),
        FAKE_IDEMPOTENCY_KEY,
      ],
    );
    expect(emitTemplateReviewDecisionAudit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// §2-§3 — guards fire before tx open
// ---------------------------------------------------------------------------

describe('postFormsTemplateDecisionHandler §2 — tenant guard precedence', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§2a missing tenant context throws BEFORE withIdempotentExecution opens', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('TenantContextMissing');
    });
    await expect(postFormsTemplateDecisionHandler(makeReq(), makeReply())).rejects.toThrow(
      /TenantContextMissing/,
    );
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

describe('postFormsTemplateDecisionHandler §3 — admin role guard precedence', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§3a non-admin actor throws BEFORE withIdempotentExecution opens', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requireAdminRole).mockImplementation(() => {
      throw new Error('AdminRoleRequired');
    });
    await expect(postFormsTemplateDecisionHandler(makeReq(), makeReply())).rejects.toThrow(
      /AdminRoleRequired/,
    );
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — 42501 → 403 tenant-blind
// ---------------------------------------------------------------------------

describe('postFormsTemplateDecisionHandler §4 — wrapper 42501 maps to tenant-blind 403', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§4a 42501 from withDbRole maps to 403 with no tenant identifiers', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const wrapperError = Object.assign(
      new Error(
        'record_forms_template_admin_decision: tenant scope mismatch — actor tenant Telecheck-US does not match wrapper p_tenant_id Telecheck-Ghana',
      ),
      { code: '42501' },
    );
    vi.mocked(withDbRole).mockImplementation(async () => {
      throw wrapperError;
    });

    let thrown: unknown;
    try {
      await postFormsTemplateDecisionHandler(makeReq({ actorNonce: 'nonce-x' }), makeReply());
    } catch (e) {
      thrown = e;
    }
    const errObj = thrown as { statusCode?: number; message?: string };
    expect(errObj.statusCode).toBe(403);
    expect(errObj.message ?? '').not.toContain('Telecheck-US');
    expect(errObj.message ?? '').not.toContain('Telecheck-Ghana');
    expect(errObj.message ?? '').not.toContain('tenant scope mismatch');
    expect(errObj.message ?? '').not.toContain('42501');
    expect(errObj.message ?? '').toMatch(/scope|forbidden|insufficient/i);
  });

  it('§4b non-42501 PG errors propagate UNCHANGED — identity preserved', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const otherErr = Object.assign(new Error('connection terminated'), { code: '57P01' });
    vi.mocked(withDbRole).mockImplementation(async () => {
      throw otherErr;
    });
    let thrown: unknown;
    try {
      await postFormsTemplateDecisionHandler(makeReq({ actorNonce: 'nonce-x' }), makeReply());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(otherErr);
    expect((thrown as { code?: string }).code).toBe('57P01');
    expect((thrown as { statusCode?: number }).statusCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §5 — audit emission payload shape
// ---------------------------------------------------------------------------

describe('postFormsTemplateDecisionHandler §5 — audit emission payload', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§5a audit detail carries decision + decision_payload + actor attribution', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    await postFormsTemplateDecisionHandler(
      makeReq({
        actorNonce: 'nonce-x',
        actorAccountId: 'admin-acct-XYZ',
        body: {
          decision: 'reject',
          decision_payload: { review_notes: 'missing fields', severity: 'high' },
        },
      }),
      makeReply(),
    );
    expect(emitTemplateReviewDecisionAudit).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(emitTemplateReviewDecisionAudit).mock.calls[0]![0];
    expect(auditCall.tenantId).toBe('Telecheck-US');
    expect(auditCall.reviewId).toBe(VALID_REVIEW_ID);
    expect(auditCall.formsTemplateId).toBe(VALID_TEMPLATE_ID);
    expect(auditCall.deciderPrincipalId).toBe('admin-acct-XYZ');
    expect(auditCall.deciderActorTenantId).toBe('Telecheck-US');
    expect(auditCall.decision).toBe('reject');
    expect(auditCall.decisionPayload).toEqual({
      review_notes: 'missing fields',
      severity: 'high',
    });
    expect(auditCall.countryOfCare).toBe('US');
  });
});

// ---------------------------------------------------------------------------
// §6 — mapServiceError envelope coverage (via withIdempotentExecution)
// ---------------------------------------------------------------------------

describe('postFormsTemplateDecisionHandler §6 — mapServiceError envelopes', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§6a mapServiceError fn is wired into withIdempotentExecution + handles 02000/40001/22023/23502/42501', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    await postFormsTemplateDecisionHandler(makeReq({ actorNonce: 'nonce-x' }), makeReply());
    expect(withIdempotentExecution).toHaveBeenCalledTimes(1);
    const mapper = vi.mocked(withIdempotentExecution).mock.calls[0]![2] as (
      err: unknown,
      reply: FastifyReply,
      requestId: string,
    ) => boolean;

    // Each SQLSTATE → its own envelope; all generic, no tenant identifiers.
    const reply = makeReply();
    expect(mapper({ code: '42501', message: 'leak Telecheck-US leak' }, reply, 'req-1')).toBe(true);
    expect(reply.code).toHaveBeenCalledWith(403);
    const sent42501 = vi.mocked(reply.send).mock.calls.at(-1)![0] as {
      error: { code: string; message: string };
    };
    expect(sent42501.error.message).not.toContain('Telecheck-US');

    const reply22023 = makeReply();
    expect(mapper({ code: '22023' }, reply22023, 'req-2')).toBe(true);
    expect(reply22023.code).toHaveBeenCalledWith(400);

    const reply23502 = makeReply();
    expect(mapper({ code: '23502' }, reply23502, 'req-3')).toBe(true);
    expect(reply23502.code).toHaveBeenCalledWith(400);

    const reply02000 = makeReply();
    expect(mapper({ code: '02000' }, reply02000, 'req-4')).toBe(true);
    expect(reply02000.code).toHaveBeenCalledWith(404);

    const reply40001 = makeReply();
    expect(mapper({ code: '40001' }, reply40001, 'req-5')).toBe(true);
    expect(reply40001.code).toHaveBeenCalledWith(409);

    // Unknown SQLSTATE → mapper returns false (let global handler take it).
    const replyUnknown = makeReply();
    expect(mapper({ code: '99999' }, replyUnknown, 'req-6')).toBe(false);

    // Non-pg-error shape → mapper returns false (no `code` key).
    expect(mapper(new Error('plain'), makeReply(), 'req-7')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §7 — decision-value branch
// ---------------------------------------------------------------------------

describe('postFormsTemplateDecisionHandler §7 — decision-value branch', () => {
  beforeEach(() => vi.resetAllMocks());

  it('§7a approve / reject / request_revision each flow through correctly', async () => {
    for (const decision of ['approve', 'reject', 'request_revision'] as const) {
      vi.resetAllMocks();
      const tx = makeFakeTx();
      installDefaultCompositionMocks(tx);
      await postFormsTemplateDecisionHandler(
        makeReq({
          actorNonce: 'nonce-x',
          body: { decision, decision_payload: {} },
        }),
        makeReply(),
      );
      const dbRoleCallback = vi.mocked(withDbRole).mock.calls[0]![2]!;
      await dbRoleCallback();
      const sqlCall = vi
        .mocked(tx.query)
        .mock.calls.find((c) => String(c[0]).includes('record_forms_template_admin_decision'));
      expect(sqlCall).toBeDefined();
      expect(sqlCall![1]![2]).toBe(decision);
      expect(vi.mocked(emitTemplateReviewDecisionAudit).mock.calls[0]![0].decision).toBe(decision);
    }
  });

  it('§7b unknown decision value rejected at zod boundary with 400', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    await expect(
      postFormsTemplateDecisionHandler(makeReq({ body: { decision: 'maybe' } }), makeReply()),
    ).rejects.toThrow(/Invalid request body/);
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});
