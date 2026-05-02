/**
 * ai-context.ts — AI workload type + autonomy level resolution per ADR-029.
 *
 * Purpose:
 *   Resolves `ai_workload_type` and `autonomy_level` for AI invocations per
 *   WORKLOAD_TAXONOMY v5.2 and AUTONOMY_LEVELS v5.2. Enforces that reserved
 *   workload types and autonomy levels throw at runtime when their feature flags
 *   are false (default at v1.0). Exposes resolved context via Fastify decorator
 *   `req.aiContext` when applicable.
 *
 * Spec references:
 *   - ADR-029 (AI Workload Taxonomy): discriminator `ai_workload_type`.
 *   - WORKLOAD_TAXONOMY v5.2:
 *       * Active at v1.0: `conversational_assistant`, `protocol_execution`.
 *       * Reserved (require successor ADR + activation audit event):
 *         `autonomous_agent`, `multi_agent_supervisor`, `tool_using_agent`.
 *       * Sentinels: `rejected_invalid_attempt` (execution_rejected events only),
 *         `n/a` (I-012 clinician-only approval records only).
 *   - AUTONOMY_LEVELS v5.2:
 *       * Active at v1.0: `advisory`, `suggestion`, `action_with_confirm`.
 *       * Reserved (require ADR-030 + PolicyAuthorization):
 *         `action_with_audit_only`, `fully_autonomous`.
 *   - I-019 (crisis detection floor): applies regardless of workload type or autonomy level.
 *   - I-012: prescribing/refill/medication-order actions require `action_with_confirm`.
 *   - AUDIT_EVENTS v5.2 §1: every AI audit event carries `ai_workload_type` + `autonomy_level`.
 *
 * Runtime gate design:
 *   - Reserved workload types: `resolveWorkloadType()` throws `ReservedWorkloadTypeError`
 *     if `config.featureFlags.ENABLE_*` is false (always false at v1.0).
 *   - Reserved autonomy levels: `resolveAutonomyLevel()` throws `ReservedAutonomyLevelError`
 *     if `config.featureFlags.ENABLE_ACTION_WITH_AUDIT_ONLY` or `ENABLE_FULLY_AUTONOMOUS` is false.
 *   - Sentinels (`rejected_invalid_attempt`, `n/a`) are NOT resolvable via this module —
 *     they are set by the audit emitter directly on rejection/clinician-only records.
 *
 * Open questions for Engineering Lead:
 *   - `req.aiContext` is populated by the `aiContextPlugin` only for routes that
 *     explicitly opt in via the `x-ai-workload-type` header (machine-to-machine) or
 *     by calling `resolveAiContext()` in the route handler. Should it be auto-populated
 *     for all routes? Current design: opt-in to avoid overhead on non-AI routes.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Types (re-exported for consumers that don't import glossary.ts directly)
// ---------------------------------------------------------------------------

export type AIWorkloadType =
  | 'conversational_assistant'
  | 'protocol_execution'
  | 'autonomous_agent'              // RESERVED
  | 'multi_agent_supervisor'        // RESERVED
  | 'tool_using_agent'              // RESERVED
  | 'rejected_invalid_attempt'      // SENTINEL — not for runtime AI workloads
  | 'n/a';                          // SENTINEL — not for runtime AI workloads

export type AutonomyLevel =
  | 'advisory'
  | 'suggestion'
  | 'action_with_confirm'
  | 'action_with_audit_only'   // RESERVED
  | 'fully_autonomous'         // RESERVED
  | 'rejected_invalid_attempt' // SENTINEL
  | 'n/a';                     // SENTINEL

export interface AIContext {
  ai_workload_type: AIWorkloadType;
  autonomy_level: AutonomyLevel;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ReservedWorkloadTypeError extends Error {
  constructor(workloadType: string) {
    super(
      `Reserved ai_workload_type "${workloadType}" cannot be used at v1.0. ` +
        'Activation requires (a) successor ADR accepted AND (b) activation audit event ' +
        'in the immutable audit chain. See WORKLOAD_TAXONOMY v5.2 §3.',
    );
    this.name = 'ReservedWorkloadTypeError';
  }
}

export class ReservedAutonomyLevelError extends Error {
  constructor(autonomyLevel: string) {
    super(
      `Reserved autonomy_level "${autonomyLevel}" cannot be used at v1.0. ` +
        'Activation requires ADR-030 (Tiered Autonomy Progression Model) + ' +
        'PolicyAuthorization framework + I-012 successor invariant. ' +
        'See AUTONOMY_LEVELS v5.2 §3.',
    );
    this.name = 'ReservedAutonomyLevelError';
  }
}

export class SentinelWorkloadTypeError extends Error {
  constructor(sentinel: string) {
    super(
      `Sentinel value "${sentinel}" cannot be used by runtime AI workloads. ` +
        'Sentinels are set only by the audit emitter on rejection/clinician-only records. ' +
        'See WORKLOAD_TAXONOMY v5.2 §1 + AUDIT_EVENTS v5.2 §I-012 closure rule.',
    );
    this.name = 'SentinelWorkloadTypeError';
  }
}

// ---------------------------------------------------------------------------
// Workload type resolution
// ---------------------------------------------------------------------------

/**
 * resolveWorkloadType — validates and returns an AIWorkloadType.
 *
 * Throws for reserved types (feature flag false) and sentinels.
 * Active types at v1.0: `conversational_assistant`, `protocol_execution`.
 */
