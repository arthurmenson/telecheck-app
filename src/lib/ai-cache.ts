/**
 * ai-cache.ts — Multi-provider AI invocation with prompt caching (TLC-058a skeleton).
 *
 * Purpose:
 *   Wraps Anthropic Messages API prompt caching (`cache_control` blocks) behind
 *   the ADR-020 multi-provider abstraction. Exposes a single `aiInvoke()` entry
 *   point that downstream Mode 1 (`conversational_assistant`) and Mode 2
 *   (`protocol_execution`) module-level AI calls consume. Returns a normalized
 *   `AIInvocationResult` with `tokens_used` (input + cached_input + output),
 *   `model_version`, and `latency_ms` so callers and TLC-058c telemetry can
 *   reason about cache effectiveness retrospectively.
 *
 *   This is the Tier 1 skeleton per
 *   `docs/AI_COST_OPTIMIZATION_STRATEGY.md` §7. The Anthropic provider attaches
 *   explicit `cache_control: { type: 'ephemeral' }` blocks to (a) the system
 *   prompt and (b) the tool catalog; the Bedrock + Azure providers are stubs
 *   that throw a not-implemented error pointing at Tier 2.
 *
 * Spec references:
 *   - ADR-020 (Multi-Provider AI Abstraction): Anthropic Claude primary;
 *     AWS Bedrock + Azure OpenAI as resilience providers. Cache optimization is
 *     a performance feature, never a correctness feature — fallback to
 *     non-cached execution preserves routing decisions.
 *   - ADR-029 (AI Workload Taxonomy): every AI call carries `ai_workload_type`
 *     and `autonomy_level` per WORKLOAD_TAXONOMY v5.2 + AUTONOMY_LEVELS v5.2.
 *     This file does not re-validate those (delegated to ai-context.ts) — it
 *     only consumes them off the resolved invocation.
 *   - WORKLOAD_TAXONOMY v5.2: active workloads `conversational_assistant`,
 *     `protocol_execution`. Reserved workloads are out of scope at v1.0.
 *   - AUTONOMY_LEVELS v5.2: active levels `advisory`, `suggestion`,
 *     `action_with_confirm`.
 *   - AUDIT_EVENTS v5.2 §1 — AI audit envelope carries `model_version`,
 *     `guardrail_template_id` (Mode 1) or `protocol_id` + `version` (Mode 2).
 *     TLC-058c will add `cache_creation_input_tokens` + `cache_read_input_tokens`
 *     as additive nullable fields to that envelope (Engineering Lead review
 *     pending per strategy doc §10 decision 5).
 *   - I-023 / I-024 / I-025 (tenant isolation): cache prefixes MUST be
 *     tenant-scoped. `tenantCachePrefix()` derives the namespacing sentinel
 *     that lives at the head of every cached block; identical prompt content
 *     under different tenants produces distinct cached prefixes by content.
 *   - I-019 (crisis-detection floor): orthogonal to caching. Crisis detection
 *     runs as a separate scanning pass on every Mode 1 input regardless of
 *     cache layer behavior.
 *   - `src/lib/ai-context.ts` — resolves `ai_workload_type` + `autonomy_level`.
 *     **Cross-reference gap** per strategy doc §11: ai-context.ts does NOT
 *     currently expose `model_version` or `guardrail_template_id`/`protocol_id`.
 *     This skeleton accommodates the gap by accepting those fields directly on
 *     `CacheableAIInvocation` rather than reaching into ai-context.ts. Do NOT
 *     modify ai-context.ts to close this gap without Engineering Lead review
 *     (the strategy doc flags the shape design as a sprint-planning follow-up).
 *
 * Strategy doc §7 Tier 1 + the 6 open decision points (parameterization rationale):
 *
 *   1. Sprint placement (TLC-058 in Sprint 35 vs 36) — operational; does not
 *      affect this skeleton.
 *   2. 1h vs 5min TTL for spec-corpus prefix — parameterized via
 *      `CacheConfig.platformLayerTtl`. Default '1h' matching the strategy doc's
 *      Tier 1 recommendation for stable platform-canonical content.
 *   3. Haiku tier acceptability for low-stakes Mode 1 — parameterized via
 *      `CacheableAIInvocation.model`. The cache layer is model-tier-agnostic;
 *      the routing decision lives in a future Tier 2 `resolveModelTier()` per
 *      strategy doc §6 (not this file's scope).
 *   4. Telemetry surface (stdout / JSON daily roll-up / vendor) — parameterized
 *      via the injected `TelemetryEmitter` interface. Default is a no-op
 *      emitter; TLC-058c wires the real surface.
 *   5. Contracts Pack envelope extension additive vs v5.3 cycle — orthogonal to
 *      this file; the additive fields land in audit.ts when TLC-058c ships.
 *   6. Codex adversarial review at sprint exit — operational; does not affect
 *      this skeleton.
 *
 * Authoring discipline:
 *   - Canonical glossary terms: `medication_request` not `prescription`;
 *     `Mode 1` / `Mode 2` not `chatbot`; `tenant` not `customer`.
 *   - No PHI in cached prefixes. System prompt, tool catalog, and earlier
 *     conversation turns may be tenant-scoped but are NOT patient-scoped.
 *     Patient-specific context flows through the per-turn user input which is
 *     deliberately OUTSIDE every cache_control breakpoint.
 *   - No new dependencies. The Anthropic SDK boundary is abstracted via an
 *     `AnthropicSDKLike` interface so the real `@anthropic-ai/sdk` add lands
 *     with TLC-058c (Tier 1 closure), not here.
 *   - Tenant isolation per ADR-023: tenantCachePrefix() namespaces cached
 *     prefixes by tenant_id so two tenants with byte-identical prompt content
 *     resolve to distinct cached prefixes.
 */

