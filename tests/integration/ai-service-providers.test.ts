/**
 * ai-service-providers.test.ts — LLMProvider abstraction tests per
 * TLC-AI PR D.
 *
 * The interface + NullLLMProvider + resolveProvider registry are
 * unit-testable (no DB / no HTTP). At PR D the registry returns
 * NullLLMProvider for every supported workload — these tests lock
 * in:
 *   1. NullLLMProvider always throws LLMProviderUnavailableError on
 *      sendCompletion (AI-RESIL-001 fail-soft path).
 *   2. NullLLMProvider.healthcheck reports healthy=false.
 *   3. resolveProvider returns a NullLLMProvider for
 *      conversational_assistant + protocol_execution at v1.0.
 *   4. resolveProvider THROWS on reserved workload types
 *      (autonomous_agent, multi_agent_supervisor, tool_using_agent)
 *      so a callsite that accidentally constructs one of these
 *      fails-loud at runtime.
 *   5. resolveProvider THROWS on sentinel values
 *      (rejected_invalid_attempt, n/a, null) — those are
 *      audit-envelope discriminators with no provider mapping.
 *
 * Spec references:
 *   - ADR-020 (multi-provider LLM abstraction; Anthropic primary)
 *   - AI_LAYERING v5.2 §7 (AI-RESIL-001/002 fail-soft)
 *   - WORKLOAD_TAXONOMY v5.2 (active + reserved workload types)
 *   - ADR-029 §6 (reserved workload activation: two-condition AND
 *     of successor ADR + activation audit event)
 */

import { describe, expect, it } from 'vitest';

import type { AIWorkloadType } from '../../src/lib/audit.ts';
import {
  LLMProviderUnavailableError,
  NullLLMProvider,
  resolveProvider,
} from '../../src/modules/ai-service/index.ts';

const TENANT_ID_STUB = 'Telecheck-US';

function aRequest(workload_type: AIWorkloadType) {
  return {
    workload_type,
    messages: [{ role: 'user' as const, content: 'hi' }],
    max_output_tokens: 100,
    temperature: 0,
    tenant_id: TENANT_ID_STUB,
  };
}

describe('NullLLMProvider — PR D fail-soft default', () => {
  it('sendCompletion always throws LLMProviderUnavailableError (AI-RESIL-001 fail-soft path)', async () => {
    const provider = new NullLLMProvider();
    expect(provider.name).toBe('null');

    let thrown: unknown = null;
    try {
      await provider.sendCompletion(aRequest('conversational_assistant'));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMProviderUnavailableError);
    if (thrown instanceof LLMProviderUnavailableError) {
      expect(thrown.provider_name).toBe('null');
      expect(thrown.cause_summary).toContain('ADR-020');
    }
  });

  it('healthcheck reports healthy=false with a documented reason', async () => {
    const provider = new NullLLMProvider();
    const health = await provider.healthcheck();
    expect(health.healthy).toBe(false);
    expect(health.reason).toContain('No LLM provider configured');
    expect(health.reason).toContain('ADR-020');
  });
});

describe('resolveProvider — PR D registry routes', () => {
  it('conversational_assistant → NullLLMProvider at v1.0', () => {
    const provider = resolveProvider('conversational_assistant');
    expect(provider).toBeInstanceOf(NullLLMProvider);
    expect(provider.name).toBe('null');
  });

  it('protocol_execution → NullLLMProvider at v1.0', () => {
    const provider = resolveProvider('protocol_execution');
    expect(provider).toBeInstanceOf(NullLLMProvider);
    expect(provider.name).toBe('null');
  });

  it('reserved workload types throw fail-loud — autonomous_agent', () => {
    expect(() => resolveProvider('autonomous_agent')).toThrow(/reserved per ADR-029/);
  });

  it('reserved workload types throw fail-loud — multi_agent_supervisor', () => {
    expect(() => resolveProvider('multi_agent_supervisor')).toThrow(/reserved per ADR-029/);
  });

  it('reserved workload types throw fail-loud — tool_using_agent', () => {
    expect(() => resolveProvider('tool_using_agent')).toThrow(/reserved per ADR-029/);
  });

  it('sentinel workload types throw — rejected_invalid_attempt', () => {
    expect(() => resolveProvider('rejected_invalid_attempt')).toThrow(/sentinel\/null/);
  });

  it('sentinel workload types throw — n/a', () => {
    expect(() => resolveProvider('n/a')).toThrow(/sentinel\/null/);
  });

  it('null workload type throws — has no provider mapping', () => {
    expect(() => resolveProvider(null)).toThrow(/sentinel\/null/);
  });
});

describe('LLMProvider integration boundary', () => {
  it('a workload routed through resolveProvider + sendCompletion fails-soft end-to-end', async () => {
    // The PR D end-to-end smoke: a caller that asks for the
    // canonical clinical workload + sends a completion gets the
    // documented AI-RESIL-001 error envelope shape. This is the
    // exact path PR-after-PR-D handlers traverse before Anthropic
    // lands; locking it in means any regression in the abstraction
    // (e.g., a future PR accidentally swallowing the error) trips
    // this test.
    const provider = resolveProvider('conversational_assistant');
    let thrown: unknown = null;
    try {
      await provider.sendCompletion(aRequest('conversational_assistant'));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LLMProviderUnavailableError);
  });
});
