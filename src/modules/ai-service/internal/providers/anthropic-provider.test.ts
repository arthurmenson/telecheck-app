/**
 * anthropic-provider.test.ts — SI-025 unit tests for the real Anthropic
 * Messages API adapter (fetch-mocked; no live network).
 *
 * Locks in:
 *   1. Happy path: parses the Messages API response into LLMCompletionResult
 *      (text, provider_name, model, usage).
 *   2. The API key travels ONLY in the x-api-key request header — never in
 *      the result, and never in a thrown error's message.
 *   3. Fail-soft: a network throw / non-2xx surfaces as
 *      LLMProviderUnavailableError (AI-RESIL-001), 400/422 as
 *      LLMRequestValidationError.
 *   4. The constructor rejects an empty key (programming-error guard).
 *
 * Spec references:
 *   - ADR-020 (Anthropic primary) / SI-025 §5 (key injected, never logged)
 *   - AI_LAYERING v5.2 §7 (AI-RESIL-001 fail-soft)
 */

import { describe, expect, it, vi } from 'vitest';

import { AnthropicLLMProvider } from './anthropic-provider.ts';
import {
  LLMProviderUnavailableError,
  LLMRequestValidationError,
  type LLMCompletionRequest,
} from './types.ts';

const SECRET_KEY = 'sk-ant-SECRET-DO-NOT-LEAK-123456';
const MODEL = 'claude-opus-4-5-20250929';

function aRequest(): LLMCompletionRequest {
  return {
    workload_type: 'conversational_assistant',
    messages: [
      { role: 'system', content: 'You are a clinical assistant.' },
      { role: 'user', content: 'hello' },
    ],
    max_output_tokens: 128,
    temperature: 0,
    tenant_id: 'Telecheck-US',
  };
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: 'hi there' }],
      model: MODEL,
      usage: { input_tokens: 12, output_tokens: 3 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('AnthropicLLMProvider — happy path', () => {
  it('parses the Messages API response into an LLMCompletionResult', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const provider = new AnthropicLLMProvider({ apiKey: SECRET_KEY, model: MODEL, fetchImpl });
    const result = await provider.sendCompletion(aRequest());

    expect(result.text).toBe('hi there');
    expect(result.provider_name).toBe('anthropic');
    expect(result.model).toBe(MODEL);
    expect(result.usage.input_tokens).toBe(12);
    expect(result.usage.output_tokens).toBe(3);
  });

  it('sends the API key ONLY in the x-api-key header (system split, versioned)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const provider = new AnthropicLLMProvider({ apiKey: SECRET_KEY, model: MODEL, fetchImpl });
    await provider.sendCompletion(aRequest());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(SECRET_KEY);
    expect(headers['anthropic-version']).toBeDefined();
    // The key MUST NOT appear anywhere in the request body.
    expect(String(init.body)).not.toContain(SECRET_KEY);
    // System message hoisted to top-level `system`; turns exclude it.
    const body = JSON.parse(String(init.body)) as { system?: string; messages: unknown[] };
    expect(body.system).toContain('clinical assistant');
    expect(body.messages).toHaveLength(1);
  });

  it('the result never contains the API key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const provider = new AnthropicLLMProvider({ apiKey: SECRET_KEY, model: MODEL, fetchImpl });
    const result = await provider.sendCompletion(aRequest());
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
  });
});

describe('AnthropicLLMProvider — fail-soft (AI-RESIL-001)', () => {
  it('a network throw surfaces as LLMProviderUnavailableError without leaking the key', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const provider = new AnthropicLLMProvider({ apiKey: SECRET_KEY, model: MODEL, fetchImpl });
    let thrown: unknown;
    try {
      await provider.sendCompletion(aRequest());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMProviderUnavailableError);
    expect((thrown as Error).message).not.toContain(SECRET_KEY);
  });

  it('a 500 response surfaces as LLMProviderUnavailableError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('upstream error', { status: 500 }));
    const provider = new AnthropicLLMProvider({ apiKey: SECRET_KEY, model: MODEL, fetchImpl });
    await expect(provider.sendCompletion(aRequest())).rejects.toBeInstanceOf(
      LLMProviderUnavailableError,
    );
  });

  it('a 400 response surfaces as LLMRequestValidationError', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    const provider = new AnthropicLLMProvider({ apiKey: SECRET_KEY, model: MODEL, fetchImpl });
    await expect(provider.sendCompletion(aRequest())).rejects.toBeInstanceOf(
      LLMRequestValidationError,
    );
  });
});

describe('AnthropicLLMProvider — constructor guard', () => {
  it('rejects an empty API key (programming error, message does not echo it)', () => {
    expect(() => new AnthropicLLMProvider({ apiKey: '', model: MODEL })).toThrow(
      /apiKey is required/,
    );
  });

  it('healthcheck reports healthy when a key is present (no live call)', async () => {
    const provider = new AnthropicLLMProvider({ apiKey: SECRET_KEY, model: MODEL });
    const health = await provider.healthcheck();
    expect(health.healthy).toBe(true);
  });
});
