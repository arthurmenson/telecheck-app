/**
 * pharmacy/audit.ts — module-specific audit envelope emitters.
 *
 * Sprint 35 / TLC-055 part A. Wraps `lib/audit.ts emitAudit()` for the
 * MedicationRequest lifecycle events ratified at P-011 / SI-001 closure
 * 2026-05-11. Unlike the other module audit wrappers
 * (async-consult/audit.ts, consent/audit.ts, etc.) that ship placeholder
 * action IDs pending SI ratification, these emitters use the canonical
 * AUDIT_EVENTS v5.3 action IDs directly — no placeholder cast needed —
 * because SI-001 is RATIFIED and the action IDs are typed in
 * `src/lib/audit.ts` CategoryAAction.
 *
 * Action_id binding (state-machine.ts §9 convention): the canonical I-012
 * `action_id` for a MedicationRequest prescribing decision IS the row's
 * id (the canonical `mrx_<26-char ULID>`). All audit events emitted in
 * service of that prescribing decision MUST share that action_id, which
 * is the `resource_id` field on the audit envelope here. The service
 * layer (TLC-055 PR C) is responsible for routing the row.id consistently
 * through every emission for the row's lifecycle.
 *
 * Spec references:
 *   - AUDIT_EVENTS v5.3 §I-012 closure rule (bumped v5.2 → v5.3 at P-011)
 *   - State Machines v1.2 §19 (each transition's success_audit_action +
 *     i012_gated classification)
 *   - WORKLOAD_TAXONOMY v5.2 §2.1/§2.2 (canonical workload values)
 *   - AUTONOMY_LEVELS v5.2 (action_with_confirm)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - I-027 (every audit record carries tenant_id)
 *   - src/modules/pharmacy/internal/state-machine.ts AUDIT_ACTIONS
 */

import {
  type AuditDbClient,
  type AuditEnvelope,
  type AuditEnvelopeInput,
  emitAudit,
} from '../../lib/audit.js';
import type { TenantId } from '../../lib/glossary.js';

import { AUDIT_ACTIONS } from './internal/state-machine.js';
import type {
  AIWorkloadType,
  AutonomyLevel,
  InteractionSignalsStatus,
  MedicationRequestDiscontinuedReason,
  MedicationRequestId,
} from './internal/types.js';

// ---------------------------------------------------------------------------
// Common envelope builder
// ---------------------------------------------------------------------------

interface MedicationRequestAuditCommon {
  /** Operating-tenant identifier. */
  tenantId: TenantId;
  /** The patient whose data the action affects. */
  patientAccountId: string;
  /**
   * The canonical I-012 action_id for this prescribing decision. Per the
   * state-machine §9 convention, this IS the MedicationRequest row's id.
   * The caller MUST pass `medicationRequestRow.id` here so the audit chain
   * is scoped consistently throughout the row's lifecycle.
   */
  medicationRequestId: MedicationRequestId;
  /** Operating-tenant country_of_care. */
  countryOfCare: string;
  /** Per-event detail payload. */
  detail: Record<string, unknown>;
}

/**
 * Builder for the common audit envelope shape across all
 * MedicationRequest lifecycle events. Centralized so future envelope-
 * field additions (e.g., reserved agentic-context fields when ADR-030+
 * lands) only need to change here.
 */