import type { TenantId } from './glossary.ts';

// ---------------------------------------------------------------------------
// Provider abstraction (per ADR-020)
// ---------------------------------------------------------------------------

/** Provider family per ADR-020. Anthropic is primary; Bedrock + Azure are resilience. */
export type AIProvider = 'anthropic' | 'bedrock' | 'azure-openai';

/** Cache TTL choices. Mirrors Anthropic's prompt-cache surface. */
export type CacheTtl = '5m' | '1h';

/** Cache layer per strategy doc §5. Each layer maps to one cache_control breakpoint. */
export type CacheLayer = 'platform' | 'tenant' | 'session' | 'turn';

// ---------------------------------------------------------------------------
// CacheableAIInvocation — what the caller passes to aiInvoke()
// ---------------------------------------------------------------------------

/**
 * Per-turn user input. Deliberately OUTSIDE every cache_control breakpoint
 * because (a) it varies on every call and (b) it may contain patient-specific
 * content. PHI MUST NOT flow into cached layers.
 */
export interface TurnInput {
  /** Free-form user content for this turn (Mode 1) or per-invocation payload (Mode 2). */
  content: string;
}

/**
 * A single conversation turn. The last turn in the history is the in-flight
 * user turn (non-cached); earlier turns can be cached as part of the session
 * layer prefix.
 */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Tool definition as understood by the cache layer. We don't validate JSON
 * schema shapes here — that is the AI provider's job. We do require a stable
 * serialization so the tool catalog hashes identically across calls.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * CacheableAIInvocation — the canonical input to `aiInvoke()`.
 *
 * Cache layering maps to strategy doc §5 tables:
 *   - `systemPrompt`         -> L1 platform-canonical (1h TTL by default)
 *   - `toolCatalog`          -> L1 platform-canonical (1h TTL by default)
 *   - `historyTurns`         -> L3 session (5m TTL by default); the last
 *                                 element is the current user turn (non-cached)
 *   - `turnInput`            -> L4 turn (NOT cached)
 *
 * `model_version` and `guardrail_template_id` / `protocol_id` are taken
 * explicitly off this struct rather than read from ai-context.ts — see the
 * cross-reference gap note in the header.
 *
 * TODO (strategy doc §11 cross-ref gap): once ai-context.ts is extended (or a
 * sibling AIInvocationContext type is defined) to carry these fields, this
 * shape may collapse into reading them off `req.aiContext`. Engineering Lead
 * review required before that change; do NOT pre-empt it here.
 */
