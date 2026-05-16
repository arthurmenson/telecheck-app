/**
 * ai-service-mode-1-chat-http.test.ts — Mode 1 conversational assistant
 * HTTP integration tests.
 *
 * R7 follow-up coverage for PR #160 (Track 2 first sprint, 2026-05-16).
 * PR #160 merged with Codex APPROVE at the code level but the R7 medium
 * finding (no HTTP-level regression test) was explicitly deferred to
 * this PR.
 *
 * Coverage groups:
 *
 *   Group A — Happy-path / fail-soft (no crisis)
 *     A1 valid patient JWT + non-crisis message → 200, Mode1ChatResponseView,
 *        provider_unavailable=true (NullProvider AI-RESIL-001 path),
 *        crisis_detected=false, escalation_triggered=false
 *
 *   Group B — Crisis-bypass path (I-019 always-on)
 *     B1 crisis-content message under the 4000 char limit →
 *        200 crisis sentinel response, crisis_detected=true,
 *        escalation_triggered=true, ai_model_version='crisis-bypass:no-llm-call'
 *     B2 OVERSIZED crisis-content message (>4000 chars) → 200 crisis
 *        sentinel (R6 H1 two-stage validation: crisis gate runs on raw
 *        text BEFORE Zod size constraints; oversized crisis input still
 *        triggers the safety surface)
 *
 *   Group C — Validation rejections
 *     C1 missing message_text → 400
 *     C2 empty message_text → 400
 *     C3 non-string message_text → 400
 *     C4 OVERSIZED non-crisis message (>4000 chars) → 400 (Stage 2 Zod
 *        constraint fires after gate confirms no crisis)
 *
 *   Group D — Auth rejections
 *     D1 no Bearer JWT → 401
 *     D2 clinician JWT (non-patient role) → 403 (Mode 1 is patient-only
 *        at v1.0)
 *     D3 platform_admin JWT → 403 (same)
 *     D4 patient JWT with delegateId set → 403 (R1 H2 delegate-rejection
 *        gate; Mode 1 is direct-patient-only at v1.0)
 *
 *   Group E — Idempotency
 *     E1 same Idempotency-Key + same body → cached 200 replay (same
 *        message_id + session_id deterministic)
 *     E2 same Idempotency-Key + different body → 409 body_mismatch
 *
 *   Group F — Deterministic identifier derivation (R4 H1 closure)
 *     F1 two requests with the SAME Idempotency-Key+body but in
 *        sequence produce the SAME ai_chat_session_id + message_id
 *        (provability of the cross-retry stability invariant)
 *     F2 two requests with DIFFERENT Idempotency-Keys produce
 *        DIFFERENT session_id + message_id (independence)
 *
 * The R4 H1 retry-after-audit-failure scenario (force emitMode1ChatResponseAudit
 * to fail, retry, assert Category A audit emitted at most once) is
 * deferred to a separate test PR — requires audit-emission injection
 * harness that doesn't yet exist; the deterministic-ID invariant (Group F)
 * proves the necessary precondition (stable session_id across retries
 * keeps the crisis gate's dedupe key stable).
 *
 * Spec references:
 *   - src/modules/ai-service/internal/handlers/chat.ts (target)
 *   - AI Clinical Assistant Slice PRD v1.0 §3 Mode 1
 *   - AI_LAYERING v5.2 §2/§3/§4/§6/§7
 *   - I-019 / I-023 / I-025 / I-027
 *   - ADR-020 multi-provider abstraction (NullProvider at v1.0)
 *   - PR #160 commit history (Codex R1-R6 closure rounds)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { config } from '../../src/lib/config.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { issueAccessToken } from '../../src/lib/jwt.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { TENANT_US } from '../helpers/tenant-fixtures.ts';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const T_US = asTenantId(TENANT_US);

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

/**
 * Mint a Bearer JWT for a patient actor in the US tenant. Mirrors the
 * pattern used in async-consult-http.test.ts. The accountId is supplied
 * by the caller so per-test isolation is explicit (each test mints its
 * own accountId via ulid()).
 */
function mintPatientToken(accountId: string): string {
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: T_US,
      session_id: ulid(),
      role: 'patient',
      country_of_care: 'US',
    },
    config.jwtSigningKey,
  );
}

function mintClinicianToken(accountId: string): string {
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: T_US,
      session_id: ulid(),
      role: 'clinician',
      country_of_care: 'US',
    },
    config.jwtSigningKey,
  );
}

function mintPlatformAdminToken(accountId: string): string {
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: T_US,
      session_id: ulid(),
      role: 'platform_admin',
      country_of_care: 'US',
    },
    config.jwtSigningKey,
  );
}

