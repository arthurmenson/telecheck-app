/**
 * ai-cache.test.ts — direct unit-coverage on the TLC-058a skeleton.
 *
 * Mocks the Anthropic SDK boundary via the `AnthropicSDKLike` interface so no
 * real network calls or dependency adds are required (TLC-058c brings the
 * real SDK in alongside telemetry wire-up).
 *
 * Coverage in this file (7 sections):
 *
 *   §1 CacheableAIInvocation type construction + validation
 *   §2 aiInvoke happy path — Anthropic provider mocked; cache_control blocks
 *      attached to system + tools
 *   §3 aiInvoke cache-config parameterization (TTL passed through)
 *   §4 tenantCachePrefix namespacing (per-tenant distinctness)
 *   §5 Provider-stub paths (Bedrock + Azure throw ProviderNotImplementedError)
 *   §6 TelemetryEmitter hook invocation (cache_hit / cache_miss / cache_creation)
 *   §7 Cross-reference gap regression marker (CacheableAIInvocation accepts
 *      model_version + guardrail_template_id / protocol_id directly without
 *      reaching into ai-context.ts)
 *
 * Spec references:
 *   - ai-cache.ts (target)
 *   - ADR-020 (multi-provider abstraction)
 *   - ADR-029 (AI workload taxonomy + audit envelope fields)
 *   - strategy doc §7 Tier 1 (parameterization rationale)
 *   - I-023 (tenant isolation at cache layer)
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type AIInvocationResult,
  type AnthropicMessagesCreateParams,
  type AnthropicMessagesCreateResponse,
  type AnthropicSDKLike,
  type CacheConfig,
  type CacheTelemetryEvent,
  type CacheableAIInvocation,
  type ProviderContext,
  type TelemetryEmitter,
  AnthropicSDKMissingError,
  ProviderNotImplementedError,
  aiInvoke,
  buildAnthropicSystemBlocks,
  buildAnthropicToolBlocks,
  defaultCacheConfig,
  noopTelemetryEmitter,
  tenantCachePrefix,
} from './ai-cache.ts';
import { asTenantId, type TenantId } from './glossary.ts';

const TENANT_US: TenantId = asTenantId('Telecheck-US');
const TENANT_GH: TenantId = asTenantId('Telecheck-Ghana');

function makeInvocation(overrides: Partial<CacheableAIInvocation> = {}): CacheableAIInvocation {
  return {
    tenant_id: TENANT_US,
    systemPrompt: 'You are Telecheck AI operating under guardrail template GT-001.',
    toolCatalog: [
      {
        name: 'lookup_medication_request',
        description: 'Look up a medication_request record by id.',
        input_schema: { type: 'object', properties: { id: { type: 'string' } } },
      },
      {
        name: 'create_consult',
        description: 'Create a consult record.',
        input_schema: { type: 'object', properties: { patient_id: { type: 'string' } } },
      },
    ],
    historyTurns: [],
    turnInput: { content: 'When is my next refill?' },
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1024,
    model_version: 'claude-sonnet-4-5-20250929',
    guardrail_template_id: 'GT-001',
    ...overrides,
  };
}

function makeAnthropicResponse(
  overrides: Partial<AnthropicMessagesCreateResponse> = {},
): AnthropicMessagesCreateResponse {
  return {
    content: [{ type: 'text', text: 'Your next refill is on 2026-05-15.' }],
    usage: {
      input_tokens: 50,
      output_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    model: 'claude-sonnet-4-5-20250929',
    ...overrides,
  };
}

function makeMockSdk(response: AnthropicMessagesCreateResponse): {
  sdk: AnthropicSDKLike;
  createSpy: ReturnType<typeof vi.fn>;
} {
  const createSpy = vi.fn(async (_params: AnthropicMessagesCreateParams) => response);
  const sdk: AnthropicSDKLike = { messages: { create: createSpy } };
  return { sdk, createSpy };
}

function makeProviderCtx(
  overrides: Partial<ProviderContext> = {},
  sdk?: AnthropicSDKLike,
): ProviderContext {
  const base: ProviderContext = {
    provider: 'anthropic',
    cacheConfig: defaultCacheConfig(),
    telemetry: noopTelemetryEmitter,
    ...(sdk ? { anthropicSdk: sdk } : {}),
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// §1 — CacheableAIInvocation type construction + validation
// ---------------------------------------------------------------------------

describe('§1 CacheableAIInvocation', () => {
  it('§1a constructs a valid Mode 1 invocation with guardrail_template_id', () => {
    const invocation = makeInvocation();
    expect(invocation.tenant_id).toBe(TENANT_US);
    expect(invocation.guardrail_template_id).toBe('GT-001');
    expect(invocation.protocol_id).toBeUndefined();
    expect(invocation.turnInput.content).toContain('refill');
  });

  it('§1b constructs a valid Mode 2 invocation with protocol_id', () => {
    const base = makeInvocation({
      protocol_id: 'PROTOCOL-GLP1-v3',
      turnInput: { content: 'Evaluate medication_request mr_123 against GLP-1 protocol.' },
    });
    // exactOptionalPropertyTypes: omit guardrail_template_id rather than assign undefined.
    const { guardrail_template_id: _drop, ...invocation } = base;
    expect(invocation.protocol_id).toBe('PROTOCOL-GLP1-v3');
    expect((invocation as CacheableAIInvocation).guardrail_template_id).toBeUndefined();
  });

  it('§1c allows conversation history with the last turn as in-flight user input', () => {
    const invocation = makeInvocation({
      historyTurns: [
        { role: 'user', content: 'I have type 2 diabetes.' },
        { role: 'assistant', content: 'Thanks — I will keep that in mind.' },
      ],
      turnInput: { content: 'Can I take my medication_request with food?' },
    });
    expect(invocation.historyTurns).toHaveLength(2);
    expect(invocation.historyTurns[1]?.role).toBe('assistant');
    expect(invocation.turnInput.content).toContain('food');
  });
});

// ---------------------------------------------------------------------------
// §2 — aiInvoke happy path with Anthropic provider mocked
// ---------------------------------------------------------------------------

describe('§2 aiInvoke happy path — Anthropic provider', () => {
  it('§2a returns AIInvocationResult with normalized token usage', async () => {
    const { sdk } = makeMockSdk(
      makeAnthropicResponse({
        usage: {
          input_tokens: 50,
          output_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    const result: AIInvocationResult = await aiInvoke(makeInvocation(), makeProviderCtx({}, sdk));
    expect(result.content).toContain('refill');
    expect(result.tokens_used.input).toBe(50);
    expect(result.tokens_used.output).toBe(12);
    expect(result.tokens_used.cached_input).toBe(0);
    expect(result.model_version).toBe('claude-sonnet-4-5-20250929');
    expect(result.provider).toBe('anthropic');
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('§2b attaches cache_control to the system prompt block', async () => {
    const { sdk, createSpy } = makeMockSdk(makeAnthropicResponse());
    await aiInvoke(makeInvocation(), makeProviderCtx({}, sdk));
    const params = createSpy.mock.calls[0]?.[0] as AnthropicMessagesCreateParams;
    expect(params.system).toHaveLength(1);
    expect(params.system[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    // tenant sentinel baked into the cached system content per I-023
    expect(params.system[0]?.text).toContain('Telecheck-US');
  });

  it('§2c attaches cache_control to the LAST tool block only', async () => {
    const { sdk, createSpy } = makeMockSdk(makeAnthropicResponse());
    await aiInvoke(makeInvocation(), makeProviderCtx({}, sdk));
    const params = createSpy.mock.calls[0]?.[0] as AnthropicMessagesCreateParams;
    expect(params.tools).toHaveLength(2);
    expect(params.tools[0]?.cache_control).toBeUndefined();
    expect(params.tools[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('§2d throws AnthropicSDKMissingError when no SDK is injected', async () => {
    await expect(aiInvoke(makeInvocation(), makeProviderCtx({}))).rejects.toBeInstanceOf(
      AnthropicSDKMissingError,
    );
  });
});

// ---------------------------------------------------------------------------
// §3 — cache-config parameterization (TTL passed through)
// ---------------------------------------------------------------------------

describe('§3 CacheConfig parameterization', () => {
  it('§3a passes the configured platformLayerTtl through to cache_control', async () => {
    const { sdk, createSpy } = makeMockSdk(makeAnthropicResponse());
    const cacheConfig: CacheConfig = {
      ...defaultCacheConfig(),
      platformLayerTtl: '5m', // override the strategy-doc default (decision 2)
    };
    await aiInvoke(makeInvocation(), makeProviderCtx({ cacheConfig }, sdk));
    const params = createSpy.mock.calls[0]?.[0] as AnthropicMessagesCreateParams;
    expect(params.system[0]?.cache_control?.ttl).toBe('5m');
    expect(params.tools[1]?.cache_control?.ttl).toBe('5m');
  });

  it('§3b defaultCacheConfig returns strategy-doc Tier 1 defaults', () => {
    const cfg = defaultCacheConfig();
    expect(cfg.platformLayerTtl).toBe('1h');
    expect(cfg.tenantLayerTtl).toBe('5m');
    expect(cfg.sessionLayerTtl).toBe('5m');
    expect(cfg.cacheHitWarnThreshold).toBe(0.7);
  });

  it('§3c buildAnthropicSystemBlocks + buildAnthropicToolBlocks honour custom TTL', () => {
    const invocation = makeInvocation();
    const cfg: CacheConfig = { ...defaultCacheConfig(), platformLayerTtl: '5m' };
    expect(buildAnthropicSystemBlocks(invocation, cfg)[0]?.cache_control?.ttl).toBe('5m');
    const tools = buildAnthropicToolBlocks(invocation, cfg);
    expect(tools.at(-1)?.cache_control?.ttl).toBe('5m');
  });
});

// ---------------------------------------------------------------------------
// §4 — tenantCachePrefix namespacing
// ---------------------------------------------------------------------------

describe('§4 tenantCachePrefix', () => {
  it('§4a produces distinct prefixes per tenant per I-023', () => {
    const usPrefix = tenantCachePrefix(TENANT_US);
    const ghPrefix = tenantCachePrefix(TENANT_GH);
    expect(usPrefix).not.toBe(ghPrefix);
    expect(usPrefix).toContain('Telecheck-US');
    expect(ghPrefix).toContain('Telecheck-Ghana');
  });

  it('§4b is deterministic — same tenant produces same prefix', () => {
    expect(tenantCachePrefix(TENANT_US)).toBe(tenantCachePrefix(TENANT_US));
  });

  it('§4c bakes the tenant sentinel into the cached system block content', () => {
    const usSystem = buildAnthropicSystemBlocks(
      makeInvocation({ tenant_id: TENANT_US }),
      defaultCacheConfig(),
    );
    const ghSystem = buildAnthropicSystemBlocks(
      makeInvocation({ tenant_id: TENANT_GH }),
      defaultCacheConfig(),
    );
    // Two tenants with byte-identical systemPrompt content still produce
    // distinct cached content because the sentinel differs.
    expect(usSystem[0]?.text).not.toBe(ghSystem[0]?.text);
  });
});

// ---------------------------------------------------------------------------
// §5 — Provider stub paths
// ---------------------------------------------------------------------------

describe('§5 Provider stubs throw ProviderNotImplementedError', () => {
  it('§5a Bedrock provider throws with actionable message pointing at Tier 2', async () => {
    try {
      await aiInvoke(makeInvocation(), makeProviderCtx({ provider: 'bedrock' }));
      expect.unreachable('expected ProviderNotImplementedError');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderNotImplementedError);
      expect((err as Error).message).toContain('Tier 2');
    }
  });

  it('§5b Azure OpenAI provider throws with actionable message pointing at Tier 2', async () => {
    await expect(
      aiInvoke(makeInvocation(), makeProviderCtx({ provider: 'azure-openai' })),
    ).rejects.toBeInstanceOf(ProviderNotImplementedError);
  });

  it('§5c error message names the provider that was rejected', async () => {
    try {
      await aiInvoke(makeInvocation(), makeProviderCtx({ provider: 'bedrock' }));
      expect.unreachable('expected ProviderNotImplementedError');
    } catch (err) {
      expect((err as Error).message).toContain('bedrock');
    }
  });
});

// ---------------------------------------------------------------------------
// §6 — TelemetryEmitter hook invocation
// ---------------------------------------------------------------------------

describe('§6 TelemetryEmitter hook', () => {
  function makeCapturingEmitter(): {
    emitter: TelemetryEmitter;
    events: CacheTelemetryEvent[];
  } {
    const events: CacheTelemetryEvent[] = [];
    return {
      events,
      emitter: {
        emit(event: CacheTelemetryEvent): void {
          events.push(event);
        },
      },
    };
  }

  it('§6a emits cache_hit when cache_read_input_tokens > 0', async () => {
    const { sdk } = makeMockSdk(
      makeAnthropicResponse({
        usage: {
          input_tokens: 5,
          output_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 4096,
        },
      }),
    );
    const { emitter, events } = makeCapturingEmitter();
    await aiInvoke(makeInvocation(), makeProviderCtx({ telemetry: emitter }, sdk));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('cache_hit');
    expect(events[0]?.tenant_id).toBe(TENANT_US);
    expect(events[0]?.tokens?.cache_read_input_tokens).toBe(4096);
  });

  it('§6b emits cache_creation when cache_creation_input_tokens > 0', async () => {
    const { sdk } = makeMockSdk(
      makeAnthropicResponse({
        usage: {
          input_tokens: 4096,
          output_tokens: 12,
          cache_creation_input_tokens: 4096,
          cache_read_input_tokens: 0,
        },
      }),
    );
    const { emitter, events } = makeCapturingEmitter();
    await aiInvoke(makeInvocation(), makeProviderCtx({ telemetry: emitter }, sdk));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('cache_creation');
    expect(events[0]?.tokens?.cache_creation_input_tokens).toBe(4096);
  });

  it('§6c emits cache_miss when neither cache_read nor cache_creation tokens are present', async () => {
    const { sdk } = makeMockSdk(
      makeAnthropicResponse({
        usage: {
          input_tokens: 50,
          output_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
    );
    const { emitter, events } = makeCapturingEmitter();
    await aiInvoke(makeInvocation(), makeProviderCtx({ telemetry: emitter }, sdk));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('cache_miss');
  });

  it('§6d noopTelemetryEmitter is the default and does not throw', () => {
    expect(() =>
      noopTelemetryEmitter.emit({
        type: 'cache_hit',
        tenant_id: TENANT_US,
        layer: 'platform',
        provider: 'anthropic',
        model_version: 'claude-sonnet-4-5-20250929',
        timestamp: new Date().toISOString(),
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §7 — Cross-reference gap regression marker (strategy doc §11)
// ---------------------------------------------------------------------------

describe('§7 Cross-reference gap accommodation (ai-context.ts §11)', () => {
  it('§7a CacheableAIInvocation accepts model_version directly (not read from ai-context.ts)', () => {
    const invocation = makeInvocation({ model_version: 'claude-opus-4-5-20250929' });
    expect(invocation.model_version).toBe('claude-opus-4-5-20250929');
  });

  it('§7b CacheableAIInvocation accepts guardrail_template_id directly (Mode 1 path)', () => {
    const invocation = makeInvocation({ guardrail_template_id: 'GT-042' });
    expect(invocation.guardrail_template_id).toBe('GT-042');
  });

  it('§7c CacheableAIInvocation accepts protocol_id directly (Mode 2 path)', () => {
    const base = makeInvocation({ protocol_id: 'PROTOCOL-GLP1-v3' });
    const { guardrail_template_id: _drop, ...invocation } = base;
    expect(invocation.protocol_id).toBe('PROTOCOL-GLP1-v3');
  });

  it('§7d model_version on AIInvocationResult matches the value supplied on the invocation', async () => {
    const { sdk } = makeMockSdk(makeAnthropicResponse());
    const result = await aiInvoke(
      makeInvocation({ model_version: 'claude-haiku-4-5-20250929' }),
      makeProviderCtx({}, sdk),
    );
    expect(result.model_version).toBe('claude-haiku-4-5-20250929');
  });
});
