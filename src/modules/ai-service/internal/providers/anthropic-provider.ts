/**
 * ai-service/internal/providers/anthropic-provider.ts — the real Anthropic
 * Messages API adapter per ADR-020 (Anthropic primary for clinical paths).
 *
 * **SI-025 (Admin-Managed AI Provider Credentials):** the API key is
 * resolved by `resolveProvider()` — from the admin-managed DB credential via
 * the SECDEF read path, or the ANTHROPIC_API_KEY env fallback — and injected
 * into the constructor. This adapter NEVER reads the key from config itself
 * and NEVER logs it.
 *
 * **No heavy deps:** a minimal fetch-based client against
 * https://api.anthropic.com/v1/messages (Node 20 global fetch), rather than
 * pulling in the Anthropic SDK. The request shape follows the Messages API:
 * `x-api-key` header + `anthropic-version` header + a system/messages body.
 *
 * **Fail-soft (AI-RESIL-001):** extends BaseLLMProvider, so any thrown error
 * (network, non-2xx, malformed body) is wrapped as
 * LLMProviderUnavailableError by the base — the caller maps it to the
 * documented "AI assistant temporarily unavailable" UI state. Request-shape
 * errors (context too large, etc.) surface as LLMRequestValidationError.
 *
 * **Key-safety discipline:** the plaintext key is held ONLY in the private
 * `#apiKey` field, sent ONLY in the x-api-key request header, and is never
 * placed in a log line, error message, thrown cause_summary, or the returned
 * result. The base-class wrap surfaces only the upstream error message (which
 * Anthropic does not echo the key into).
 *
 * Spec references:
 *   - ADR-020 (multi-provider LLM abstraction; Anthropic primary)
 *   - SI-025 §5 (AI-service read-path wiring; key injected, never logged)
 *   - AI_LAYERING v5.2 §7 (AI-RESIL-001 fail-soft)
 *   - AUDIT_EVENTS v5.3 (provider + model + model_version attribution)
 */

import {
  BaseLLMProvider,
  LLMProviderUnavailableError,
  LLMRequestValidationError,
  type LLMCompletionRequest,
  type LLMCompletionResult,
  type LLMProviderName,
} from './types.js';

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Minimal shape of the Anthropic Messages API success response we consume. */
interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export interface AnthropicProviderOptions {
  /** The resolved plaintext API key (from the DB credential or env fallback).
   *  Held privately; never logged. */
  apiKey: string;
  /** The model id (e.g. 'claude-opus-4-5-20250929'), from config.anthropicModel. */
  model: string;
  /** Optional fetch override for tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

export class AnthropicLLMProvider extends BaseLLMProvider {
  readonly name: LLMProviderName = 'anthropic';

  // Private field — the plaintext key. Never logged, never surfaced.
  readonly #apiKey: string;
  readonly #model: string;
  readonly #fetch: typeof fetch;

  constructor(opts: AnthropicProviderOptions) {
    super();
    if (typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
      // Programming error — resolveProvider must not construct this adapter
      // without a key. Message intentionally does NOT echo the (empty) key.
      throw new Error('AnthropicLLMProvider: apiKey is required and must be non-empty.');
    }
    this.#apiKey = opts.apiKey;
    this.#model = opts.model;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  protected override async _sendCompletion(
    request: LLMCompletionRequest,
  ): Promise<LLMCompletionResult> {
    // Split system messages (Anthropic takes `system` as a top-level string)
    // from the conversational turns.
    const systemText = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: this.#model,
      max_tokens: request.max_output_tokens,
      temperature: request.temperature,
      messages: turns,
    };
    if (systemText.length > 0) {
      body['system'] = systemText;
    }

    let resp: Response;
    try {
      resp = await this.#fetch(ANTHROPIC_MESSAGES_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // The key travels ONLY here. Never logged.
          'x-api-key': this.#apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure — fail-soft. The message is the transport
      // error, which does not contain the key.
      throw new LLMProviderUnavailableError(
        'anthropic',
        err instanceof Error ? err.message : String(err),
      );
    }

    if (!resp.ok) {
      // Read a bounded error body for diagnostics. Anthropic error bodies do
      // NOT echo the request's x-api-key. A 400/422 is a request-shape
      // problem (maps to 4xx); everything else is provider-unavailable.
      const errText = await safeReadText(resp);
      if (resp.status === 400 || resp.status === 422) {
        throw new LLMRequestValidationError(
          'anthropic',
          `Anthropic rejected the request (HTTP ${resp.status}): ${errText}`,
        );
      }
      throw new LLMProviderUnavailableError(
        'anthropic',
        `Anthropic returned HTTP ${resp.status}: ${errText}`,
      );
    }

    let parsed: AnthropicMessagesResponse;
    try {
      parsed = (await resp.json()) as AnthropicMessagesResponse;
    } catch (err) {
      throw new LLMProviderUnavailableError(
        'anthropic',
        `Anthropic response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const text = (parsed.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('');

    return {
      text,
      provider_name: 'anthropic',
      model: parsed.model ?? this.#model,
      // Anthropic does not return a separate model_version; the model id is
      // date-stamped (e.g. claude-opus-4-5-20250929) so we surface it here.
      model_version: parsed.model ?? this.#model,
      usage: {
        input_tokens: parsed.usage?.input_tokens ?? 0,
        output_tokens: parsed.usage?.output_tokens ?? 0,
      },
    };
  }

  protected override async _healthcheck(): Promise<{ healthy: boolean; reason?: string }> {
    // A construction-time healthcheck: the presence of a non-empty key means
    // the adapter is configured. We deliberately do NOT make a live API call
    // here (that would spend tokens on every probe); the operator-facing
    // "test connection" probe (POST /v1/admin/ai-providers/:provider/test)
    // is the explicit live-ping surface.
    return { healthy: this.#apiKey.length > 0 };
  }
}

/** Read a response body as text without throwing (bounded diagnostics). */
async function safeReadText(resp: Response): Promise<string> {
  try {
    const t = await resp.text();
    return t.length > 500 ? `${t.slice(0, 500)}…` : t;
  } catch {
    return '(unreadable error body)';
  }
}