export interface CacheableAIInvocation {
  /** Tenant scoping per I-023. Required on every cacheable invocation. */
  tenant_id: TenantId;

  /** System prompt — stable platform-canonical content. */
  systemPrompt: string;

  /** Tool catalog — stable platform-canonical content. */
  toolCatalog: ToolDefinition[];

  /** Conversation history. Empty array for fresh Mode 1 sessions or Mode 2 single-shot calls. */
  historyTurns: ConversationTurn[];

  /** Per-turn user input — non-cached. */
  turnInput: TurnInput;

  /** Anthropic model identifier (e.g., 'claude-sonnet-4-5-20250929'). */
  model: string;

  /** Max output tokens for this invocation. */
  max_tokens: number;

  /**
   * Resolved `model_version` per ADR-029 audit-envelope requirement.
   * Accepted directly to work around the ai-context.ts cross-ref gap (§11).
   */
  model_version: string;

  /**
   * Resolved guardrail/protocol identifier per ADR-029. Exactly one of these
   * is populated per the workload type:
   *   - Mode 1 (`conversational_assistant`) -> `guardrail_template_id`
   *   - Mode 2 (`protocol_execution`) -> `protocol_id`
   */
  guardrail_template_id?: string;
  protocol_id?: string;
}

// ---------------------------------------------------------------------------
// CacheConfig — decision-agnostic parameterization
// ---------------------------------------------------------------------------

/**
 * CacheConfig — the 6 strategy-doc decision points materialize as fields here.
 * Defaults match the strategy doc's Tier 1 recommendations; downstream callers
 * may override per their workload. All fields are required on the resolved
 * config; the `defaultCacheConfig` helper provides the defaults.
 */
export interface CacheConfig {
  /** TTL for the L1 platform-canonical layer (system prompt + tool catalog). */
  platformLayerTtl: CacheTtl;

  /** TTL for the L2 tenant-overlay layer. */
  tenantLayerTtl: CacheTtl;

  /** TTL for the L3 session-history layer. */
  sessionLayerTtl: CacheTtl;

  /**
   * Threshold (0..1) below which a sustained cache-hit rate triggers a
   * telemetry-emitted warning per strategy doc §9. TLC-058c surfaces the
   * threshold-breached event; the skeleton just carries the field.
   */
  cacheHitWarnThreshold: number;
}

/**
 * defaultCacheConfig — strategy doc §7 Tier 1 recommended defaults.
 *
 * Decisions parameterized rather than hardcoded so Evans's pending
 * ratification on strategy doc §10 decision points 2 + 3 + 4 can flow through
 * without changing the call sites.
 */
export function defaultCacheConfig(): CacheConfig {
  return {
    platformLayerTtl: '1h', // strategy doc §5 Mode 1/Mode 2 L1 row (decision 2 default)
    tenantLayerTtl: '5m', // strategy doc §5 (also bounds tenant-data staleness per §9)
    sessionLayerTtl: '5m', // strategy doc §5
    cacheHitWarnThreshold: 0.7, // strategy doc §9 — < 30% miss rate
  };
}

// ---------------------------------------------------------------------------
// Tenant-scoped cache prefix helper
// ---------------------------------------------------------------------------

/**
 * tenantCachePrefix — derives a tenant-scoped sentinel that prepends every
 * cached block. Two tenants with byte-identical prompt content resolve to
 * distinct cached prefixes because the sentinel differs.
 *
 * Anthropic's prompt cache is content-keyed; injecting the tenant_id into the
 * cached content is how we achieve tenant isolation at the cache layer per
 * strategy doc §5 + I-023. There is no cross-organization sharing in
 * Anthropic's cache, but cross-tenant sharing WITHIN our organization is
 * exactly the risk this guards.
 */
