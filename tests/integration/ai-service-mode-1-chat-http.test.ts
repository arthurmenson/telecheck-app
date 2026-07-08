/**
 * ai-service-mode-1-chat-http.test.ts — Mode 1 conversational assistant
 * HTTP integration tests.
 *
 * R7 follow-up coverage for PR #160 (Track 2 first sprint, 2026-05-16).
 * PR #160 merged with Codex APPROVE at the code level but the R7 medium
 * finding (no HTTP-level regression test) was explicitly deferred to
 * this PR.
 *
 * Persistence-era update (migrations 066/067/068): the handler now
 * persists conversation/turn rows into the `ai_mode1_*` entities, so:
 *   - every test whose POST reaches the persistence phase seeds a REAL
 *     patient account first (composite tenant-scoped FK
 *     ai_mode1_conversation.patient_id → accounts(tenant_id, account_id));
 *   - session/message ids are UUIDs (the `ai_mode1_conversation.id` /
 *     `..._turn_admission.id` primary keys), derived deterministically
 *     per Idempotency-Key via deriveDeterministicMode1Uuid;
 *   - Group P asserts the persisted rows directly.
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
 *     C5 malformed ai_chat_session_id (non-UUID) + non-crisis → 400
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
 *   Group F — Deterministic identifier derivation (R4 H1 closure,
 *        UUID-era: deriveDeterministicMode1Uuid)
 *
 *   Group G — HTTP-level cached idempotent replay (key independence)
 *
 *   Group P — Mode 1 persistence (migrations 067/068)
 *     P1 non-crisis fail-soft turn persists conversation + admission +
 *        detector-result (severity NULL) + turn-result
 *        (failed / llm_provider_unavailable / during_llm)
 *     P2 crisis turn persists conversation + admission + turn-result
 *        (completed, crisis sentinel) and SKIPS the detector-result row
 *        (spec-gated: i019_enqueue_ack_log surface + severity taxonomy)
 *     P3 supplying ai_chat_session_id threads the same conversation
 *        (no second conversation row; second admission's
 *        history_snapshot_high_water_mark advances past -infinity)
 *     P4 another patient's conversation id → tenant-blind 404 (I-025),
 *        nothing persisted for the caller
 *     P5 crisis turn claiming another patient's conversation → 200
 *        crisis sentinel, but NOTHING persisted against the unowned
 *        conversation
 *     P6 idempotent replay does not duplicate rows
 *
 * Spec references:
 *   - src/modules/ai-service/internal/handlers/chat.ts (target)
 *   - migrations/067 + 068; CDM v1.8 §4.NEW1/NEW3/NEW4/NEW5 (P-036)
 *   - AI Service Mode 1 Handler Spec v0.4 RATIFIED (P-035) §4.2/§6
 *   - AI Clinical Assistant Slice PRD v1.0 §3 Mode 1
 *   - AI_LAYERING v5.2 §2/§3/§4/§6/§7
 *   - I-019 / I-023 / I-025 / I-027 / I-035
 *   - ADR-020 multi-provider abstraction (NullProvider at v1.0)
 *   - PR #160 commit history (Codex R1-R6 closure rounds)
 */

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { config } from '../../src/lib/config.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import type { IdempotencyCtx } from '../../src/lib/idempotency.ts';
import { issueAccessToken } from '../../src/lib/jwt.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { deriveDeterministicMode1Uuid } from '../../src/modules/ai-service/internal/handlers/chat.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId } from '../../src/modules/identity/internal/types.ts';
import { grantSliceRolesToTestApp } from '../helpers/grant-slice-roles.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { uniquePhone } from '../helpers/unique-phone.ts';
import { getTestClient } from '../setup.ts';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const T_US = asTenantId(TENANT_US);

let app: FastifyInstance | null = null;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  // The Mode 1 chat handler elevates to ai_service_mode1 (migration 068)
  // for the persistence writes; the shared test client's session role
  // (telecheck_test_app) has no slice-role memberships by default, so
  // SET LOCAL ROLE would 42501 → 500 (CI run 28944926412 pinned this;
  // same class as the async-consult-v1 CI run 28911340820). Grant via a
  // dedicated superuser connection per the async-consult-v1-http
  // precedent — do NOT rely on another suite's SLICE_ROLES-wide grant
  // loop having run first (fork order is nondeterministic).
  await grantSliceRolesToTestApp(['ai_service_mode1']);
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app !== null) {
    await app.close();
  }
});

