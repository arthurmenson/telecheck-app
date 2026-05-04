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
 * forms-engine template / deployment / submission / variant lifecycle. The
 * slice PRD §8.5, §14.5, §14.6 say these MUST be audited but doesn't pin
 * exact action identifiers. This module emits them under DESCRIPTIVE-but-
 * unratified IDs through a SINGLE pattern:
 *
 *   `formsAuditPlaceholder()` helper — typed-cast helper with a closed
 *   union of placeholder IDs (`FormsAuditActionPlaceholder`). The single
 *   sanctioned `as AuditAction` cast lives inside the helper. Used by all
 *   11 unratified emitters across the module:
 *     template (2) + deployment (2) + submission (4) + variant (3)
 *   Inventory: `git grep "formsAuditPlaceholder("`.
 *
 * (History note 2026-05-04: prior to the legacy-emitter-migration batch,
 * 3 emitters (`emitFormsResumeStateSaved`, `emitFormsResumeStateRestored`,
 * `emitFormsVariantDeployed`) used a different pattern — canonical action
 * `config_change_validated` + `detail.intent: '<unratified_id>'`. The
 * resume-state emitters were migrated to the helper; the deprecated
 * `emitFormsVariantDeployed` was deleted outright since it had zero
 * internal callers and was not on the cross-module surface. Tests now
 * assert against the new action_id directly instead of the (action,
 * detail.intent) tuple.)
 *
 * Engineering Lead + Contracts Pack owner must ratify ALL ELEVEN action
 * IDs enumerated in the `FormsAuditActionPlaceholder` union (template
 * lifecycle: `forms_template_created`, `forms_template_version_published`;
 * deployment lifecycle: `forms_deployment_created`,
 * `forms_deployment_retired`; submission lifecycle:
 * `forms_submission_started`, `forms_submission_paused`,
 * `forms_submission_resumed`, `forms_submission_completed`; variant
 * lifecycle: `forms_variant_created`, `forms_variant_winner_promoted`,
 * `forms_variant_retired`) in a future AUDIT_EVENTS amendment per
 * EHBG §12 SI/DSI escalation. Partial ratification (e.g. only the
 * template/deployment subset) would leave the unratified subset
 * stranded if the helper is deleted; the migration MUST be all-or-
 * nothing or staged through a smaller union. When the full amendment
 * lands, deleting `formsAuditPlaceholder()` and migrating its callers
 * is a 3-step grep documented at the helper definition.
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
// SPEC ISSUE — unratified Forms/Intake audit action IDs (placeholder helper)
//
// AUDIT_EVENTS v5.2 enumerates `forms_eligibility_logic_edited` and
// `forms_approval_governance_edited` as canonical Category B governance
// actions for the forms engine, but does NOT canonicalize action IDs for
// template/deployment/submission/variant lifecycle. Slice PRD v2.1 §8.5,
// §14.5, §14.6 require these events to be audited (per I-027 + I-003), so
// this module emits them under DESCRIPTIVE-but-not-yet-ratified action IDs
// pending an EHBG §12 SI/DSI escalation that adds them to the canonical
// AuditAction enum in `lib/audit.ts`.
//
// Until that ratification lands, the placeholder IDs are typed via a single
// sanctioned cast helper (`formsAuditPlaceholder()` below) so every
// unratified emission flows through ONE grep-able call site. The
// `FormsAuditActionPlaceholder` union enumerates exactly the placeholder
// strings — typos at call sites become compile errors, and a future commit
// removing this helper (because the spec landed) deletes every placeholder
// reference at once.
//
// Pattern audit (2026-05-04, post legacy-emitter migration + r1 cleanup):
//   - All 11 unratified emissions across the module now route through the
//     placeholder helper. The legacy `config_change_validated +
//     detail.intent: '<unratified_id>'` pattern was migrated 2026-05-04 —
//     `emitFormsResumeStateSaved` and `emitFormsResumeStateRestored` now
//     use formsAuditPlaceholder() with the canonical placeholder
//     action_id and dropped the redundant detail.intent field. The third
//     legacy emitter on that pattern, `emitFormsVariantDeployed`, was
//     deleted outright at verify-r1 (zero internal callers, not on the
//     cross-module surface) — see history note at the file-header SPEC
//     ISSUE block above. Single-pattern state holds going forward; any
//     new unratified emission MUST go through the helper, not via
//     canonical-action + detail-intent encoding.
//
// When the spec amendment lands, the migration is a 3-step grep:
//   1. Add the new actions to `AuditAction` in lib/audit.ts.
//   2. Delete `formsAuditPlaceholder()` and its union here.
//   3. Replace every `formsAuditPlaceholder('<id>')` call with bare
//      `'<id>' satisfies AuditAction` (or just the literal — TS infers).
// ---------------------------------------------------------------------------

