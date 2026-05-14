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
// repo are authored in PR D / PR E respectively. The PR A scaffold +
// PR B type contract deliberately do NOT declare row shapes; that's
// schema authoring, which waits on slice work.

// ---------------------------------------------------------------------------
// Mode 1 chat response wire contract (PR B type-only at this stage).
//
// The HTTP handler that returns this view is intentionally NOT mounted
// at PR B (Codex PR B R1 CRITICAL + R2 CRITICAL closures): a live
// /v0/ai/chat surface that accepts patient free-text input has to run
// I-019 crisis detection on every message AND emit the FLOOR-020
// audit record for every response. Both land in PR D (real provider)
// + PR E (guardrails) + PR F (crisis detection). Until then the
// route is unregistered.
//
// The type contract is exported now so frontend / mobile clients can
// integrate against the stable wire shape ahead of the handler. When
// PRs D/E/F land, the route is registered + this exact shape is what
// the 200 response carries.
//
// Per AI_LAYERING v5.2 §6 (FLOOR-020) audit-envelope fields, the
// patient-visible response carries source_type + ai_mode +
// ai_workload_type + autonomy_level + guardrail_template_id +
// model_version + escalation_triggered + crisis_detected +
// response_text. The audit envelope ALSO carries input/output
// summaries that don't surface to the patient.
// ---------------------------------------------------------------------------

export interface Mode1ChatResponseView {
  ai_chat_session_id: AIChatSessionId;
  message_id: string;
  source_type: 'ai';
  /** Canonical AI_LAYERING §6 audit-envelope mode discriminator.
   *  Surfaced in the response so frontends can branch on a single
   *  field without re-deriving from ai_workload_type. */
  ai_mode: 'mode_1';
  ai_workload_type: 'conversational_assistant';
  autonomy_level: 'advisory';
  guardrail_template_id: 'conservative_default';
  model_version: string;
  escalation_triggered: boolean;
  crisis_detected: boolean;
  response_text: string;
}

// ---------------------------------------------------------------------------
// Mode 2 case-prep response wire contract (PR C type-only at this stage).
//
// As with Mode 1 (PR B), the HTTP handler that returns this view is NOT
// mounted at PR C. Mode 2 is protocol-execution: it prepares a clinical
// case for clinician review per AI Clinical Assistant Slice PRD v1.0
// §4.2. The clinician then approves/declines/modifies — the AI does
// NOT prescribe. Per AI-ARCH-002 + I-012, Mode 2 auto-approve requires
// 90-day track record + zero safety-critical disagreements + Clinical
// Governance Lead sign-off + a formal ADR. At v1.0 every Mode 2 case
// is physician-reviewed.
//
// The route is gated for the same reasons as Mode 1:
//   - I-019: crisis detection runs on all conversation surfaces;
//     case-prep inputs that include patient-reported symptoms can
//     contain crisis text that must trigger the platform-floor
//     detector + audit + escalation before any AI output is emitted
//   - FLOOR-020: per-response audit emission boundary not yet
//     established; AUDIT_EVENTS v5.3 enumerates Mode 2 success audits
//     (`protocol_authorized_prescribing`,
//     `prescribing.protocol_authorization_granted`) for the I-012
//     pathway, but the canonical case-prep emission action ID is
//     pending spec clarification
//   - The case-prep recommendation feeds into the clinician's
//     downstream decision; the path from "AI prepared a case" →
//     "clinician approved a prescription" → "protocol-authorized
//     prescribing" is bound by the I-012 reject-unless three-clause
//     rule (per State Machines v1.2 §19 §19.X), and the case-prep
//     side of that audit chain must land alongside the protocol
//     engine integration
//
// Frontend / clinician-console integration: import the TYPE now;
// the route comes online when PR D (provider) + PR E (guardrails) +
// PR F (crisis detection) land + the protocol engine slice ships
// alongside (deferred at v1.0 per pharmacy slice closure).
//
// Per AI_LAYERING v5.2 §2 (Mode 2 audit fields), the case-prep
// envelope carries: consult_id, patient_id, protocol_id,
// protocol_version, ai_model_version, recommendation, confidence,
// concern_flags. Physician agreement is captured separately at
// clinician decision time (AI-AGR-001) — NOT in this response.
// ---------------------------------------------------------------------------

export interface Mode2CasePrepResponseView {
  ai_workflow_execution_id: AIWorkflowExecutionId;
  /** The async-consult or other clinical anchor this case-prep
   *  attaches to. Discriminator for the audit chain — Mode 2 audit
   *  records carry consult_id, not session_id (Mode 1 uses
   *  session_id). */
  consult_id: string;
  source_type: 'ai';
  /** Canonical AI_LAYERING §6 audit-envelope mode discriminator. */
  ai_mode: 'mode_2';
  ai_workload_type: 'protocol_execution';
  /** Mode 2 ceiling per ADR-005 + I-012. Auto-approve (the reserved
   *  `action_with_audit_only` / `fully_autonomous` levels) requires
   *  successor ADR + activation audit event per ADR-029. */
  autonomy_level: 'action_with_confirm';
  /** Protocol that governed the case preparation (per Master PRD
   *  §13.1 protocolized clinical autonomy). NEVER null at v1.0 —
   *  Mode 2 always runs within a named protocol context. */
  protocol_id: string;
  protocol_version: string;
  model_version: string;
  /** AI's clinical summary for the reviewing clinician. */
  recommendation_summary: string;
  /** Self-reported confidence band (`low` | `medium` | `high`) per
   *  AI_LAYERING v5.2 §2 Mode 2 audit fields. */
  confidence: 'low' | 'medium' | 'high';
  /** Concern flags the AI surfaced (e.g., interaction signals,
   *  protocol-eligibility edges). Empty array if none. */
  concern_flags: ReadonlyArray<string>;
  /** Crisis-detection outcome (FLOOR-009 / I-019). FALSE when no
   *  crisis indicators detected in case-prep inputs. */
  crisis_detected: boolean;
  /** Escalation outcome (FLOOR-013). FALSE when no escalation
   *  conditions triggered. */
  escalation_triggered: boolean;
}