/**
 * Seed a REAL patient account (accounts table row). The Mode 1
 * persistence path composite-FKs patient identity to
 * accounts(tenant_id, account_id), so requests that reach persistence
 * must run under an existing account. Mirrors async-consult-http.test.ts
 * seedAccount().
 */
async function seedPatientAccount(): Promise<string> {
  const accountId = asAccountId(ulid());
  const phone = uniquePhone('+1');
  await withTenantContext(T_US, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: T_US,
        phone_e164: phone,
        first_name: 'A',
        last_name: 'B',
        date_of_birth: '1990-01-01',
        gender: 'prefer_not_to_say',
        country_of_residence: 'US',
        country_of_care: 'US',
      },
      async () => {},
    ),
  );
  return accountId;
}

/**
 * Mint a Bearer JWT for a patient actor in the US tenant. Mirrors the
 * pattern used in async-consult-http.test.ts. The accountId is supplied
 * by the caller — groups that reach persistence pass a SEEDED account id
 * (see seedPatientAccount); auth/validation groups that reject before
 * persistence may pass synthetic ids.
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

/**
 * Codex R1 M1 closure (2026-05-16): patient-facing surfaces MUST NOT
 * leak `tenant_id` or the operating-tenant identifier `Telecheck-US`
 * per Master PRD v1.10 §17 + Glossary v5.2 C3 + I-025. The handler's
 * current `Mode1ChatResponseView` shape does not include `tenant_id`,
 * but the idempotency cache replays the projected body verbatim — a
 * future refactor that added `tenant_id` to the response would also
 * persist it into the cached replay. Pinning the absence invariant
 * here catches that regression.
 *
 * Apply this to EVERY response — success and error — across the suite.
 */
function expectNoTenantLeak(body: string): void {
  expect(body).not.toContain('"tenant_id"');
  expect(body).not.toContain('Telecheck-US');
}

/**
 * Mode1ChatResponseView allowed-key whitelist. Pins the response shape
 * so a future refactor that adds fields requires explicit test update
 * (and a deliberate choice that the new field is patient-safe).
 */
const ALLOWED_MODE1_RESPONSE_KEYS = new Set([
  'ai_chat_session_id',
  'message_id',
  'patient_id',
  'source_type',
  'ai_mode',
  'ai_workload_type',
  'autonomy_level',
  'guardrail_template_id',
  'guardrail_version',
  'ai_model_version',
  'escalation_triggered',
  'crisis_detected',
  'response_text',
]);

function expectMode1ResponseShape(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    expect(
      ALLOWED_MODE1_RESPONSE_KEYS.has(key),
      `unexpected key in Mode1ChatResponseView: ${key} — if intentional, add to ALLOWED_MODE1_RESPONSE_KEYS after confirming the new field is patient-safe (no tenant_id, no PHI beyond what the documented view carries)`,
    ).toBe(true);
  }
}

const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------------------
// Persistence row-inspection helpers (Group P). Direct SQL through the
// shared test client under tenant context — the test client applied the
// migrations (table owner), so table privileges are implicit; RLS FORCE
// still applies and is satisfied by the fixtures' set_tenant_context.
// ---------------------------------------------------------------------------

interface Mode1PersistedRows {
  conversationCount: number;
  conversationPatientId: string | null;
  admissions: Array<{
    id: string;
    patient_id: string;
    user_message: string;
    conversation_history_window: number;
    past_floor: boolean;
  }>;
  detectorResults: Array<{
    turn_id: string;
    detector_version: string;
    severity: string | null;
    crisis_server_signal_id: string | null;
  }>;
  turnResults: Array<{
    turn_id: string;
    assistant_message: string | null;
    provider: string | null;
    turn_outcome: string;
    failure_class: string | null;
    failure_phase: string | null;
  }>;
}