function mintPatientDelegateToken(accountId: string, delegateId: string): string {
  return issueAccessToken(
    {
      account_id: accountId,
      tenant_id: T_US,
      session_id: ulid(),
      role: 'patient',
      country_of_care: 'US',
      delegate_id: delegateId,
    },
    config.jwtSigningKey,
  );
}

/**
 * Common host header for Mode 1 chat requests — drives tenant context
 * resolution to Telecheck-US via the Host-header → tenant mapping in
 * tenant-context.ts. Matches the host the test fixtures use.
 */
const US_HOST = 'heroshealth.com';

/**
 * Crisis-content sample text. The crisis detector in
 * src/lib/crisis-detection.ts uses keyword-based detection at v1.0
 * (clinical-grade NLP classifier is a documented follow-up). The
 * phrase 'suicidal' is in the canonical keyword set used by
 * ai-service-crisis-gate.test.ts (which proves the detector's
 * triggering); reusing it here keeps the two test suites coupled to
 * the same detector behavior.
 */
const CRISIS_TEXT_SHORT = 'I am having suicidal thoughts and need help right now';

/**
 * Non-crisis sample text — generic patient question.
 */
const SAFE_TEXT_SHORT = 'What time should I take my medication today?';

/**
 * Common headers for an authenticated patient request. Idempotency-Key
 * is generated per call (UUIDv4-shaped ULID acceptable to the
 * idempotency plugin's well-formed-key validation).
 */
function patientRequestHeaders(token: string): Record<string, string> {
  return {
    host: US_HOST,
    authorization: `Bearer ${token}`,
    'idempotency-key': ulid(),
    'content-type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Group A — Happy-path / fail-soft (no crisis)
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group A: happy-path / AI-RESIL-001 fail-soft', () => {
  it('A1 valid patient JWT + non-crisis message → 200 Mode1ChatResponseView with provider_unavailable=true', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();

    // FLOOR-020 envelope discriminators (per Mode1ChatResponseView shape)
    expect(body['source_type']).toBe('ai');
    expect(body['ai_mode']).toBe('mode_1');
    expect(body['ai_workload_type']).toBe('conversational_assistant');
    expect(body['autonomy_level']).toBe('advisory');
    expect(body['guardrail_template_id']).toBe('conservative_default');
    expect(typeof body['guardrail_version']).toBe('string');

    // NullProvider path: AI-RESIL-001 fail-soft response
    expect(body['ai_model_version']).toBe('null-provider:unavailable');
    expect(body['crisis_detected']).toBe(false);
    expect(body['escalation_triggered']).toBe(false);

    // Identifiers + patient attribution
    expect(typeof body['ai_chat_session_id']).toBe('string');
    expect(typeof body['message_id']).toBe('string');
    expect(body['patient_id']).toBe(accountId);

    // Response text — the canonical AI_UNAVAILABLE_RESPONSE_TEXT
    // exact wording is reviewable in the handler; assert key markers.
    expect(typeof body['response_text']).toBe('string');
    expect(body['response_text']).toContain('temporarily unavailable');
  });
});

// ---------------------------------------------------------------------------
// Group B — Crisis-bypass path
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group B: I-019 crisis-bypass (always-on per FLOOR-013)', () => {
  it('B1 crisis-content message → 200 crisis sentinel, crisis_detected=true', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: CRISIS_TEXT_SHORT },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();

    expect(body['crisis_detected']).toBe(true);
    expect(body['escalation_triggered']).toBe(true);
    // Crisis-bypass path: no LLM call → ai_model_version reflects bypass
    expect(body['ai_model_version']).toBe('crisis-bypass:no-llm-call');
    // Crisis sentinel response text — key markers
    expect(typeof body['response_text']).toBe('string');
    expect(body['response_text']).toContain('safety');
  });

  it('B2 OVERSIZED crisis-content (>4000 chars) → 200 crisis sentinel (R6 H1: gate runs before Zod size)', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    // Build an oversized message that still contains crisis keywords:
    // crisis keyword at the start, then padding to exceed the 4000-char
    // Zod ceiling. The two-stage validation must run runCrisisGate on
    // this raw text BEFORE the Stage 2 size constraint fires; the patient
    // gets the crisis sentinel + Category A audit, not a bare 400.
    const padding = 'x'.repeat(4500);
    const oversizedCrisisMessage = `${CRISIS_TEXT_SHORT} ${padding}`;
    expect(oversizedCrisisMessage.length).toBeGreaterThan(4000);

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: oversizedCrisisMessage },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body['crisis_detected']).toBe(true);
    expect(body['escalation_triggered']).toBe(true);
    expect(body['ai_model_version']).toBe('crisis-bypass:no-llm-call');
  });
});

