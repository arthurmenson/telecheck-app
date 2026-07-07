/**
 * async-consult/audit.ts — module-specific audit envelope emitters.
 *
 * Wraps `lib/audit.ts emitAudit()` for Async Consult slice lifecycle
 * events per Async Consult Slice PRD v1.0 §13 + State Machines v1.1
 * §3 transitions implemented at Sprint 9 (TLC-021c):
 *
 *   - consult.initiated         (transition 1: INITIATED → INTAKE; emitted at initiate)
 *   - consult.intake_submitted  (transition 2: INTAKE → SUBMITTED; emitted at submit)
 *   - consult.abandoned         (transition 3: INTAKE → ABANDONED; emitted at abandon)
 *   - consult.expired           (transition 5: ABANDONED → EXPIRED; scaffolded — call
 *                                 site deferred to Sprint 11+ scheduled `expire` job)
 *
 * SPEC ISSUE: AUDIT_EVENTS v5.2 does NOT enumerate canonical action IDs
 * for these events. Same placeholder pattern as identity/audit.ts +
 * forms-intake/audit.ts + consent/audit.ts — single sanctioned
 * `as AuditAction` cast site via `asyncConsultAuditPlaceholder()`.
 *
 * SI-004 closure path: when AUDIT_EVENTS v5.2 ratifies consult.* event
 * names, replace placeholder strings with canonical names (string
 * replace; trivial if names match verbatim).
 *
 * Spec references:
 *   - Async Consult Slice PRD v1.0 §13 (audit emission requirements)
 *   - State Machines v1.1 §3 (transition vocabulary)
 *   - I-003 (audit append-only; bare suppression forbidden)
 *   - I-027 (every audit record carries tenant_id)
 *   - docs/SI-004-Async-Consult-Audit-Events-Ratification.md (resume gate)
 */

import {
  type AuditAction,
  type AuditDbClient,
  type AuditEnvelope,
  type AuditEnvelopeInput,
  emitAudit,
} from '../../lib/audit.js';
import type { TenantId } from '../../lib/glossary.js';
import type { AccountId } from '../identity/internal/types.js';

import type { ConsultId, ConsultType, ConsultModality } from './internal/types.js';

// ---------------------------------------------------------------------------
// Placeholder action ID union (per SI-004)
// ---------------------------------------------------------------------------

type AsyncConsultAuditActionPlaceholder =
  | 'consult_initiated'
  | 'consult_intake_submitted'
  | 'consult_abandoned'
  | 'consult_expired';

function asyncConsultAuditPlaceholder(id: AsyncConsultAuditActionPlaceholder): AuditAction {
  return id as AuditAction;
}

// ---------------------------------------------------------------------------
// Common envelope builder
// ---------------------------------------------------------------------------

interface AsyncConsultAuditCommon {
  tenant_id: TenantId;
  actor_type: 'patient' | 'delegate' | 'system' | 'operator';
  actor_id: string;
  actor_tenant_id: string | null;
  target_patient_id: AccountId | string | null;
  country_of_care: string;
  resource_id: string;
  detail: Record<string, unknown>;
}

function buildEnvelope(
  action: AuditAction,
  category: 'A' | 'B' | 'C',
  common: AsyncConsultAuditCommon,
): AuditEnvelopeInput {
  return {
    timestamp: new Date().toISOString(),
    tenant_id: common.tenant_id,
    actor_type: common.actor_type,
    actor_id: common.actor_id,
    actor_tenant_id: common.actor_tenant_id,
    target_patient_id: common.target_patient_id,
    delegate_context: null,
    action,
    category,
    audit_sensitivity_level: 'standard',
    resource_type: 'consult',
    resource_id: common.resource_id,
    detail: common.detail,
    engine_versions: null,
    ai_workload_type: null,
    autonomy_level: null,
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
    country_of_care: common.country_of_care,
    break_glass: null,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle emitters (4 events; Sprint 9 supported transitions only)
// ---------------------------------------------------------------------------

/**
 * Emit `consult.initiated` audit event for transition 1
 * (INITIATED → INTAKE on `start_intake` event).
 *
 * Category C (lifecycle event; not Category A safety-critical or
 * Category B governance — patient-initiated workflow start).
 */
export async function emitConsultInitiatedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    consultId: ConsultId;
    actorId: string;
    countryOfCare: string;
    consultType: ConsultType;
    modality: ConsultModality;
    currentProgramCatalogEntryId: string | null;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(asyncConsultAuditPlaceholder('consult_initiated'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_id: args.consultId,
      detail: {
        consult_type: args.consultType,
        modality: args.modality,
        current_program_catalog_entry_id: args.currentProgramCatalogEntryId,
      },
    }),
    tx,
  );
}

