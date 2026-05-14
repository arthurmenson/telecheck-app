/**
 * ai-service/internal/crisis/audit.ts — emit
 * `crisis_detection_trigger` Category A audit for AI surfaces per
 * AUDIT_EVENTS v5.3 + AI_LAYERING v5.2 §6.
 *
 * The forms-intake module has its own emitter wrapping the same
 * canonical action ID; AI-service surfaces use this one because the
 * `actor_type` differs (`ai_workload` here vs `patient` there) and
 * the `detection_source` enum value differs (`ai_chat_input` /
 * `ai_chat_output` / `ai_case_prep_input` vs `form_response`).
 *
 * Per I-019 + FLOOR-009: this audit MUST emit on EVERY positive
 * detection. Bare suppression is forbidden per I-003. Per
 * AI_LAYERING v5.2 §6 the AI response is still delivered if audit
 * write fails during a crisis response (safety trumps audit
 * completeness for crisis); the caller catches the audit error,
 * logs it, fires an ops alert, and proceeds with the crisis-resource
 * surface. Audit is written when the system recovers.
 *
 * Spec references:
 *   - AI_LAYERING v5.2 §4 FLOOR-009 (crisis detection platform-floor)
 *   - AI_LAYERING v5.2 §6 (FLOOR-020 audit envelope; crisis-write
 *     exception)
 *   - AUDIT_EVENTS v5.3 §Category A `crisis_detection_trigger`
 *     (actor_type ai_mode_1 / system; detail: patient_id, crisis_type,
 *     detection_source, response_provided, escalation_destination)
 *   - I-019 (always-on; cannot be configured away)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - src/lib/crisis-detection.ts (the canonical keyword-stub
 *     detector; clinical-grade NLP classifier required before
 *     patient-facing deployment per file-level open-question)
 */

import type { AuditDbClient, AuditEnvelope, AuditEnvelopeInput } from '../../../../lib/audit.js';
import { emitAudit } from '../../../../lib/audit.js';
import { asTenantId } from '../../../../lib/glossary.js';

/**
 * The canonical AI-side detection sources. Distinct from the
 * forms-intake `form_response` source so audit queries can filter
 * AI-surface detections from form-surface detections.
 */
export type AICrisisDetectionSource =
  /** Patient's INPUT message to Mode 1 chat (scanned before any
   *  AI processing). */
  | 'ai_chat_input'
  /** Mode 1 chat AI OUTPUT (scanned post-generation, before
   *  surfacing to the patient — defense-in-depth on the AI's own
   *  response text). */
  | 'ai_chat_output'
  /** Mode 2 case-prep input (clinician-supplied patient notes
   *  scanned for crisis text before AI summarization). */
  | 'ai_case_prep_input'
  /** Mode 2 case-prep AI output (scanned before surfacing to the
   *  reviewing clinician). */
  | 'ai_case_prep_output';

/**
 * The (workload_type, autonomy_level) pair that the FLOOR-020 audit
 * envelope MUST carry for this emission. Derived by the gate from
 * `resourceType` (and validated against it) — Mode 1 chat surfaces use
 * `conversational_assistant` + `advisory`; Mode 2 case-prep / protocol-
 * execution surfaces use `protocol_execution` + `action_with_confirm`.
 *
 * Surfaced as an explicit input on the emitter (rather than hard-coded)
 * per Codex PR F R1 HIGH closure 2026-05-13: a single hard-coded pair
 * mislabeled every Mode 2 case-prep detection as Mode 1 workload,
 * breaking audit-filter queries, I-012 correlation, and safety
 * reporting for protocol_execution incidents.
 */
export type AICrisisAuditEnvelope =
  | { workloadType: 'conversational_assistant'; autonomyLevel: 'advisory' }
  | { workloadType: 'protocol_execution'; autonomyLevel: 'action_with_confirm' };