export function tenantCachePrefix(tenantId: TenantId): string {
  return `[telecheck.cache.tenant=${tenantId}]`;
}

// ---------------------------------------------------------------------------
// AIInvocationResult — normalized return shape
// ---------------------------------------------------------------------------

export interface TokenUsage {
  /** Non-cached input tokens for this call. */
  input: number;
  /** Tokens read from the prompt cache at ~10% of base input cost. */
  cached_input: number;
  /** Output tokens generated by the model. */
  output: number;
}

export interface AIInvocationResult {
  /** Model-generated content (concatenated text block content). */
  content: string;
  /** Token usage breakdown for cost analysis. */
  tokens_used: TokenUsage;
  /** Resolved `model_version` per ADR-029 audit envelope. */
  model_version: string;
  /** End-to-end wall-clock latency for the AI call in milliseconds. */
  latency_ms: number;
  /** Provider that served the call per ADR-020. */
  provider: AIProvider;
}

// ---------------------------------------------------------------------------
// Telemetry hook — strategy doc §10 decision 4 parameterization point
// ---------------------------------------------------------------------------

export type CacheTelemetryEventType = 'cache_hit' | 'cache_miss' | 'cache_creation';

export interface CacheTelemetryEvent {
  type: CacheTelemetryEventType;
  /** Tenant scoping per I-023. */
  tenant_id: TenantId;
  /** Which cache layer the event applies to. */
  layer: CacheLayer;
  /** Provider that emitted the event. */
  provider: AIProvider;
  /** Model version per ADR-029. */
  model_version: string;
  /** Token counts surfaced by the provider for this event. */
  tokens?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  /** Wall-clock timestamp (ISO 8601). */
  timestamp: string;
}

/**
 * TelemetryEmitter — injectable surface. v0.1 default is a no-op so TLC-058c
 * can wire the real emitter without touching this file's API.
 *
 * Note: this hook DOES NOT emit audit events (those are I-027 platform-floor
 * and require a Postgres transaction handle per audit.ts). Cache telemetry is
 * a performance/cost signal, not an audit signal. TLC-058c may layer audit
 * emission on top of telemetry once the AUDIT_EVENTS v5.2 envelope extension
 * lands (strategy doc §10 decision 5).
 */
export interface TelemetryEmitter {
  emit(event: CacheTelemetryEvent): void;
}

/** noopTelemetryEmitter — default surface; replace via injection in TLC-058c. */
export const noopTelemetryEmitter: TelemetryEmitter = {
  emit(_event: CacheTelemetryEvent): void {
    // Intentionally empty. TLC-058c wires the real emitter.
  },
};

// ---------------------------------------------------------------------------
// Anthropic SDK boundary (interface only; no dep)
// ---------------------------------------------------------------------------

/**
 * AnthropicCacheControl — mirrors the SDK's `cache_control` block shape so we
 * can construct the request payload without depending on the SDK type
 * definitions in this skeleton. When TLC-058c adds `@anthropic-ai/sdk` to
 * package.json, this shape can be replaced with the SDK's exported type and
 * the structural equivalence will hold.
 */