/**
 * Emit `consult.intake_submitted` audit event for transition 2
 * (INTAKE → SUBMITTED on `submit` event).
 */
export async function emitConsultIntakeSubmittedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    consultId: ConsultId;
    actorId: string;
    countryOfCare: string;
    intakeFormSubmissionId: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(asyncConsultAuditPlaceholder('consult_intake_submitted'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_id: args.consultId,
      detail: {
        intake_form_submission_id: args.intakeFormSubmissionId,
      },
    }),
    tx,
  );
}

/**
 * Emit `consult.abandoned` audit event for transition 3
 * (INTAKE → ABANDONED on `abandon` event after 48h+ no activity).
 *
 * Actor type is 'system' because abandon is triggered by inactivity,
 * not an explicit patient action. The `hours_since_activity` detail
 * captures the elapsed time at the moment of transition.
 */
export async function emitConsultAbandonedAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    consultId: ConsultId;
    countryOfCare: string;
    hoursSinceActivity: number;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(asyncConsultAuditPlaceholder('consult_abandoned'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: 'async-consult.scheduler',
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_id: args.consultId,
      detail: {
        hours_since_activity: args.hoursSinceActivity,
      },
    }),
    tx,
  );
}

/**
 * Emit `consult.expired` audit event for transition 5
 * (ABANDONED → EXPIRED on `expire` event after 14d+ no activity).
 *
 * Sprint 10 SCAFFOLDS this emitter; the call site (scheduled `expire`
 * job) is DEFERRED to Sprint 11+ per Async Consult Slice PRD §12 +
 * State Machines §3 (action: "Archive, refund payment"). Refund
 * orchestration depends on Payment slice authoring — separate work.
 */
export async function emitConsultExpiredAudit(
  args: {
    tenantId: TenantId;
    accountId: AccountId;
    consultId: ConsultId;
    countryOfCare: string;
    daysSinceAbandoned: number;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(asyncConsultAuditPlaceholder('consult_expired'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'system',
      actor_id: 'async-consult.scheduler',
      actor_tenant_id: args.tenantId,
      target_patient_id: args.accountId,
      country_of_care: args.countryOfCare,
      resource_id: args.consultId,
      detail: {
        days_since_abandoned: args.daysSinceAbandoned,
      },
    }),
    tx,
  );
}

// ===========================================================================
// Sprint 10 PR 6 — /v1/async-consults handler-surface emitters (P-038 slice)
//
// The Sprint-10 canonical entities (migrations 056-059) carry their own
// ratified audit catalog: 17 `async_consult.*` action IDs in AUDIT_EVENTS
// v5.11. SPEC ISSUE (SI follow-on, same posture as the Sprint-9 SI-004
// placeholders above): `src/lib/audit.ts`'s AuditAction union has NOT yet
// been synced with the AUDIT_EVENTS v5.11 `async_consult.*` rows, so these
// IDs are realized via the same sanctioned `as AuditAction` cast pattern
// (med-interaction/audit.ts + admin-backend precedent). When the catalog
// sync lands in `src/lib/audit.ts`, delete the placeholder union entries
// below and let the canonical enum flow through (verbatim string match).
//
// Per-handler audit-emission contract (PR 6 endpoints; the emit runs in
// the SAME tx as the SECDEF wrapper call, AFTER withDbRole returns — i.e.
// under the restored telecheck_app_role, matching the crisis-response
// post-crisis-event.ts precedent):
//
//   POST /v1/async-consults                     → async_consult.initiated (Cat C)
//   POST /v1/async-consults/:id/intake          → async_consult.intake_submitted (Cat C)
//   POST /v1/async-consults/:id/claim           → async_consult.claim_expired_auto_released
//                                                 (Cat B; ONLY when the wrapper returned a
//                                                 released prior-claim id) THEN
//                                                 async_consult.case_claimed (Cat C; always)
//   POST /v1/async-consults/:id/decision        → async_consult.clinician_decision_recorded
//                                                 (Cat A; always) + async_consult.prescribing_recorded
//                                                 (Cat A; decision_type='prescribe' only)
//                                                 + async_consult.clinician_decision_rationale_disagreement
//                                                 (Cat A; agreement='disagreed' only)
//   GET  /v1/async-consults/queue + /:id        → no audit (read-only; med-interaction
//                                                 GET /signals/:id precedent)
//
// I-003: none of these emissions may be suppressed — a throw from emitAudit
// rolls back the wrapper effect in the same tx.
// ===========================================================================

