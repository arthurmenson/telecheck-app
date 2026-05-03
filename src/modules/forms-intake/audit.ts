/**
 * forms-intake/audit.ts — module-specific audit envelope emitters.
 *
 * Wraps `lib/audit.ts emitAudit()` with the action IDs and envelope shape
 * the Forms/Intake Engine emits per Forms/Intake Engine Slice PRD v2.1
 * §8.5 (save/resume/abandon are Category C), §14.6 (variant lifecycle is
 * Category B), and Contracts Pack v5.2 AUDIT_EVENTS (governance edits
 * `forms_eligibility_logic_edited`, `forms_approval_governance_edited`).
 *
 * Spec references:
 *   - Slice PRD v2.1 §8.5 — save-and-resume audit (Category C operational)
 *   - Slice PRD v2.1 §14.6 — variant audit (Category B governance)
 *   - Slice PRD v2.1 §16.6 — abandonment recovery audit
 *   - Slice PRD v2.1 §25.3 — research consent block audit linkage
 *     (`research.consent_granted` / `research.consent_revoked` — emitted from
 *     the consent module, not here; this file only handles forms-engine-
 *     scoped governance + lifecycle audit actions).
 *   - AUDIT_EVENTS v5.2 — `forms_eligibility_logic_edited`,
 *     `forms_approval_governance_edited` (already in lib/audit.ts AuditAction)
 *   - INVARIANTS I-003 (audit append-only; bare suppression forbidden),
 *     I-027 (every record carries tenant_id).
 *
 * SPEC ISSUE: AUDIT_EVENTS v5.2 does not enumerate canonical action IDs for
 * forms-engine submission lifecycle (start, pause, resume, abandon, complete)
 * or for variant deploy/retire/promote. The slice PRD §14.6 and §8.5 say
 * these MUST be audited but does not pin exact action identifiers. This
 * scaffold uses the existing `forms_*` actions for governance edits and
 * routes lifecycle events through the closest existing operational actions
 * (`config_change_validated`) plus rich `detail` payloads. Engineering Lead
 * + Contracts Pack owner should add canonical `forms_submission_*` and
 * `forms_variant_*` action IDs in a future AUDIT_EVENTS amendment.
 *
 * Hard rule per I-003: every emitter below MUST throw on emission failure
 * (the underlying `emitAudit()` already does); callers MUST NOT swallow
 * the throw.
 */

import {
  type AuditAction,
  type AuditDbClient,
  type AuditEnvelope,
  type AuditEnvelopeInput,
  emitAudit,
} from '../../lib/audit.js';
import type { TenantId } from '../../lib/glossary.js';

import type {
  FormDeploymentId,
  FormSubmissionId,
  FormTemplateId,
  FormVariantId,
  FormVersionId,
  PatientId,
  ResumeStateId,
} from './internal/types.js';

// ---------------------------------------------------------------------------
// Common envelope-builder for forms-engine audit emissions.
//
// Forms-engine audit records are non-AI-actor (tenant admin, patient, or
// system) — they pass `actor_type` accordingly and set `ai_workload_type` /
// `autonomy_level` to null since none of them are I-012 action-class events.
// ---------------------------------------------------------------------------

interface FormsAuditCommon {
  tenant_id: TenantId;
  actor_type: 'patient' | 'delegate' | 'operator' | 'system';
  actor_id: string;
  actor_tenant_id: string | null;
  // Nullable for platform-scope events (e.g., template authoring,
  // not patient-related); the foundation audit emitter maps null to the
  // 'PLATFORM' hash-chain sentinel matching the DB trigger COALESCE.
  // (Patch v0.2 — 2026-05-02 per Codex first-handler-implementation
  //  CRITICAL closure: prior type forced PatientId, blocking platform-
  //  scope event emission entirely.)
  target_patient_id: PatientId | null;
  country_of_care: string; // ISO 3166-1 alpha-2
  resource_type: string;
  resource_id: string;
  detail: Record<string, unknown>;
}

