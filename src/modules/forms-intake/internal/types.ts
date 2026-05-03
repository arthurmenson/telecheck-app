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

/**
 * FormTemplate projection without the four JSONB layer payloads. Returned
 * by `GET /v0/forms/templates` (list) so a tenant with many large templates
 * can't turn the list endpoint into a DoS vector by forcing every request
 * to allocate, serialize, and ship megabytes of layer payloads (Codex
 * forms-admin-r1 MEDIUM closure 2026-05-03). Detail (`GET /v0/forms/
 * templates/:templateId`) returns the full FormTemplate.
 */
export interface FormTemplateSummary {
  template_id: FormTemplateId;
  tenant_id: TenantId;
  program_id: ProgramCatalogEntryId;
  country_of_care: 'US' | 'GH';
  template_version: number;
  status: FormLifecycleStatus;
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
/**
 * forms_snapshot row shape — aligned 1:1 with migration 006 §TABLE 4
 * (Codex snapshot-r1 schema-mismatch closure 2026-05-03). The prior scaffold
 * had `captured_at` which doesn't exist (migration uses `created_at`) and
 * was missing `template_version` (the integer that pins which template
 * version was rendered alongside the JSONB `presented_content`).
 *
 * Append-only per migration: `REVOKE UPDATE ON forms_snapshot FROM PUBLIC`
 * + `REVOKE DELETE ON forms_snapshot FROM PUBLIC`. No `updated_at` or
 * `deleted_at` columns by design — snapshots never change.
 */
export interface FormSnapshot {
  snapshot_id: FormSnapshotId;
  tenant_id: TenantId;
  submission_id: FormSubmissionId; // composite FK (tenant_id, submission_id) → forms_submission
  template_id: FormTemplateId; // composite FK (tenant_id, template_id) → forms_template
  template_version: number; // pins which template version was rendered (>= 1)
  presented_content: unknown; // full rendered template + branching + L4 governance + CCR keys + research_consent_text_version per FORMS_ENGINE v5.2
  created_at: string;
}

/**
 * forms_variant row shape — aligned 1:1 with migration 006 columns
 * (Codex variants-r0 alignment 2026-05-03; the prior scaffold type used
 * `parent_version_id` + `traffic_split_percent` which don't exist in the
 * actual table).
 *
 * Per migration 006 §TABLE 5: variants are scoped to a (tenant_id,
 * deployment_id) tuple. Each variant arm is backed by an independent
 * forms_template (the `variant_template_id`) — Pattern A versioning
 * means a variant gets its own template row rather than referencing a
 * "version" of the parent. The Control variant uses the same
 * variant_template_id as the deployment's primary template; A/B/C/D
 * variants point at modified templates the tenant admin authored
 * separately (visual-builder slice scope).
 */
export interface FormVariant {
  variant_id: FormVariantId;
  tenant_id: TenantId;
  deployment_id: FormDeploymentId;
  variant_label: 'control' | 'A' | 'B' | 'C' | 'D';
  variant_template_id: FormTemplateId;
  traffic_percent: number; // 0..100
  posthog_flag_key: string | null;
  status: 'active' | 'retired' | 'winner';
  created_by: string;
  retired_by: string | null;
  retired_reason: string | null;
  created_at: string;
  updated_at: string;
  retired_at: string | null;
}

/**
 * forms_resume_state row shape — aligned 1:1 with migration 006.
 *
 * **Key migration vs. spec gaps (flagged 2026-05-03):**
 *
 *   1. The migration does NOT carry a `submission_id` column — resume_state
 *      binds to a `(tenant_id, deployment_id, patient_id | device_anonymous_token)`
 *      tuple, not to a specific submission. Mapping to an in-progress
 *      `forms_submission` for restoration is a service-layer concern that
 *      depends on whether the deployment changed since pause (slice §8.3).
 *
 *   2. The migration does NOT carry a `resume_token` or `resume_token_hash`
 *      column. The patient-held "resume token" is materialised at the service
 *      layer as a self-contained HMAC envelope (see
 *      `internal/services/resume-token.ts`). Tokens encode the row's primary
 *      key + tenant + expiry; the row itself is fetched by primary key under
 *      RLS once the token verifies.
 *
 * Both gaps are captured as SPEC ISSUEs per EHBG §12 in the module README;
 * they are NOT suppressed here. Callers that need the (resume_state ↔ submission)
 * binding must derive it via `(tenant_id, deployment_id, patient_id, status='in_progress')`
 * on `forms_submission` once the pause/write side is implemented.
 */
export interface ResumeState {
  resume_state_id: ResumeStateId;
  tenant_id: TenantId;
  patient_id: PatientId | null;
  device_anonymous_token: string | null;
  deployment_id: FormDeploymentId;
  variant_id: FormVariantId | null;
  // Encrypted at rest per ADR-024 KMS; service layer decrypts via lib/kms.ts.
  // Not surfaced through metadata-only read paths.
  encrypted_partial_responses: Buffer;
  current_section_index: number;
  progress_percent: number;
  status: 'active' | 'completed' | 'expired';
  expires_at: string;
  created_at: string;
  updated_at: string;
  last_saved_at: string;
  resumed_at: string | null;
}

/**
 * Patient-app metadata view of a resume_state row — what the dashboard
 * surfaces ("[N]% complete · Resume") without decrypting partial responses.
 *
 * **No `tenant_id`** (Codex resume-r1 MEDIUM closure 2026-05-03): per
 * Master PRD v1.10 §17 + Glossary v5.2 C3 brand-structure rules, internal
 * operating-tenant identifiers (`tenant.id` like `Telecheck-US`) MUST NOT
 * render in patient-facing API responses. The patient surface uses
 * `tenant.consumer_dba` (e.g., "Heros Health") when brand context is
 * needed, never the operating-tenant id. Even if the UI hides the field,
 * shipping it in the patient API makes the internal id part of the public
 * contract.
 */
export interface ResumeStateMetadata {
  resume_state_id: ResumeStateId;
  deployment_id: FormDeploymentId;
  current_section_index: number;
  progress_percent: number;
  status: 'active' | 'completed' | 'expired';
  expires_at: string;
  last_saved_at: string;
}
