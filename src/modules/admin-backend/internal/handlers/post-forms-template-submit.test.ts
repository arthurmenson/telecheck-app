/**
 * post-forms-template-submit.test.ts — unit tests for the Sprint 2 PR 2
 * first WRITE handler POST /v1/admin/templates/:template_id/submit-for-review.
 *
 * **Scope:** unit-mock the composition boundaries (withIdempotentExecution,
 * withTransaction-via-helper, withTenantContext, withActorContext,
 * withDbRole, audit emitter, role + tenant context shims) so the handler's
 * canonical write composition + 42501 error mapping + audit emission are
 * observable + assertable without a real DB.
 *
 * Coverage sections mirror get-crisis-operational-health.test.ts §1-§4
 * plus the additional WRITE-handler specific sections:
 *
 *   §1 happy path — initial_submission: full composition order;
 *       withDbRole('admin_basic_operator') wraps the SECDEF wrapper call;
 *       same-transaction audit emission with path='initial_submission'.
 *   §2 tenant guard fires before idempotency / tx open.
 *   §3 admin-role guard fires before idempotency / tx open.
 *   §4 wrapper-raised tenant-scope-mismatch (42501) maps to tenant-blind
 *       403 — neither tenant ids nor raw SQLSTATE leak in the message.
 *   §5 audit emission carries the canonical SI-023 §3 row 2 payload
 *       shape including the path discriminator + actor attribution
 *       sourced from req.actorContext.
 *   §6 idempotency wrapper integration — withIdempotentExecution receives
 *       request + reply + mapServiceError + body callback; status=201 +
 *       { review_id } returned from the body callback.
 *   §7 revision_resubmission path — handler reads the latest transition
 *       row + emits audit with path='revision_resubmission'.
 *
 * **Out of scope (covered by future integration tests):**
 *   - Real PostgreSQL execution of submit_forms_template_for_admin_review
 *     wrapper LAYER A + LAYER C enforcement (integration test of migration
 *     043 §1).
 *   - Real audit_records persistence + hash-chain.
 *   - Cross-tenant isolation (LAYER C 42501 from the wrapper under real
 *     RLS).
 *   - Real idempotency cache table read/replay.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock hoists ABOVE imports — declare BEFORE the handler is imported
// so the mocks are in place when the handler module evaluates.
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
  emitTemplateSubmittedForReviewAudit: vi.fn(),
}));

// Imports AFTER vi.mock declarations.
import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { requireAdminRole } from '../../../../lib/admin-role.js';
import { resolveActorTenantIdForAudit } from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitTemplateSubmittedForReviewAudit } from '../../audit.js';
import { TemplateStateConflictError } from '../errors.js';

import { postFormsTemplateSubmitHandler } from './post-forms-template-submit.js';

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

const VALID_TEMPLATE_ID = '01HFG6Z3Q8B7H9P2W4V5K6N7T9';
const RETURNED_REVIEW_ID = 'a5b8d3e1-1f2a-4c5d-9e8f-7a6b5c4d3e2f';
const ACTOR_ACCOUNT_ID = '01HFG6Z3Q8B7H9P2W4V5K6N0AA';

interface FakeTx {
  query: ReturnType<typeof vi.fn>;
}

function makeFakeTx(): FakeTx {
  return {
    // Default behavior: the wrapper SELECT returns the review id; the
    // latest-transition SELECT returns initial_submission. Individual
    // tests can override per call via .mockResolvedValueOnce.
    query: vi.fn(async (sql: string) => {
      if (sql.includes('submit_forms_template_for_admin_review')) {
        return { rows: [{ review_id: RETURNED_REVIEW_ID }], rowCount: 1 };
      }
      if (sql.includes('forms_template_admin_review_lifecycle_transition')) {
        return {
          rows: [{ transition_reason: 'initial_submission' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

function makeReq(opts?: {
  actorNonce?: string | undefined;
  actorContext?: { accountId: string } | undefined;
  templateId?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): FastifyRequest {
  const httpErrors = {
    forbidden: (msg?: string) => Object.assign(new Error(msg ?? 'Forbidden'), { statusCode: 403 }),
    notFound: (msg?: string) => Object.assign(new Error(msg ?? 'Not Found'), { statusCode: 404 }),
    badRequest: (msg?: string) =>
      Object.assign(new Error(msg ?? 'Bad Request'), { statusCode: 400 }),
    unauthorized: (msg?: string) =>
      Object.assign(new Error(msg ?? 'Unauthorized'), { statusCode: 401 }),
  };
  return {
    actorNonce: opts?.actorNonce,
    actorContext: opts?.actorContext,
    params: { template_id: opts?.templateId ?? VALID_TEMPLATE_ID },
    body: opts?.body ?? {},
    headers: opts?.headers ?? {},
    id: 'req-test-id-12345',
    server: { httpErrors },
    log: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply {
  return {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as FastifyReply;
}

/**
 * Install pass-through implementations for the composition helpers so the
 * default behavior is: the idempotency wrapper invokes the body callback
 * with a fake tx; withTenantContext + withActorContext call through;
 * withDbRole calls through; the audit emitter returns a fake envelope.
 */