function buildEnvelope(
  action: AuditAction,
  category: 'A' | 'B' | 'C',
  common: FormsAuditCommon,
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
// Template lifecycle audit
//
// SPEC ISSUE: AUDIT_EVENTS v5.2 catalog enumerates `forms_eligibility_logic_
// edited` and `forms_approval_governance_edited` (Category B governance)
// but does NOT canonicalize a `forms_template_created` action ID. The slice
// PRD §6.1 visual-builder workflow REQUIRES audit on template creation
// (every state-changing operation must audit per I-027 + I-003 spirit).
// Added here under the placeholder action ID `forms_template_created`,
// Category B (governance — tenant-admin authoring); pending Engineering
// Lead ratification per EHBG §12 SI/DSI escalation. The audit envelope
// shape and tx-threading discipline match the canonical pattern; only
// the action ID is unratified.
// ---------------------------------------------------------------------------

/**
 * Emit `forms_template_created` — tenant admin created a draft template.
 * Category B (governance / config). Always emitted at template creation
 * (status='draft' per FORMS_ENGINE v5.2 lifecycle); subsequent edits emit
 * `forms_eligibility_logic_edited` / `forms_approval_governance_edited` /
 * etc. as appropriate.
 *
 * Per the canonical durability discipline: tx is required in production
 * (foundation audit.ts throws without it outside NODE_ENV=test).
 * target_patient_id is null for template-creation events (no patient
 * involved); audit_records.target_patient_id allows NULL for non-patient
 * platform-scope events (the trigger uses 'PLATFORM' sentinel for the
 * hash chain partition in that case).
 */
export async function emitFormsTemplateCreated(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    templateId: FormTemplateId;
    programId: string;
    templateVersion: number;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    {
      ...buildEnvelope('forms_template_created' as AuditAction, 'B', {
        tenant_id: args.tenantId,
        actor_type: 'operator',
        actor_id: args.actorId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: null, // platform-scope event; foundation audit emitter maps null to the 'PLATFORM' hash-chain sentinel
        country_of_care: args.countryOfCare,
        resource_type: 'forms_template',
        resource_id: args.templateId,
        detail: {
          template_id: args.templateId,
          program_id: args.programId,
          template_version: args.templateVersion,
          status: 'draft',
        },
      }),
    },
    tx,
  );
}

/**
 * Emit `forms_template_version_published` — tenant admin promoted a draft
 * template version to `published`, simultaneously superseding any prior
 * published version in the same (tenant, program, country) family.
 * Category B (governance / config).
 *
 * Same SPEC ISSUE caveat as emitFormsTemplateCreated: AUDIT_EVENTS v5.2
 * doesn't enumerate `forms_template_version_published`; the closest
 * Engineering-Lead-ratified action is `config_change_validated`. Using the
 * descriptive action ID here (typed via `as AuditAction`) preserves the
 * SPEC-ISSUE flag — grep for `as AuditAction` to find unratified action
 * IDs awaiting Engineering Lead amendment per EHBG §12.
 *
 * `priorPublishedVersionId` is null when this publish is the first
 * published version for the family (no prior to supersede). When non-null,
 * the supersession cascade ran in the same transaction; the audit detail
 * captures both ends of the cascade so a chain walker can reconstruct the
 * lifecycle without joining additional tables.
 */
export async function emitFormsTemplateVersionPublished(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    templateId: FormTemplateId;
    versionId: FormVersionId;
    programId: string;
    templateVersion: number;
    priorPublishedVersionId: FormVersionId | null;
    changeNotes: string | null;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    {
      ...buildEnvelope('forms_template_version_published' as AuditAction, 'B', {
        tenant_id: args.tenantId,
        actor_type: 'operator',
        actor_id: args.actorId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: null, // platform-scope event
        country_of_care: args.countryOfCare,
        resource_type: 'forms_template',
        resource_id: args.versionId,
        detail: {
          template_id: args.templateId,
          version_id: args.versionId,
          program_id: args.programId,
          template_version: args.templateVersion,
          status: 'published',
          prior_published_version_id: args.priorPublishedVersionId,
          change_notes: args.changeNotes,
        },
      }),
    },
    tx,
  );
}

/**
 * Emit `forms_deployment_created` — tenant admin deployed a published
 * template to a program market. Category B (governance / config).
 *
 * Same SPEC ISSUE caveat as emitFormsTemplateCreated: AUDIT_EVENTS v5.2
 * doesn't canonicalize this action ID — pending Engineering Lead ratification.
 */
export async function emitFormsDeploymentCreated(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    deploymentId: FormDeploymentId;
    templateId: FormTemplateId;
    programId: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    {
      ...buildEnvelope('forms_deployment_created' as AuditAction, 'B', {
        tenant_id: args.tenantId,
        actor_type: 'operator',
        actor_id: args.actorId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: null, // platform-scope: no patient target
        country_of_care: args.countryOfCare,
        resource_type: 'forms_deployment',
        resource_id: args.deploymentId,
        detail: {
          deployment_id: args.deploymentId,
          template_id: args.templateId,
          program_id: args.programId,
        },
      }),
    },
    tx,
  );
}

