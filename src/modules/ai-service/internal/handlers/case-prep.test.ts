/**
 * case-prep.test.ts — unit tests for the Mode 2 case-prep handler
 * (POST /v0/ai/case-prep).
 *
 * **Scope:** unit-mock the surrounding lifecycle helpers
 * (withTenantContext, withActorContext, withIdempotentExecution,
 * runCrisisGate, the LLM provider, the audit emitter) and exercise
 * the handler against an in-memory request/reply pair. Verifies:
 *
 *   §1 Layer B authorization shape — clinician-only, delegate-reject.
 *   §2 Two-stage body validation — minimal shape check pre-gate;
 *      full Zod validation post-gate (R6 H1 pattern from Mode 1 chat).
 *   §3 Crisis-floor preflight (I-019) — gate is called on input;
 *      positive detection returns crisis-bypass envelope WITHOUT
 *      invoking the LLM.
 *   §4 AI-RESIL-001 fail-soft — NullLLMProvider's
 *      LLMProviderUnavailableError maps to the documented
 *      "case-prep temporarily unavailable" envelope, NOT a 5xx.
 *   §5 Canonical AI envelope stamping per CLAUDE.md hard rule for
 *      Mode 2: source_type, ai_workload_type=protocol_execution,
 *      ai_mode=mode_2, autonomy_level=action_with_confirm,
 *      protocol_id + protocol_version present.
 *   §6 Cat A `ai_mode_2_evaluation` audit emission same-tx;
 *      audit-emission failure rolls back via 503
 *      (mode2_case_prep_audit_emission_failed → mapServiceError).
 *
 * **Out of scope (covered by future integration tests):**
 *   - Real PostgreSQL execution + RLS verification.
 *   - End-to-end Fastify route registration + buildApp + inject.
 *   - Crisis-detector NLP accuracy (the gate is mocked here; the
 *     gate's own test suite covers the FLOOR-009 detection paths).
 *   - Real provider integration (NullLLMProvider is the only v0.1
 *     adapter; real adapters land with secrets management).
 *
 * **Why unit-only at v0.1:** the same rationale as Mode 1 chat —
 * the integration-test harness for the AI surface lands when (a)
 * a real provider adapter ships + (b) the protocol-engine slice
 * wires the downstream I-012 confirmation path. Until then, unit
 * coverage pins the handler's composition shape (crisis-gate +
 * provider + audit ordering) at a layer that does not require a
 * live PostgreSQL with the AI conversation-persistence migrations.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks for the foundation helpers. Each test resets the stubs in
// beforeEach so per-test customization is clean.
// ---------------------------------------------------------------------------

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

vi.mock('../../../../lib/auth-context.js', () => ({
  requireActorContext: vi.fn(),
}));

// withIdempotentExecution: pass-through that invokes the body callback
// with a fake tx + a fake idempotencyCtx, then reply-codes the result.
// Service-error mapping is preserved for the audit-failure → 503 path.
vi.mock('../../../../lib/idempotent-handler.js', () => ({
  withIdempotentExecution: vi.fn(
    async (
      _req: FastifyRequest,
      reply: FastifyReply,
      mapServiceError: (err: unknown, reply: FastifyReply, reqId: string) => boolean,
      body: (tx: unknown, idempotencyCtx: unknown) => Promise<{ status: number; view: unknown }>,
    ) => {
      const fakeTx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
      const fakeCtx = {
        tenantId: 'Telecheck-US',
        idempotencyKey: 'idem_test',
        actorId: 'acct_clin_test',
        endpoint: 'POST /v0/ai/case-prep',
        bodyHash: 'hash_test',
      };
      try {
        const result = await body(fakeTx, fakeCtx);
        void (reply as unknown as { code: (n: number) => FastifyReply })
          .code(result.status)
          .send(result.view);
        return reply;
      } catch (err) {
        if (mapServiceError(err, reply, 'req_test')) return reply;
        throw err;
      }
    },
  ),
}));

vi.mock('../../../../lib/idempotency.js', () => ({
  buildIdempotencyCtx: vi.fn(() => ({
    tenantId: 'Telecheck-US',
    idempotencyKey: 'idem_test',
    actorId: 'acct_clin_test',
    endpoint: 'POST /v0/ai/case-prep',
    bodyHash: 'hash_test',
  })),
}));

// Crisis-gate mock — per-test overrideable via crisisOutcome.
let crisisOutcome: { kind: 'crisis' | 'no_crisis'; [k: string]: unknown } = { kind: 'no_crisis' };
const crisisGateCalls: unknown[] = [];
vi.mock('../crisis/gate.js', () => ({
  runCrisisGate: vi.fn(async (ctx: unknown, _text: string, source: string) => {
    crisisGateCalls.push({ ctx, source });
    return crisisOutcome;
  }),
}));

// Provider mock — by default the real NullLLMProvider's behavior
// (always throws LLMProviderUnavailableError). Tests can swap.
import {
  LLMProviderUnavailableError,
  LLMRequestValidationError,
} from '../providers/types.js';

let providerBehavior: 'unavailable' | 'success' | 'unknown_throw' = 'unavailable';
vi.mock('../providers/null-provider.js', async () => {
  const { LLMProviderUnavailableError: Err } = await import('../providers/types.js');
  return {
    NullLLMProvider: class {
      readonly name = 'null' as const;
      // eslint-disable-next-line @typescript-eslint/require-await
      async sendCompletion(_req: unknown): Promise<{
        text: string;
        provider_name: 'null';
        model: string;
        model_version: string;
        usage: { input_tokens: number; output_tokens: number };
      }> {
        if (providerBehavior === 'unavailable') {
          throw new Err('null', 'mocked unavailable');
        }
        if (providerBehavior === 'unknown_throw') {
          throw new Error('mocked unknown error class');
        }
        return {
          text: 'mocked recommendation',
          provider_name: 'null',
          model: 'mock-model',
          model_version: 'mock-version',
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      }
      // eslint-disable-next-line @typescript-eslint/require-await
      async healthcheck(): Promise<{ healthy: boolean; reason?: string }> {
        return { healthy: false, reason: 'mocked' };
      }
    },
  };
});

// Audit emitter mock — per-test toggleable to simulate emission
// success (default) vs failure (503 path).
let auditEmitterShouldThrow = false;
const auditCalls: unknown[] = [];
vi.mock('../../audit.js', () => ({
  emitMode2CasePrepResponseAudit: vi.fn(async (args: unknown, _tx: unknown) => {
    auditCalls.push(args);
    if (auditEmitterShouldThrow) {
      throw new Error('mocked audit-emission failure');
    }
    return { id: 'audit_test', timestamp: new Date().toISOString() };
  }),
}));

// glossary.asTenantId is just a brand cast — pass through.
vi.mock('../../../../lib/glossary.js', () => ({
  asTenantId: (s: string) => s,
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks are registered).
// ---------------------------------------------------------------------------

import { requireActorContext } from '../../../../lib/auth-context.js';
import { mode2CasePrepHandler } from './case-prep.js';

const requireActorContextMock = vi.mocked(requireActorContext);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { ActorContext } from '../../../../lib/auth-context.js';
import type { TenantId } from '../../../../lib/glossary.js';

function makeClinicianActor(): ActorContext {
  return {
    accountId: 'acct_clin_test',
    sessionId: 'sess_test',
    tenantId: 'Telecheck-US' as unknown as TenantId,
    role: 'clinician',
    countryOfCare: 'US',
    delegateId: null,
    adminTenantBinding: null,
    adminHomeTenantId: null,
  };
}

function makeReq(opts?: { body?: unknown }): FastifyRequest {
  const body = opts?.body ?? {
    consult_id: 'cons_test_01',
    protocol_id: 'glp1.v1',
    protocol_version: '1.0.0',
    patient_id: 'pat_test_01',
    context: { chief_complaint: 'fatigue', current_medications: [] },
  };
  return {
    body,
    id: 'req_test',
    log: { warn: vi.fn(), error: vi.fn() },
    server: {
      httpErrors: {
        badRequest: (msg: string) => {
          const e = new Error(msg) as Error & { statusCode: number };
          e.statusCode = 400;
          return e;
        },
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
  crisisOutcome = { kind: 'no_crisis' };
  providerBehavior = 'unavailable';
  auditEmitterShouldThrow = false;
  crisisGateCalls.length = 0;
  auditCalls.length = 0;
  requireActorContextMock.mockReturnValue(makeClinicianActor());
});

// ===========================================================================
// §1 — Layer B authorization
// ===========================================================================

describe('mode2CasePrepHandler §1 — Layer B authorization', () => {
  it('rejects a patient actor with 403 (Mode 2 is clinician-only)', async () => {
    requireActorContextMock.mockReturnValueOnce({
      ...makeClinicianActor(),
      role: 'patient',
    });
    const req = makeReq();
    const { reply } = makeReply();
    await expect(mode2CasePrepHandler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('clinician-only'),
    });
  });

  it('rejects a tenant_admin actor with 403', async () => {
    requireActorContextMock.mockReturnValueOnce({
      ...makeClinicianActor(),
      role: 'tenant_admin',
    });
    const req = makeReq();
    const { reply } = makeReply();
    await expect(mode2CasePrepHandler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('rejects a delegate clinician session with 403', async () => {
    requireActorContextMock.mockReturnValueOnce({
      ...makeClinicianActor(),
      delegateId: 'del_test',
    });
    const req = makeReq();
    const { reply } = makeReply();
    await expect(mode2CasePrepHandler(req, reply)).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringContaining('delegated sessions'),
    });
  });
});

// ===========================================================================
// §2 — Two-stage body validation
// ===========================================================================

describe('mode2CasePrepHandler §2 — body validation', () => {
  it('rejects a body missing consult_id with 400 (stage 1 shape check)', async () => {
    const req = makeReq({
      body: {
        protocol_id: 'glp1.v1',
        protocol_version: '1.0.0',
        patient_id: 'pat_test_01',
        context: {},
      },
    });
    const { reply } = makeReply();
    await expect(mode2CasePrepHandler(req, reply)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('consult_id'),
    });
  });

  it('rejects a body with non-object context with 400', async () => {
    const req = makeReq({
      body: {
        consult_id: 'cons_test_01',
        protocol_id: 'glp1.v1',
        protocol_version: '1.0.0',
        patient_id: 'pat_test_01',
        context: 'not_an_object',
      },
    });
    const { reply } = makeReply();
    await expect(mode2CasePrepHandler(req, reply)).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('context (object)'),
    });
  });

  it('rejects an array context with 400 (arrays are objects in JS but not valid here)', async () => {
    const req = makeReq({
      body: {
        consult_id: 'cons_test_01',
        protocol_id: 'glp1.v1',
        protocol_version: '1.0.0',
        patient_id: 'pat_test_01',
        context: [],
      },
    });
    const { reply } = makeReply();
    await expect(mode2CasePrepHandler(req, reply)).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

// ===========================================================================
// §3 — Crisis-floor preflight (I-019)
// ===========================================================================

describe('mode2CasePrepHandler §3 — crisis-floor preflight', () => {
  it('always invokes runCrisisGate on input with ai_case_prep_input source', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await mode2CasePrepHandler(req, reply);
    expect(crisisGateCalls).toHaveLength(1);
    expect(crisisGateCalls[0]).toMatchObject({
      source: 'ai_case_prep_input',
    });
  });

  it('passes auditDedupeDiscriminator=context_serialized to the gate (required for case-prep)', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await mode2CasePrepHandler(req, reply);
    const call = crisisGateCalls[0] as { ctx: { auditDedupeDiscriminator?: string } };
    expect(call.ctx.auditDedupeDiscriminator).toBe('context_serialized');
  });

  it('passes ai_workflow_execution resourceType (Mode 2) to the gate', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await mode2CasePrepHandler(req, reply);
    const call = crisisGateCalls[0] as { ctx: { resourceType: string } };
    expect(call.ctx.resourceType).toBe('ai_workflow_execution');
  });

  it('returns crisis-bypass envelope without calling the LLM on positive detection', async () => {
    crisisOutcome = {
      kind: 'crisis',
      crisis_type: 'self_harm',
      detection_source: 'ai_case_prep_input',
      audit_emitted: true,
    };
    providerBehavior = 'success'; // would return a recommendation if called
    const req = makeReq();
    const { reply, sent } = makeReply();
    await mode2CasePrepHandler(req, reply);
    expect(sent.code).toBe(200);
    const body = sent.body as {
      crisis_detected: boolean;
      escalation_triggered: boolean;
      ai_model_version: string;
      recommendation: string;
    };
    expect(body.crisis_detected).toBe(true);
    expect(body.escalation_triggered).toBe(true);
    expect(body.ai_model_version).toBe('crisis-bypass:no-llm-call');
    expect(body.recommendation).toContain('halted');
  });
});

// ===========================================================================
// §4 — AI-RESIL-001 fail-soft + provider unknown-error pass-through
// ===========================================================================

describe('mode2CasePrepHandler §4 — provider abstraction', () => {
  it('maps LLMProviderUnavailableError to documented fail-soft envelope (NOT a 5xx)', async () => {
    providerBehavior = 'unavailable';
    const req = makeReq();
    const { reply, sent } = makeReply();
    await mode2CasePrepHandler(req, reply);
    expect(sent.code).toBe(200);
    const body = sent.body as {
      ai_model_version: string;
      recommendation: string;
      crisis_detected: boolean;
    };
    expect(body.ai_model_version).toBe('null-provider:unavailable');
    expect(body.recommendation).toContain('temporarily unavailable');
    expect(body.crisis_detected).toBe(false);
  });

  it('re-throws unknown error classes (NOT LLMProviderUnavailableError) up to Fastify', async () => {
    providerBehavior = 'unknown_throw';
    const req = makeReq();
    const { reply } = makeReply();
    await expect(mode2CasePrepHandler(req, reply)).rejects.toThrow('mocked unknown error class');
  });

  it('the LLMRequestValidationError class is still importable from providers (sanity)', () => {
    // Smoke check: the type contract is stable. Codex PR D R1 closure
    // preserves LLMRequestValidationError as a 4xx-mapping signal.
    expect(LLMRequestValidationError).toBeDefined();
    expect(LLMProviderUnavailableError).toBeDefined();
  });
});

// ===========================================================================
// §5 — Canonical AI envelope per CLAUDE.md hard rule (Mode 2 specifically)
// ===========================================================================

describe('mode2CasePrepHandler §5 — AI envelope stamping', () => {
  it('stamps the canonical Mode 2 envelope fields (source_type, ai_workload_type, ai_mode, autonomy_level)', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await mode2CasePrepHandler(req, reply);
    expect(sent.body).toMatchObject({
      source_type: 'ai',
      ai_workload_type: 'protocol_execution',
      ai_mode: 'mode_2',
      autonomy_level: 'action_with_confirm',
    });
  });

  it('echoes protocol_id and protocol_version on the envelope (Mode 2 audit field — NOT guardrail_template_id)', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await mode2CasePrepHandler(req, reply);
    const body = sent.body as Record<string, unknown>;
    expect(body['protocol_id']).toBe('glp1.v1');
    expect(body['protocol_version']).toBe('1.0.0');
    // CLAUDE.md hard rule: Mode 2 stamps protocol_id+protocol_version,
    // NOT guardrail_template_id (that's Mode 1's field).
    expect(body['guardrail_template_id']).toBeUndefined();
  });

  it('echoes consult_id and patient_id on the envelope (Mode 2 audit anchor pair)', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await mode2CasePrepHandler(req, reply);
    const body = sent.body as Record<string, unknown>;
    expect(body['consult_id']).toBe('cons_test_01');
    expect(body['patient_id']).toBe('pat_test_01');
  });

  it('emits a deterministic ai_workflow_execution_id with the aiwfe_ prefix', async () => {
    const req = makeReq();
    const { reply, sent } = makeReply();
    await mode2CasePrepHandler(req, reply);
    const body = sent.body as { ai_workflow_execution_id: string };
    expect(body.ai_workflow_execution_id).toMatch(/^aiwfe_[0-9a-f]{26}$/);
  });
});

// ===========================================================================
// §6 — Cat A audit emission + audit-failure → 503
// ===========================================================================

describe('mode2CasePrepHandler §6 — audit emission', () => {
  it('emits ai_mode_2_evaluation audit with the canonical envelope detail', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await mode2CasePrepHandler(req, reply);
    expect(auditCalls).toHaveLength(1);
    const call = auditCalls[0] as {
      tenantId: string;
      targetPatientId: string;
      detail: {
        ai_mode: string;
        protocol_id: string;
        protocol_version: string;
        crisis_detected: boolean;
        provider_unavailable: boolean;
      };
    };
    expect(call.tenantId).toBe('Telecheck-US');
    expect(call.targetPatientId).toBe('pat_test_01');
    expect(call.detail.ai_mode).toBe('mode_2');
    expect(call.detail.protocol_id).toBe('glp1.v1');
    expect(call.detail.protocol_version).toBe('1.0.0');
    expect(call.detail.crisis_detected).toBe(false);
    expect(call.detail.provider_unavailable).toBe(true);
  });

  it('maps audit-emission failure to a tenant-blind 503 via mapServiceError', async () => {
    auditEmitterShouldThrow = true;
    const req = makeReq();
    const { reply, sent } = makeReply();
    await mode2CasePrepHandler(req, reply);
    expect(sent.code).toBe(503);
    const body = sent.body as { error: { code: string; message: string; request_id: string } };
    expect(body.error.code).toBe('ai_case_prep.audit_emission_unavailable');
    expect(body.error.message).toContain('temporarily unable to record');
    // I-025: error envelope is tenant-blind (no tenant_id field).
    expect((body.error as unknown as { tenant_id?: unknown }).tenant_id).toBeUndefined();
  });

  it('records context_length and recommendation_length on audit detail (not raw text)', async () => {
    const req = makeReq();
    const { reply } = makeReply();
    await mode2CasePrepHandler(req, reply);
    const call = auditCalls[0] as {
      detail: { context_length: number; recommendation_length: number };
    };
    expect(call.detail.context_length).toBeGreaterThan(0);
    expect(call.detail.recommendation_length).toBeGreaterThan(0);
    // Audit detail does NOT carry raw input/output text (I-025 + audit
    // policy). The lengths are the only quantitative signal.
    expect(Object.keys(call.detail)).not.toContain('context');
    expect(Object.keys(call.detail)).not.toContain('recommendation_text');
  });
});
