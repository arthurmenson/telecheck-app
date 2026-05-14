/**
 * ai-service/internal/types.ts — branded ID types + workload re-exports
 * at the PR A skeleton stage.
 *
 * Schema authoring for AI conversation persistence (chat_sessions,
 * chat_messages, ai_executions row shapes) is deferred to PR B+ when
 * the conversation surface lands. Per EHBG §7, engineering does NOT
 * author canonical schema — the rows referenced here are anticipated
 * per AI Clinical Assistant Slice PRD v1.0 §13 (audit fields) and
 * AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope).
 *
 * Branded IDs land here because they are identifier hygiene, not
 * schema. Downstream callers (handlers, audit emitters, tests) can
 * compile clean against typed AI-session + workflow-execution +
 * guardrail-template references before row shapes exist.
 *
 * The two-mode architecture per AI-LAYERING §2 AI-ARCH-001:
 *   - Mode 1 (conversational_assistant) — patient-facing chat
 *   - Mode 2 (protocol_execution) — async clinical case prep
 *
 * Per ADR-029 the workload taxonomy is the canonical discriminator;
 * "Mode 1 / Mode 2" is UI/prose nomenclature. Code uses the
 * workload-type strings (`conversational_assistant`,
 * `protocol_execution`) from `AIWorkloadType` in `src/lib/audit.ts`.
 *
 * Spec references:
 *   - AI Clinical Assistant Slice PRD v1.0 §13 (audit fields)
 *   - AI_LAYERING v5.2 §2 (two-mode architecture; AI-ARCH-001/002)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope)
 *   - WORKLOAD_TAXONOMY v5.2 (discriminator + reserved namespace)
 *   - AUTONOMY_LEVELS v5.2 (level enum + reserved/activation rules)
 *   - ADR-029 (AI workload taxonomy; prospective ADR-002 supersession)
 *   - I-019 (crisis detection platform-floor; runs independent of
 *     guardrail templates)
 */

// Re-export the canonical workload + autonomy types from the audit
// envelope's source-of-truth declaration. AI Service emissions populate
// the same envelope fields per FLOOR-020.
export type { AIWorkloadType, AutonomyLevel } from '../../../lib/audit.js';

// ---------------------------------------------------------------------------
// Branded ID types — PROVISIONAL at PR A.
//
// Names align with anticipated CDM entity inventory + AI_LAYERING audit
// envelope semantics. If a future PR or slice-PRD revision picks
// different names, treat as a controlled rename.
// ---------------------------------------------------------------------------

/**
 * AIChatSessionId — Mode 1 conversation session identifier.
 *
 * Per AI_LAYERING v5.2 §6 (FLOOR-020), every Mode 1 audit record
 * carries a `session_id`. Per §9 (added v5.1), conversation sessions
 * are tenant-scoped — `(tenant_id, ai_chat_session_id)` is the
 * authorization pair, never `ai_chat_session_id` alone.
 */
declare const _aiChatSessionIdBrand: unique symbol;
export type AIChatSessionId = string & {
  readonly [_aiChatSessionIdBrand]: 'AIChatSessionId';
};
export function asAIChatSessionId(s: string): AIChatSessionId {
  return s as AIChatSessionId;
}

/**
 * AIWorkflowExecutionId — a single AI invocation. One Mode 1 turn (a
 * message-and-response pair) corresponds to one AIWorkflowExecution.
 * One Mode 2 case-prep corresponds to one AIWorkflowExecution. The
 * execution row carries the workload_type + autonomy_level + model
 * version + audit envelope discriminators per WORKLOAD_TAXONOMY v5.2
 * §2.
 *
 * This is the canonical I-012 action_id for AI-attributed prescribing
 * actions (Mode 2 routes into `protocol_authorized_prescribing` per
 * State Machines v1.2 §19 are bound by this id).
 */
declare const _aiWorkflowExecutionIdBrand: unique symbol;
export type AIWorkflowExecutionId = string & {
  readonly [_aiWorkflowExecutionIdBrand]: 'AIWorkflowExecutionId';
};
export function asAIWorkflowExecutionId(s: string): AIWorkflowExecutionId {
  return s as AIWorkflowExecutionId;
}

/**
 * GuardrailTemplateId — Mode 1 governance handle per AI_LAYERING v5.2
 * §3 (Invariant AI-GUARD-001: every Mode 1 response is governed by
 * exactly one guardrail template; the template_id and version are
 * logged on every response).
 *
 * Platform-shipped templates at v1.0: Conservative Default (immutable;
 * cannot be modified or deactivated per AI-GUARD-003), GLP-1 Program,
 * ED Program, Labs.
 */
declare const _guardrailTemplateIdBrand: unique symbol;
export type GuardrailTemplateId = string & {
  readonly [_guardrailTemplateIdBrand]: 'GuardrailTemplateId';
};
export function asGuardrailTemplateId(s: string): GuardrailTemplateId {
  return s as GuardrailTemplateId;
}

// Row-shape interfaces (ChatSession, ChatMessage, AIExecution,
// GuardrailTemplate) land when the conversation surface and template
// repo are authored in PR B / PR E respectively. The PR A skeleton
// deliberately does NOT declare row shapes; that's schema authoring,
// which waits on slice work.