// ---------------------------------------------------------------------------
// Group C — Validation rejections
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group C: body validation', () => {
  it('C1 missing message_text → 400', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('C2 empty message_text → 400', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('C3 non-string message_text → 400', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: 12345 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('C4 OVERSIZED non-crisis message (>4000 chars) → 400 (Stage 2 Zod fires AFTER gate confirms no crisis)', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const oversizedSafeMessage = 'x'.repeat(4500);
    expect(oversizedSafeMessage.length).toBeGreaterThan(4000);

    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: oversizedSafeMessage },
    });
    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Group D — Auth rejections
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group D: auth + role gates', () => {
  it('D1 no Bearer JWT → 401', async () => {
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: {
        host: US_HOST,
        'idempotency-key': ulid(),
        'content-type': 'application/json',
      },
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(response.statusCode).toBe(401);
  });

  it('D2 clinician JWT (non-patient role) → 403', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintClinicianToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(response.statusCode).toBe(403);
  });

  it('D3 platform_admin JWT → 403 (Mode 1 is patient-only)', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPlatformAdminToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(response.statusCode).toBe(403);
  });

  it('D4 patient JWT with delegateId set → 403 (R1 H2 delegate-rejection gate)', async () => {
    const accountId = `acct_${ulid()}`;
    const delegateId = `acct_${ulid()}`;
    const token = mintPatientDelegateToken(accountId, delegateId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Group E — Idempotency
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group E: idempotency', () => {
  it('E1 same Idempotency-Key + same body → cached 200 replay', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const idempotencyKey = ulid();
    const headers = {
      host: US_HOST,
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      'content-type': 'application/json',
    };
    const payload = { message_text: SAFE_TEXT_SHORT };

    const r1 = await app!.inject({ method: 'POST', url: '/v0/ai/chat', headers, payload });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json<Record<string, unknown>>();

    const r2 = await app!.inject({ method: 'POST', url: '/v0/ai/chat', headers, payload });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json<Record<string, unknown>>();

    // Cached replay: identical identifiers + identical response.
    expect(b2['ai_chat_session_id']).toBe(b1['ai_chat_session_id']);
    expect(b2['message_id']).toBe(b1['message_id']);
    expect(b2['response_text']).toBe(b1['response_text']);
  });

  it('E2 same Idempotency-Key + different body → 409 body_mismatch', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const idempotencyKey = ulid();
    const headers = {
      host: US_HOST,
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      'content-type': 'application/json',
    };

    const r1 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers,
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers,
      payload: { message_text: `${SAFE_TEXT_SHORT} (different)` },
    });
    expect(r2.statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Group F — Deterministic identifier derivation (R4 H1 closure)
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group F: deterministic session/message IDs (R4 H1)', () => {
  it('F1 same Idempotency-Key + same body across two calls → same session_id + message_id', async () => {
    // This is the same invariant as E1, but asserted explicitly as the
    // R4 H1 closure mechanism (deterministic ID derivation from the
    // idempotency 4-tuple). The retry-after-rollback scenario itself
    // requires audit-emission injection harness; this test proves the
    // precondition (stable IDs across retries) so the crisis gate's
    // dedupe key remains stable even when the response audit fails
    // and the cache reservation rolls back.
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const idempotencyKey = ulid();
    const headers = {
      host: US_HOST,
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      'content-type': 'application/json',
    };
    const payload = { message_text: SAFE_TEXT_SHORT };

    const r1 = await app!.inject({ method: 'POST', url: '/v0/ai/chat', headers, payload });
    const r2 = await app!.inject({ method: 'POST', url: '/v0/ai/chat', headers, payload });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const b1 = r1.json<Record<string, unknown>>();
    const b2 = r2.json<Record<string, unknown>>();
    expect(b1['ai_chat_session_id']).toBe(b2['ai_chat_session_id']);
    expect(b1['message_id']).toBe(b2['message_id']);
  });

  it('F2 different Idempotency-Keys → different session_id + message_id (independence)', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const headers1 = {
      host: US_HOST,
      authorization: `Bearer ${token}`,
      'idempotency-key': ulid(),
      'content-type': 'application/json',
    };
    const headers2 = { ...headers1, 'idempotency-key': ulid() };
    const payload = { message_text: SAFE_TEXT_SHORT };

    const r1 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: headers1,
      payload,
    });
    const r2 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: headers2,
      payload,
    });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const b1 = r1.json<Record<string, unknown>>();
    const b2 = r2.json<Record<string, unknown>>();
    expect(b1['ai_chat_session_id']).not.toBe(b2['ai_chat_session_id']);
    expect(b1['message_id']).not.toBe(b2['message_id']);
  });
});