export interface AnthropicCacheControl {
  type: 'ephemeral';
  /**
   * Anthropic's prompt cache supports a `ttl` hint on the cache_control block
   * for extended (1h) caching. Omitted blocks default to 5m.
   */
  ttl?: '5m' | '1h';
}

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicToolBlock {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicMessageBlock {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnthropicMessagesCreateParams {
  model: string;
  max_tokens: number;
  system: AnthropicSystemBlock[];
  tools: AnthropicToolBlock[];
  messages: AnthropicMessageBlock[];
}

export interface AnthropicMessagesCreateResponse {
  content: Array<{ type: 'text'; text: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  model: string;
}

/**
 * AnthropicSDKLike — minimal structural interface the real
 * `@anthropic-ai/sdk` Messages client satisfies. Decouples this skeleton from
 * the dependency add (TLC-058c) per the authoring-discipline rule.
 */
export interface AnthropicSDKLike {
  messages: {
    create(params: AnthropicMessagesCreateParams): Promise<AnthropicMessagesCreateResponse>;
  };
}

// ---------------------------------------------------------------------------
// ProviderContext — what aiInvoke() needs from the caller
// ---------------------------------------------------------------------------

export interface ProviderContext {
  /** Which ADR-020 provider family handles this call. */
  provider: AIProvider;
  /** Cache configuration; defaults via defaultCacheConfig() when omitted upstream. */
  cacheConfig: CacheConfig;
  /** Anthropic SDK boundary (or test double). Required when provider === 'anthropic'. */
  anthropicSdk?: AnthropicSDKLike;
  /** Telemetry surface; defaults to noopTelemetryEmitter when omitted upstream. */
  telemetry: TelemetryEmitter;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ProviderNotImplementedError extends Error {
  constructor(provider: AIProvider) {
    super(
      `ai-cache: provider "${provider}" is not implemented in the TLC-058a Tier 1 skeleton. ` +
        'Per ADR-020 + strategy doc §7, Anthropic Claude is the Tier 1 primary; AWS Bedrock + ' +
        'Azure OpenAI implementations are Tier 2 scope. Fall back to Anthropic or wait for the ' +
        'Tier 2 implementation.',
    );
    this.name = 'ProviderNotImplementedError';
  }
}

export class AnthropicSDKMissingError extends Error {
  constructor() {
    super(
      'ai-cache: anthropicSdk must be provided on ProviderContext when provider === "anthropic". ' +
        'Inject a real SDK client (TLC-058c) or a test double (vitest).',
    );
    this.name = 'AnthropicSDKMissingError';
  }
}

// ---------------------------------------------------------------------------
// Anthropic provider implementation
// ---------------------------------------------------------------------------

/**
 * buildAnthropicSystemBlocks — composes the L1 platform-canonical system
 * prompt blocks with a tenant-scoped sentinel prepended (so the tenant_id is
 * baked into the cached content per I-023).
 *
 * The single cache_control breakpoint sits on the last block in the array so
 * Anthropic's prompt cache treats the whole system layer as one cached
 * prefix.
 */
export function buildAnthropicSystemBlocks(
  invocation: CacheableAIInvocation,
  config: CacheConfig,
): AnthropicSystemBlock[] {
  const tenantSentinel = tenantCachePrefix(invocation.tenant_id);
  return [
    {
      type: 'text',
      text: `${tenantSentinel}\n${invocation.systemPrompt}`,
      cache_control: { type: 'ephemeral', ttl: config.platformLayerTtl },
    },
  ];
}

/**
 * buildAnthropicToolBlocks — attaches a cache_control breakpoint to the LAST
 * tool definition so the entire tool catalog is treated as one cached prefix
 * per the strategy doc §5 L1 layering.
 */
export function buildAnthropicToolBlocks(
  invocation: CacheableAIInvocation,
  config: CacheConfig,
): AnthropicToolBlock[] {
  if (invocation.toolCatalog.length === 0) {
    return [];
  }
  return invocation.toolCatalog.map((tool, idx) => {
    const isLast = idx === invocation.toolCatalog.length - 1;
    if (isLast) {
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema,
        cache_control: { type: 'ephemeral', ttl: config.platformLayerTtl } as const,
      };
    }
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    };
  });
}

/**
 * buildAnthropicMessages — composes the conversation history + per-turn user
 * input into Anthropic's `messages` array. The per-turn input is appended
 * last, OUTSIDE any cache breakpoint (Anthropic caches the prefix; everything
 * after the last cache_control block is the variable tail).
 */
export function buildAnthropicMessages(invocation: CacheableAIInvocation): AnthropicMessageBlock[] {
  const turns: AnthropicMessageBlock[] = invocation.historyTurns.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));
  turns.push({ role: 'user', content: invocation.turnInput.content });
  return turns;
}