function buildEnvelope(
  args: MedicationRequestAuditCommon & {
    actorType: 'clinician' | 'patient' | 'system' | 'ai_workload';
    actorId: string;
    actorTenantId: string | null;
    /** Canonical AUDIT_EVENTS v5.3 Category A action ID. */
    action: AuditEnvelopeInput['action'];
    category: 'A' | 'B' | 'C';
    aiWorkloadType: AuditEnvelopeInput['ai_workload_type'];
    autonomyLevel: AuditEnvelopeInput['autonomy_level'];
  },
): AuditEnvelopeInput {
  return {
    timestamp: new Date().toISOString(),
    tenant_id: args.tenantId,
    actor_type: args.actorType,
    actor_id: args.actorId,
    actor_tenant_id: args.actorTenantId,
    target_patient_id: args.patientAccountId,
    delegate_context: null,
    action: args.action,
    category: args.category,
    audit_sensitivity_level: 'standard',
    resource_type: 'medication_request',
    /**
     * `resource_id` IS the canonical I-012 action_id per the §9
     * convention — the row's id scopes every event in the prescribing
     * decision's audit chain.
     */
    resource_id: args.medicationRequestId,
    detail: args.detail,
    engine_versions: null,
    ai_workload_type: args.aiWorkloadType,
    autonomy_level: args.autonomyLevel,
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
}

// ---------------------------------------------------------------------------
// I-012-gated success emitters (the two prescribing-execution routes)
// ---------------------------------------------------------------------------

/**
 * Emit `prescribing.approved` — the clinician-only route's terminal
 * success audit (State Machines v1.2 §19 `clinician_approve` →
 * `active`).
 *
 * Per AUDIT_EVENTS v5.3 line 127 clinician-only carve-out, when no AI
 * workload contributed to the prescribing decision the envelope MUST
 * carry `ai_workload_type='n/a'` and `autonomy_level='n/a'` (NOT null;
 * the I-012 closure rule rejects null on I-012 action-class records).
 * When upstream AI advice contributed (e.g., a Mode 2 advisory pass
 * that the clinician then ratified directly), the envelope INHERITS
 * those values — `aiWorkloadType` and `autonomyLevel` get the upstream
 * action_id's preceding workload/autonomy values.
 */
export async function emitPrescribingApproved(
  args: MedicationRequestAuditCommon & {
    clinicianAccountId: string;
    /** Upstream AI workload if any contributed; null for pure clinician path. */
    upstreamAiWorkloadType?: AIWorkloadType;
    /** Upstream autonomy level if any contributed; null for pure clinician path. */
    upstreamAutonomyLevel?: AutonomyLevel;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const aiWorkloadType: AIWorkloadType | 'n/a' = args.upstreamAiWorkloadType ?? 'n/a';
  const autonomyLevel: AutonomyLevel | 'n/a' = args.upstreamAutonomyLevel ?? 'n/a';
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: 'clinician',
      actorId: args.clinicianAccountId,
      actorTenantId: args.tenantId,
      action: AUDIT_ACTIONS.PRESCRIBING_APPROVED,
      category: 'A',
      aiWorkloadType,
      autonomyLevel,
    }),
    tx,
  );
}

/**
 * Emit `prescribing.protocol_authorization_granted` — the new
 * clinician I-012 confirmation event (AUDIT_EVENTS v5.3 §I-012 closure
 * rule authoritative set amendment under P-011). The clinician adopts
 * the Mode 2 protocol-engine route by explicitly authorizing it for
 * this consult / patient / protocol_id+version. Required prerequisite
 * for the subsequent `protocol_authorized_prescribing` success audit
 * (both share the same action_id scoping via the row's id).
 *
 * Per validateWorkloadFields' action-scoped binding (PR #110 R4 closure):
 *   - actor_type MUST be 'clinician'
 *   - ai_workload_type MUST be 'protocol_execution' (the protocol-route
 *     is by definition AI-attributed)
 *   - autonomy_level MUST be 'action_with_confirm'
 */
export async function emitPrescribingProtocolAuthorizationGranted(
  args: MedicationRequestAuditCommon & {
    clinicianAccountId: string;
    protocolId: string;
    protocolVersion: string;
    consultId: string | null;
    authorizationWindowMinutes: number;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: 'clinician',
      actorId: args.clinicianAccountId,
      actorTenantId: args.tenantId,
      action: AUDIT_ACTIONS.PRESCRIBING_PROTOCOL_AUTHORIZATION_GRANTED,
      category: 'A',
      aiWorkloadType: 'protocol_execution',
      autonomyLevel: 'action_with_confirm',
      detail: {
        ...args.detail,
        protocol_id: args.protocolId,
        protocol_version: args.protocolVersion,
        consult_id: args.consultId,
        accountable_clinician_id: args.clinicianAccountId,
        authorization_window_minutes: args.authorizationWindowMinutes,
      },
    }),
    tx,
  );
}

/**
 * Emit `protocol_authorized_prescribing` — the Mode 2 protocol-engine
 * route's terminal success audit (State Machines v1.2 §19
 * `protocol_authorized_prescribing` → `active`).
 *
 * Per AUDIT_EVENTS v5.3 §I-012 closure rule + PR #110 R4 actor-binding:
 *   - actor_type MUST be 'ai_workload' (legacy `protocol_engine` is
 *     rejected for new emissions per R5)
 *   - ai_workload_type MUST be 'protocol_execution'
 *   - autonomy_level MUST be 'action_with_confirm'
 *   - accountable_clinician_id carries the human clinician whose prior
 *     `prescribing.protocol_authorization_granted` event is the I-012
 *     anchor (bound by the same action_id = row id)
 */
