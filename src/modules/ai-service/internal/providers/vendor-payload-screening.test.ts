import { afterEach, describe, expect, it, vi } from 'vitest';

import { PII_PATTERNS } from '../../../../lib/pii-screener/patterns.js';

import { AnthropicLLMProvider } from './anthropic-provider.js';
import type { LLMCompletionRequest, LLMMessage } from './types.js';
import {
  VendorAuditUnavailableError,
  VendorEgressBlockedError,
  withVendorBoundary,
} from './vendor-boundary.js';
import { screenVendorRequest, VENDOR_REDACTION_TOKEN } from './vendor-payload-screening.js';

// If the local component ever loads the NER stack, collection fails.
vi.mock('../../../../lib/pii-screener/ner.js', () => {
  throw new Error('Layer 4 must not load NER');
});

function request(messages: LLMMessage[]): LLMCompletionRequest {
  return {
    workload_type: 'conversational_assistant',
    tenant_id: 'Telecheck-US',
    messages,
    max_output_tokens: 1024,
    temperature: 0,
  };
}

const cases = [
  { id: 'date_of_birth', text: 'DOB 1990-01-15', action: 'block' },
  { id: 'ghana_card', text: 'GHA-123456789-0', action: 'block' },
  { id: 'us_ssn', text: '123-45-6789', action: 'block' },
  { id: 'us_passport', text: 'passport no. AB1234567', action: 'redact' },
  { id: 'credit_card', text: '4111 1111 1111 1111', action: 'block' },
  { id: 'email', text: 'synthetic.person@example.com', action: 'block' },
  { id: 'us_phone', text: '+1 (312) 555-1212', action: 'block' },
  { id: 'ghana_phone', text: '+233 24 123 4567', action: 'block' },
  { id: 'ipv4', text: '192.0.2.1', action: 'redact' },
  { id: 'ipv6', text: '2001:db8::1', action: 'redact' },
  { id: 'medical_record_number', text: 'MRN 543210', action: 'block' },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('screenVendorRequest — local regex component (not resolver wiring)', () => {
  it('covers every currently registered regex category', () => {
    expect(cases.map((c) => c.id).sort()).toEqual(PII_PATTERNS.map((p) => p.id).sort());
  });

  describe.each(['system', 'user', 'assistant'] as const)('%s message', (role) => {
    it.each(cases)('$id produces $action without exposing matches', ({ id, text, action }) => {
      const result = screenVendorRequest(request([{ role, content: text }]));
      expect(result.action).toBe(action);
      expect(result.patternIds).toContain(id);
      expect(result.hitCount).toBeGreaterThan(0);
      expect(JSON.stringify(result)).not.toContain(text);
      if (result.action === 'block') {
        expect(result).not.toHaveProperty('request');
        expect(result.reason).toBe('high_confidence_match');
      } else {
        expect(result.request.messages[0]?.content).toBe(VENDOR_REDACTION_TOKEN);
      }
    });
  });

  it('preserves clean clinical content and all routing metadata', () => {
    const input = request([
      { role: 'user', content: 'What time should I take my medication today?' },
    ]);
    const result = screenVendorRequest(input);
    expect(result).toEqual({ action: 'pass', patternIds: [], hitCount: 0, request: input });
    if (result.action === 'block') throw new Error('expected sendable request');
    expect(result.request).not.toBe(input);
    expect(result.request.messages).not.toBe(input.messages);
    expect(result.request.messages[0]).not.toBe(input.messages[0]);
  });

  it('does not mutate frozen caller input and snapshots the content', () => {
    const message: LLMMessage = { role: 'user', content: 'Use 192.0.2.1 for this example.' };
    const input = Object.freeze(request(Object.freeze([Object.freeze(message)]) as LLMMessage[]));
    const result = screenVendorRequest(input);
    expect(result.action).toBe('redact');
    expect(input.messages[0]?.content).toContain('192.0.2.1');
    if (result.action === 'block') throw new Error('expected sendable request');
    expect(result.request.messages[0]?.content).toBe('Use [REDACTED:PII] for this example.');
  });

  it('blocks a DOB pattern formed only by concatenating system messages', () => {
    for (const content of ['DOB', '1990-01-15']) {
      expect(screenVendorRequest(request([{ role: 'system', content }])).action).toBe('pass');
    }
    const result = screenVendorRequest(
      request([
        { role: 'system', content: 'DOB' },
        { role: 'user', content: 'Hello' },
        { role: 'system', content: '1990-01-15' },
      ]),
    );
    expect(result.action).toBe('block');
    expect(result.patternIds).toContain('date_of_birth');
  });

  it('redacts a passport pattern formed only by concatenating system messages', () => {
    const result = screenVendorRequest(
      request([
        { role: 'system', content: 'passport' },
        { role: 'system', content: 'ABCDE1234' },
        { role: 'user', content: 'Hello' },
      ]),
    );
    expect(result.action).toBe('redact');
    if (result.action === 'block') throw new Error('expected sendable request');
    expect(result.request.messages).toEqual([
      { role: 'system', content: VENDOR_REDACTION_TOKEN },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('blocks if any message is high-confidence, even when others only need redaction', () => {
    const result = screenVendorRequest(
      request([
        { role: 'system', content: 'Use 192.0.2.1' },
        { role: 'assistant', content: 'Earlier synthetic.person@example.com' },
        { role: 'user', content: 'Hello' },
      ]),
    );
    expect(result.action).toBe('block');
    expect(result.patternIds).toEqual(expect.arrayContaining(['email', 'ipv4']));
    expect(result).not.toHaveProperty('request');
  });

  it('checks high-confidence matches before replacing overlapping lower-confidence matches', () => {
    const result = screenVendorRequest(request([{ role: 'user', content: 'passport 123456789' }]));
    expect(result.action).toBe('block');
    expect(result.patternIds).toEqual(expect.arrayContaining(['us_ssn', 'us_passport']));
  });

  it('merges overlapping network matches without nested redaction tokens', () => {
    const result = screenVendorRequest(request([{ role: 'user', content: '::ffff:192.0.2.1' }]));
    expect(result.action).toBe('redact');
    if (result.action === 'block') throw new Error('expected sendable request');
    expect(result.request.messages[0]?.content).toBe(VENDOR_REDACTION_TOKEN);
  });

  it('honors Luhn validation and preserves a rejected card candidate', () => {
    const result = screenVendorRequest(request([{ role: 'user', content: '4111111111111112' }]));
    expect(result.action).toBe('pass');
    expect(result.patternIds).not.toContain('credit_card');
  });

  it('does not load NER or call any external classifier', () => {
    const external = vi.fn(() => {
      throw new Error('external classification forbidden');
    });
    vi.stubGlobal('fetch', external);
    expect(screenVendorRequest(request([{ role: 'user', content: cases[5].text }])).action).toBe(
      'block',
    );
    expect(external).not.toHaveBeenCalled();
  });

  it('preserves the documented regex-only name gap without claiming launch readiness', () => {
    expect(
      screenVendorRequest(request([{ role: 'user', content: 'My name is Sarah Whitfield' }]))
        .action,
    ).toBe('pass');
  });

  it('is independent of shared regex lastIndex and repeat calls', () => {
    const pattern = PII_PATTERNS.find((p) => p.id === 'email')!;
    pattern.regex.lastIndex = 999;
    try {
      for (let i = 0; i < 3; i++) {
        expect(
          screenVendorRequest(request([{ role: 'user', content: cases[5].text }])).action,
        ).toBe('block');
      }
      expect(pattern.regex.lastIndex).toBe(999);
    } finally {
      pattern.regex.lastIndex = 0;
    }
  });

  it('fails closed if a local validator throws without returning its message', () => {
    const pattern = PII_PATTERNS.find((p) => p.id === 'credit_card')!;
    vi.spyOn(pattern, 'validate').mockImplementation(() => {
      throw new Error(cases[5].text);
    });
    const result = screenVendorRequest(request([{ role: 'user', content: cases[4].text }]));
    expect(result).toEqual({
      action: 'block',
      reason: 'screening_failed',
      patternIds: [],
      hitCount: 0,
    });
  });

  it.each([
    null,
    { ...request([]), messages: [{ role: 'tool', content: 'Hello' }] },
    { ...request([]), messages: [{ role: 'user', content: { text: cases[5].text } }] },
    { ...request([]), messages: [{ role: 'user', content: 'Hello', name: cases[5].text }] },
    { ...request([]), tools: [{ input: cases[5].text }] },
    { ...request([]), [cases[5].text]: 'unknown field' },
    { ...request([]), temperature: Number.NaN },
    { ...request([]), workload_type: 'tool_using_agent' },
  ])('rejects malformed or unreviewed request extensions %#', (input) => {
    expect(screenVendorRequest(input as LLMCompletionRequest)).toEqual({
      action: 'block',
      reason: 'screening_failed',
      patternIds: [],
      hitCount: 0,
    });
  });

  it('does not invoke candidate-bearing getters', () => {
    const getter = vi.fn(() => cases[5].text);
    const input = request([
      {
        role: 'user',
        get content() {
          return getter();
        },
      },
    ]);
    expect(screenVendorRequest(input).action).toBe('block');
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('screened component output through the actual Anthropic serializer', () => {
  function capture(): { provider: AnthropicLLMProvider; bodies: string[] } {
    const bodies: string[] = [];
    const provider = new AnthropicLLMProvider({
      apiKey: 'synthetic-test-key',
      model: 'synthetic-test-model',
      fetchImpl: async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response(
          JSON.stringify({ content: [{ type: 'text', text: 'Hello' }], usage: {} }),
          { status: 200 },
        );
      },
    });
    return { provider, bodies };
  }

  it('preserves the clean wire body including system joins and turn order', async () => {
    const { provider, bodies } = capture();
    const input = request([
      { role: 'system', content: 'Be helpful.' },
      { role: 'user', content: 'Prior question' },
      { role: 'system', content: 'Use synthetic examples.' },
      { role: 'assistant', content: 'Prior reply' },
      { role: 'user', content: 'Current question' },
    ]);
    await provider.sendCompletion(input);
    const result = screenVendorRequest(input);
    if (result.action === 'block') throw new Error('expected sendable request');
    await provider.sendCompletion(result.request);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it('serializes only redacted content and passes a regex replay on prompt fields', async () => {
    const { provider, bodies } = capture();
    const result = screenVendorRequest(
      request([
        { role: 'system', content: 'passport' },
        { role: 'system', content: 'ABCDE1234' },
        { role: 'assistant', content: 'Prior endpoint 192.0.2.1' },
        { role: 'user', content: 'Use 2001:db8::1 now.' },
      ]),
    );
    expect(result.action).toBe('redact');
    if (result.action === 'block') throw new Error('expected sendable request');
    await provider.sendCompletion(result.request);
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]!) as { system: string; messages: LLMMessage[] };
    expect(bodies[0]).not.toMatch(/ABCDE1234|192\.0\.2\.1|2001:db8::1/);
    for (const content of [body.system, ...body.messages.map((m) => m.content)]) {
      for (const pattern of PII_PATTERNS) {
        const matches = [
          ...content.matchAll(new RegExp(pattern.regex.source, pattern.regex.flags)),
        ].filter((m) => !pattern.validate || pattern.validate(m[0]));
        expect(matches, pattern.id).toEqual([]);
      }
    }
  });

  it.each(cases.filter((c) => c.action === 'block'))(
    'wrapper prevents $id from reaching the actual transport',
    async ({ text }) => {
      const { provider, bodies } = capture();
      const record = vi.fn(async () => undefined);
      const protectedProvider = withVendorBoundary(provider, record);
      await expect(
        protectedProvider.sendCompletion(request([{ role: 'system', content: text }])),
      ).rejects.toBeInstanceOf(VendorEgressBlockedError);
      expect(bodies).toEqual([]);
      expect(record).toHaveBeenCalledOnce();
      expect(record.mock.calls[0]).not.toContain(text);
      expect(JSON.stringify(record.mock.calls)).not.toContain(text);
    },
  );

  it('awaits the recorder before dispatch and isolates the payload from later input mutation', async () => {
    const { provider, bodies } = capture();
    let release!: () => void;
    const recorded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record = vi.fn(() => recorded);
    const input = request([{ role: 'user', content: 'Use 192.0.2.1' }]);
    const completion = withVendorBoundary(provider, record).sendCompletion(input);
    expect(record).toHaveBeenCalledOnce();
    expect(bodies).toEqual([]);
    input.messages[0]!.content = cases[5].text;
    release();
    await completion;
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('Use [REDACTED:PII]');
    expect(bodies[0]).not.toContain(cases[5].text);
  });

  it.each(['192.0.2.1', 'synthetic.person@example.com'])(
    'audit failure for %s prevents dispatch and does not expose diagnostic content',
    async (content) => {
      const { provider, bodies } = capture();
      const wrapped = withVendorBoundary(provider, async () => {
        throw new Error('sensitive diagnostic synthetic.person@example.com');
      });
      const failure: unknown = await wrapped
        .sendCompletion(request([{ role: 'user', content }]))
        .catch((err: unknown) => err);
      expect(failure).toBeInstanceOf(VendorAuditUnavailableError);
      expect(String(failure)).not.toContain('synthetic.person@example.com');
      expect(failure).not.toHaveProperty('cause');
      expect(bodies).toEqual([]);
    },
  );

  it('records screening failure and sends nothing when the local validator fails', async () => {
    const { provider, bodies } = capture();
    const pattern = PII_PATTERNS.find((p) => p.id === 'credit_card')!;
    vi.spyOn(pattern, 'validate').mockImplementation(() => {
      throw new Error(cases[5].text);
    });
    const record = vi.fn(async () => undefined);
    await expect(
      withVendorBoundary(provider, record).sendCompletion(
        request([{ role: 'user', content: cases[4].text }]),
      ),
    ).rejects.toBeInstanceOf(VendorEgressBlockedError);
    expect(record).toHaveBeenCalledWith({
      action: 'block',
      reason: 'screening_failed',
      patternIds: [],
      hitCount: 0,
    });
    expect(bodies).toEqual([]);
  });

  it('preserves clean provider results, health checks, and provider errors', async () => {
    const { provider, bodies } = capture();
    const record = vi.fn(async () => undefined);
    const wrapped = withVendorBoundary(provider, record);
    expect(wrapped.name).toBe('anthropic');
    expect(await wrapped.healthcheck()).toEqual({ healthy: true });
    expect(bodies).toEqual([]);
    const result = await wrapped.sendCompletion(request([{ role: 'user', content: 'Hello' }]));
    expect(result.text).toBe('Hello');
    expect(record).not.toHaveBeenCalled();
    const failure = new Error('synthetic provider failure');
    vi.spyOn(provider, 'sendCompletion').mockRejectedValue(failure);
    await expect(
      wrapped.sendCompletion(request([{ role: 'user', content: 'Hello' }])),
    ).rejects.toBe(failure);
  });

  it('requires an explicit recorder at construction', () => {
    const { provider } = capture();
    expect(() => withVendorBoundary(provider, undefined as never)).toThrow(
      VendorAuditUnavailableError,
    );
  });
});