function installDefaultCompositionMocks(tx: FakeTx): void {
  vi.mocked(requireTenantContext).mockReturnValue(
    FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
  );
  vi.mocked(requireAdminRole).mockReturnValue('platform_admin');
  vi.mocked(resolveActorTenantIdForAudit).mockReturnValue(FAKE_TENANT_CTX.tenantId);
  vi.mocked(withIdempotentExecution).mockImplementation(async (_req, _reply, _mapErr, body) => {
    // Pass the fake tx into the body callback + return whatever it
    // returns (mirrors the production helper's success path).
    const idempotencyCtx = {
      tenantId: FAKE_TENANT_CTX.tenantId,
      idempotencyKey: 'fake-idempotency-key',
      endpoint: '/v1/admin/templates/' + VALID_TEMPLATE_ID + '/submit-for-review',
      actorId: ACTOR_ACCOUNT_ID,
      bodyHash: 'fake-body-hash',
    };
    return body(tx as unknown as Parameters<typeof body>[0], idempotencyCtx);
  });
  vi.mocked(withTenantContext).mockImplementation(async (_client, _tenantId, fn) =>
    fn(tx as unknown as Parameters<typeof fn>[0]),
  );
  vi.mocked(withActorContext).mockImplementation(async (_tx, _nonce, fn) => fn());
  vi.mocked(withDbRole).mockImplementation(async (_tx, _role, fn) => fn());
  vi.mocked(emitTemplateSubmittedForReviewAudit).mockResolvedValue({
    audit_id: 'aud_test_envelope',
  } as unknown as Awaited<ReturnType<typeof emitTemplateSubmittedForReviewAudit>>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// §1 — happy path: full composition + initial_submission audit
// ---------------------------------------------------------------------------

describe('postFormsTemplateSubmitHandler §1 — happy path composition (initial_submission)', () => {
  it('§1a invokes requireTenantContext + requireAdminRole, opens idempotent execution, composes withTenantContext → withActorContext → withDbRole, calls the SECDEF wrapper, then emits the Cat A audit', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const req = makeReq({
      actorNonce: 'fake-uuid-v4-nonce',
      actorContext: { accountId: ACTOR_ACCOUNT_ID },
    });

    const result = (await postFormsTemplateSubmitHandler(req, makeReply())) as {
      status: number;
      view: { review_id: string };
    };

    expect(requireTenantContext).toHaveBeenCalledWith(req);
    expect(requireAdminRole).toHaveBeenCalledWith(req);
    expect(withIdempotentExecution).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withTenantContext).toHaveBeenCalledWith(tx, 'Telecheck-US', expect.any(Function));
    expect(withActorContext).toHaveBeenCalledTimes(1);
    expect(withActorContext).toHaveBeenCalledWith(tx, 'fake-uuid-v4-nonce', expect.any(Function));
    expect(withDbRole).toHaveBeenCalledTimes(1);
    expect(withDbRole).toHaveBeenCalledWith(tx, 'admin_basic_operator', expect.any(Function));

    // Two tx.query calls: the SECDEF wrapper + the latest-transition lookup.
    expect(tx.query).toHaveBeenCalledTimes(2);
    const wrapperCall = tx.query.mock.calls[0]!;
    expect(wrapperCall[0]).toBe(
      'SELECT submit_forms_template_for_admin_review($1, $2) AS review_id',
    );
    expect(wrapperCall[1]).toEqual(['Telecheck-US', VALID_TEMPLATE_ID]);

    const transitionLookupCall = tx.query.mock.calls[1]!;
    expect(String(transitionLookupCall[0])).toContain(
      'forms_template_admin_review_lifecycle_transition',
    );
    expect(transitionLookupCall[1]).toEqual(['Telecheck-US', RETURNED_REVIEW_ID]);

    expect(emitTemplateSubmittedForReviewAudit).toHaveBeenCalledTimes(1);

    expect(result).toEqual({ status: 201, view: { review_id: RETURNED_REVIEW_ID } });
  });
});