type AsyncConsultV1AuditActionPlaceholder =
  | 'async_consult.initiated'
  | 'async_consult.intake_submitted'
  | 'async_consult.ai_preparation_started'
  | 'async_consult.ai_preparation_completed'
  | 'async_consult.case_claimed'
  | 'async_consult.claim_expired_auto_released'
  | 'async_consult.clinician_decision_recorded'
  | 'async_consult.prescribing_recorded'
  | 'async_consult.clinician_decision_rationale_disagreement';

function asyncConsultV1AuditPlaceholder(id: AsyncConsultV1AuditActionPlaceholder): AuditAction {
  return id as AuditAction;
}

/**
 * Common envelope builder for the Sprint-10 v1 surface. Differs from the
 * Sprint-9 `buildEnvelope` above in two ways: (a) actor_type admits
 * 'clinician' (claim + decision handlers) and (b) resource_type is
 * caller-supplied (the v1 events attest to four distinct entities:
 * consult, consult_intake_submission, consult_review_claim,
 * consult_clinician_decision).
 */
interface AsyncConsultV1AuditCommon {
  tenant_id: TenantId;
  actor_type: 'patient' | 'delegate' | 'clinician' | 'system' | 'ai_workload';
  actor_id: string;
  actor_tenant_id: string | null;
  target_patient_id: string | null;
  country_of_care: string;
  resource_type: string;
  resource_id: string;
  detail: Record<string, unknown>;
  /**
   * Required when actor_type='ai_workload' (WORKLOAD_TAXONOMY v5.2 §1
   * nullability rule enforced in src/lib/audit.ts). The AI-preparation
   * emitters pass the prepared_by_mode-derived workload class
   * ('conversational_assistant' for mode_1, 'protocol_execution' for
   * mode_2); all other emitters omit it (null).
   */
  ai_workload_type?: 'conversational_assistant' | 'protocol_execution';
}

function buildV1Envelope(
  action: AuditAction,
  category: 'A' | 'B' | 'C',
  common: AsyncConsultV1AuditCommon,
): AuditEnvelopeInput {
  return {
    timestamp: new Date().toISOString(),
    tenant_id: common.tenant_id,
    actor_type: common.actor_type,
    actor_id: common.actor_id,
    actor_tenant_id: common.actor_tenant_id,
    target_patient_id: common.target_patient_id,
    delegate_context: null,
    action,
    category,
    audit_sensitivity_level: 'standard',
    resource_type: common.resource_type,
    resource_id: common.resource_id,
    detail: common.detail,
    engine_versions: null,
    // These are lifecycle attestations, not I-012 action-class records —
    // ai_workload_type + autonomy_level stay null (med-interaction
    // buildEnvelope precedent), EXCEPT the ai_preparation_* emitters
    // whose actor_type='ai_workload' requires ai_workload_type populated
    // per the WORKLOAD_TAXONOMY v5.2 §1 nullability rule. The prescribe
    // outcome's I-012 gate lives with the Pharmacy medication_request
    // flow (prescription_details_id is an opaque handle at this slice
    // per P-038 §12 OQ2).
    ai_workload_type: common.ai_workload_type ?? null,
    autonomy_level: null,
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
    country_of_care: common.country_of_care,
    break_glass: null,
  };
}

/** Cat C — async_consult.initiated (POST /v1/async-consults success path). */
export async function emitAsyncConsultInitiatedAudit(
  args: {
    tenantId: TenantId;
    consultId: string;
    patientId: string;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    consultType: string;
    programId: string | null;
    initiationSource: string;
    consultFeeCents: number;
    currency: string;
    paymentProvider: string;
    expectedTurnaroundAt: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildV1Envelope(asyncConsultV1AuditPlaceholder('async_consult.initiated'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.patientId,
      country_of_care: args.countryOfCare,
      resource_type: 'consult',
      resource_id: args.consultId,
      detail: {
        consult_type: args.consultType,
        program_id: args.programId,
        initiation_source: args.initiationSource,
        consult_fee_cents: args.consultFeeCents,
        currency: args.currency,
        payment_provider: args.paymentProvider,
        expected_turnaround_at: args.expectedTurnaroundAt,
      },
    }),
    tx,
  );
}