export async function emitProtocolAuthorizedPrescribing(
  args: MedicationRequestAuditCommon & {
    /** The protocol-engine service account ULID. */
    protocolEngineServiceAccountId: string;
    /** The human clinician whose prior `prescribing.protocol_authorization_granted`
     *  is the I-012 anchor. */
    accountableClinicianId: string;
    protocolId: string;
    protocolVersion: string;
    engineVersions: Record<string, string> | null;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  const envelope = buildEnvelope({
    ...args,
    actorType: 'ai_workload',
    actorId: args.protocolEngineServiceAccountId,
    actorTenantId: args.tenantId,
    action: AUDIT_ACTIONS.PROTOCOL_AUTHORIZED_PRESCRIBING,
    category: 'A',
    aiWorkloadType: 'protocol_execution',
    autonomyLevel: 'action_with_confirm',
    detail: {
      ...args.detail,
      protocol_id: args.protocolId,
      protocol_version: args.protocolVersion,
      accountable_clinician_id: args.accountableClinicianId,
    },
  });
  envelope.engine_versions = args.engineVersions;
  return emitAudit(envelope, tx);
}

// ---------------------------------------------------------------------------
// I-012 rejection emitter (the bare-suppression closure)
// ---------------------------------------------------------------------------

/**
 * Emit `prescribing.execution_rejected` — the canonical I-012 rejection
 * audit (AUDIT_EVENTS v5.3 §I-012 reject-unless rejection-audit-event
 * rule). MUST be emitted whenever the state machine rejects an I-012
 * `*.executed` transition under the three-clause rule (validateTransition
 * throws I012RejectError → caller emits this → THEN throws the error).
 *
 * Per AUDIT_EVENTS v5.3 §execution_rejected envelope-population rule:
 * the envelope's `ai_workload_type` and `autonomy_level` populate from
 * the ATTEMPTED values (not the row's persisted values, which never
 * existed). If either attempted value is null / unknown / reserved,
 * the envelope value MUST be `'rejected_invalid_attempt'`.
 *
 * Bare suppression on rejection is forbidden per I-003 — if this
 * emission fails, the caller's transaction MUST abort and the
 * underlying error MUST surface.
 */
export async function emitPrescribingExecutionRejected(
  args: MedicationRequestAuditCommon & {
    /** The actor that attempted the transition. */
    attemptedActorType: 'clinician' | 'ai_workload' | 'protocol_engine' | 'system';
    attemptedActorId: string;
    /** Attempted workload — `'rejected_invalid_attempt'` sentinel if null /
     *  unknown / reserved at attempt time. */
    attemptedAiWorkloadType: AIWorkloadType | 'rejected_invalid_attempt' | 'n/a';
    /** Attempted autonomy — same sentinel rules as workload. */
    attemptedAutonomyLevel: AutonomyLevel | 'rejected_invalid_attempt' | 'n/a';
    /** Which clauses of the I-012 three-clause rule failed. */
    violatedClauses: readonly (
      | 'autonomy_level_string_equality'
      | 'audit_chain_confirmation_event_missing'
      | 'confirming_actor_rbac_unauthorized'
      | 'reserved_level_without_activation_audit_event'
    )[];
    /** Confirmation event state at the time of attempt. */
    confirmationEventState:
      | 'present-with-defect'
      | 'absent'
      | 'present-but-mismatched-action_id'
      | 'present-but-mismatched-actor';
    /** RBAC role check outcome. */
    rbacRoleCheckResult: 'authorized' | 'unauthorized' | 'role_not_found';
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: 'system',
      actorId: 'system:state-machine-validator',
      actorTenantId: null,
      action: AUDIT_ACTIONS.PRESCRIBING_EXECUTION_REJECTED,
      category: 'A',
      aiWorkloadType: args.attemptedAiWorkloadType,
      autonomyLevel: args.attemptedAutonomyLevel,
      detail: {
        ...args.detail,
        action_id: args.medicationRequestId,
        action_class: 'prescribing',
        attempted_actor_id: args.attemptedActorId,
        attempted_actor_type: args.attemptedActorType,
        attempted_ai_workload_type: args.attemptedAiWorkloadType,
        attempted_autonomy_level: args.attemptedAutonomyLevel,
        violated_clauses: args.violatedClauses,
        confirmation_event_state: args.confirmationEventState,
        rbac_role_check_result: args.rbacRoleCheckResult,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// Non-I-012-gated clinician decision emitters
// ---------------------------------------------------------------------------

/**
 * Emit `prescribing.declined` — clinician deliberately rejected the
 * prescribing decision (State Machines v1.2 §19 `clinician_decline` →
 * `rejected`). NOT an I-012 rejection: the workload+autonomy envelope
 * uses the clinician-only `'n/a'` sentinel pair.
 */
export async function emitPrescribingDeclined(
  args: MedicationRequestAuditCommon & {
    clinicianAccountId: string;
    reasonCode: string;
    reasonText: string | null;
    recommendedAction: string | null;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: 'clinician',
      actorId: args.clinicianAccountId,
      actorTenantId: args.tenantId,
      action: AUDIT_ACTIONS.PRESCRIBING_DECLINED,
      category: 'A',
      aiWorkloadType: 'n/a',
      autonomyLevel: 'n/a',
      detail: {
        ...args.detail,
        reason_code: args.reasonCode,
        reason_text: args.reasonText,
        recommended_action: args.recommendedAction,
      },
    }),
    tx,
  );
}

/**
 * Emit `prescribing.modified` — clinician modified the prescribing
 * payload and re-routed through the engine (State Machines v1.2 §19
 * `clinician_modify` → `pending_interaction_check`). NOT a refusal,
 * NOT an I-012 execution: the workload+autonomy envelope uses the
 * clinician-only `'n/a'` sentinel pair.
 */
export async function emitPrescribingModified(
  args: MedicationRequestAuditCommon & {
    clinicianAccountId: string;
    modificationReason: string;
    originalDose: string | null;
    modifiedDose: string | null;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: 'clinician',
      actorId: args.clinicianAccountId,
      actorTenantId: args.tenantId,
      action: AUDIT_ACTIONS.PRESCRIBING_MODIFIED,
      category: 'A',
      aiWorkloadType: 'n/a',
      autonomyLevel: 'n/a',
      detail: {
        ...args.detail,
        modification_reason: args.modificationReason,
        original_dose: args.originalDose,
        modified_dose: args.modifiedDose,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// MedicationRequest lifecycle event emitters (added at v5.3 under P-011)
// ---------------------------------------------------------------------------

export async function emitMedicationRequestDrafted(
  args: MedicationRequestAuditCommon & {
    clinicianAccountId: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: 'clinician',
      actorId: args.clinicianAccountId,
      actorTenantId: args.tenantId,
      action: AUDIT_ACTIONS.MEDICATION_REQUEST_DRAFTED,
      category: 'A',
      aiWorkloadType: null,
      autonomyLevel: null,
    }),
    tx,
  );
}

export async function emitMedicationRequestSubmittedForReview(
  args: MedicationRequestAuditCommon & {
    clinicianAccountId: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: 'clinician',
      actorId: args.clinicianAccountId,
      actorTenantId: args.tenantId,
      action: AUDIT_ACTIONS.MEDICATION_REQUEST_SUBMITTED_FOR_REVIEW,
      category: 'A',
      aiWorkloadType: null,
      autonomyLevel: null,
    }),
    tx,
  );
}

export async function emitMedicationRequestInteractionEvaluationCompleted(
  args: MedicationRequestAuditCommon & {
    interactionSignalsStatus: Exclude<InteractionSignalsStatus, 'pending'>;
    engineVersion: string;
    knowledgeBaseVersion: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: 'system',
      actorId: 'system:interaction-engine',
      actorTenantId: null,
      action: AUDIT_ACTIONS.MEDICATION_REQUEST_INTERACTION_EVALUATION_COMPLETED,
      category: 'A',
      aiWorkloadType: null,
      autonomyLevel: null,
      detail: {
        ...args.detail,
        interaction_signals_status: args.interactionSignalsStatus,
        engine_version: args.engineVersion,
        knowledge_base_version: args.knowledgeBaseVersion,
      },
    }),
    tx,
  );
}

