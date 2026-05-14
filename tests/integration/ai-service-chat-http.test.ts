/**
 * ai-service-chat-http.test.ts — Mode 1 conversational assistant stub
 * integration tests per TLC-AI PR B.
 *
 * Endpoint: POST /v0/ai/chat
 * Body:    { message: string, session_id?: string }
 *
 * The handler is a STUB at PR B (no real LLM call, no per-response
 * audit emission). The contract under test is:
 *   - Patient JWT + live session → 200 with FLOOR-020-shaped envelope
 *   - Clinician JWT → 403 (Mode 1 is patient-facing)
 *   - Missing / dead JWT → 401
 *   - Body validation: missing/empty/oversize message → 400; bad
 *     session_id type → 400; unexpected fields → 400
 *   - Stub envelope: source_type='ai', ai_workload_type=
 *     'conversational_assistant', autonomy_level='advisory',
 *     guardrail_template_id='conservative_default',
 *     model_version='stub-v0', escalation_triggered=false,
 *     crisis_detected=false, stub_marker='pr_b_stub_v0'
 *   - Tenant scoping per AI_LAYERING v5.2 §9
 *
 * Coverage (4 groups, 8 cases):
 *
 *   Group A — Happy path
 *     A1 patient JWT + body { message } → 200 + canonical envelope
 *     A2 patient JWT + body { message, session_id } → 200 echoes the
 *        session_id (the stub doesn't persist sessions, so the
 *        client can keep multi-turn state across stub responses)
 *
 *   Group B — Auth + role gate
 *     B1 clinician JWT → 403 (Mode 1 is patient-facing per
 *        AI Clinical Assistant Slice PRD §3)
 *     B2 no JWT → 401
 *
 *   Group C — Body validation
 *     C1 missing message → 400
 *     C2 message=empty string → 400
 *     C3 unexpected body field → 400
 *
 *   Group D — Platform-floor wire-shape assertions
 *     D1 stub response NEVER carries source_type other than 'ai'
 *        (FLOOR-007); ai_workload_type is exactly
 *        'conversational_assistant' (canonical); autonomy_level is
 *        capped at 'advisory' (Mode 1 ceiling)
 *
 * Spec references:
 *   - AI Clinical Assistant Slice PRD v1.0 §4.1
 *   - AI_LAYERING v5.2 §2 / §3 / §4 / §6 / §9
 *   - WORKLOAD_TAXONOMY v5.2
 *   - AUTONOMY_LEVELS v5.2
 *   - I-023 / I-025 / I-027
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { config } from '../../src/lib/config.ts';
import { asTenantId, type TenantId } from '../../src/lib/glossary.ts';
import { issueAccessToken } from '../../src/lib/jwt.ts';
import type { TenantContext } from '../../src/lib/tenant-context.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import * as sessionRepo from '../../src/modules/identity/internal/repositories/session-repo.ts';
import {
  asAccountId,
  asSessionId,
  type AccountId,
} from '../../src/modules/identity/internal/types.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';

const T_US = asTenantId(TENANT_US);

const US_CTX: TenantContext = {
  tenantId: T_US,
  displayName: 'Telecheck-US',
  countryOfCare: 'US',
  kmsKeyAlias: 'alias/telecheck-us-data-key',
  consumerDba: 'Heros Health',
  legalEntity: 'Telecheck Health LLC',
  consumerSubdomain: 'heroshealth.com',
};

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

async function insertAccountOfType(
  ctx: TenantContext,
  accountType: 'patient' | 'clinician',
): Promise<AccountId> {
  const accountId = asAccountId(ulid());
  await withTenantContext(ctx.tenantId, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: ctx.tenantId,
        phone_e164: uniquePhone('+1'),
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: ctx.countryOfCare,
        country_of_care: ctx.countryOfCare,
        account_type: accountType,
      },
      async () => {
        /* no-op */
      },
    ),
  );
  return accountId;
}

async function mintTokenForRole(
  tenantId: TenantId,
  accountId: AccountId,
  role: 'patient' | 'clinician',
): Promise<string> {
  const sessionId = asSessionId(ulid());
  await withTenantContext(tenantId, () =>
    sessionRepo.createSession(
      {
        session_id: sessionId,
        tenant_id: tenantId,
        account_id: accountId,
        refresh_token_hash: '0'.repeat(64),
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      async () => {
        /* no-op */
      },
    ),
  );
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: tenantId,
      session_id: sessionId,
      role,
      country_of_care: 'US',
    },
    config.jwtSigningKey,
  );
}

// ===========================================================================
// Group A — Happy path
// ===========================================================================