/**
 * Closed union of unratified action IDs used by the Forms/Intake module.
 *
 * Each entry MUST have an open EHBG §12 spec issue requesting its
 * ratification. Adding a new placeholder here is the explicit price of
 * shipping unratified audit semantics — code review can grep this union
 * to inventory what the spec owes us.
 */
type FormsAuditActionPlaceholder =
  // Template lifecycle
  | 'forms_template_created'
  | 'forms_template_version_published'
  // Deployment lifecycle
  | 'forms_deployment_created'
  | 'forms_deployment_retired'
  // Submission lifecycle (patient-facing)
  | 'forms_submission_started'
  | 'forms_submission_paused'
  | 'forms_submission_resumed'
  | 'forms_submission_completed'
  // Variant lifecycle (A/B)
  | 'forms_variant_created'
  | 'forms_variant_winner_promoted'
  | 'forms_variant_retired';

/**
 * formsAuditPlaceholder — single sanctioned `as AuditAction` cast site.
 *
 * Returns the placeholder string typed as `AuditAction` so it can flow
 * into `emitAudit()` without a per-call-site cast. The cast is contained
 * in this one function so reviewers can grep for the source of every
 * unratified emission across the module:
 *
 *   git grep "formsAuditPlaceholder("
 *
 * That single grep also gives the migration list when the spec
 * amendment ratifies these IDs and the helper can be removed.
 *
 * The compile-time `FormsAuditActionPlaceholder` union prevents typos.
 *
 * **Migration trigger (when AUDIT_EVENTS v5.2 amendment lands):**
 *   The amendment MUST ratify every member of the
 *   `FormsAuditActionPlaceholder` union — currently 11 IDs spanning
 *   template, deployment, submission, and variant lifecycle. Partial
 *   ratification strands the unratified subset; the union itself is
 *   the authoritative migration checklist (read its definition above).
 *   Once all 11 are in the canonical `AuditAction` enum:
 *     1. Add the new actions to `AuditAction` in lib/audit.ts.
 *     2. Delete this function and the union in this file.
 *     3. Replace every `formsAuditPlaceholder('<id>')` call with the
 *        bare literal — TS infers the AuditAction type.
 *
 * @param id  Placeholder action ID drawn from the closed union.
 * @returns   The same string typed as `AuditAction` (single sanctioned cast).
 */
