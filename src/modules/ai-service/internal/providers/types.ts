/**
 * ai-service/internal/providers/types.ts — LLMProvider abstraction
 * per ADR-020 (multi-provider LLM with Anthropic primary).
 *
 * At PR D, the interface + a NullLLMProvider land; real Anthropic /
 * Bedrock / Azure OpenAI adapters land when secrets management is
 * resolved (autonomous-run scope decision — secrets owner ratifies
 * the env / KMS path before real provider clients ship).
 *
 * Per ADR-020:
 *   - Anthropic Claude is primary for clinical paths (Mode 1
 *     patient-facing, Mode 2 case-prep, crisis detection,
 *     guardrail evaluation).
 *   - AWS Bedrock-hosted Claude (same model, different procurement
 *     chain) is a documented alternative for AWS-native BAA cases.
 *   - Azure OpenAI is a documented alternative for Microsoft/Azure
 *     tenant relationships.
 *   - Self-hosted Llama is permitted for NON-CLINICAL paths only
 *     (per the ADR; clinical paths are Anthropic-only at v1.0).
 *   - Provider selection is per-route + per-workload. Tenants may
 *     override provider for non-clinical routes only (clinical
 *     routes are platform-default per ADR-020 + AI_LAYERING v5.2
 *     §9 tenant scoping).
 *
 * Per ADR-020 audit consequence: "every LLM call records provider,
 * model, model_version in audit per AUDIT-EVENTS contract.
 * Provider-swap is observable post-hoc." The result type carries
 * the provider attribution so the caller's audit emission can
 * populate it.
 *
 * Per AI-RESIL-001: provider unavailability MUST NOT cascade to
 * clinical workflows. The interface exposes `healthcheck()` for
 * the operator dashboard's degradation alert (AI-RESIL-002) and
 * `LLMProviderUnavailableError` is the canonical fail-soft path the
 * caller maps to AI-RESIL-001's "AI assistant temporarily
 * unavailable" UI state.
 *
 * Spec references:
 *   - ADR-020 (multi-provider LLM abstraction)
 *   - AI_LAYERING v5.2 §7 (AI-RESIL-001/002)
 *   - AI_LAYERING v5.2 §9 (tenant scoping; clinical-path provider
 *     selection is platform-scoped)
 *   - AUDIT_EVENTS v5.3 (provider + model + model_version attribution
 *     on every LLM call's audit record)
 *   - WORKLOAD_TAXONOMY v5.2 (provider routing keys off workload_type)
 */

import type { AIWorkloadType } from '../../../../lib/audit.js';

// ---------------------------------------------------------------------------
// LLMProvider — the abstraction
// ---------------------------------------------------------------------------

/** Provider identifier for audit attribution + registry lookup. */
export type LLMProviderName =
  | 'anthropic'
  | 'bedrock_claude'
  | 'azure_openai'
  | 'llama_self_hosted'
  | 'null'; // SENTINEL — used for tests + the unconfigured-default

/**
 * A single message in an LLM conversation. Aligns with the Anthropic
 * messages API shape; other providers map to/from this in their
 * adapter.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCompletionRequest {
  /**
   * The workload context — the registry resolves provider selection
   * from this + per-route configuration.
   */
  workload_type: AIWorkloadType;
  /** Conversation turns to feed the provider. */
  messages: ReadonlyArray<LLMMessage>;
  /**
   * Maximum tokens the provider may return. Caller enforces upper
   * bound by use case (Mode 1 chat caps lower than Mode 2 case-prep).
   */
  max_output_tokens: number;
  /**
   * Temperature 0..1. Clinical paths default to 0 (deterministic) per
   * AI Safety review. The interface allows higher temperatures for
   * non-clinical paths (e.g., creative copy generation) but callers
   * MUST justify in audit detail.
   */
  temperature: number;
  /**
   * Tenant context for per-tenant cost attribution + (future)
   * per-tenant provider override resolution per AI_LAYERING v5.2 §9.
   */
  tenant_id: string;
}

export interface LLMCompletionResult {
  /** Provider's full response text. Caller may post-process for
   *  guardrail enforcement (PR E) before surfacing. */
  text: string;
  /** Provider attribution for the audit envelope. */
  provider_name: LLMProviderName;
  /** Provider's model identifier (e.g., 'claude-sonnet-4',
   *  'claude-haiku-3-5'). */
  model: string;
  /** Provider's model VERSION (e.g., '2026-04-15'). Distinct from
   *  `model` so an audit chain can query "all responses from
   *  claude-sonnet-4 between dates" with one filter, or "responses
   *  from model_version X" for a versioned compliance review. */
  model_version: string;
  /** Token usage for cost + capacity tracking. */
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * The provider abstraction. Concrete adapters: AnthropicProvider
 * (primary), BedrockClaudeProvider, AzureOpenAIProvider,
 * LlamaSelfHostedProvider (non-clinical only). At PR D only
 * NullLLMProvider implements this.
 */
export interface LLMProvider {
  readonly name: LLMProviderName;

  /**
   * Send a completion request. On provider error, callers should
   * receive an `LLMProviderUnavailableError` (or its subclass) so
   * the AI-RESIL-001 fail-soft path can fire ("AI assistant
   * temporarily unavailable" UI state + alternative actions).
   */
  sendCompletion(request: LLMCompletionRequest): Promise<LLMCompletionResult>;

  /**
   * Health-check probe for the operator dashboard's degradation
   * alert (AI-RESIL-002). Returns `healthy: false` + a reason on
   * provider unavailability so the alert surface can render a
   * useful operator message without exposing implementation
   * internals.
   */
  healthcheck(): Promise<{ healthy: boolean; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * The provider is unavailable. Caller maps to the AI-RESIL-001
 * fail-soft UI state. Distinct from a request-level validation error
 * (which is a 4xx) — provider unavailability is a 503-ish condition
 * the caller surfaces as "AI assistant temporarily unavailable".
 */
export class LLMProviderUnavailableError extends Error {
  constructor(
    public readonly provider_name: LLMProviderName,
    public readonly cause_summary: string,
  ) {
    super(`LLM provider ${provider_name} unavailable: ${cause_summary}`);
    this.name = 'LLMProviderUnavailableError';
  }
}

/**
 * The provider is configured but the caller's request violates a
 * provider-level constraint (e.g., context window exceeded). Caller
 * maps to a 400 / 422 since the user-facing path is bounded.
 */
export class LLMRequestValidationError extends Error {
  constructor(
    public readonly provider_name: LLMProviderName,
    public readonly reason: string,
  ) {
    super(`LLM provider ${provider_name} rejected request: ${reason}`);
    this.name = 'LLMRequestValidationError';
  }
}
