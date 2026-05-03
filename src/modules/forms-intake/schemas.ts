/**
 * forms-intake/schemas.ts — Zod request/response schemas.
 *
 * SCAFFOLD scope: top-level request/response shells with `z.unknown()` /
 * `z.record(z.unknown())` for nested four-layer payloads. Future commits
 * tighten these as the visual builder + admin authoring slices land.
 *
 * Spec references:
 *   - Forms/Intake Engine Slice PRD v2.1 §4 (template element model)
 *   - Forms/Intake Engine Slice PRD v2.1 §7 (endpoint surface — derived; OpenAPI v0.2 does not enumerate forms endpoints — see SPEC ISSUE in routes.ts)
 *   - Contracts Pack v5.2 FORMS_ENGINE (four-layer architecture)
 *   - ERROR_MODEL v5.1 (canonical error envelope handled at lib/error-envelope.ts;
 *     this module raises typed errors that the envelope plugin serializes)
 *
 * SPEC ISSUE: OpenAPI v0.2 lacks explicit `/v0/forms/*` endpoint definitions.
 * The slice PRD v2.1 references endpoint behavior (templates, deployments,
 * submissions, variants, resume) but no canonical paths are listed. Filing
 * this in routes.ts as well so engineering escalation per EHBG §12 is
 * captured at the surface where it matters most.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Path parameter schemas
// ---------------------------------------------------------------------------

export const TemplateIdParamSchema = z.object({
  templateId: z.string().min(1),
});

export const VersionIdParamSchema = z.object({
  versionId: z.string().min(1),
});

export const DeploymentIdParamSchema = z.object({
  deploymentId: z.string().min(1),
});

export const SubmissionIdParamSchema = z.object({
  submissionId: z.string().min(1),
});

export const VariantIdParamSchema = z.object({
  variantId: z.string().min(1),
});

export const ResumeTokenParamSchema = z.object({
  resumeToken: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Template + version request bodies
// ---------------------------------------------------------------------------

/**
 * CreateTemplateRequest — tenant admin creates a new template (draft only).
 * Per FORMS_ENGINE §Form versioning, deployment is a separate step gated
 * by Tenant Clinical Lead approval for clinical-field changes.
 */
export const CreateTemplateRequestSchema = z.object({
  programCatalogEntryId: z.string().min(1),
  name: z.string().min(1).max(200),
  // Four-layer payload — `z.unknown()` at scaffold; tighten with explicit
  // L1/L2/L3/L4 schemas once visual-builder slice authors them.
  layout: z.unknown(),
  branchingLogic: z.unknown(),
  eligibilityLogic: z.unknown(),
  approvalGovernance: z.unknown(),
});

export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequestSchema>;

export const PublishVersionRequestSchema = z.object({
  // Tenant Clinical Lead sign-off captured separately via consent/audit
  // chain — this body is just the publish trigger metadata.
  changeNotes: z.string().max(2000).optional(),
});

export type PublishVersionRequest = z.infer<typeof PublishVersionRequestSchema>;

// ---------------------------------------------------------------------------
// Deployment request bodies
// ---------------------------------------------------------------------------

/**
 * CreateDeploymentRequest — tenant admin deploys a published template version
 * to a program market. Per FORMS_ENGINE v5.2 Pattern A, only `published`-
 * status templates may be deployed; the deployment binds a (tenant, template,
 * country_of_care) trio (template carries program_id + template_version
 * inline post-CDM-§4.1 alignment).
 *
 * (Updated v0.2 patch 2026-05-02: removed legacy versionId + programMarket
 * PolicyId fields per the post-types.ts-alignment shape — template now
 * carries version + program inline; deployment just references the template.)
 */
export const CreateDeploymentRequestSchema = z.object({
  templateId: z.string().min(1),
});

export type CreateDeploymentRequest = z.infer<typeof CreateDeploymentRequestSchema>;

// ---------------------------------------------------------------------------
// Submission request bodies
// ---------------------------------------------------------------------------

/**
 * StartSubmissionRequest — patient or delegate begins an intake against a
 * specific deployment. The engine resolves the active variant per the A/B
 * traffic split (per Slice PRD §14.2 — sticky per patient).
 */
