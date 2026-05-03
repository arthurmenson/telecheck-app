/**
 * forms-intake/internal/types.ts — module-private types.
 *
 * These types are internal to the forms-intake module. They MUST NOT be
 * re-exported from the module's public `index.ts` — cross-module consumers
 * use the public interface in `index.ts` instead.
 *
 * Spec references:
 *   - Forms/Intake Engine Slice PRD v2.1 §4 (four-layer + variant + resume state)
 *   - Contracts Pack v5.2 FORMS_ENGINE (canonical four-layer architecture)
 *   - Forms/Intake Engine Slice PRD v2.1 §25 (v1.10 cycle additions)
 *
 * Notes on naming: per GLOSSARY v5.2 we use `medication_request` (not
 * `prescription`) anywhere a medication entity surfaces. ESLint id-denylist
 * blocks regressions at typecheck time.
 */

import type { TenantId } from '../../../lib/glossary.js';

// ---------------------------------------------------------------------------
// Common ID alias types (string IDs at this scaffold; tighten to brand types
// once the corresponding TYPES v5.2 ID prefixes are wired into glossary.ts).
// ---------------------------------------------------------------------------

export type FormTemplateId = string; // expected prefix `frt_`
export type FormVersionId = string; // expected prefix `frv_`
export type FormDeploymentId = string; // expected prefix `frd_`
export type FormSubmissionId = string; // expected prefix `sub_` (per slice PRD §17.1)
export type FormSnapshotId = string; // expected prefix `frs_`
export type FormVariantId = string; // expected prefix `frvar_`
export type ResumeStateId = string; // expected prefix `frrs_`
export type ProgramCatalogEntryId = string; // expected prefix `pce_` (per Master PRD v1.10 §10.5)
export type ProgramMarketPolicyId = string; // expected prefix `pmp_`
export type PatientId = string; // expected prefix `pat_`

// ---------------------------------------------------------------------------
// Four-layer entity skeletons (per FORMS_ENGINE v5.2 + Slice PRD v2.1 §4)
// ---------------------------------------------------------------------------

export type FormLifecycleStatus = 'draft' | 'published' | 'superseded' | 'archived';
export type SubmissionStatus =
  | 'in_progress'
  | 'paused'
  | 'submitted'
  | 'ai_evaluated'
  | 'physician_reviewed'
  | 'approved'
  | 'declined'
  | 'abandoned';

export interface FormTemplate {
  id: FormTemplateId;
  tenant_id: TenantId;
  program_catalog_entry_id: ProgramCatalogEntryId;
  name: string;
  current_version_id: FormVersionId | null;
  created_at: string;
  updated_at: string;
}

export interface FormVersion {
  id: FormVersionId;
  template_id: FormTemplateId;
  tenant_id: TenantId;
  version_number: number;
  status: FormLifecycleStatus;
  // The four-layer payload — at this scaffold, opaque JSON. Layer-specific
  // typing is added when the Admin Backend slice authors the visual builder.
  layout: unknown; // L1: presentation_content
  branching_logic: unknown; // L2: branching_logic
  eligibility_logic: unknown; // L3: eligibility_logic — clinical safety
  approval_governance: unknown; // L4: approval_governance — pricing/market gates
  published_at: string | null;
  created_at: string;
}

export interface FormDeployment {
  id: FormDeploymentId;
  tenant_id: TenantId;
  template_id: FormTemplateId;
  version_id: FormVersionId;
  program_market_policy_id: ProgramMarketPolicyId;
  status: 'active' | 'retired';
  deployed_at: string;
  retired_at: string | null;
}

export interface FormSubmission {
  id: FormSubmissionId;
  tenant_id: TenantId;
  deployment_id: FormDeploymentId;
  version_id: FormVersionId;
  variant_id: FormVariantId | null;
  patient_id: PatientId | null; // null when pre-account device-anonymous
  status: SubmissionStatus;
  responses: Record<string, unknown>;
  started_at: string;
  submitted_at: string | null;
}

/**
 * Snapshot — immutable record of EXACTLY what the patient saw at submission
 * time. Per FORMS_ENGINE v5.2 §Form versioning + Slice PRD v2.1 §4 this is
 * the audit-anchor for "what content/branching/copy did the patient interact
 * with". Snapshots are append-only.
 */
export interface FormSnapshot {
  id: FormSnapshotId;
  tenant_id: TenantId;
  submission_id: FormSubmissionId;
  version_id: FormVersionId;
  rendered_layout: unknown;
  rendered_branching: unknown;
  rendered_eligibility: unknown;
  rendered_approval_governance: unknown;
  ccr_resolution_pack: unknown; // CCR keys resolved at render time
  created_at: string;
}

export interface FormVariant {
  id: FormVariantId;
  tenant_id: TenantId;
  template_id: FormTemplateId;
  parent_version_id: FormVersionId;
  label: 'control' | 'A' | 'B' | 'C' | 'D';
  traffic_split_percent: number; // 0..100
  status: 'active' | 'retired' | 'winner_promoted';
  created_at: string;
}

export interface ResumeState {
  id: ResumeStateId;
  tenant_id: TenantId;
  submission_id: FormSubmissionId;
  patient_id: PatientId | null;
  resume_token: string; // opaque; encrypted at rest per ADR-024 KMS
  expires_at: string;
  paused_at: string;
}