export async function emitAICrisisDetectionTrigger(
  args: {
    tenantId: string;
    /** The AI workload's system actor id (e.g.,
     *  'system:ai_mode_1', 'system:ai_mode_2_case_prep'). */
    actorId: string;
    countryOfCare: string;
    targetPatientId: string;
    detectionSource: AICrisisDetectionSource;
    /** Crisis-type classification per src/lib/crisis-detection.ts. */
    crisisType: string;
    /** The AI surface aggregate the text came from. For Mode 1 the
     *  ai_chat_session_id; for Mode 2 the consult_id. */
    resourceType: 'ai_chat_session' | 'ai_workflow_execution';
    resourceId: string;
    /** Whether the surface DID surface crisis resources to the
     *  patient. This is a DELIVERY-OBSERVATION, not a gate-time
     *  prediction (per Codex PR F R9 HIGH closure 2026-05-13).
     *  The gate emits with `null` because at gate-emission time
     *  the response has not yet been delivered; a follow-up
     *  delivery-outcome audit, emitted by the handler after the
     *  crisis-resource envelope reaches the patient, is the
     *  correct place for `true`/`false`. Callers that bypass the
     *  gate (direct service emissions) and DO observe delivery
     *  may pass the boolean directly. */
    responseProvided: boolean | null;
    /** Crisis escalation destination per the tenant's CCR + the
     *  detected crisis type. Null when the destination cannot be
     *  resolved (the audit still fires; the caller's error path
     *  + ops alert handle the resolution miss). */
    escalationDestination: string | null;
    /** FLOOR-020 audit envelope per Codex PR F R1 HIGH closure
     *  2026-05-13 — gate derives from `resourceType` to keep Mode 1
     *  vs Mode 2 emissions correctly classified. */
    auditEnvelope: AICrisisAuditEnvelope;
    /** Wiring-error metadata for fallback emit path (Codex PR F R12
     *  HIGH closure 2026-05-13). When validation fails (tenant
     *  mismatch, missing discriminator, malformed discriminator,
     *  resourceType/detectionSource pair mismatch), the gate STILL
     *  emits the Category A audit on a best-effort path with a
     *  conservative fallback envelope + this marker in detail so
     *  the wiring bug is visible in the durable audit chain (not
     *  just the log stream). Always undefined on the canonical
     *  (no-wiring-error) path. */
    wiringError?: { name: string; message: string };
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const input: AuditEnvelopeInput = {
    timestamp: new Date().toISOString(),
    tenant_id: asTenantId(args.tenantId),
    // Per AUDIT_EVENTS v5.3 + v5.2 §2 actor-type addition: new
    // v1.10+ AI emissions use `ai_workload` (the canonical name);
    // the legacy `ai_mode_1` alias is preserved for backward-compat
    // reads only.
    actor_type: 'ai_workload',
    actor_id: args.actorId,
    actor_tenant_id: null,
    target_patient_id: args.targetPatientId,
    delegate_context: null,
    action: 'crisis_detection_trigger',
    category: 'A',
    audit_sensitivity_level: 'standard',
    resource_type: args.resourceType,
    resource_id: args.resourceId,
    detail: {
      detection_source: args.detectionSource,
      crisis_type: args.crisisType,
      response_provided: args.responseProvided,
      escalation_destination: args.escalationDestination,
      // PHI: the text content itself is NOT captured. The audit
      // chain records that a detection fired (per I-019) without
      // duplicating PHI text into a second store.
      ...(args.wiringError !== undefined
        ? {
            wiring_error: {
              name: args.wiringError.name,
              message: args.wiringError.message,
            },
          }
        : {}),
    },
    engine_versions: null,
    // Crisis detection is platform-floor — runs across every AI
    // surface regardless of guardrail / mode / autonomy. ai_workload
    // emissions populate the workload + autonomy envelope per
    // FLOOR-020. The pair is derived by the gate from `resourceType`
    // (Mode 1 → conversational_assistant + advisory; Mode 2 →
    // protocol_execution + action_with_confirm). Per Codex PR F R1
    // HIGH closure 2026-05-13.
    ai_workload_type: args.auditEnvelope.workloadType,
    autonomy_level: args.auditEnvelope.autonomyLevel,
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
  return emitAudit(input, tx);
}