/**
 * Emit `forms_deployment_retired` — tenant admin retired an active
 * deployment. Category B (governance / config).
 *
 * Same SPEC ISSUE caveat as the createTemplate / versionPublished family:
 * AUDIT_EVENTS v5.2 doesn't enumerate `forms_deployment_retired` and
 * neither State Machines v1.1 nor the slice PRD canonicalize the
 * deployment lifecycle (active → retired). The action ID is type-cast
 * via `as AuditAction` so grep finds unratified action IDs awaiting
 * Engineering Lead amendment per EHBG §12 SI/DSI escalation.
 *
 * Per Slice PRD §14.5 supersession discipline + Pattern A immutability,
 * retiring a deployment does NOT halt in-progress submissions assigned
 * to its template version — those continue to completion. Retirement
 * means the deployment is no longer offered to NEW intakes (the
 * `findActiveDeployment` query filters by `retired_at IS NULL`).
 */
export async function emitFormsDeploymentRetired(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    deploymentId: FormDeploymentId;
    templateId: FormTemplateId;
    programId: string;
    retiredAt: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    {
      ...buildEnvelope('forms_deployment_retired' as AuditAction, 'B', {
        tenant_id: args.tenantId,
        actor_type: 'operator',
        actor_id: args.actorId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: null,
        country_of_care: args.countryOfCare,
        resource_type: 'forms_deployment',
        resource_id: args.deploymentId,
        detail: {
          deployment_id: args.deploymentId,
          template_id: args.templateId,
          program_id: args.programId,
          retired_at: args.retiredAt,
        },
      }),
    },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Governance edits (Category B per AUDIT_EVENTS v5.2)
// ---------------------------------------------------------------------------

/**
 * Emit `forms_eligibility_logic_edited` — Layer 3 (clinical safety) edit.
 * Per FORMS_ENGINE v5.2 dual-control required (I-015); the calling service
 * MUST verify both clinical_content_author + clinical_safety_officer
 * approval before invoking this emitter.
 */
export async function emitFormsEligibilityLogicEdited(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    versionId: FormVersionId;
    targetPatientId: PatientId;
    changes: ReadonlyArray<Record<string, unknown>>;
    clinicalImpactAssessment: string;
  },
  tx?: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope('forms_eligibility_logic_edited', 'B', {
      tenant_id: args.tenantId,
      actor_type: 'operator',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.targetPatientId,
      country_of_care: args.countryOfCare,
      resource_type: 'form_version',
      resource_id: args.versionId,
      detail: {
        form_version_id: args.versionId,
        changes: args.changes,
        clinical_impact_assessment: args.clinicalImpactAssessment,
      },
    }),
    tx,
  );
}

/**
 * Emit `forms_approval_governance_edited` — Layer 4 (pricing / market /
 * launch gating) edit per FORMS_ENGINE v5.2.
 */