export function resolveWorkloadType(raw: string): AIWorkloadType {
  // Sentinels must not be used by runtime workloads
  if (raw === 'rejected_invalid_attempt' || raw === 'n/a') {
    throw new SentinelWorkloadTypeError(raw);
  }

  // Reserved workload type gates (all false at v1.0 per config)
  if (raw === 'autonomous_agent') {
    if (!config.featureFlags.ENABLE_AUTONOMOUS_AGENT) {
      throw new ReservedWorkloadTypeError(raw);
    }
  }
  if (raw === 'multi_agent_supervisor') {
    if (!config.featureFlags.ENABLE_MULTI_AGENT_SUPERVISOR) {
      throw new ReservedWorkloadTypeError(raw);
    }
  }
  if (raw === 'tool_using_agent') {
    if (!config.featureFlags.ENABLE_TOOL_USING_AGENT) {
      throw new ReservedWorkloadTypeError(raw);
    }
  }

  // Active at v1.0
  if (raw === 'conversational_assistant' || raw === 'protocol_execution') {
    return raw;
  }

  // Unknown value — reject
  throw new ReservedWorkloadTypeError(raw);
}

// ---------------------------------------------------------------------------
// Autonomy level resolution
// ---------------------------------------------------------------------------

/**
 * resolveAutonomyLevel — validates and returns an AutonomyLevel.
 *
 * Throws for reserved levels (feature flag false) and sentinels.
 * Active levels at v1.0: `advisory`, `suggestion`, `action_with_confirm`.
 */
export function resolveAutonomyLevel(raw: string): AutonomyLevel {
  // Sentinels must not be used by runtime workloads
  if (raw === 'rejected_invalid_attempt' || raw === 'n/a') {
    throw new SentinelWorkloadTypeError(raw);
  }

  // Reserved autonomy level gates
  if (raw === 'action_with_audit_only') {
    if (!config.featureFlags.ENABLE_ACTION_WITH_AUDIT_ONLY) {
      throw new ReservedAutonomyLevelError(raw);
    }
  }
  if (raw === 'fully_autonomous') {
    if (!config.featureFlags.ENABLE_FULLY_AUTONOMOUS) {
      throw new ReservedAutonomyLevelError(raw);
    }
  }

  // Active at v1.0
  if (
    raw === 'advisory' ||
    raw === 'suggestion' ||
    raw === 'action_with_confirm'
  ) {
    return raw;
  }

  // Unknown value — reject
  throw new ReservedAutonomyLevelError(raw);
}

// ---------------------------------------------------------------------------
// resolveAiContext — convenience resolver
// ---------------------------------------------------------------------------

/**
 * resolveAiContext — resolves both workload type and autonomy level together.
 * Validates the (workload_type, autonomy_level) pair against the permitted
 * combinations from WORKLOAD_TAXONOMY v5.2 §2.
 *
 * Permitted pairs at v1.0:
 *   conversational_assistant + advisory (only valid pair per §2.1)
 *   protocol_execution + advisory | suggestion | action_with_confirm (per §2.2)
 *
 * @throws `ReservedWorkloadTypeError` if workload type is reserved.
 * @throws `ReservedAutonomyLevelError` if autonomy level is reserved.
 * @throws `Error` if the (workload_type, autonomy_level) pair is not permitted.
 */
export function resolveAiContext(
  workloadTypeRaw: string,
  autonomyLevelRaw: string,
): AIContext {
  const workloadType = resolveWorkloadType(workloadTypeRaw);
  const autonomyLevel = resolveAutonomyLevel(autonomyLevelRaw);

  // Validate the pair per WORKLOAD_TAXONOMY v5.2 §2
  if (workloadType === 'conversational_assistant') {
    // conversational_assistant ONLY supports `advisory` per §2.1
    if (autonomyLevel !== 'advisory') {
      throw new Error(
        `Invalid (workload_type, autonomy_level) pair: ` +
          `conversational_assistant only supports autonomy_level="advisory" at v1.0 ` +
          `(got "${autonomyLevel}"). See WORKLOAD_TAXONOMY v5.2 §2.1.`,
      );
    }
  }
  // protocol_execution supports advisory, suggestion, action_with_confirm (§2.2)
  // All three active autonomy levels are valid for protocol_execution.

  return { ai_workload_type: workloadType, autonomy_level: autonomyLevel };
}

// ---------------------------------------------------------------------------
// Fastify plugin + decorator
// ---------------------------------------------------------------------------

export interface AiContextPluginOptions {
  /** If true, attempt to resolve AI context from request headers for all routes. */
  autoResolve?: boolean;
}

const aiContextPluginImpl: FastifyPluginAsync<AiContextPluginOptions> = async (
  fastify: FastifyInstance,
  _opts: AiContextPluginOptions,
) => {
  // Decorate the request with an aiContext slot (undefined by default)
  fastify.decorateRequest('aiContext', undefined);
};

export const aiContextPlugin = fp(aiContextPluginImpl, {
  name: 'ai-context',
  fastify: '5.x',
});

// ---------------------------------------------------------------------------
// Module augmentation
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Populated by route handlers or middleware that invoke `resolveAiContext()`.
     * Undefined on non-AI routes.
     */
    aiContext: AIContext | undefined;
  }
}