async function loadMode1Rows(conversationId: string): Promise<Mode1PersistedRows> {
  return withTenantContext(T_US, async () => {
    const client = getTestClient();
    const conv = await client.query<{ patient_id: string }>(
      `SELECT patient_id FROM ai_mode1_conversation
        WHERE tenant_id = $1 AND id = $2`,
      [T_US, conversationId],
    );
    const admissions = await client.query<{
      id: string;
      patient_id: string;
      user_message: string;
      conversation_history_window: number;
      past_floor: boolean;
    }>(
      `SELECT id, patient_id, user_message, conversation_history_window,
              (history_snapshot_high_water_mark > '-infinity'::timestamptz) AS past_floor
         FROM ai_mode1_conversation_turn_admission
        WHERE tenant_id = $1 AND conversation_id = $2
        ORDER BY admitted_at ASC`,
      [T_US, conversationId],
    );
    const detectorResults = await client.query<{
      turn_id: string;
      detector_version: string;
      severity: string | null;
      crisis_server_signal_id: string | null;
    }>(
      `SELECT d.turn_id, d.detector_version, d.severity, d.crisis_server_signal_id
         FROM ai_mode1_conversation_turn_detector_result d
         JOIN ai_mode1_conversation_turn_admission a
           ON a.tenant_id = d.tenant_id AND a.id = d.turn_id
        WHERE d.tenant_id = $1 AND a.conversation_id = $2`,
      [T_US, conversationId],
    );
    const turnResults = await client.query<{
      turn_id: string;
      assistant_message: string | null;
      provider: string | null;
      turn_outcome: string;
      failure_class: string | null;
      failure_phase: string | null;
    }>(
      `SELECT turn_id, assistant_message, provider, turn_outcome,
              failure_class, failure_phase
         FROM ai_mode1_conversation_turn_result
        WHERE tenant_id = $1 AND conversation_id = $2
        ORDER BY completed_at ASC`,
      [T_US, conversationId],
    );
    return {
      conversationCount: conv.rows.length,
      conversationPatientId: conv.rows[0]?.patient_id ?? null,
      admissions: admissions.rows,
      detectorResults: detectorResults.rows,
      turnResults: turnResults.rows,
    };
  });
}