export async function emitFormsApprovalGovernanceEdited(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    versionId: FormVersionId;
    targetPatientId: PatientId;
    changes: ReadonlyArray<Record<string, unknown>>;
  },
  tx?: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope('forms_approval_governance_edited', 'B', {
      tenant_id: args.tenantId,
      actor_type: 'operator',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.targetPatientId,
      country_of_care: args.countryOfCare,
      resource_type: 'form_version',
      resource_id: args.versionId,
      detail: {
        form_version_id: args.versionId,
        changes: args.changes,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// Submission lifecycle audit (Category C — operational per Slice PRD §8.5
// + AUDIT_EVENTS v5.2 §Category C action catalog naming intake_paused,
// intake_resumed, intake_completed, intake_abandoned).
//
// SPEC ISSUE: the `intake_*` family isn't enumerated in src/lib/audit.ts
// AuditAction union (which mirrors AUDIT_EVENTS v5.2 Category C, but the
// spec catalog lists these by name in PRD §8.5 prose only). We type-cast
// `'forms_submission_started' as AuditAction` etc. so grep finds
// unratified action IDs. Engineering Lead amendment pending per
// EHBG §12 SI/DSI escalation.
// ---------------------------------------------------------------------------

/**
 * Emit `forms_submission_started` — patient (or delegate) began an intake.
 * Category C (operational). target_patient_id is the patient the
 * submission belongs to; resource_id is the submission_id.
 */
export async function emitFormsSubmissionStartedAudit(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    submissionId: FormSubmissionId;
    deploymentId: FormDeploymentId;
    patientId: PatientId;
    delegateId: string | null;
    variantId: FormVariantId | null;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    {
      ...buildEnvelope('forms_submission_started' as AuditAction, 'C', {
        tenant_id: args.tenantId,
        actor_type: args.delegateId !== null ? 'delegate' : 'patient',
        actor_id: args.actorId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: args.patientId,
        country_of_care: args.countryOfCare,
        resource_type: 'forms_submission',
        resource_id: args.submissionId,
        detail: {
          submission_id: args.submissionId,
          deployment_id: args.deploymentId,
          patient_id: args.patientId,
          delegate_id: args.delegateId,
          variant_id: args.variantId,
        },
      }),
    },
    tx,
  );
}

/**
 * Emit `crisis_detection_trigger` — the I-019 platform-floor detector
 * fired on a patient-facing text input. Category A safety-critical;
 * **MUST be emitted even when the originating action is rejected**
 * (Slice PRD §13 escalation; I-003 bare-suppression-forbidden).
 *
 * The action ID `crisis_detection_trigger` IS canonical in AUDIT_EVENTS
 * v5.2 §Category A — no SPEC ISSUE flag needed here. Emitted from the
 * forms-intake module when an autosave / final-submit path detects
 * crisis text; the same audit is also emitted from chat / community /
 * other surfaces (each calls into this same emitter via a thin
 * surface-specific wrapper).
 */
export async function emitCrisisDetectionTrigger(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    targetPatientId: PatientId;
    /** Surface that produced the text (form_response, ai_chat, community, etc.). */
    detectionSource: string;
    /** Crisis-type classification per crisis-detection.ts. */
    crisisType: string;
    /** The submission / message / aggregate the text came from (PHI carrier). */
    resourceType: string;
    resourceId: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    {
      ...buildEnvelope('crisis_detection_trigger' as AuditAction, 'A', {
        tenant_id: args.tenantId,
        actor_type: 'patient',
        actor_id: args.actorId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: args.targetPatientId,
        country_of_care: args.countryOfCare,
        resource_type: args.resourceType,
        resource_id: args.resourceId,
        detail: {
          detection_source: args.detectionSource,
          crisis_type: args.crisisType,
          // The text content itself is intentionally NOT captured in the
          // audit detail — the source row holds the PHI; the audit chain
          // records that a detection fired (per I-019) without
          // duplicating the text into a second store. The source row is
          // recoverable via (tenant_id, resource_type, resource_id).
        },
      }),
    },
    tx,
  );
}

/**
 * Emit `forms_submission_completed` — patient finalized the intake.
 * Category C operational; corresponds to the AUDIT_EVENTS v5.2 §Category C
 * `intake_completed` action. The corresponding `intake_response.submitted`
 * domain event is emitted in the same transaction.
 */
export async function emitFormsSubmissionCompletedAudit(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    submissionId: FormSubmissionId;
    deploymentId: FormDeploymentId;
    patientId: PatientId;
    delegateId: string | null;
    submittedAt: string;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    {
      ...buildEnvelope('forms_submission_completed' as AuditAction, 'C', {
        tenant_id: args.tenantId,
        actor_type: args.delegateId !== null ? 'delegate' : 'patient',
        actor_id: args.actorId,
        actor_tenant_id: args.actorTenantId,
        target_patient_id: args.patientId,
        country_of_care: args.countryOfCare,
        resource_type: 'forms_submission',
        resource_id: args.submissionId,
        detail: {
          submission_id: args.submissionId,
          deployment_id: args.deploymentId,
          patient_id: args.patientId,
          delegate_id: args.delegateId,
          submitted_at: args.submittedAt,
        },
      }),
    },
    tx,
  );
}

// Note: per-keystroke auto-save events are intentionally NOT audited here —
// Category C `intake_paused` (explicit save-and-leave) is covered by the
// existing `emitFormsResumeStateSaved` emitter; the auto-save path is
// internal traffic and would explode the audit chain if every keystroke
// produced an audit row. Slice PRD §8.5 + AUDIT_EVENTS v5.2 §Category C
// confirm this read of the discipline.

// ---------------------------------------------------------------------------
// Submission lifecycle audit (legacy — kept for save-and-resume flow only)
//
// SPEC ISSUE flagged at file header: AUDIT_EVENTS v5.2 lacks dedicated
// `forms_submission_*` action IDs. We use `config_change_validated` as the
// closest available Category B action for variant lifecycle and retain
// rich `detail` payloads for traceability until the spec adds canonical IDs.
// ---------------------------------------------------------------------------