/** Cat C — async_consult.intake_submitted (POST /v1/async-consults/:id/intake). */
export async function emitAsyncConsultIntakeSubmittedAudit(
  args: {
    tenantId: TenantId;
    submissionId: string;
    consultId: string;
    patientId: string;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    templateId: string;
    templateVersion: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildV1Envelope(asyncConsultV1AuditPlaceholder('async_consult.intake_submitted'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.patientId,
      country_of_care: args.countryOfCare,
      resource_type: 'consult_intake_submission',
      resource_id: args.submissionId,
      detail: {
        consult_id: args.consultId,
        template_id: args.templateId,
        template_version: args.templateVersion,
        // The intake payload itself is a KMS envelope (I-026) — never
        // echoed into audit detail.
      },
    }),
    tx,
  );
}

/**
 * Cat C — async_consult.ai_preparation_started + ai_preparation_completed
 * (POST /v1/async-consults/:id/ai-preparation; AUDIT_EVENTS v5.11 rows 4-5).
 *
 * The migration 059 §3 wrapper is ATOMIC (ai_processing_started when
 * entering from submitted + clinical_summary INSERT + ai_processing_completed
 * in one call), so the handler emits both attestations in the same tx after
 * the wrapper returns — preparation started and completed within this
 * request. actor_type='ai_workload' per the migration 002 actor-type rule
 * for new v1.10+ AI emitters; ai_workload_type derives from
 * prepared_by_mode (mode_1 → conversational_assistant, mode_2 →
 * protocol_execution per ADR-029 / WORKLOAD_TAXONOMY v5.2).
 */
export async function emitAsyncConsultAiPreparationAudits(
  args: {
    tenantId: TenantId;
    summaryId: string;
    consultId: string;
    patientId: string;
    /** The AI-service principal's account id (JWT sub). */
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    preparedByMode: 'mode_1' | 'mode_2';
    aiProvider: string;
    modelId: string;
    recommendation: string | null;
  },
  tx: AuditDbClient,
): Promise<void> {
  const aiWorkloadType =
    args.preparedByMode === 'mode_1' ? 'conversational_assistant' : 'protocol_execution';
  await emitAudit(
    buildV1Envelope(asyncConsultV1AuditPlaceholder('async_consult.ai_preparation_started'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'ai_workload',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.patientId,
      country_of_care: args.countryOfCare,
      resource_type: 'consult',
      resource_id: args.consultId,
      ai_workload_type: aiWorkloadType,
      detail: {
        prepared_by_mode: args.preparedByMode,
        ai_provider: args.aiProvider,
        model_id: args.modelId,
      },
    }),
    tx,
  );
  await emitAudit(
    buildV1Envelope(asyncConsultV1AuditPlaceholder('async_consult.ai_preparation_completed'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'ai_workload',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.patientId,
      country_of_care: args.countryOfCare,
      resource_type: 'consult_clinical_summary',
      resource_id: args.summaryId,
      ai_workload_type: aiWorkloadType,
      detail: {
        consult_id: args.consultId,
        prepared_by_mode: args.preparedByMode,
        ai_provider: args.aiProvider,
        model_id: args.modelId,
        recommendation: args.recommendation,
        // The clinical summary itself is a KMS envelope (I-026) —
        // never echoed into audit detail.
      },
    }),
    tx,
  );
}

/** Cat C — async_consult.case_claimed (POST /v1/async-consults/:id/claim; always). */
export async function emitAsyncConsultCaseClaimedAudit(
  args: {
    tenantId: TenantId;
    claimId: string;
    consultId: string;
    clinicianAccountId: string;
    actorTenantId: string;
    countryOfCare: string;
    claimExpiresAt: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildV1Envelope(asyncConsultV1AuditPlaceholder('async_consult.case_claimed'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'clinician',
      actor_id: args.clinicianAccountId,
      actor_tenant_id: args.actorTenantId,
      // The claim wrapper resolves patient_id internally; the handler does
      // not read it back (the claim row carries it). target_patient_id is
      // therefore null here — the consult resource linkage in detail is
      // the forensic anchor.
      target_patient_id: null,
      country_of_care: args.countryOfCare,
      resource_type: 'consult_review_claim',
      resource_id: args.claimId,
      detail: {
        consult_id: args.consultId,
        clinician_account_id: args.clinicianAccountId,
        claim_expires_at: args.claimExpiresAt,
      },
    }),
    tx,
  );
}

/**
 * Cat B — async_consult.claim_expired_auto_released (AUDIT_EVENTS v5.11
 * row 17). Emitted by POST /v1/async-consults/:id/claim ONLY when
 * `claim_consult_for_review` returned a non-NULL auto-released prior
 * claim id (migration 059 §4 STEP 2). Fires BEFORE the paired
 * async_consult.case_claimed Cat C (cause before effect), same tx.
 */
