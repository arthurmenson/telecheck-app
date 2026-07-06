/**
 * ai-service/audit.ts — module-specific audit envelope emitters.
 *
 * Wraps `lib/audit.ts emitAudit()` with the action IDs and envelope
 * shape AI Service emissions populate per AI Clinical Assistant Slice
 * PRD v1.0 + AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope).
 *
 * Crisis detection has its own dedicated emitter at
 * `internal/crisis/audit.ts` (the `crisis_detection_trigger`
 * Category A action ID is canonicalized in AUDIT_EVENTS v5.3). This
 * file handles the non-crisis Mode 1 / Mode 2 response emissions
 * pending AUDIT_EVENTS canonical action-id ratification.
 *
 * SPEC ISSUE — unratified AI-surface audit action IDs:
 *   AUDIT_EVENTS v5.3 enumerates `crisis_detection_trigger`,
 *   `protocol_authorized_prescribing`, and similar I-012/I-019 actions
 *   but does NOT yet canonicalize the per-response action IDs for
 *   Mode 1 chat / Mode 2 case-prep non-crisis emissions. Slice PRD
 *   v1.0 §6.4 says these MUST be audited per FLOOR-020; this module
 *   emits under DESCRIPTIVE-but-not-yet-ratified action IDs through a
 *   single sanctioned-cast helper (`aiServiceAuditPlaceholder()`).
 *   Same pattern as forms-intake's `formsAuditPlaceholder()`.
 *
 *   Migration trigger (when AUDIT_EVENTS v5.4+ amendment lands):
 *     1. Add the new actions to `AuditAction` in lib/audit.ts.
 *     2. Delete `aiServiceAuditPlaceholder()` and its closed union here.
 *     3. Replace every `aiServiceAuditPlaceholder('<id>')` call with
 *        the bare literal — TS infers the AuditAction type.
 *
 * Spec references:
 *   - AI Clinical Assistant Slice PRD v1.0 §6.4 (response audit)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope)
 *   - AI_LAYERING v5.2 §4 FLOOR-007..FLOOR-013 (platform-floor)
 *   - WORKLOAD_TAXONOMY v5.2 (envelope.ai_workload_type)
 *   - AUTONOMY_LEVELS v5.2 (envelope.autonomy_level)
 *   - INVARIANTS I-003 / I-027
 *
 * Hard rule per I-003: every emitter MUST throw on emission failure;
 * callers MUST NOT swallow the throw. The Mode 1 handler's outer
 * try/catch logs + ops-alerts on audit emission failure and surfaces
 * an AI-RESIL-001 "AI temporarily unavailable" response — never
 * dropping the failure silently.
 */

import {
  type AuditAction,
  type AuditDbClient,
  type AuditEnvelope,
  type AuditEnvelopeInput,
  emitAudit,
} from '../../lib/audit.js';
import type { TenantId } from '../../lib/glossary.js';

import type { AIChatSessionId, AIWorkflowExecutionId } from './internal/types.js';

// ---------------------------------------------------------------------------
// Placeholder-helper for unratified AI-surface audit action IDs
// ---------------------------------------------------------------------------

type AIServiceAuditActionPlaceholder = 'ai_chat_response_emitted';

/**
 * Single sanctioned `as AuditAction` cast site. Mirrors
 * `formsAuditPlaceholder()`. The cast is contained here so reviewers
 * can grep one call site to inventory the unratified surface:
 *
 *   git grep "aiServiceAuditPlaceholder("
 */
export function aiServiceAuditPlaceholder(id: AIServiceAuditActionPlaceholder): AuditAction {
  return id as AuditAction;
}

// ---------------------------------------------------------------------------
// Mode 1 chat response audit emitter
// ---------------------------------------------------------------------------

/**
 * Detail payload on the `ai_chat_response_emitted` envelope. Mirrors
 * the patient-visible `Mode1ChatResponseView` FLOOR-020 fields PLUS
 * audit-only context (lengths instead of raw text; provider attempted;
 * fail-soft state).
 *
 * Per I-025 + I-027 + audit-policy: NEVER include the raw patient
 * input or response text in the audit detail. The audit is the
 * durable append-only record of WHAT envelope was emitted and WHY
 * (envelope + outcome); it is NOT a transcript store. A separate
 * transcript table (or KMS-encrypted message log) handles full-text
 * persistence with its own retention + access controls.
 */