/**
 * Emit a paused-submission audit (save-and-leave per Slice PRD §8.2).
 *
 * SPEC ISSUE: no canonical `forms_submission_paused` action exists in
 * AUDIT_EVENTS v5.2. Until that lands, we use `config_change_validated`
 * as a placeholder Category B action — Engineering Lead must replace this
 * via an AUDIT_EVENTS amendment. TODO once spec lands.
 */
export async function emitFormsResumeStateSaved(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    submissionId: FormSubmissionId;
    resumeStateId: ResumeStateId;
    targetPatientId: PatientId;
    sectionIndex: number;
    timeInIntakeMs: number;
  },
  tx?: AuditDbClient,
): Promise<AuditEnvelope> {
  // SPEC ISSUE: action 'forms_submission_paused' is not canonical in
  // AUDIT_EVENTS v5.2. Using 'config_change_validated' as the closest
  // available Category B action; the rich detail block preserves the
  // intended semantics until the spec adds a dedicated action ID.
  return emitAudit(
    buildEnvelope('config_change_validated', 'B', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.targetPatientId,
      country_of_care: args.countryOfCare,
      resource_type: 'form_submission',
      resource_id: args.submissionId,
      detail: {
        intent: 'forms_submission_paused',
        submission_id: args.submissionId,
        resume_state_id: args.resumeStateId,
        section_index: args.sectionIndex,
        time_in_intake_ms: args.timeInIntakeMs,
      },
    }),
    tx,
  );
}

/**
 * Emit an audit when a previously-paused submission is resumed.
 *
 * SPEC ISSUE: action 'forms_submission_resumed' is not canonical in
 * AUDIT_EVENTS v5.2. Same placeholder + detail block treatment as above.
 */
export async function emitFormsResumeStateRestored(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    submissionId: FormSubmissionId;
    resumeStateId: ResumeStateId;
    targetPatientId: PatientId;
    timePausedMs: number;
  },
  tx?: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope('config_change_validated', 'B', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.targetPatientId,
      country_of_care: args.countryOfCare,
      resource_type: 'form_submission',
      resource_id: args.submissionId,
      detail: {
        intent: 'forms_submission_resumed',
        submission_id: args.submissionId,
        resume_state_id: args.resumeStateId,
        time_paused_ms: args.timePausedMs,
      },
    }),
    tx,
  );
}

// ---------------------------------------------------------------------------
// Variant lifecycle (Category B per Slice PRD §14.6)
// ---------------------------------------------------------------------------

/**
 * Emit a variant deployment audit. Per Slice PRD §14.6, this MUST capture
 * tenant admin actor, variant identifier, sample-size config, traffic split.
 *
 * SPEC ISSUE: action 'forms_variant_deployed' is not canonical in
 * AUDIT_EVENTS v5.2. Using `config_change_validated` as the placeholder
 * Category B action; replace once a canonical action is added.
 */
export async function emitFormsVariantDeployed(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    variantId: FormVariantId;
    parentVersionId: FormVersionId;
    targetPatientId: PatientId;
    label: string;
    trafficSplitPercent: number;
  },
  tx?: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope('config_change_validated', 'B', {
      tenant_id: args.tenantId,
      actor_type: 'operator',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.targetPatientId,
      country_of_care: args.countryOfCare,
      resource_type: 'form_variant',
      resource_id: args.variantId,
      detail: {
        intent: 'forms_variant_deployed',
        variant_id: args.variantId,
        parent_version_id: args.parentVersionId,
        label: args.label,
        traffic_split_percent: args.trafficSplitPercent,
      },
    }),
    tx,
  );
}

/**
 * Emit a variant winner-promotion audit. Per Slice PRD §14.5/§14.6, captures
 * sample size, p-value, and rationale.
 *
 * SPEC ISSUE: action 'forms_variant_winner_promoted' is not canonical.
 */
export async function emitFormsVariantWinnerPromoted(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    variantId: FormVariantId;
    targetPatientId: PatientId;
    sampleSize: number;
    pValue: number;
    rationale: string;
  },
  tx?: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope('config_change_validated', 'B', {
      tenant_id: args.tenantId,
      actor_type: 'operator',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.targetPatientId,
      country_of_care: args.countryOfCare,
      resource_type: 'form_variant',
      resource_id: args.variantId,
      detail: {
        intent: 'forms_variant_winner_promoted',
        variant_id: args.variantId,
        sample_size: args.sampleSize,
        p_value: args.pValue,
        rationale: args.rationale,
      },
    }),
    tx,
  );
}