async function invokeAnthropic(
  invocation: CacheableAIInvocation,
  providerCtx: ProviderContext,
): Promise<AIInvocationResult> {
  if (!providerCtx.anthropicSdk) {
    throw new AnthropicSDKMissingError();
  }

  const system = buildAnthropicSystemBlocks(invocation, providerCtx.cacheConfig);
  const tools = buildAnthropicToolBlocks(invocation, providerCtx.cacheConfig);
  const messages = buildAnthropicMessages(invocation);

  const start = Date.now();
  const response = await providerCtx.anthropicSdk.messages.create({
    model: invocation.model,
    max_tokens: invocation.max_tokens,
    system,
    tools,
    messages,
  });
  const latencyMs = Date.now() - start;

  const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = response.usage.cache_creation_input_tokens ?? 0;

  // Telemetry — strategy doc §10 decision 4 surface. Emit one event per
  // observation; TLC-058c rolls these up into the JSON daily file.
  const timestamp = new Date().toISOString();
  if (cacheReadTokens > 0) {
    providerCtx.telemetry.emit({
      type: 'cache_hit',
      tenant_id: invocation.tenant_id,
      layer: 'platform',
      provider: 'anthropic',
      model_version: invocation.model_version,
      tokens: { cache_read_input_tokens: cacheReadTokens },
      timestamp,
    });
  } else if (cacheCreationTokens > 0) {
    providerCtx.telemetry.emit({
      type: 'cache_creation',
      tenant_id: invocation.tenant_id,
      layer: 'platform',
      provider: 'anthropic',
      model_version: invocation.model_version,
      tokens: { cache_creation_input_tokens: cacheCreationTokens },
      timestamp,
    });
  } else {
    providerCtx.telemetry.emit({
      type: 'cache_miss',
      tenant_id: invocation.tenant_id,
      layer: 'platform',
      provider: 'anthropic',
      model_version: invocation.model_version,
      timestamp,
    });
  }

  // Concatenate text content blocks. Tool-use blocks are out of scope for the
  // skeleton; TLC-058c will surface them in a richer response type.
  const content = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return {
    content,
    tokens_used: {
      input: response.usage.input_tokens,
      cached_input: cacheReadTokens,
      output: response.usage.output_tokens,
    },
    model_version: invocation.model_version,
    latency_ms: latencyMs,
    provider: 'anthropic',
  };
}

// ---------------------------------------------------------------------------
// aiInvoke — the single public entry point
// ---------------------------------------------------------------------------

/**
 * aiInvoke — runs a `CacheableAIInvocation` through the resolved provider.
 *
 * Mode 1 + Mode 2 module-level AI calls consume this. The function:
 *   - Anthropic: attaches `cache_control: { type: 'ephemeral' }` blocks to the
 *     system prompt + tool catalog, fires the call, surfaces token usage
 *     including cache_read + cache_creation tokens.
 *   - Bedrock: throws ProviderNotImplementedError (Tier 2 scope).
 *   - Azure OpenAI: throws ProviderNotImplementedError (Tier 2 scope).
 *
 * Resilience routing (ADR-020) is unaffected by cache layer behavior — if
 * Anthropic is unavailable, the caller should fall back to Bedrock/Azure
 * before reaching aiInvoke, and the cache layer simply does not apply on the
 * resilience path until Tier 2.
 */
export async function aiInvoke(
  invocation: CacheableAIInvocation,
  providerCtx: ProviderContext,
): Promise<AIInvocationResult> {
  switch (providerCtx.provider) {
    case 'anthropic':
      return invokeAnthropic(invocation, providerCtx);
    case 'bedrock':
      throw new ProviderNotImplementedError('bedrock');
    case 'azure-openai':
      throw new ProviderNotImplementedError('azure-openai');
    default: {
      // Exhaustiveness guard — strict mode catches unhandled cases at compile
      // time, but the runtime branch keeps the error surface explicit if a
      // future ADR-020 successor adds another provider family.
      const exhaustive: never = providerCtx.provider;
      throw new Error(`ai-cache: unknown provider "${String(exhaustive)}"`);
    }
  }
}