export async function emitAsyncConsultClaimExpiredAutoReleasedAudit(
  args: {
    tenantId: TenantId;
    releasedClaimId: string;
    consultId: string;
    /** The clinician whose claim attempt triggered the auto-release. */
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildV1Envelope(
      asyncConsultV1AuditPlaceholder('async_consult.claim_expired_auto_released'),
      'B',
      {
        tenant_id: args.tenantId,
        actor_type: 'clinician',
        actor_id: args.actorId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: null,
        country_of_care: args.countryOfCare,
        resource_type: 'consult_review_claim',
        resource_id: args.releasedClaimId,
        detail: {
          consult_id: args.consultId,
          release_reason: 'claim_expired',
          released_during: 'claim_consult_for_review',
        },
      },
    ),
    tx,
  );
}

/** Cat A — async_consult.clinician_decision_recorded (POST .../decision; always). */
export async function emitAsyncConsultClinicianDecisionRecordedAudit(
  args: {
    tenantId: TenantId;
    decisionId: string;
    consultId: string;
    patientId: string;
    claimId: string;
    clinicianAccountId: string;
    actorTenantId: string;
    countryOfCare: string;
    decisionType: string;
    agreementWithAiRecommendation: string;
    interactionSignalsReviewedIds: readonly string[];
    prescriptionDetailsId: string | null;
    referralTargetId: string | null;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildV1Envelope(
      asyncConsultV1AuditPlaceholder('async_consult.clinician_decision_recorded'),
      'A',
      {
        tenant_id: args.tenantId,
        actor_type: 'clinician',
        actor_id: args.clinicianAccountId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: args.patientId,
        country_of_care: args.countryOfCare,
        resource_type: 'consult_clinician_decision',
        resource_id: args.decisionId,
        detail: {
          consult_id: args.consultId,
          claim_id: args.claimId,
          decision_type: args.decisionType,
          agreement_with_ai_recommendation: args.agreementWithAiRecommendation,
          interaction_signals_reviewed_ids: [...args.interactionSignalsReviewedIds],
          prescription_details_id: args.prescriptionDetailsId,
          referral_target_id: args.referralTargetId,
          // Decision rationale is a KMS envelope (I-026) — never echoed.
        },
      },
    ),
    tx,
  );
}

/**
 * Cat A — async_consult.prescribing_recorded. Emitted by POST .../decision
 * ONLY when decision_type='prescribe', AFTER the decision_recorded event
 * (same tx). prescription_details_id is an opaque handle at this slice
 * (P-038 §12 OQ2); the I-012 prescribing gate executes in the Pharmacy
 * medication_request flow that this handle will bind to.
 */
export async function emitAsyncConsultPrescribingRecordedAudit(
  args: {
    tenantId: TenantId;
    decisionId: string;
    consultId: string;
    patientId: string;
    clinicianAccountId: string;
    actorTenantId: string;
    countryOfCare: string;
    prescriptionDetailsId: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildV1Envelope(asyncConsultV1AuditPlaceholder('async_consult.prescribing_recorded'), 'A', {
      tenant_id: args.tenantId,
      actor_type: 'clinician',
      actor_id: args.clinicianAccountId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.patientId,
      country_of_care: args.countryOfCare,
      resource_type: 'consult_clinician_decision',
      resource_id: args.decisionId,
      detail: {
        consult_id: args.consultId,
        prescription_details_id: args.prescriptionDetailsId,
      },
    }),
    tx,
  );
}

/**
 * Cat A — async_consult.clinician_decision_rationale_disagreement.
 * Emitted by POST .../decision ONLY when
 * agreement_with_ai_recommendation='disagreed' — flags the human-AI
 * disagreement for downstream clinical-governance review. Fires AFTER the
 * decision_recorded event (and after prescribing_recorded when both
 * apply), same tx.
 */
export async function emitAsyncConsultDecisionRationaleDisagreementAudit(
  args: {
    tenantId: TenantId;
    decisionId: string;
    consultId: string;
    patientId: string;
    clinicianAccountId: string;
    actorTenantId: string;
    countryOfCare: string;
    decisionType: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildV1Envelope(
      asyncConsultV1AuditPlaceholder('async_consult.clinician_decision_rationale_disagreement'),
      'A',
      {
        tenant_id: args.tenantId,
        actor_type: 'clinician',
        actor_id: args.clinicianAccountId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: args.patientId,
        country_of_care: args.countryOfCare,
        resource_type: 'consult_clinician_decision',
        resource_id: args.decisionId,
        detail: {
          consult_id: args.consultId,
          decision_type: args.decisionType,
          agreement_with_ai_recommendation: 'disagreed',
        },
      },
    ),
    tx,
  );
}
