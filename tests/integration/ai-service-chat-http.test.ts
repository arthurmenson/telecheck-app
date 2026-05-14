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

describe('ai-service Mode 1 chat — Group A: happy path', () => {
  it('A1 patient JWT + { message } → 200 + canonical FLOOR-020-shaped envelope', async () => {
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
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      ai_chat_session_id: string;
      message_id: string;
      source_type: string;
      ai_workload_type: string;
      autonomy_level: string;
      guardrail_template_id: string;
      model_version: string;
      escalation_triggered: boolean;
      crisis_detected: boolean;
      response_text: string;
      stub_marker: string;
    }>();
    expect(body.ai_chat_session_id.startsWith('aics_')).toBe(true);
    expect(body.message_id.startsWith('aimsg_')).toBe(true);
    expect(body.source_type).toBe('ai');
    expect(body.ai_workload_type).toBe('conversational_assistant');
    expect(body.autonomy_level).toBe('advisory');
    expect(body.guardrail_template_id).toBe('conservative_default');
    expect(body.model_version).toBe('stub-v0');
    expect(body.escalation_triggered).toBe(false);
    expect(body.crisis_detected).toBe(false);
    expect(body.response_text.length).toBeGreaterThan(0);
    expect(body.stub_marker).toBe('pr_b_stub_v0');
  });

  it('A2 patient JWT + { message, session_id } → echoes the supplied session_id', async () => {
    const patient = await insertAccountOfType(US_CTX, 'patient');
    const token = await mintTokenForRole(T_US, patient, 'patient');
    const sessionId = `aics_${ulid()}`;

    const r = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: {
        host: 'heroshealth.com',
        authorization: `Bearer ${token}`,
      },
      payload: { message: 'Follow-up question', session_id: sessionId },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json<{ ai_chat_session_id: string }>().ai_chat_session_id).toBe(sessionId);
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

describe('ai-service Mode 1 chat — Group D: platform-floor wire shape', () => {
  it('D1 stub response always carries source_type=ai + conversational_assistant + advisory (FLOOR-007 + Mode 1 ceiling)', async () => {
    const patient = await insertAccountOfType(US_CTX, 'patient');
    const token = await mintTokenForRole(T_US, patient, 'patient');

    // Hit the endpoint a few times — the canonical envelope fields
    // must NEVER drift to anything outside the Mode 1 cap, even on
    // different inputs.
    const messages = ['short', 'a longer question', 'a final probe'];
    for (const m of messages) {
      const r = await app!.inject({
        method: 'POST',
        url: '/v0/ai/chat',
        headers: { host: 'heroshealth.com', authorization: `Bearer ${token}` },
        payload: { message: m },
      });
      expect(r.statusCode).toBe(200);
      const body = r.json<{
        source_type: string;
        ai_workload_type: string;
        autonomy_level: string;
        guardrail_template_id: string;
      }>();
      // FLOOR-007: no concealment of AI identity.
      expect(body.source_type).toBe('ai');
      // ADR-029 + WORKLOAD_TAXONOMY v5.2 §2: Mode 1 is exactly
      // `conversational_assistant`.
      expect(body.ai_workload_type).toBe('conversational_assistant');
      // AUTONOMY_LEVELS v5.2 + AI-ARCH-001 + I-012: Mode 1 cannot
      // exceed 'advisory'.
      expect(body.autonomy_level).toBe('advisory');
      // AI-GUARD-003: Conservative Default is immutable.
      expect(body.guardrail_template_id).toBe('conservative_default');
    }
  });
});