describe('ai-service Mode 1 chat — Group A: valid input → 503 informational envelope (PR B)', () => {
  // Per Codex PR B R1 CRITICAL + HIGH closures 2026-05-14, the route
  // returns 503 (not a Mode1ChatResponseView) until crisis detection
  // (PR F) + per-response audit (PR E/F) + real LLM provider (PR D)
  // all land. Auth + body validation precede the 503, so a happy-path
  // request lands in the 503 envelope after the gates pass.
  it('A1 patient JWT + { message } → 503 with route-registered informational envelope', async () => {
    const patient = await insertAccountOfType(US_CTX, 'patient');
    const token = await mintTokenForRole(T_US, patient, 'patient');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
      },
      payload: { message: 'What does my latest lab result mean?' },
    });
    expect(r.statusCode).toBe(503);
    const body = r.json<{
      status: string;
      module: string;
      surface: string;
      phase: string;
      pending_message: string;
    }>();
    expect(body.status).toBe('not_ready');
    expect(body.module).toBe('ai-service');
    expect(body.surface).toBe('mode_1_chat');
    expect(body.phase).toBe('route_registered_503_pr_b');
    expect(body.pending_message).toContain('crisis detection');
    expect(body.pending_message).toContain('FLOOR-009');
    expect(body.pending_message).toContain('I-019');
    expect(body.pending_message).toContain('per-response audit');
    expect(body.pending_message).toContain('Anthropic');
    // The 503 envelope intentionally does NOT carry a
    // Mode1ChatResponseView — emitting one would imply an AI
    // response was generated, violating the platform-floor stance.
    expect(body).not.toHaveProperty('source_type');
    expect(body).not.toHaveProperty('response_text');
    expect(body).not.toHaveProperty('ai_chat_session_id');
  });

  it('A2 patient JWT + { message, session_id } → 503 (session_id not validated or echoed)', async () => {
    const patient = await insertAccountOfType(US_CTX, 'patient');
    const token = await mintTokenForRole(T_US, patient, 'patient');
    const clientSessionId = `aics_${ulid()}`;

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
      },
      payload: { message: 'Follow-up question', session_id: clientSessionId },
    });
    expect(r.statusCode).toBe(503);
    const body = r.json<Record<string, unknown>>();
    // Codex PR B R1 MEDIUM-2 closure: client-supplied session_id
    // must NOT be echoed back without tenant/patient validation.
    // The 503 envelope avoids this entirely by not carrying any
    // chat session field.
    expect(body['ai_chat_session_id']).toBeUndefined();
  });
});

// ===========================================================================
// Group B — Auth + role gate
// ===========================================================================

describe('ai-service Mode 1 chat — Group B: auth + role gate', () => {
  it('B1 clinician JWT → 403 (Mode 1 is patient-facing)', async () => {
    const clinician = await insertAccountOfType(US_CTX, 'clinician');
    const token = await mintTokenForRole(T_US, clinician, 'clinician');

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
      },
      payload: { message: 'hi' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('B2 no JWT → 401', async () => {
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: { host: 'heroshealth.com' },
      payload: { message: 'hi' },
    });
    expect(r.statusCode).toBe(401);
  });
});

// ===========================================================================
// Group C — Body validation
// ===========================================================================

describe('ai-service Mode 1 chat — Group C: body validation', () => {
  async function setup() {
    const patient = await insertAccountOfType(US_CTX, 'patient');
    const token = await mintTokenForRole(T_US, patient, 'patient');
    return { token };
  }

  it('C1 missing message → 400', async () => {
    const { token } = await setup();
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(r.statusCode).toBe(400);
  });

  it('C2 message=empty string → 400', async () => {
    const { token } = await setup();
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
      payload: { message: '' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('C3 unexpected body field → 400', async () => {
    const { token } = await setup();
    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
      payload: { message: 'hi', sneaky: 'value' },
    });
    expect(r.statusCode).toBe(400);
  });
});

// ===========================================================================
// Group D — Platform-floor wire-shape assertions
// ===========================================================================

describe('ai-service Mode 1 chat — Group D: platform-floor compliance at 503', () => {
  it('D1 NO AI-labeled response is ever emitted from the route at PR B (CRITICAL + HIGH closures)', async () => {
    const patient = await insertAccountOfType(US_CTX, 'patient');
    const token = await mintTokenForRole(T_US, patient, 'patient');

    // The route MUST never emit a Mode1ChatResponseView-shaped 200
    // at PR B because (a) no I-019 crisis detector has run on the
    // patient's input yet (FLOOR-009 + FLOOR-013 + I-019) and (b)
    // no durable audit record would land for the response (FLOOR-
    // 020). Codex PR B R1 CRITICAL + HIGH closures 2026-05-14.
    //
    // Repeat the request with different inputs to make a "the route
    // accidentally emitted an AI response on input X" regression
    // visible immediately.
    const messages = ['short', 'a longer question', 'a final probe'];
    for (const m of messages) {
      const r = await app!.inject({
        method: 'POST',
        url: '/v0/ai/chat',
        headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
        payload: { message: m },
      });
      expect(r.statusCode).toBe(503);
      const body = r.json<Record<string, unknown>>();
      // FLOOR-007: no concealment of AI identity. The 503 path
      // intentionally avoids this concern by not carrying a
      // source_type field at all — there is no AI response.
      expect(body['source_type']).toBeUndefined();
      // No response_text means no AI-authored content reaches the
      // patient.
      expect(body['response_text']).toBeUndefined();
      // No model_version means no provider attribution leaks.
      expect(body['model_version']).toBeUndefined();
      // No escalation/crisis fields means no false "we checked" claim.
      expect(body['crisis_detected']).toBeUndefined();
      expect(body['escalation_triggered']).toBeUndefined();
    }
  });
});