// ---------------------------------------------------------------------------
// §2 — tenant guard fires before idempotency/tx open
// ---------------------------------------------------------------------------

describe('postFormsTemplateSubmitHandler §2 — tenant guard precedes tx', () => {
  it('§2a requireTenantContext throw aborts before requireAdminRole + withIdempotentExecution are called', async () => {
    vi.mocked(requireTenantContext).mockImplementation(() => {
      throw new Error('tenantContext absent — programming error');
    });

    await expect(postFormsTemplateSubmitHandler(makeReq(), makeReply())).rejects.toThrow(
      /tenantContext absent/,
    );

    expect(requireAdminRole).not.toHaveBeenCalled();
    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §3 — admin-role guard fires before idempotency/tx open
// ---------------------------------------------------------------------------

describe('postFormsTemplateSubmitHandler §3 — admin-role guard precedes tx', () => {
  it('§3a requireAdminRole throw aborts before withIdempotentExecution is called', async () => {
    vi.mocked(requireTenantContext).mockReturnValue(
      FAKE_TENANT_CTX as unknown as ReturnType<typeof requireTenantContext>,
    );
    vi.mocked(requireAdminRole).mockImplementation(() => {
      throw new Error('forbidden: actor lacks admin role');
    });

    await expect(postFormsTemplateSubmitHandler(makeReq(), makeReply())).rejects.toThrow(
      /forbidden/,
    );

    expect(withIdempotentExecution).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// §4 — wrapper raise propagates as tenant-blind 403 (42501 mapping)
//      Parity with get-crisis-operational-health R1 HIGH-1 + R2 MED-1
//      closures: catch wraps the ENTIRE withDbRole call; generic message
//      contains no tenant identifiers.
// ---------------------------------------------------------------------------

describe('postFormsTemplateSubmitHandler §4 — wrapper error mapping (42501 → 403 tenant-blind)', () => {
  it('§4a wrapper-side 42501 (tenant-scope mismatch / no actor bound) maps to 403 with NO tenant identifiers in the message', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    // Simulate wrapper LAYER C raise: tenant scope mismatch.
    const wrapperError = Object.assign(
      new Error(
        'submit_forms_template_for_admin_review: tenant scope mismatch — actor tenant Telecheck-US does not match wrapper p_tenant_id Telecheck-Ghana; cross-tenant submission rejected',
      ),
      { code: '42501' },
    );
    tx.query.mockRejectedValueOnce(wrapperError);

    let thrown: unknown;
    try {
      await postFormsTemplateSubmitHandler(
        makeReq({
          actorNonce: 'fake-nonce',
          actorContext: { accountId: ACTOR_ACCOUNT_ID },
        }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeDefined();
    const errObj = thrown as { statusCode?: number; message?: string };
    expect(errObj.statusCode).toBe(403);
    // Critical I-025 invariant: message must NOT contain tenant identifiers
    // or raw SQLSTATE/wrapper details from the upstream PG error.
    expect(errObj.message ?? '').not.toContain('Telecheck-US');
    expect(errObj.message ?? '').not.toContain('Telecheck-Ghana');
    expect(errObj.message ?? '').not.toContain('tenant scope mismatch');
    expect(errObj.message ?? '').not.toContain('42501');
    expect(errObj.message ?? '').toMatch(/scope|forbidden|insufficient/i);

    // Audit emission MUST NOT fire on the rejected path — the rollback
    // would discard the audit row anyway, but throwing inside the body
    // callback before the audit emit call is the correct fail-closed
    // shape (no audit attempt = no I-003 question).
    expect(emitTemplateSubmittedForReviewAudit).not.toHaveBeenCalled();
  });

  it('§4b non-42501 PG errors propagate UNCHANGED — identity-preserved, code intact, no 4xx statusCode added', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    const otherPgError = Object.assign(new Error('connection terminated unexpectedly'), {
      code: '57P01',
    });
    tx.query.mockRejectedValueOnce(otherPgError);

    let thrown: unknown;
    try {
      await postFormsTemplateSubmitHandler(
        makeReq({
          actorNonce: 'fake-nonce',
          actorContext: { accountId: ACTOR_ACCOUNT_ID },
        }),
        makeReply(),
      );
    } catch (e) {
      thrown = e;
    }

    // Identity-preservation: the unwrapped pg error is what gets thrown.
    // Regressions that re-wrapped would lose .code OR add a 4xx statusCode.
    expect(thrown).toBe(otherPgError);
    expect((thrown as { code?: string }).code).toBe('57P01');
    expect((thrown as { statusCode?: number }).statusCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// §5 — audit emission carries the canonical SI-023 §3 row 2 payload shape
// ---------------------------------------------------------------------------

describe('postFormsTemplateSubmitHandler §5 — audit emission payload', () => {
  it('§5a emits admin.template_submitted_for_review with review_id + forms_template_id + submitter_principal_id + initial_submission path', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await postFormsTemplateSubmitHandler(
      makeReq({
        actorNonce: 'fake-nonce',
        actorContext: { accountId: ACTOR_ACCOUNT_ID },
      }),
      makeReply(),
    );

    expect(emitTemplateSubmittedForReviewAudit).toHaveBeenCalledTimes(1);
    const [auditArgs, txArg] = vi.mocked(emitTemplateSubmittedForReviewAudit).mock.calls[0]!;
    expect(auditArgs).toEqual({
      tenantId: 'Telecheck-US',
      reviewId: RETURNED_REVIEW_ID,
      formsTemplateId: VALID_TEMPLATE_ID,
      submitterPrincipalId: ACTOR_ACCOUNT_ID,
      submitterActorTenantId: 'Telecheck-US',
      countryOfCare: 'US',
      path: 'initial_submission',
    });
    // Same-transaction durability (I-003): tx passed to the emitter is
    // the same business tx used for the SECDEF wrapper call.
    expect(txArg).toBe(tx);
  });

  it('§5b falls back to x-actor-id header when actorContext is absent (legacy Tier 2 shim)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    await postFormsTemplateSubmitHandler(
      makeReq({
        actorNonce: 'fake-nonce',
        actorContext: undefined,
        headers: { 'x-actor-id': 'legacy-header-actor-id' },
      }),
      makeReply(),
    );

    const [auditArgs] = vi.mocked(emitTemplateSubmittedForReviewAudit).mock.calls[0]!;
    expect(auditArgs.submitterPrincipalId).toBe('legacy-header-actor-id');
  });
});

// ---------------------------------------------------------------------------
// §6 — idempotency wrapper integration
// ---------------------------------------------------------------------------

describe('postFormsTemplateSubmitHandler §6 — idempotency wrapper integration', () => {
  it('§6a withIdempotentExecution is invoked with req + reply + mapServiceError + body callback; returns the body callback payload { status: 201, view: { review_id } }', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    const req = makeReq({
      actorNonce: 'fake-nonce',
      actorContext: { accountId: ACTOR_ACCOUNT_ID },
    });
    const reply = makeReply();

    const result = (await postFormsTemplateSubmitHandler(req, reply)) as {
      status: number;
      view: { review_id: string };
    };

    expect(withIdempotentExecution).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(withIdempotentExecution).mock.calls[0]!;
    expect(callArgs[0]).toBe(req);
    expect(callArgs[1]).toBe(reply);
    expect(typeof callArgs[2]).toBe('function'); // mapServiceError
    expect(typeof callArgs[3]).toBe('function'); // body callback

    expect(result.status).toBe(201);
    expect(result.view).toEqual({ review_id: RETURNED_REVIEW_ID });
  });

  it('§6b mapServiceError maps wrapper 02000 → 404 + 40001 → 409 envelopes (tenant-blind; no detail leak)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    // Capture the mapServiceError function passed in to withIdempotentExecution
    // and exercise it directly (the helper wraps it in a try/catch around the
    // body callback; here we test the mapper shape independently).
    let capturedMapper: ((err: unknown, reply: FastifyReply, reqId: string) => boolean) | null =
      null;
    vi.mocked(withIdempotentExecution).mockImplementation(async (_req, _reply, mapErr, _body) => {
      capturedMapper = mapErr;
      return { status: 201, view: { review_id: RETURNED_REVIEW_ID } };
    });

    await postFormsTemplateSubmitHandler(
      makeReq({
        actorNonce: 'fake-nonce',
        actorContext: { accountId: ACTOR_ACCOUNT_ID },
      }),
      makeReply(),
    );

    expect(capturedMapper).not.toBeNull();

    // 02000 not-found → 404
    {
      const reply = makeReply();
      const handled = capturedMapper!({ code: '02000' }, reply, 'req-1');
      expect(handled).toBe(true);
      expect(reply.code).toHaveBeenCalledWith(404);
      const sendBody = vi.mocked(reply.send).mock.calls[0]![0] as {
        error?: { message?: string };
      };
      expect(sendBody.error?.message ?? '').not.toContain('Telecheck-');
    }

    // 40001 already-in-flight → 409
    {
      const reply = makeReply();
      const handled = capturedMapper!({ code: '40001' }, reply, 'req-2');
      expect(handled).toBe(true);
      expect(reply.code).toHaveBeenCalledWith(409);
    }

    // 42501 → 403 (defensive — primary path is the try/catch inside the
    // body, but the mapper covers the case where some future code path
    // throws an unmapped 42501).
    {
      const reply = makeReply();
      const handled = capturedMapper!({ code: '42501' }, reply, 'req-3');
      expect(handled).toBe(true);
      expect(reply.code).toHaveBeenCalledWith(403);
    }

    // Unknown errors propagate (mapper returns false).
    {
      const reply = makeReply();
      const handled = capturedMapper!(new Error('unrelated'), reply, 'req-4');
      expect(handled).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// §7 — revision_resubmission path discriminator
// ---------------------------------------------------------------------------

describe('postFormsTemplateSubmitHandler §7 — revision_resubmission path', () => {
  it('§7a when the latest lifecycle transition is revision_resubmission, audit payload carries path="revision_resubmission"', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);
    // Override the default transition lookup: return revision_resubmission
    // for the latest-transition SELECT (second tx.query call).
    tx.query.mockImplementationOnce(async (sql: string) => {
      // First call: wrapper SELECT — return the review id as usual.
      if (sql.includes('submit_forms_template_for_admin_review')) {
        return { rows: [{ review_id: RETURNED_REVIEW_ID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    tx.query.mockImplementationOnce(async () => ({
      rows: [{ transition_reason: 'revision_resubmission' }],
      rowCount: 1,
    }));

    await postFormsTemplateSubmitHandler(
      makeReq({
        actorNonce: 'fake-nonce',
        actorContext: { accountId: ACTOR_ACCOUNT_ID },
      }),
      makeReply(),
    );

    const [auditArgs] = vi.mocked(emitTemplateSubmittedForReviewAudit).mock.calls[0]!;
    expect(auditArgs.path).toBe('revision_resubmission');
  });
});

// ---------------------------------------------------------------------------
// §8 — PR #205 Codex R1 Finding 1: draft-only state guard
//
//      The wrapper raises 42P17 (invalid_object_state) when the parent
//      template is not in `draft` status or has been soft-deleted. The
//      handler:
//        (a) catches 42P17 inside the same try/catch that wraps the
//            entire withDbRole call (so the catch sees the raw PG error
//            BEFORE the role is restored);
//        (b) logs templateId + tenantId via req.log.warn (server-side
//            only; never echoed in the response per I-025);
//        (c) throws TemplateStateConflictError so the
//            withIdempotentExecution mapServiceError can branch on a
//            typed discriminator and emit a tenant-blind 409;
//        (d) does NOT emit the audit (audit emission is downstream of
//            the wrapper success path; rejected submissions correctly
//            leave no audit row).
// ---------------------------------------------------------------------------

describe('postFormsTemplateSubmitHandler §8 — PR #205 Codex R1 Finding 1: draft-only state guard', () => {
  it('§8a wrapper-side 42P17 (template not in draft) → TemplateStateConflictError thrown + req.log.warn called with templateId+tenantId (server-side only) + no audit emitted', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    // Simulate wrapper draft-only guard raise (migration 052).
    const wrapperError = Object.assign(
      new Error(
        'admin-template-submit-invalid-state: template 01HFG... is not in draft state (status=published, deleted_at=null)',
      ),
      { code: '42P17' },
    );
    tx.query.mockRejectedValueOnce(wrapperError);

    const req = makeReq({
      actorNonce: 'fake-nonce',
      actorContext: { accountId: ACTOR_ACCOUNT_ID },
    });

    let thrown: unknown;
    try {
      await postFormsTemplateSubmitHandler(req, makeReply());
    } catch (e) {
      thrown = e;
    }

    // The handler MUST wrap the raw PG error in a typed conflict so the
    // mapper has a stable discriminator (vs. stringly-typed SQLSTATE
    // comparison only).
    expect(thrown).toBeInstanceOf(TemplateStateConflictError);
    const tsce = thrown as TemplateStateConflictError;
    expect(tsce.code).toBe('template_state_conflict');
    expect(tsce.templateId).toBe(VALID_TEMPLATE_ID);
    expect(tsce.tenantId).toBe('Telecheck-US');

    // Internal logging fires with the discriminators (server-side only).
    const logWarn = (req.log as unknown as { warn: ReturnType<typeof vi.fn> }).warn;
    expect(logWarn).toHaveBeenCalledTimes(1);
    const [logCtx, logMsg] = logWarn.mock.calls[0]!;
    expect(logCtx).toMatchObject({
      template_id: VALID_TEMPLATE_ID,
      tenant_id: 'Telecheck-US',
      pg_sqlstate: '42P17',
    });
    expect(String(logMsg)).toContain('draft state');

    // No audit on the rejected submit path. The wrapper raised inside
    // withDbRole BEFORE the audit emission code runs; the catch
    // converted the raw error into the typed conflict and propagated.
    expect(emitTemplateSubmittedForReviewAudit).not.toHaveBeenCalled();
  });

  it('§8b mapServiceError maps TemplateStateConflictError → 409 with tenant-blind body (no templateId / tenantId leak per I-025)', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    // Capture mapServiceError as in §6b.
    let capturedMapper: ((err: unknown, reply: FastifyReply, reqId: string) => boolean) | null =
      null;
    vi.mocked(withIdempotentExecution).mockImplementation(async (_req, _reply, mapErr, _body) => {
      capturedMapper = mapErr;
      return { status: 201, view: { review_id: RETURNED_REVIEW_ID } };
    });

    await postFormsTemplateSubmitHandler(
      makeReq({
        actorNonce: 'fake-nonce',
        actorContext: { accountId: ACTOR_ACCOUNT_ID },
      }),
      makeReply(),
    );

    expect(capturedMapper).not.toBeNull();

    // Typed error → 409 envelope.
    {
      const reply = makeReply();
      const typedErr = new TemplateStateConflictError(
        VALID_TEMPLATE_ID,
        'Telecheck-US',
        'is not in draft state',
      );
      const handled = capturedMapper!(typedErr, reply, 'req-tsce');
      expect(handled).toBe(true);
      expect(reply.code).toHaveBeenCalledWith(409);

      const sendBody = vi.mocked(reply.send).mock.calls[0]![0] as {
        error?: { code?: string; message?: string };
      };
      expect(sendBody.error?.code).toBe('admin.template_state_conflict');
      // I-025: tenant + template identifiers MUST NOT leak.
      expect(sendBody.error?.message ?? '').not.toContain(VALID_TEMPLATE_ID);
      expect(sendBody.error?.message ?? '').not.toContain('Telecheck-US');
      expect(sendBody.error?.message ?? '').not.toContain('Telecheck-Ghana');
      expect(sendBody.error?.message ?? '').toMatch(/state|draft|refresh/i);
    }

    // Raw 42P17 (defense-in-depth — if a future code path lets the PG
    // error through unwrapped, the mapper still produces the canonical
    // 409 envelope).
    {
      const reply = makeReply();
      const handled = capturedMapper!({ code: '42P17' }, reply, 'req-raw');
      expect(handled).toBe(true);
      expect(reply.code).toHaveBeenCalledWith(409);

      const sendBody = vi.mocked(reply.send).mock.calls[0]![0] as {
        error?: { code?: string; message?: string };
      };
      expect(sendBody.error?.code).toBe('admin.template_state_conflict');
      expect(sendBody.error?.message ?? '').not.toContain(VALID_TEMPLATE_ID);
      expect(sendBody.error?.message ?? '').not.toContain('Telecheck-');
    }
  });

  it('§8c 42501 catch precedes 42P17 catch in error-discrimination order — a tenant-scope error is NEVER re-classified as a state conflict', async () => {
    const tx = makeFakeTx();
    installDefaultCompositionMocks(tx);

    // 42501 + 42P17 are mutually exclusive at the wrapper, but the
    // handler discriminator ordering matters for defense-in-depth
    // against any future code path that conflates them. Pin the
    // ordering by checking that a 42501 raise still maps to forbidden
    // (403), NOT to the state-conflict path.
    const tenantScopeError = Object.assign(new Error('tenant scope mismatch'), { code: '42501' });
    tx.query.mockRejectedValueOnce(tenantScopeError);

    const req = makeReq({
      actorNonce: 'fake-nonce',
      actorContext: { accountId: ACTOR_ACCOUNT_ID },
    });

    let thrown: unknown;
    try {
      await postFormsTemplateSubmitHandler(req, makeReply());
    } catch (e) {
      thrown = e;
    }

    expect((thrown as { statusCode?: number }).statusCode).toBe(403);
    expect(thrown).not.toBeInstanceOf(TemplateStateConflictError);

    // The 42P17 logger MUST NOT fire on a 42501 path — pin this so a
    // future regression that broadens the catch can't silently start
    // logging templateId/tenantId on every forbidden submit.
    const logWarn = (req.log as unknown as { warn: ReturnType<typeof vi.fn> }).warn;
    expect(logWarn).not.toHaveBeenCalled();
  });
});
