/**
 * Layer 4 HTTP wiring: real chat, resolver, request screening and Anthropic
 * serialization, with an in-process fake transport. The recorder callback is
 * mocked here; vendor-audit.test.ts proves its independent PostgreSQL commit.
 *
 * Layer 1 normally rejects these regex hits before Layer 4 can see them. A
 * one-shot Layer 1 bypass models an upstream miss for the defense-in-depth
 * cases only. Other cases retain real input, output and crisis screening.
 */
import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.ts';
import { config } from '../../src/lib/config.ts';
import { asTenantId } from '../../src/lib/glossary.ts';
import { issueAccessToken } from '../../src/lib/jwt.ts';
import { screenInput } from '../../src/lib/pii-screener/index.ts';
import { ulid } from '../../src/lib/ulid.ts';
import { recordVendorDecision } from '../../src/modules/ai-service/internal/providers/vendor-audit.ts';
import { createAccount } from '../../src/modules/identity/internal/repositories/account-repo.ts';
import { asAccountId } from '../../src/modules/identity/internal/types.ts';
import { grantSliceRolesToTestApp } from '../helpers/grant-slice-roles.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';
import { getTestClient } from '../setup.ts';

vi.mock('../../src/lib/pii-screener/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/pii-screener/index.ts')>();
  return { ...actual, screenInput: vi.fn(actual.screenInput) };
});

vi.mock(
  '../../src/modules/ai-service/internal/providers/vendor-audit.ts',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../../src/modules/ai-service/internal/providers/vendor-audit.ts')
      >();
    // Keep the real resolver preflight validator; only the durable write is
    // replaced, so missing/invalid request attribution cannot become a pass.
    return { ...actual, recordVendorDecision: vi.fn<typeof actual.recordVendorDecision>() };
  },
);

const TENANT = asTenantId(TENANT_US);
const SAFE_MESSAGE = 'What time should I take my medication today?';
const HIGH_MESSAGE = 'Please send the instructions to test.patient@example.invalid.';
const LOW_MESSAGE = 'The clinic portal at 192.0.2.44 is not loading.';
const SUCCESS_TEXT = 'Please follow the instructions supplied by your care team.';
const MODEL = 'test-clinical-model';
const originalApiKey = config.anthropicApiKey;
const originalModel = config.anthropicModel;
const inputScreener = vi.mocked(screenInput);
const recorder = vi.mocked(recordVendorDecision);
const vendorFetch = vi.fn<typeof fetch>();
let app: FastifyInstance;