export const StartSubmissionRequestSchema = z.object({
  deploymentId: z.string().min(1),
  // Optional pre-account device token for anonymous resume per Slice PRD §8.2.
  deviceAnonymousToken: z.string().optional(),
});

export type StartSubmissionRequest = z.infer<typeof StartSubmissionRequestSchema>;

/**
 * UpdateSubmissionResponsesRequest — partial-progress save (auto-save or
 * explicit save). Engine MUST persist atomically per Slice PRD §8.1.
 */
export const UpdateSubmissionResponsesRequestSchema = z.object({
  responses: z.record(z.unknown()),
  // Indicates whether the patient explicitly clicked "Save and continue
  // later" (Slice PRD §8.2). Drives ResumeState creation + recovery touches.
  pause: z.boolean().optional(),
});

export type UpdateSubmissionResponsesRequest = z.infer<
  typeof UpdateSubmissionResponsesRequestSchema
>;

export const SubmitSubmissionRequestSchema = z.object({
  // Final submission — engine snapshots the rendered form and runs
  // eligibility logic. Body is structurally a confirmation; the responses
  // were already persisted via the update endpoint.
  attestation: z
    .object({
      acceptedTerms: z.boolean(),
      acceptedPrivacy: z.boolean(),
    })
    .optional(),
});

export type SubmitSubmissionRequest = z.infer<typeof SubmitSubmissionRequestSchema>;

// ---------------------------------------------------------------------------
// Variant request bodies
// ---------------------------------------------------------------------------

/**
 * CreateVariantRequest — tenant admin creates an A/B variant of a deployed
 * template.
 *
 * Aligned to migration 006 §TABLE 5 columns 2026-05-03:
 *   - `deploymentId` — which deployment this variant binds to (required).
 *   - `variantTemplateId` — the template that backs this variant arm. The
 *     Control variant uses the deployment's primary template; A/B/C/D
 *     variants point at separately-authored modified templates. Composite
 *     FK at the DB layer enforces tenant alignment (variant_template_id
 *     must belong to the same tenant as the variant's deployment).
 *   - `label` — control / A / B / C / D (one Control + 1–4 alternatives
 *     per Slice PRD §14.1; UNIQUE per deployment at the DB layer).
 *   - `trafficPercent` — 0..100. Sum across all active variants for a
 *     deployment SHOULD equal 100; enforced at the application layer
 *     (PostHog feature-flag config), not the DB.
 *
 * Removed legacy fields `templateId` + `parentVersionId` that don't exist
 * in the migration. Pattern A versioning means each variant arm gets its
 * own template row, not a "version" pointer.
 */
export const CreateVariantRequestSchema = z.object({
  deploymentId: z.string().min(1),
  variantTemplateId: z.string().min(1),
  label: z.enum(['control', 'A', 'B', 'C', 'D']),
  trafficPercent: z.number().int().min(0).max(100),
});

export type CreateVariantRequest = z.infer<typeof CreateVariantRequestSchema>;

export const PromoteVariantRequestSchema = z.object({
  // Tenant admin promotes an A/B-test winner to new Control. Per Slice PRD
  // §14.5 the engine retires losing variants and lets in-progress
  // submissions finish on their assigned variant.
  rationale: z.string().min(1).max(2000),
  sampleSize: z.number().int().nonnegative(),
  pValue: z.number().nonnegative(),
});

export type PromoteVariantRequest = z.infer<typeof PromoteVariantRequestSchema>;

// ---------------------------------------------------------------------------
// Resume request bodies
// ---------------------------------------------------------------------------

export const ResumeSubmissionRequestSchema = z.object({
  resumeToken: z.string().min(1),
});

export type ResumeSubmissionRequest = z.infer<typeof ResumeSubmissionRequestSchema>;

// ---------------------------------------------------------------------------
// Response shells (kept as `z.unknown()` placeholders so future tightening
// happens behind the public interface without breaking the route signature)
// ---------------------------------------------------------------------------

export const TemplateResponseSchema = z.unknown();
export const VersionResponseSchema = z.unknown();
export const DeploymentResponseSchema = z.unknown();
export const SubmissionResponseSchema = z.unknown();
export const VariantResponseSchema = z.unknown();
export const ResumeStateResponseSchema = z.unknown();