export interface Mode1ChatResponseAuditDetail {
  ai_chat_session_id: AIChatSessionId;
  message_id: string;
  /** Always 'mode_1' for this emitter. */
  ai_mode: 'mode_1';
  /** AI-GUARD-003 binding. */
  guardrail_template_id: 'conservative_default';
  /** AI-GUARD-001: version logged on every response. */
  guardrail_version: string;
  /** Crisis detection outcome (I-019). When true, the
   *  `crisis_detection_trigger` Category A audit has ALREADY been
   *  emitted separately by `runCrisisGate`. */
  crisis_detected: boolean;
  /** True if the response surfaced an escalation message (crisis
   *  resource referral). */
  escalation_triggered: boolean;
  /** AI-RESIL-001 fail-soft state: true when the LLM provider was
   *  unavailable (NullProvider always; real adapters when degraded). */
  provider_unavailable: boolean;
  /** Length of the patient input text in characters (audit-safe). */
  input_text_length: number;
  /** Length of the AI response text in characters. */
  response_text_length: number;
}

/**
 * Emit `ai_chat_response_emitted` for every Mode 1 chat HTTP response.
 * Category C (operational) per FLOOR-020 — captures the envelope
 * discriminator + outcome without logging patient PHI.
 *
 * For crisis-detected responses, this emitter records the chat-response
 * envelope; the canonical I-019 `crisis_detection_trigger` Category A
 * audit is emitted separately by `runCrisisGate` per AUDIT_EVENTS v5.3.
 * Both audits coexist in the chain for the same request.
 */
export async function emitMode1ChatResponseAudit(
  args: {
    tenantId: TenantId;
    /** Patient account ID (Mode 1 actor; tenant-scoped). */
    actorId: string;
    /** F-4 audit attribution — equals tenantId for tenant-scoped patient. */
    actorTenantId: string;
    countryOfCare: string;
    /** Target patient — Mode 1 actor === target at v1.0. */
    targetPatientId: string;
    detail: Mode1ChatResponseAuditDetail;
    /** AI_LAYERING §6 envelope: workload type for canonical column. */
    aiModelVersion: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const envelope: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'patient',
    actor_id: args.actorId,
    actor_tenant_id: args.actorTenantId,
    target_patient_id: args.targetPatientId,
    delegate_context: null,
    action: aiServiceAuditPlaceholder('ai_chat_response_emitted'),
    category: 'C',
    audit_sensitivity_level: 'standard',
    resource_type: 'ai_chat_session',
    resource_id: args.detail.ai_chat_session_id,
    detail: args.detail as unknown as Record<string, unknown>,
    engine_versions: { ai_model_version: args.aiModelVersion },
    // WORKLOAD_TAXONOMY v5.2 + AUTONOMY_LEVELS v5.2 — Mode 1 chat is
    // conversational_assistant + advisory, canonically.
    ai_workload_type: 'conversational_assistant',
    autonomy_level: 'advisory',
    agent_id: null,
    agent_version: null,
    tool_call_id: null,
    memory_read_set_id: null,
    memory_write_set_id: null,
    supervising_policy_id: null,
    knowledge_source_versions: null,
    signals: null,
    override: null,
    linked_events: [],
    compliance_flags: [],
    country_of_care: args.countryOfCare,
    break_glass: null,
  };
  return emitAudit(envelope, tx);
}

// ---------------------------------------------------------------------------
// Mode 2 case-prep response audit emitter
// ---------------------------------------------------------------------------

/**
 * Detail payload on the Mode 2 `ai_mode_2_evaluation` envelope. Mirrors
 * the canonical AI_LAYERING v5.2 §2 Mode 2 audit fields PLUS audit-only
 * context (input/output length lengths, provider state, crisis-gate
 * outcome). The envelope's category-A action ID lands directly from
 * AUDIT_EVENTS v5.3 — no `aiServiceAuditPlaceholder` cast is required
 * because `ai_mode_2_evaluation` is already on the canonical
 * `CategoryAAction` union in `lib/audit.ts`.
 *
 * Per I-025 + I-027 + audit-policy: NEVER include the raw patient
 * context (the structured intake data the case-prep agent operated
 * over) in the audit detail. The audit is the durable append-only
 * record of WHAT envelope was emitted and WHY; full case-prep
 * transcripts persist in a separate transcript store with its own
 * retention + access controls.
 */
