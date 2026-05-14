/**
 * ai-service/internal/providers/null-provider.ts — the always-
 * unavailable provider used as the v1.0 default until real adapters
 * land.
 *
 * Why a Null provider:
 *
 *   - Avoids the "what does sendCompletion return when no provider
 *     is configured?" trap. Without a Null implementation, callers
 *     would have to special-case undefined providers everywhere.
 *   - Forces the AI-RESIL-001 fail-soft path to be exercised in
 *     tests from day 1. Tests against the registry default land an
 *     `LLMProviderUnavailableError` and assert the caller maps it
 *     to the "AI assistant temporarily unavailable" UI envelope.
 *   - Makes the provider abstraction (PR D) standalone-testable
 *     without depending on real network calls or SDK installs.
 *
 * The Null provider is INTENTIONALLY unsafe to use in production:
 * `sendCompletion` always throws `LLMProviderUnavailableError`. The
 * registry (PR D companion) maps every workload to Null at v1.0;
 * the real-provider registry update lands when secrets management
 * + Anthropic SDK install are resolved.
 *
 * Spec references:
 *   - ADR-020 (Anthropic primary; multi-provider abstraction)
 *   - AI_LAYERING v5.2 §7 (AI-RESIL-001/002)
 */

import type { LLMCompletionRequest, LLMCompletionResult } from './types.js';
import { BaseLLMProvider, LLMProviderUnavailableError } from './types.js';

export class NullLLMProvider extends BaseLLMProvider {
  readonly name = 'null' as const;

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async _sendCompletion(
    _request: LLMCompletionRequest,
  ): Promise<LLMCompletionResult> {
    throw new LLMProviderUnavailableError(
      'null',
      'No LLM provider configured. Configure an adapter (Anthropic / Bedrock / Azure OpenAI) per ADR-020 ' +
        'before routing live AI traffic; until then, every sendCompletion call fails-soft so the ' +
        'AI-RESIL-001 path renders the documented "AI assistant temporarily unavailable" UI state.',
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected override async _healthcheck(): Promise<{ healthy: boolean; reason?: string }> {
    return {
      healthy: false,
      reason: 'No LLM provider configured (NullLLMProvider in use). See ADR-020.',
    };
  }
}
