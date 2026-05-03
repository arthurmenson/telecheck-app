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

/**
 * Domain types — aligned 1:1 with migration 006 column names per Codex
 * slice-scaffold-verify-r2 MEDIUM finding closure (2026-05-02). The prior
 * scaffold types used legacy field names (`id`, `version_id`,
 * `program_catalog_entry_id`, etc.) that did not match the canonical
 * schema. `client.query<T>` is only a TypeScript assertion — handlers
 * consuming these types must see the actual DB column shape.
 */
export interface FormTemplate {
  template_id: FormTemplateId;
  tenant_id: TenantId;
  program_id: ProgramCatalogEntryId; // mirrors forms_template.program_id
  country_of_care: 'US' | 'GH'; // ISO 3166-1 alpha-2 per CDM §4.1
  template_version: number; // monotonic per (tenant, program, country) per Pattern A
  status: FormLifecycleStatus;
  // Four FORMS_ENGINE v5.2 functional layers stored as JSONB.
  presentation_content: unknown; // L1
  branching_logic: unknown; // L2
  eligibility_logic: unknown; // L3 — clinical safety
  approval_governance: unknown; // L4 — pricing/market gates
  created_at: string;
  updated_at: string;
}

export interface FormDeployment {
  deployment_id: FormDeploymentId;
  tenant_id: TenantId;
  template_id: FormTemplateId; // composite FK (tenant_id, template_id) → forms_template
  program_id: ProgramCatalogEntryId;
  deployed_at: string;
  retired_at: string | null; // NULL = currently active (no separate `status` column)
}

export interface FormSubmission {
  submission_id: FormSubmissionId;
  tenant_id: TenantId;
  deployment_id: FormDeploymentId; // composite FK (tenant_id, deployment_id) → forms_deployment
  variant_id: FormVariantId | null; // triple-composite FK (tenant_id, deployment_id, variant_id) → forms_variant when set
  patient_id: PatientId | null; // null when pre-account device-anonymous
  delegate_id: string | null; // delegate context per slice PRD §3
  status: SubmissionStatus;
  responses: Record<string, unknown>; // dynamic per template_version; reconstruction via snapshot
  started_at: string;
  submitted_at: string | null;
}

/**
 * Snapshot — immutable record of EXACTLY what the patient saw at submission
 * time. Per FORMS_ENGINE v5.2 §Form versioning + Slice PRD v2.1 §4 this is
 * the audit-anchor for "what content/branching/copy did the patient interact
 * with". Snapshots are append-only (REVOKE UPDATE/DELETE FROM PUBLIC + raise-
 * exception trigger per migration 006).
 */
export interface FormSnapshot {
  snapshot_id: FormSnapshotId;
  tenant_id: TenantId;
  submission_id: FormSubmissionId; // composite FK (tenant_id, submission_id) → forms_submission
  template_id: FormTemplateId; // composite FK (tenant_id, template_id) → forms_template
  presented_content: unknown; // full rendered template + branching + L4 governance + CCR keys + research_consent_text_version per FORMS_ENGINE v5.2
  captured_at: string;
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