export interface Mode2CasePrepResponseAuditDetail {
  ai_workflow_execution_id: AIWorkflowExecutionId;
  /** Anchor consult — Mode 2 audit records carry consult_id, not
   *  session_id. */
  consult_id: string;
  /** Always 'mode_2' for this emitter. */
  ai_mode: 'mode_2';
  /** Protocol the case-prep agent operated under. NEVER null at v1.0 —
   *  Mode 2 always runs within a named protocol context per AI Clinical
   *  Assistant Slice PRD v1.0 §4.2. */
  protocol_id: string;
  protocol_version: string;
  /** Self-reported confidence band per AI_LAYERING v5.2 §2 Mode 2
   *  audit fields. */
  confidence: 'low' | 'medium' | 'high';
  /** Count of concern flags the AI surfaced (the flag IDENTIFIERS
   *  themselves are NOT logged in audit detail at v1.0 — they may
   *  encode PHI via lab-value thresholds or symptom names. The full
   *  flag list lives in the response transcript store. The COUNT is
   *  safe + useful for compliance dashboards). */
  concern_flag_count: number;
  /** Crisis detection outcome (I-019). When true, the
   *  `crisis_detection_trigger` Category A audit has ALREADY been
   *  emitted separately by `runCrisisGate`. */
  crisis_detected: boolean;
  /** True if the response surfaced a crisis escalation envelope
   *  (suppressing the case-prep recommendation). */
  escalation_triggered: boolean;
  /** AI-RESIL-001 fail-soft state: true when the LLM provider was
   *  unavailable (NullProvider always; real adapters when degraded). */
  provider_unavailable: boolean;
  /** Length of the patient context payload as serialized JSON
   *  characters (audit-safe — no field VALUES). */
  context_length: number;
  /** Length of the AI recommendation text in characters. */
  recommendation_length: number;
}

/**
 * Emit `ai_mode_2_evaluation` for every Mode 2 case-prep HTTP response.
 * Category A (safety-critical clinical action) per AUDIT_EVENTS v5.3 —
 * Mode 2 outputs influence the clinician's downstream prescribing
 * decision, so the audit class matches the prescribing-pathway floor
 * rather than the Mode 1 conversational (Category C) floor.
 *
 * The downstream `prescribing.protocol_authorization_granted` audit
 * (emitted by the protocol-engine slice when the clinician confirms)
 * carries forward the AI envelope (model_version, ai_workflow_execution_id)
 * so the I-012 reject-unless three-clause rule can be audited
 * end-to-end against the case-prep emission that informed it.
 *
 * For crisis-detected case-prep responses, this emitter records the
 * case-prep envelope (recording that case-prep ran AND was suppressed
 * by crisis flow); the canonical I-019 `crisis_detection_trigger`
 * Category A audit is emitted separately by `runCrisisGate`. Both
 * audits coexist in the chain for the same request.
 */
export async function emitMode2CasePrepResponseAudit(
  args: {
    tenantId: TenantId;
    /** Clinician actor invoking case-prep (tenant-scoped). */
    actorId: string;
    /** F-4 audit attribution — equals tenantId for tenant-scoped clinician. */
    actorTenantId: string;
    countryOfCare: string;
    /** Target patient — the consult subject. Distinct from the actor
     *  (clinician), unlike Mode 1 where actor === target. */
    targetPatientId: string;
    detail: Mode2CasePrepResponseAuditDetail;
    /** AI_LAYERING §6 envelope: workload type for canonical column. */
    aiModelVersion: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const envelope: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: 'clinician',
    actor_id: args.actorId,
    actor_tenant_id: args.actorTenantId,
    target_patient_id: args.targetPatientId,
    delegate_context: null,
    // Canonical Category A action ID per AUDIT_EVENTS v5.3 — no
    // placeholder cast required (action is on the closed union in
    // lib/audit.ts).
    action: 'ai_mode_2_evaluation',
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: 'ai_workflow_execution',
    resource_id: args.detail.ai_workflow_execution_id,
    detail: args.detail as unknown as Record<string, unknown>,
    engine_versions: { ai_model_version: args.aiModelVersion },
    // WORKLOAD_TAXONOMY v5.2 + AUTONOMY_LEVELS v5.2 — Mode 2 case-prep
    // is protocol_execution + action_with_confirm, canonically. Per
    // ADR-029 + I-012 the autonomy ceiling at v1.0 is
    // action_with_confirm; the reserved `action_with_audit_only` /
    // `fully_autonomous` levels require successor ADR + activation
    // audit event.
    ai_workload_type: 'protocol_execution',
    autonomy_level: 'action_with_confirm',
    agent_id: null,
    agent_version: null,
    tool_call_id: null,
    memory_read_set_id: null,
    memory_write_set_id: null,
    supervising_policy_id: null,
    knowledge_source_versions: null,
    signals: null,
    override: null,
    linked_events: [],
    compliance_flags: [],
    country_of_care: args.countryOfCare,
    break_glass: null,
  };
  return emitAudit(envelope, tx);
}