export async function emitMedicationRequestDiscontinued(
  args: MedicationRequestAuditCommon & {
    actorType: 'clinician' | 'patient' | 'system';
    actorId: string;
    discontinuedReason: MedicationRequestDiscontinuedReason;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: args.actorType,
      actorId: args.actorId,
      actorTenantId: args.actorType === 'system' ? null : args.tenantId,
      action: AUDIT_ACTIONS.MEDICATION_REQUEST_DISCONTINUED,
      category: 'A',
      aiWorkloadType: null,
      autonomyLevel: null,
      detail: {
        ...args.detail,
        discontinued_reason: args.discontinuedReason,
      },
    }),
    tx,
  );
}

export async function emitMedicationRequestSuperseded(
  args: MedicationRequestAuditCommon & {
    clinicianAccountId: string;
    /** The new replacement MedicationRequest. */
    newMedicationRequestId: MedicationRequestId;
    supersessionReason: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: 'clinician',
      actorId: args.clinicianAccountId,
      actorTenantId: args.tenantId,
      action: AUDIT_ACTIONS.MEDICATION_REQUEST_SUPERSEDED,
      category: 'A',
      aiWorkloadType: null,
      autonomyLevel: null,
      detail: {
        ...args.detail,
        new_medication_request_id: args.newMedicationRequestId,
        supersession_reason: args.supersessionReason,
      },
    }),
    tx,
  );
}

export async function emitMedicationRequestExpired(
  args: MedicationRequestAuditCommon,
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope({
      ...args,
      actorType: 'system',
      actorId: 'system:medication-request-expiry-job',
      actorTenantId: null,
      action: AUDIT_ACTIONS.MEDICATION_REQUEST_EXPIRED,
      category: 'A',
      aiWorkloadType: null,
      autonomyLevel: null,
    }),
    tx,
  );
}