/** Count conversations owned by a patient in the US tenant. */
async function countConversationsForPatient(patientId: string): Promise<number> {
  return withTenantContext(T_US, async () => {
    const client = getTestClient();
    const res = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM ai_mode1_conversation
        WHERE tenant_id = $1 AND patient_id = $2`,
      [T_US, patientId],
    );
    return Number.parseInt(res.rows[0]!.n, 10);
  });
}

// ---------------------------------------------------------------------------
// Group A — Happy-path / fail-soft (no crisis)
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group A: happy-path / AI-RESIL-001 fail-soft', () => {
  it('A1 valid patient JWT + non-crisis message → 200 Mode1ChatResponseView with provider_unavailable=true', async () => {
    const accountId = await seedPatientAccount();
    const token = mintPatientToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(response.statusCode).toBe(200);
    // R1 M1 closure: pin tenant-leak absence on every success body.
    expectNoTenantLeak(response.body);
    const body = response.json<Record<string, unknown>>();
    expectMode1ResponseShape(body);

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

    // Identifiers + patient attribution. Persistence-era: both ids are
    // the migration-067 UUID primary keys.
    expect(body['ai_chat_session_id']).toMatch(UUID_SHAPE_RE);
    expect(body['message_id']).toMatch(UUID_SHAPE_RE);
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
    const accountId = await seedPatientAccount();
    const token = mintPatientToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: CRISIS_TEXT_SHORT },
    });
    expect(response.statusCode).toBe(200);
    expectNoTenantLeak(response.body);
    const body = response.json<Record<string, unknown>>();
    expectMode1ResponseShape(body);

    expect(body['crisis_detected']).toBe(true);
    expect(body['escalation_triggered']).toBe(true);
    // Crisis-bypass path: no LLM call → ai_model_version reflects bypass
    expect(body['ai_model_version']).toBe('crisis-bypass:no-llm-call');
    // Crisis sentinel response text — key markers
    expect(typeof body['response_text']).toBe('string');
    expect(body['response_text']).toContain('safety');
  });

  it('B2 OVERSIZED crisis-content (>4000 chars) → 200 crisis sentinel (R6 H1: gate runs before Zod size)', async () => {
    const accountId = await seedPatientAccount();
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
    expectNoTenantLeak(response.body);
    const body = response.json<Record<string, unknown>>();
    expectMode1ResponseShape(body);
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

  it('C5 malformed ai_chat_session_id (non-UUID) + non-crisis → 400', async () => {
    const accountId = `acct_${ulid()}`;
    const token = mintPatientToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: SAFE_TEXT_SHORT, ai_chat_session_id: 'not-a-uuid' },
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
    const accountId = await seedPatientAccount();
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
    // Tenant-leak guard applies to BOTH original and replayed bodies
    // per Codex R1 M1 closure 2026-05-16 — the cache replays the
    // projected view verbatim, so if a future refactor added tenant_id
    // to the original body the replay would carry it forward silently.
    expectNoTenantLeak(r1.body);
    const b1 = r1.json<Record<string, unknown>>();
    expectMode1ResponseShape(b1);

    const r2 = await app!.inject({ method: 'POST', url: '/v0/ai/chat', headers, payload });
    expect(r2.statusCode).toBe(200);
    expectNoTenantLeak(r2.body);
    const b2 = r2.json<Record<string, unknown>>();
    expectMode1ResponseShape(b2);

    // Cached replay: identical identifiers + identical response.
    expect(b2['ai_chat_session_id']).toBe(b1['ai_chat_session_id']);
    expect(b2['message_id']).toBe(b1['message_id']);
    expect(b2['response_text']).toBe(b1['response_text']);
  });

  it('E2 same Idempotency-Key + different body → 409 body_mismatch', async () => {
    const accountId = await seedPatientAccount();
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
// Group F — deriveDeterministicMode1Uuid unit-level proof (R4 H1 closure)
//
// Codex R1 H1 closure 2026-05-16 (carried into the persistence era):
//   The HTTP-level retry-after-audit-failure scenario is covered by
//   ai-service-mode-1-chat-audit-injection.test.ts Group H. Group F
//   exercises the deterministic-derivation invariant where it lives:
//   the `deriveDeterministicMode1Uuid` helper itself, via direct
//   import. Stability of the derived UUIDs across retries is what
//   keeps the crisis gate's dedupe key stable AND what makes a retry
//   re-land the SAME conversation/turn primary keys after a rollback.
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group F: deriveDeterministicMode1Uuid (R4 H1 unit-level proof)', () => {
  const ctx: IdempotencyCtx = {
    tenantId: 'Telecheck-US',
    idempotencyKey: '01HXYZ_KEY_FIXED',
    endpoint: '/v0/ai/chat',
    actorId: 'acct_01ABCDEFGH',
    bodyHash: 'sha256:0123456789abcdef',
  };

  it('F1 same idempotency context + variant → same UUID across calls', () => {
    const id1 = deriveDeterministicMode1Uuid(ctx, 'conversation');
    const id2 = deriveDeterministicMode1Uuid(ctx, 'conversation');
    expect(id1).toBe(id2);
  });

  it('F2 different idempotencyKey → different UUID', () => {
    const id1 = deriveDeterministicMode1Uuid(ctx, 'conversation');
    const id2 = deriveDeterministicMode1Uuid(
      { ...ctx, idempotencyKey: 'OTHER_KEY' },
      'conversation',
    );
    expect(id1).not.toBe(id2);
  });

  it('F3 different actorId → different UUID (per-patient isolation)', () => {
    const id1 = deriveDeterministicMode1Uuid(ctx, 'conversation');
    const id2 = deriveDeterministicMode1Uuid({ ...ctx, actorId: 'acct_OTHER' }, 'conversation');
    expect(id1).not.toBe(id2);
  });

  it('F4 different bodyHash → different UUID (per-body isolation)', () => {
    const id1 = deriveDeterministicMode1Uuid(ctx, 'conversation');
    const id2 = deriveDeterministicMode1Uuid(
      { ...ctx, bodyHash: 'sha256:fedcba9876543210' },
      'conversation',
    );
    expect(id1).not.toBe(id2);
  });

  it('F5 variant parameter creates distinct UUIDs from same context (conversation vs turn)', () => {
    const conversationId = deriveDeterministicMode1Uuid(ctx, 'conversation');
    const turnId = deriveDeterministicMode1Uuid(ctx, 'turn');
    expect(conversationId).not.toBe(turnId);
  });

  it('F6 same variant produces same UUID (idempotent per variant)', () => {
    const t1 = deriveDeterministicMode1Uuid(ctx, 'turn');
    const t2 = deriveDeterministicMode1Uuid(ctx, 'turn');
    expect(t1).toBe(t2);
  });

  it('F7 derived id is RFC-4122-shaped (accepted by the migration-067 UUID columns)', () => {
    const id = deriveDeterministicMode1Uuid(ctx, 'conversation');
    expect(id).toMatch(UUID_SHAPE_RE);
  });
});

// ---------------------------------------------------------------------------
// Group G — HTTP-level cached idempotent replay (key independence)
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group G: HTTP-level cached idempotent replay', () => {
  it('G1 different Idempotency-Keys → different session_id + message_id (independence)', async () => {
    const accountId = await seedPatientAccount();
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
    expectNoTenantLeak(r1.body);
    expectNoTenantLeak(r2.body);
    const b1 = r1.json<Record<string, unknown>>();
    const b2 = r2.json<Record<string, unknown>>();
    expectMode1ResponseShape(b1);
    expectMode1ResponseShape(b2);
    expect(b1['ai_chat_session_id']).not.toBe(b2['ai_chat_session_id']);
    expect(b1['message_id']).not.toBe(b2['message_id']);
  });
});

// ---------------------------------------------------------------------------
// Group P — Mode 1 persistence (migrations 067/068; CDM v1.8 §4.NEW1-NEW5)
// ---------------------------------------------------------------------------

describe('Mode 1 chat — Group P: conversation/turn persistence', () => {
  it('P1 non-crisis fail-soft turn persists conversation + admission + detector-result + failed turn-result', async () => {
    const accountId = await seedPatientAccount();
    const token = mintPatientToken(accountId);
    const response = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    const conversationId = body['ai_chat_session_id'] as string;
    const turnId = body['message_id'] as string;

    const rows = await loadMode1Rows(conversationId);
    // Conversation envelope (CDM v1.8 §4.NEW1)
    expect(rows.conversationCount).toBe(1);
    expect(rows.conversationPatientId).toBe(accountId);
    // Admission row (§4.NEW3): raw user message + ratified default window;
    // first turn of the conversation → high-water-mark at the -infinity floor.
    expect(rows.admissions).toHaveLength(1);
    expect(rows.admissions[0]!.id).toBe(turnId);
    expect(rows.admissions[0]!.patient_id).toBe(accountId);
    expect(rows.admissions[0]!.user_message).toBe(SAFE_TEXT_SHORT);
    expect(rows.admissions[0]!.conversation_history_window).toBe(20);
    expect(rows.admissions[0]!.past_floor).toBe(false);
    // Detector-result row (§4.NEW4): no-crisis shape (severity NULL +
    // signal NULL) — the canonical detector_completed state.
    expect(rows.detectorResults).toHaveLength(1);
    expect(rows.detectorResults[0]!.turn_id).toBe(turnId);
    expect(rows.detectorResults[0]!.severity).toBeNull();
    expect(rows.detectorResults[0]!.crisis_server_signal_id).toBeNull();
    expect(rows.detectorResults[0]!.detector_version).toBe('keyword-stub-v1.0');
    // Turn-result terminal row (§4.NEW5): NullProvider fail-soft is a
    // FAILED turn per the ratified taxonomy; assistant_message NULL
    // (the canned UI text is not an assistant message).
    expect(rows.turnResults).toHaveLength(1);
    expect(rows.turnResults[0]!.turn_id).toBe(turnId);
    expect(rows.turnResults[0]!.turn_outcome).toBe('failed');
    expect(rows.turnResults[0]!.failure_class).toBe('llm_provider_unavailable');
    expect(rows.turnResults[0]!.failure_phase).toBe('during_llm');
    expect(rows.turnResults[0]!.assistant_message).toBeNull();
    expect(rows.turnResults[0]!.provider).toBe('null');
  });

  it('P2 crisis turn persists conversation + admission + completed turn-result; detector-result SKIPPED (spec-gated)', async () => {
    const accountId = await seedPatientAccount();
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
    const conversationId = body['ai_chat_session_id'] as string;
    const turnId = body['message_id'] as string;

    const rows = await loadMode1Rows(conversationId);
    expect(rows.conversationCount).toBe(1);
    expect(rows.admissions).toHaveLength(1);
    expect(rows.admissions[0]!.id).toBe(turnId);
    // Crisis-positive detector-result persistence is SPEC-GATED
    // (i019_enqueue_ack_log FK target deferred in migration 067 +
    // severity-taxonomy mapping unratified) — the Category A crisis
    // audit is the durable I-019 record. No detector row for this turn.
    expect(rows.detectorResults).toHaveLength(0);
    // The crisis sentinel IS the completed patient-visible turn.
    expect(rows.turnResults).toHaveLength(1);
    expect(rows.turnResults[0]!.turn_outcome).toBe('completed');
    expect(rows.turnResults[0]!.failure_class).toBeNull();
    expect(rows.turnResults[0]!.provider).toBeNull();
    expect(rows.turnResults[0]!.assistant_message).toContain('safety');
  });

  it('P3 supplying ai_chat_session_id threads the same conversation (no second conversation row; snapshot advances)', async () => {
    const accountId = await seedPatientAccount();
    const token = mintPatientToken(accountId);
    const r1 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(r1.statusCode).toBe(200);
    const conversationId = r1.json<Record<string, unknown>>()['ai_chat_session_id'] as string;

    const r2 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(token),
      payload: {
        message_text: 'And how much water should I drink?',
        ai_chat_session_id: conversationId,
      },
    });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json<Record<string, unknown>>();
    // The response echoes the threaded conversation id.
    expect(b2['ai_chat_session_id']).toBe(conversationId);

    expect(await countConversationsForPatient(accountId)).toBe(1);
    const rows = await loadMode1Rows(conversationId);
    expect(rows.admissions).toHaveLength(2);
    // Turn 1 had no prior completed turns (-infinity floor); turn 2's
    // history_snapshot_high_water_mark captured turn 1's completed_at
    // (spec §6.3 replay-safety anchor).
    expect(rows.admissions[0]!.past_floor).toBe(false);
    expect(rows.admissions[1]!.past_floor).toBe(true);
    expect(rows.turnResults).toHaveLength(2);
  });

  it("P4 another patient's conversation id → tenant-blind 404 (I-025); nothing persisted for the caller", async () => {
    const ownerId = await seedPatientAccount();
    const intruderId = await seedPatientAccount();
    const ownerToken = mintPatientToken(ownerId);
    const intruderToken = mintPatientToken(intruderId);

    const r1 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(ownerToken),
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(r1.statusCode).toBe(200);
    const conversationId = r1.json<Record<string, unknown>>()['ai_chat_session_id'] as string;

    const r2 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(intruderToken),
      payload: { message_text: SAFE_TEXT_SHORT, ai_chat_session_id: conversationId },
    });
    expect(r2.statusCode).toBe(404);
    expectNoTenantLeak(r2.body);

    // Owner's conversation is untouched; intruder created nothing.
    const rows = await loadMode1Rows(conversationId);
    expect(rows.admissions).toHaveLength(1);
    expect(await countConversationsForPatient(intruderId)).toBe(0);
  });

  it("P5 crisis turn claiming another patient's conversation → 200 crisis sentinel; NOTHING persisted against the unowned conversation", async () => {
    const ownerId = await seedPatientAccount();
    const intruderId = await seedPatientAccount();
    const ownerToken = mintPatientToken(ownerId);
    const intruderToken = mintPatientToken(intruderId);

    const r1 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(ownerToken),
      payload: { message_text: SAFE_TEXT_SHORT },
    });
    expect(r1.statusCode).toBe(200);
    const conversationId = r1.json<Record<string, unknown>>()['ai_chat_session_id'] as string;

    // Crisis text: the safety surface outranks the ownership 404
    // (R6 H1 pattern) — but the unowned conversation MUST NOT gain rows.
    const r2 = await app!.inject({
      method: 'POST',
      url: '/v0/ai/chat',
      headers: patientRequestHeaders(intruderToken),
      payload: { message_text: CRISIS_TEXT_SHORT, ai_chat_session_id: conversationId },
    });
    expect(r2.statusCode).toBe(200);
    const b2 = r2.json<Record<string, unknown>>();
    expect(b2['crisis_detected']).toBe(true);

    const rows = await loadMode1Rows(conversationId);
    expect(rows.admissions).toHaveLength(1);
    expect(rows.turnResults).toHaveLength(1);
    expect(await countConversationsForPatient(intruderId)).toBe(0);
  });

  it('P6 idempotent replay does not duplicate rows', async () => {
    const accountId = await seedPatientAccount();
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
    const conversationId = r1.json<Record<string, unknown>>()['ai_chat_session_id'] as string;

    const r2 = await app!.inject({ method: 'POST', url: '/v0/ai/chat', headers, payload });
    expect(r2.statusCode).toBe(200);

    const rows = await loadMode1Rows(conversationId);
    expect(rows.conversationCount).toBe(1);
    expect(rows.admissions).toHaveLength(1);
    expect(rows.detectorResults).toHaveLength(1);
    expect(rows.turnResults).toHaveLength(1);
  });
});
