/**
 * ai-service/internal/providers/registry.ts — workload → provider
 * selection per ADR-020.
 *
 * At PR D the registry always returns the NullLLMProvider (no real
 * adapters wired). Real selection lands when Anthropic + secrets
 * management are resolved.
 *
 * Per ADR-020:
 *   - Selection is per-workload (per-route in the slice-PRD prose;
 *     workload_type is the canonical discriminator per
 *     WORKLOAD_TAXONOMY v5.2).
 *   - Clinical paths (conversational_assistant, protocol_execution,
 *     crisis-detection-within-those) are Anthropic-only at v1.0.
 *     The registry returns a clinical-default provider for those
 *     types; reserved workload types (autonomous_agent,
 *     multi_agent_supervisor, tool_using_agent) are unsupported
 *     until a successor ADR + activation audit event per ADR-029.
 *   - Per-tenant override (AI_LAYERING v5.2 §9): tenants may
 *     override provider for NON-CLINICAL routes only. At v1.0 we
 *     don't expose any non-clinical routes through this registry;
 *     tenant override lands when the admin AI-suggestion surface
 *     ships.
 *
 * Spec references:
 *   - ADR-020 (multi-provider LLM abstraction)
 *   - AI_LAYERING v5.2 §9 (clinical paths platform-scoped)
 *   - WORKLOAD_TAXONOMY v5.2 (canonical discriminator)
 */

import type { AIWorkloadType } from '../../../../lib/audit.js';

import { NullLLMProvider } from './null-provider.js';
import type { LLMProvider } from './types.js';

/**
 * Resolve the LLM provider for a given workload type at v1.0.
 *
 * At PR D every workload returns NullLLMProvider — no real adapters
 * are wired. The shape exists so PR-after-PR-D callers can:
 *   - Inject a provider via the registry boundary (DI-friendly)
 *   - Test against NullLLMProvider for the AI-RESIL-001 path
 *   - Replace the per-workload return when a real adapter ships
 *     without changing every call site
 *
 * Reserved workload types (autonomous_agent, multi_agent_supervisor,
 * tool_using_agent) — per ADR-029 §6 these are namespace
 * placeholders pending successor ADR. The registry throws on them
 * so a caller attempting to route a reserved type fails-loud at
 * runtime rather than silently degrading to Null.
 */
export function resolveProvider(workload_type: AIWorkloadType): LLMProvider {
  switch (workload_type) {
    case 'conversational_assistant':
    case 'protocol_execution':
      // Clinical paths — Anthropic-only at v1.0 per ADR-020.
      // NullLLMProvider returns at PR D until the real Anthropic
      // adapter ships.
      return new NullLLMProvider();
    case 'autonomous_agent':
    case 'multi_agent_supervisor':
    case 'tool_using_agent':
      // Per ADR-029 §6 + AI_LAYERING v5.2 §10.1: reserved workload
      // types require successor ADR + activation audit event before
      // code paths exist. Silently routing them to NullLLMProvider
      // would hide that this branch is unreachable at v1.0; throwing
      // fails-loud so a callsite that accidentally constructs one
      // of these is visible immediately.
      throw new Error(
        `AIWorkloadType "${workload_type}" is reserved per ADR-029 §6 — successor ADR + activation audit event required before code paths exist`,
      );
    case 'rejected_invalid_attempt':
    case 'n/a':
    case null:
      // These are sentinel / null values that should never be
      // passed to the provider registry — they're audit-envelope
      // discriminators for execution_rejected records / clinician-
      // only carve-outs / non-AI events.
      throw new Error(
        `AIWorkloadType "${workload_type ?? 'null'}" is a sentinel/null value and has no provider mapping`,
      );
    default: {
      // Exhaustiveness check: TypeScript will fail-compile if a new
      // AIWorkloadType is added without a case branch above.
      const _exhaustive: never = workload_type;
      void _exhaustive;
      throw new Error(`Unhandled AIWorkloadType in resolveProvider: ${String(workload_type)}`);
    }
  }
}