export function formsAuditPlaceholder(id: FormsAuditActionPlaceholder): AuditAction {
  // The cast is intentional and contained here. Removing this function
  // when AUDIT_EVENTS v5.2 ratifies these IDs is the migration trigger;
  // do NOT replicate this cast pattern at call sites.
  return id as AuditAction;
}

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
      ...buildEnvelope(formsAuditPlaceholder('forms_template_created'), 'B', {
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
 * doesn't enumerate `forms_template_version_published`. The action ID
 * routes through `formsAuditPlaceholder()` (the single sanctioned-cast
 * helper documented at the top of this file) — grep
 * `formsAuditPlaceholder(` to inventory every unratified emission across
 * the module pending Engineering Lead amendment per EHBG §12.
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
      ...buildEnvelope(formsAuditPlaceholder('forms_template_version_published'), 'B', {
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
      ...buildEnvelope(formsAuditPlaceholder('forms_deployment_created'), 'B', {
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
 * deployment lifecycle (active → retired). Routed through
 * `formsAuditPlaceholder()` so the `FormsAuditActionPlaceholder` union
 * tracks the unratified IDs in one grep-able place pending Engineering
 * Lead amendment per EHBG §12 SI/DSI escalation.
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
      ...buildEnvelope(formsAuditPlaceholder('forms_deployment_retired'), 'B', {
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
// spec catalog lists these by name in PRD §8.5 prose only). The
// `forms_submission_*` placeholder action IDs route through
// `formsAuditPlaceholder()` so unratified emissions are inventoried via
// `git grep "formsAuditPlaceholder("` pending Engineering Lead amendment
// per EHBG §12 SI/DSI escalation.
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
      ...buildEnvelope(formsAuditPlaceholder('forms_submission_started'), 'C', {
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
      // crisis_detection_trigger IS canonical in AUDIT_EVENTS v5.2 §Category A
      // (see lib/audit.ts CategoryAAction). The historical `as AuditAction` cast
      // here was a copy-paste artifact from the placeholder pattern; removed
      // 2026-05-04 with the placeholder-helper refactor — TS infers the literal
      // type and the bare string assigns cleanly to AuditAction.
      ...buildEnvelope('crisis_detection_trigger', 'A', {
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
      ...buildEnvelope(formsAuditPlaceholder('forms_submission_completed'), 'C', {
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
// Submission save-and-resume audit (paused / resumed) — Category C operational
//
// Migrated 2026-05-04 from the legacy `config_change_validated +
// detail.intent` pattern to the typed `formsAuditPlaceholder()` helper.
// The action IDs are unratified (SPEC ISSUE flagged at file header) but
// follow the same single-pattern discipline as the rest of the module.
//
// Category alignment 2026-05-04 (closed during legacy-emitter migration
// follow-up): slice PRD v2.1 §8.5 line 327 explicitly states "audited
// per AUDIT-EVENTS Category C (operational)". The pre-migration emitters
// inherited Category B from the legacy `config_change_validated`
// placeholder; the dedicated action_id migration now uses Category C in
// alignment with §8.5. Tests under tests/integration/forms-intake-{pause,
// restore}.test.ts have been updated to assert Category C accordingly.
// ---------------------------------------------------------------------------

/**
 * Emit a paused-submission audit (save-and-leave per Slice PRD §8.2).
 *
 * Routed through `formsAuditPlaceholder('forms_submission_paused')` —
 * the action ID is not yet canonical in AUDIT_EVENTS v5.2 (see file-header
 * SPEC ISSUE for the full migration list). Category C operational per
 * Slice PRD v2.1 §8.5.
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
  return emitAudit(
    buildEnvelope(formsAuditPlaceholder('forms_submission_paused'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.targetPatientId,
      country_of_care: args.countryOfCare,
      resource_type: 'form_submission',
      resource_id: args.submissionId,
      detail: {
        // The redundant `intent: 'forms_submission_paused'` field that the
        // legacy pattern carried has been dropped — the action_id itself
        // is now the discriminator. Tests assert against `action ===
        // 'forms_submission_paused'` directly.
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
 * Routed through `formsAuditPlaceholder('forms_submission_resumed')` —
 * same migration treatment as the paused emitter above. Category C
 * operational per Slice PRD v2.1 §8.5.
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
    buildEnvelope(formsAuditPlaceholder('forms_submission_resumed'), 'C', {
      tenant_id: args.tenantId,
      actor_type: 'patient',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: args.targetPatientId,
      country_of_care: args.countryOfCare,
      resource_type: 'form_submission',
      resource_id: args.submissionId,
      detail: {
        // Redundant `intent` field dropped per migration 2026-05-04.
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
 * Emit a `forms_variant_created` audit when a tenant admin authors a new
 * A/B variant arm. Category B (governance / config). Admin-scope event:
 * `target_patient_id: null`.
 *
 * SPEC ISSUE per EHBG §12: AUDIT_EVENTS v5.2 doesn't canonicalize
 * `forms_variant_created`. Routed through `formsAuditPlaceholder()` —
 * same pattern as `forms_template_created` et al. across this module
 * pending Engineering Lead ratification.
 */
export async function emitFormsVariantCreated(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    variantId: FormVariantId;
    deploymentId: FormDeploymentId;
    variantTemplateId: FormTemplateId;
    label: string;
    trafficPercent: number;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(formsAuditPlaceholder('forms_variant_created'), 'B', {
      tenant_id: args.tenantId,
      actor_type: 'operator',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: null, // platform-scope event
      country_of_care: args.countryOfCare,
      resource_type: 'form_variant',
      resource_id: args.variantId,
      detail: {
        variant_id: args.variantId,
        deployment_id: args.deploymentId,
        variant_template_id: args.variantTemplateId,
        label: args.label,
        traffic_percent: args.trafficPercent,
      },
    }),
    tx,
  );
}

// `emitFormsVariantDeployed` was deleted 2026-05-04 (legacy-emitter-migration
// verify-r1 closure). It was historically marked @deprecated and had ZERO
// internal callers across the entire codebase (`git grep` at deletion time
// returned only its own definition + 2 self-referential JSDoc comments). It
// was NOT exported through this module's `index.ts` (cross-module surface),
// so its removal is internal-implementation-only and breaks no external
// contract. Callers needing variant-creation audit emit through
// `emitFormsVariantCreated` directly.
//
// (Codex legacy-emitter-migration r0 MEDIUM closure — the emitter was
//  inadvertently changed from `config_change_validated + detail.intent` to
//  `forms_variant_deployed` action_id during r0, which would have broken
//  the externally-observable wire shape this emitter's @deprecated comment
//  was meant to preserve. Confirmation that no external callers exist made
//  outright deletion the cleanest fix; the placeholder union is also
//  trimmed back from 12 to 11 entries to match.)

/**
 * Emit a `forms_variant_winner_promoted` audit when a tenant admin promotes
 * a statistically-significant winner variant to new Control. Per Slice PRD
 * §14.5/§14.6, captures sample size, p-value, and rationale. Category B,
 * admin-scope event (`target_patient_id: null` per the same pattern as
 * other admin emitters).
 *
 * SPEC ISSUE per EHBG §12: action ID `forms_variant_winner_promoted` is
 * not canonical in AUDIT_EVENTS v5.2. Routed through
 * `formsAuditPlaceholder()` pending Engineering Lead ratification.
 */
export async function emitFormsVariantWinnerPromoted(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    variantId: FormVariantId;
    deploymentId: FormDeploymentId;
    sampleSize: number;
    pValue: number;
    rationale: string;
    retiredLoserIds: FormVariantId[];
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(formsAuditPlaceholder('forms_variant_winner_promoted'), 'B', {
      tenant_id: args.tenantId,
      actor_type: 'operator',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: null, // platform-scope event
      country_of_care: args.countryOfCare,
      resource_type: 'form_variant',
      resource_id: args.variantId,
      detail: {
        variant_id: args.variantId,
        deployment_id: args.deploymentId,
        sample_size: args.sampleSize,
        p_value: args.pValue,
        rationale: args.rationale,
        retired_loser_ids: args.retiredLoserIds,
      },
    }),
    tx,
  );
}

/**
 * Emit a `forms_variant_retired` audit when a sibling variant is retired
 * as part of a winner-promotion (Slice PRD §14.5 — losers retire when a
 * winner is promoted). Category B, admin-scope, target_patient_id null.
 *
 * One audit row per retired loser so each retirement is independently
 * attributable in the audit chain.
 */
export async function emitFormsVariantRetired(
  args: {
    tenantId: TenantId;
    actorId: string;
    actorTenantId: string;
    countryOfCare: string;
    variantId: FormVariantId;
    deploymentId: FormDeploymentId;
    rationale: string;
    promotedWinnerId: FormVariantId;
  },
  tx: AuditDbClient,
): Promise<AuditEnvelope> {
  return emitAudit(
    buildEnvelope(formsAuditPlaceholder('forms_variant_retired'), 'B', {
      tenant_id: args.tenantId,
      actor_type: 'operator',
      actor_id: args.actorId,
      actor_tenant_id: args.actorTenantId,
      target_patient_id: null, // platform-scope event
      country_of_care: args.countryOfCare,
      resource_type: 'form_variant',
      resource_id: args.variantId,
      detail: {
        variant_id: args.variantId,
        deployment_id: args.deploymentId,
        rationale: args.rationale,
        promoted_winner_id: args.promotedWinnerId,
        retired_as_part_of: 'winner_promotion',
      },
    }),
    tx,
  );
}
