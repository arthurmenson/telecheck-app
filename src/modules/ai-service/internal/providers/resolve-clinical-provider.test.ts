import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decryptAiProviderKey } from '../../../../lib/ai-provider-credential-envelope.js';
import { config } from '../../../../lib/config.js';
import type { DbClient } from '../../../../lib/db.js';
import { asTenantId } from '../../../../lib/glossary.js';

import { resolveClinicalProvider } from './resolve-clinical-provider.js';
import { LLMProviderUnavailableError, type LLMCompletionRequest } from './types.js';
import { recordVendorDecision, type VendorAuditContext } from './vendor-audit.js';
import { VendorAuditUnavailableError, VendorEgressBlockedError } from './vendor-boundary.js';

vi.mock('./vendor-audit.js', async (original) => ({
  ...(await original<typeof import('./vendor-audit.js')>()),
  recordVendorDecision: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../../../lib/ai-provider-credential-envelope.js', () => ({
  decryptAiProviderKey: vi.fn(() => Promise.resolve('synthetic-db-key')),
}));

const savedKey = config.anthropicApiKey;
const expiresAt = '2099-09-06 12:00:00.123456+00';
const tenantId = asTenantId('Telecheck-US');
const patientId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
function context(): Omit<VendorAuditContext, 'reservationExpiresAt'> {
  return {
    tenantId,
    countryOfCare: 'US',
    patientId,
    conversationId: 'af099216-ed59-4c2e-9f72-d98194c01065',
    messageId: 'bf099216-ed59-4c2e-9f72-d98194c01065',
    idempotency: {
      tenantId,
      actorId: patientId,
      endpoint: '/v0/ai/chat',
      idempotencyKey: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
      bodyHash: 'a'.repeat(64),
    },
  };
}
function request(content = 'Hello'): LLMCompletionRequest {
  return {
    tenant_id: tenantId,
    workload_type: 'conversational_assistant',
    messages: [{ role: 'user', content }],
    max_output_tokens: 64,
    temperature: 0,
  };
}
function database(dbCredential = false, reservation: unknown = expiresAt) {
  const query = vi.fn((sql: string) => {
    if (sql === 'SELECT current_user')
      return Promise.resolve({ rows: [{ current_user: 'telecheck_test_app' }] });
    if (sql.startsWith('SET LOCAL ROLE')) return Promise.resolve({ rows: [] });
    if (sql.includes('read_active_ai_provider_key'))
      return Promise.resolve({
        rows: dbCredential
          ? [
              {
                key_ciphertext: Buffer.from('encrypted'),
                key_kms_envelope_dek_id: 'test',
                key_kms_envelope_iv: Buffer.alloc(12),
                key_kms_envelope_tag: Buffer.alloc(16),
                key_kms_envelope_alg: 'test',
                key_kms_envelope_alg_version: 'test',
                key_kms_envelope_aad: Buffer.alloc(0),
                key_kms_envelope_encrypted_at: new Date(),
              },
            ]
          : [],
      });
    if (sql.includes('FROM idempotency_keys'))
      return Promise.resolve({ rows: reservation === null ? [] : [{ expires_at: reservation }] });
    throw new Error('Unexpected test SQL');
  });
  return { tx: { query } as unknown as DbClient, query };
}
const transport = vi.fn<typeof fetch>();
beforeEach(() => {
  Reflect.set(config, 'anthropicApiKey', 'synthetic-env-key');
  vi.mocked(recordVendorDecision).mockReset().mockResolvedValue(undefined);
  vi.mocked(decryptAiProviderKey).mockClear();
  transport.mockReset().mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Hello' }],
          usage: { input_tokens: 3, output_tokens: 1 },
        }),
        { status: 200 },
      ),
    ),
  );
  vi.stubGlobal('fetch', transport);
});
afterEach(() => {
  Reflect.set(config, 'anthropicApiKey', savedKey);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('clinical resolver installs the vendor boundary on real credential paths', () => {
  it.each([false, true])(
    'blocks high confidence before actual transport (DB credential %s)',
    async (dbCredential) => {
      const { tx, query } = database(dbCredential);
      const provider = await resolveClinicalProvider({ tx, auditContext: context() });
      await expect(
        provider.sendCompletion(request('synthetic.person@example.com')),
      ).rejects.toBeInstanceOf(VendorEgressBlockedError);
      expect(transport).not.toHaveBeenCalled();
      expect(recordVendorDecision).toHaveBeenCalledWith(
        { ...context(), reservationExpiresAt: expiresAt },
        'anthropic',
        expect.objectContaining({
          action: 'block',
          reason: 'high_confidence_match',
          patternIds: ['email'],
        }),
      );
      expect(query).toHaveBeenCalledWith(expect.stringContaining('expires_at::text'), [
        tenantId,
        context().idempotency.idempotencyKey,
        '/v0/ai/chat',
        patientId,
        'a'.repeat(64),
      ]);
      expect(decryptAiProviderKey).toHaveBeenCalledTimes(dbCredential ? 1 : 0);
    },
  );

  it.each([false, true])(
    'sends only a redacted body and honors credential precedence (DB %s)',
    async (dbCredential) => {
      const provider = await resolveClinicalProvider({
        tx: database(dbCredential).tx,
        auditContext: context(),
      });
      await provider.sendCompletion(request('Use 192.0.2.1'));
      expect(recordVendorDecision).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledOnce();
      const [url, init] = transport.mock.calls[0]!;
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(new Headers(init?.headers).get('x-api-key')).toBe(
        dbCredential ? 'synthetic-db-key' : 'synthetic-env-key',
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        messages: [{ role: 'user', content: 'Use [REDACTED:PII]' }],
      });
      expect(String(init?.body)).not.toContain('192.0.2.1');
      expect(vi.mocked(recordVendorDecision).mock.invocationCallOrder[0]).toBeLessThan(
        transport.mock.invocationCallOrder[0]!,
      );
    },
  );

  it('waits for durable recording; a rejected commit prevents transmission', async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, rejectPromise) => {
      reject = rejectPromise;
    });
    let recording!: () => void;
    const started = new Promise<void>((resolve) => {
      recording = resolve;
    });
    vi.mocked(recordVendorDecision).mockImplementation(() => {
      recording();
      return pending;
    });
    const provider = await resolveClinicalProvider({ tx: database().tx, auditContext: context() });
    const completion = provider.sendCompletion(request('Use 192.0.2.1'));
    await started;
    expect(transport).not.toHaveBeenCalled();
    const assertion = expect(completion).rejects.toBeInstanceOf(VendorAuditUnavailableError);
    reject(new Error('synthetic.person@example.com'));
    await assertion;
    expect(transport).not.toHaveBeenCalled();
  });

  it('requires valid context even for a clean send but healthcheck does not require it', async () => {
    const provider = await resolveClinicalProvider();
    expect(await provider.healthcheck()).toEqual({ healthy: true });
    await expect(provider.sendCompletion(request())).rejects.toBeInstanceOf(
      VendorAuditUnavailableError,
    );
    expect(transport).not.toHaveBeenCalled();
    expect(recordVendorDecision).not.toHaveBeenCalled();
  });

  it.each([null, 'invalid timestamp', new Date(), '2099-01-01 00:00:00+00 raw detail'])(
    'fails closed on absent or malformed actual reservation %#',
    async (expiry) => {
      const provider = await resolveClinicalProvider({
        tx: database(false, expiry).tx,
        auditContext: context(),
      });
      await expect(provider.sendCompletion(request())).rejects.toBeInstanceOf(
        VendorAuditUnavailableError,
      );
      expect(transport).not.toHaveBeenCalled();
      expect(recordVendorDecision).not.toHaveBeenCalled();
    },
  );

  it('does not expose reservation diagnostics', async () => {
    const { tx, query } = database();
    const provider = await resolveClinicalProvider({ tx, auditContext: context() });
    query.mockRejectedValueOnce(new Error('sensitive synthetic.person@example.com'));
    const failure: unknown = await provider
      .sendCompletion(request())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VendorAuditUnavailableError);
    expect(String(failure)).not.toContain('synthetic.person');
    expect(failure).not.toHaveProperty('cause');
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    'tenant',
    'actor',
    'endpoint',
    'country',
    'patient',
    'conversation',
    'message',
    'hash',
    'key',
  ])('rejects malformed trusted context: %s', async (field) => {
    const invalid = context();
    if (field === 'tenant') invalid.idempotency.tenantId = asTenantId('Telecheck-Ghana');
    if (field === 'actor') invalid.idempotency.actorId = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
    if (field === 'endpoint') invalid.idempotency.endpoint = '/v0/other';
    if (field === 'country') Reflect.set(invalid, 'countryOfCare', 'INVALID');
    if (field === 'patient') Reflect.set(invalid, 'patientId', 'invalid');
    if (field === 'conversation') Reflect.set(invalid, 'conversationId', 'invalid');
    if (field === 'message') Reflect.set(invalid, 'messageId', 'invalid');
    if (field === 'hash') invalid.idempotency.bodyHash = 'invalid';
    if (field === 'key') invalid.idempotency.idempotencyKey = 'invalid';
    const provider = await resolveClinicalProvider({ tx: database().tx, auditContext: invalid });
    await expect(provider.sendCompletion(request())).rejects.toBeInstanceOf(
      VendorAuditUnavailableError,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([{ tenant_id: 'Telecheck-Ghana' }, { workload_type: 'protocol_execution' }])(
    'rejects a clean request bound to a different scope %#',
    async (overrides) => {
      const provider = await resolveClinicalProvider({
        tx: database().tx,
        auditContext: context(),
      });
      await expect(
        provider.sendCompletion({ ...request(), ...overrides } as LLMCompletionRequest),
      ).rejects.toBeInstanceOf(VendorEgressBlockedError);
      expect(transport).not.toHaveBeenCalled();
      expect(recordVendorDecision).toHaveBeenCalledWith(expect.anything(), 'anthropic', {
        action: 'block',
        reason: 'screening_failed',
        patternIds: [],
        hitCount: 0,
        candidateFingerprint: null,
      });
    },
  );

  it('snapshots attribution before credential resolution yields', async () => {
    const input = context();
    const providerPromise = resolveClinicalProvider({ tx: database().tx, auditContext: input });
    input.idempotency.actorId = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
    Reflect.set(input, 'patientId', input.idempotency.actorId);
    const provider = await providerPromise;
    await provider.sendCompletion(request('Use 192.0.2.1'));
    expect(recordVendorDecision).toHaveBeenCalledWith(
      { ...context(), reservationExpiresAt: expiresAt },
      'anthropic',
      expect.anything(),
    );
  });

  it('preserves clean results, real provider outage typing, and the unconfigured Null path', async () => {
    const provider = await resolveClinicalProvider({ tx: database().tx, auditContext: context() });
    expect((await provider.sendCompletion(request())).text).toBe('Hello');
    expect(recordVendorDecision).not.toHaveBeenCalled();
    transport.mockRejectedValueOnce(new Error('synthetic network failure'));
    await expect(provider.sendCompletion(request())).rejects.toBeInstanceOf(
      LLMProviderUnavailableError,
    );
    Reflect.set(config, 'anthropicApiKey', undefined);
    const unconfigured = await resolveClinicalProvider();
    expect(unconfigured.name).toBe('null');
    await expect(unconfigured.sendCompletion(request())).rejects.toBeInstanceOf(
      LLMProviderUnavailableError,
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