function vendorSuccess(text = SUCCESS_TEXT): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      model: MODEL,
      usage: { input_tokens: 8, output_tokens: 12 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeAll(async () => {
  await grantSliceRolesToTestApp(['ai_service_mode1', 'ai_service_credential_reader']);
  app = await buildApp({ logger: false });
  await app.ready();
});

beforeEach(() => {
  // This is a synthetic key and global fetch is always intercepted: these
  // tests cannot spend tokens or transmit candidate text to a real provider.
  Reflect.set(config, 'anthropicApiKey', 'test-vendor-boundary-key');
  Reflect.set(config, 'anthropicModel', MODEL);
  inputScreener.mockReset();
  recorder.mockReset();
  recorder.mockResolvedValue(undefined);
  vendorFetch.mockReset();
  vendorFetch.mockImplementation(async () => vendorSuccess());
  vi.stubGlobal('fetch', vendorFetch);
});

afterEach(() => {
  Reflect.set(config, 'anthropicApiKey', originalApiKey);
  Reflect.set(config, 'anthropicModel', originalModel);
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app.close();
});

async function patientRequest(): Promise<{
  accountId: string;
  headers: Record<string, string>;
  key: string;
}> {
  const accountId = asAccountId(ulid());
  // Independent random fixture space avoids the existing module-counter
  // phone helper's collisions between test workers. E.164 permits 15 digits.
  const digits = (BigInt(`0x${randomBytes(7).toString('hex')}`) % 10000000000000n)
    .toString()
    .padStart(13, '0');
  await withTenantContext(TENANT, () =>
    createAccount(
      {
        account_id: accountId,
        tenant_id: TENANT,
        phone_e164: `+1${digits}`,
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
  const token = issueAccessToken(
    {
      account_id: accountId,
      tenant_id: TENANT,
      session_id: ulid(),
      role: 'patient',
      country_of_care: 'US',
    },
    config.jwtSigningKey,
  );
  const key = ulid();
  return {
    accountId,
    key,
    headers: {
      host: 'heroshealth.com',
      authorization: `Bearer ${token}`,
      'idempotency-key': key,
      'content-type': 'application/json',
    },
  };
}

function send(headers: Record<string, string>, message: string) {
  return app.inject({
    method: 'POST',
    url: '/v0/ai/chat',
    headers,
    payload: { message_text: message },
  });
}

async function expectNoBusinessRows(accountId: string, key: string): Promise<void> {
  await withTenantContext(TENANT, async () => {
    const conversation = await getTestClient().query<{ count: string }>(
      'SELECT count(*) FROM ai_mode1_conversation WHERE tenant_id = $1 AND patient_id = $2',
      [TENANT, accountId],
    );
    const admission = await getTestClient().query<{ count: string }>(
      `SELECT count(*) FROM ai_mode1_conversation_turn_admission
        WHERE tenant_id = $1 AND patient_id = $2`,
      [TENANT, accountId],
    );
    const reservation = await getTestClient().query<{ count: string }>(
      `SELECT count(*) FROM idempotency_keys
        WHERE tenant_id = $1 AND key = $2 AND endpoint = '/v0/ai/chat' AND actor_id = $3`,
      [TENANT, key, accountId],
    );
    expect(conversation.rows[0]?.count).toBe('0');
    expect(admission.rows[0]?.count).toBe('0');
    expect(reservation.rows[0]?.count).toBe('0');
  });
}

interface ChatResponse {
  ai_chat_session_id: string;
  message_id: string;
  response_text: string;
  ai_model_version: string;
  crisis_detected: boolean;
  escalation_triggered: boolean;
}

describe('Mode 1 Layer 4 vendor boundary — HTTP integration', () => {
  it('blocks a high-confidence upstream miss with a local 500 and rolls back the turn/cache', async () => {
    const { accountId, headers, key } = await patientRequest();
    inputScreener.mockReturnValueOnce({ action: 'pass', hits: [] });

    const response = await send(headers, HIGH_MESSAGE);

    expect(response.statusCode).toBe(500);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'ai.provider.egress_blocked',
    );
    expect(response.body).not.toContain('test.patient@example.invalid');
    expect(response.body).not.toContain(TENANT);
    expect(vendorFetch).not.toHaveBeenCalled();
    expect(recorder).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        tenantId: TENANT,
        countryOfCare: 'US',
        patientId: accountId,
        reservationExpiresAt: expect.any(String),
        idempotency: expect.objectContaining({
          tenantId: TENANT,
          actorId: accountId,
          endpoint: '/v0/ai/chat',
          idempotencyKey: key,
        }),
      }),
      'anthropic',
      {
        action: 'block',
        reason: 'high_confidence_match',
        patternIds: ['email'],
        hitCount: 1,
        candidateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    );
    await expectNoBusinessRows(accountId, key);
  });

  it.each([HIGH_MESSAGE, LOW_MESSAGE])(
    'fails closed with 503 and zero outbound calls when the decision audit rejects (%s)',
    async (message) => {
      const { accountId, headers, key } = await patientRequest();
      inputScreener.mockReturnValueOnce({ action: 'pass', hits: [] });
      recorder.mockRejectedValueOnce(
        new Error('private database diagnostic test.patient@example.invalid'),
      );

      const response = await send(headers, message);

      expect(response.statusCode).toBe(503);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'ai_chat.audit_emission_unavailable',
      );
      expect(response.body).not.toContain('private database diagnostic');
      expect(response.body).not.toContain('test.patient@example.invalid');
      expect(response.body).not.toContain('192.0.2.44');
      expect(response.body).not.toContain(TENANT);
      expect(recorder).toHaveBeenCalledTimes(1);
      expect(vendorFetch).not.toHaveBeenCalled();
      await expectNoBusinessRows(accountId, key);
    },
  );

  it('awaits the redaction audit before serializing the sanitized vendor request and keeps Layer 2 output screening', async () => {
    const { accountId, headers, key } = await patientRequest();
    inputScreener.mockReturnValueOnce({ action: 'pass', hits: [] });
    const order: string[] = [];
    let releaseAudit: () => void = () => {};
    let reportAuditStarted: () => void = () => {};
    const auditStarted = new Promise<void>((resolve) => {
      reportAuditStarted = resolve;
    });
    const auditCompletion = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    recorder.mockImplementationOnce(async () => {
      order.push('audit-started');
      reportAuditStarted();
      await auditCompletion;
      order.push('audit-committed');
    });
    vendorFetch.mockImplementationOnce(async () => {
      order.push('vendor-send');
      return vendorSuccess('Contact invented.patient@example.invalid for an appointment.');
    });

    const request = send(headers, LOW_MESSAGE).then((response) => response);
    try {
      await Promise.race([
        auditStarted,
        request.then((response) => {
          throw new Error(
            `Request completed before the audit callback: HTTP ${response.statusCode}`,
          );
        }),
      ]);
      expect(vendorFetch).not.toHaveBeenCalled();
    } finally {
      releaseAudit();
    }
    const response = await request;

    expect(response.statusCode).toBe(200);
    expect(order).toEqual(['audit-started', 'audit-committed', 'vendor-send']);
    const [url, init] = vendorFetch.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: MODEL,
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: 'user', content: 'The clinic portal at [REDACTED:PII] is not loading.' }],
    });
    expect(String(init?.body)).not.toContain('192.0.2.44');
    const body = response.json<ChatResponse>();
    expect(body.ai_model_version).toBe(`anthropic:${MODEL}`);
    expect(body.response_text).not.toContain('invented.patient@example.invalid');
    expect(body.response_text).toContain('[REDACTED:');
    expect(body.crisis_detected).toBe(false);
    expect(recorder).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        tenantId: TENANT,
        patientId: accountId,
        conversationId: body.ai_chat_session_id,
        messageId: body.message_id,
        idempotency: expect.objectContaining({ idempotencyKey: key }),
      }),
      'anthropic',
      {
        action: 'redact',
        reason: 'low_confidence_redacted',
        patternIds: ['ipv4'],
        hitCount: 1,
        candidateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    );
    const stored = await withTenantContext(TENANT, () =>
      getTestClient().query<{ assistant_message: string; turn_outcome: string; provider: string }>(
        `SELECT assistant_message, turn_outcome, provider
           FROM ai_mode1_conversation_turn_result
          WHERE tenant_id = $1 AND turn_id = $2 AND patient_id = $3`,
        [TENANT, body.message_id, accountId],
      ),
    );
    expect(stored.rows).toEqual([
      { assistant_message: body.response_text, turn_outcome: 'completed', provider: 'anthropic' },
    ]);
  });

  it('passes clean content through the real adapter without a Layer 4 decision event', async () => {
    const { headers } = await patientRequest();

    const response = await send(headers, SAFE_MESSAGE);

    expect(response.statusCode).toBe(200);
    expect(response.json<ChatResponse>().response_text).toBe(SUCCESS_TEXT);
    expect(inputScreener).toHaveBeenCalledExactlyOnceWith(SAFE_MESSAGE, 'ai_bound');
    expect(recorder).not.toHaveBeenCalled();
    expect(vendorFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vendorFetch.mock.calls[0]?.[1]?.body))).toEqual({
      model: MODEL,
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: 'user', content: SAFE_MESSAGE }],
    });
  });

  it('replays a completed redacted turn without screening, audit recording, sending or duplicate persistence', async () => {
    const { accountId, headers } = await patientRequest();
    inputScreener.mockReturnValueOnce({ action: 'pass', hits: [] });
    const first = await send(headers, LOW_MESSAGE);
    expect(first.statusCode).toBe(200);
    expect(inputScreener).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(vendorFetch).toHaveBeenCalledTimes(1);

    const replay = await send(headers, LOW_MESSAGE);

    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(inputScreener).toHaveBeenCalledTimes(1);
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(vendorFetch).toHaveBeenCalledTimes(1);
    const rows = await withTenantContext(TENANT, () =>
      getTestClient().query<{ count: string }>(
        `SELECT count(*) FROM ai_mode1_conversation_turn_result
          WHERE tenant_id = $1 AND patient_id = $2`,
        [TENANT, accountId],
      ),
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('preserves the 200 fail-soft contract for an actual upstream outage', async () => {
    const { accountId, headers } = await patientRequest();
    vendorFetch.mockResolvedValueOnce(new Response('provider overloaded', { status: 503 }));

    const response = await send(headers, SAFE_MESSAGE);

    expect(response.statusCode).toBe(200);
    const body = response.json<ChatResponse>();
    expect(body.response_text).toContain('temporarily unavailable');
    expect(body.ai_model_version).toBe('null-provider:unavailable');
    expect(vendorFetch).toHaveBeenCalledTimes(1);
    expect(recorder).not.toHaveBeenCalled();
    const stored = await withTenantContext(TENANT, () =>
      getTestClient().query<{ turn_outcome: string; failure_class: string; provider: string }>(
        `SELECT turn_outcome, failure_class, provider FROM ai_mode1_conversation_turn_result
          WHERE tenant_id = $1 AND patient_id = $2 AND turn_id = $3`,
        [TENANT, accountId, body.message_id],
      ),
    );
    expect(stored.rows).toEqual([
      { turn_outcome: 'failed', failure_class: 'llm_provider_unavailable', provider: 'anthropic' },
    ]);
  });

  it('keeps the normal Layer 1 block before the vendor boundary', async () => {
    const { accountId, headers, key } = await patientRequest();

    const response = await send(headers, HIGH_MESSAGE);

    expect(response.statusCode).toBe(422);
    expect(inputScreener).toHaveBeenCalledExactlyOnceWith(HIGH_MESSAGE, 'ai_bound');
    expect(vendorFetch).not.toHaveBeenCalled();
    expect(recorder).not.toHaveBeenCalled();
    await expectNoBusinessRows(accountId, key);
  });

  it('runs crisis handling before Layer 1 even when the message contains PII', async () => {
    const { headers } = await patientRequest();
    const response = await send(
      headers,
      'I am having suicidal thoughts and need help right now. My SSN is 123-45-6789.',
    );

    expect(response.statusCode).toBe(200);
    const body = response.json<ChatResponse>();
    expect(body.crisis_detected).toBe(true);
    expect(body.escalation_triggered).toBe(true);
    expect(body.ai_model_version).toBe('crisis-bypass:no-llm-call');
    expect(body.response_text).toContain('safety');
    expect(inputScreener).not.toHaveBeenCalled();
    expect(vendorFetch).not.toHaveBeenCalled();
    expect(recorder).not.toHaveBeenCalled();
  });
});
