/**
 * forms-intake/internal/services/template-service.ts — template + version business logic.
 *
 * Owns:
 *   - Authoring lifecycle (draft → published → superseded → archived) per
 *     FORMS_ENGINE v5.2 §Form versioning + Pattern A immutability.
 *   - Layer-3 (eligibility) clinical-safety dual control per I-015.
 *   - Layer-4 publish-time governance checks per Slice PRD §25.1
 *     (molecule-level marketing copy resolution to approved `MarketingCopy`)
 *     and §25.3 (six-category I-030 static analysis on
 *     `research_data_use_consent_block`).
 *
 * Spec references:
 *   - FORMS_ENGINE v5.2 §Four-layer architecture
 *   - FORMS_ENGINE v5.2 §Research consent integration (I-030 enforcement)
 *   - Slice PRD v2.1 §6 (visual builder)
 *   - Slice PRD v2.1 §25.1 / §25.3 / §25.4 (v1.10 cycle additions)
 *   - INVARIANT I-013 published-version immutability
 *   - INVARIANT I-015 dual-control on Layer 3
 *   - INVARIANT I-030 (no care-touching dependency on `research_consent_status`)
 */

import type { TenantContext } from '../../../../lib/tenant-context.js';

import {
  emitFormsDeploymentCreated as emitFormsDeploymentCreatedAudit,
  emitFormsTemplateCreated as emitFormsTemplateCreatedAudit,
} from '../../audit.js';
import {
  emitFormsDeploymentCreated as emitFormsDeploymentCreatedEvent,
  emitFormsTemplateCreated as emitFormsTemplateCreatedEvent,
} from '../../events.js';
import type {
  CreateDeploymentRequest,
  CreateTemplateRequest,
  PublishVersionRequest,
} from '../../schemas.js';
import * as submissionRepo from '../repositories/submission-repo.js';
import * as templateRepo from '../repositories/template-repo.js';
import type { FormDeployment, FormTemplate, FormTemplateId } from '../types.js';

/**
 * Create a draft template under the active tenant context. Returns the
 * fully-populated FormTemplate row.
 *
 * Atomicity (per I-003 + I-016 + same-tx outbox): the template INSERT,
 * the audit emission, and the domain event INSERT all run in the same
 * transaction the repository opens. If audit OR domain event fails, the
 * template INSERT rolls back too — there is no observable state where
 * the template exists without paired audit + event records.
 *
 * TODO (deferred): validate input.programId resolves to an active
 * ProgramCatalogEntry per Master PRD v1.10 §10.5 Layer 1. The
 * ProgramCatalog repository doesn't exist yet (separate slice); this
 * service currently trusts the caller's programId. When the program
 * catalog slice lands, add the lookup as the first step here so an
 * invalid program rejects with 400 before the INSERT.
 */
export async function createDraftTemplate(
  ctx: TenantContext,
  actorId: string,
  input: CreateTemplateRequest,
): Promise<FormTemplate> {
  return templateRepo.createDraftTemplate(
    ctx.tenantId,
    {
      programId: input.programCatalogEntryId,
      countryOfCare: ctx.countryOfCare,
      presentationContent: input.layout,
      branchingLogic: input.branchingLogic,
      eligibilityLogic: input.eligibilityLogic,
      approvalGovernance: input.approvalGovernance,
    },
    async (tx, template) => {
      // Audit FIRST so a failure here aborts the transaction before the
      // domain event INSERT (matching the pattern in foundation
      // set_break_glass_context).
      await emitFormsTemplateCreatedAudit(
        {
          tenantId: ctx.tenantId,
          actorId,
          actorTenantId: ctx.tenantId,
          countryOfCare: ctx.countryOfCare,
          templateId: template.template_id,
          programId: template.program_id,
          templateVersion: template.template_version,
        },
        tx,
      );

      // Domain event for the outbox (consumed by analytics + downstream
      // module subscribers per Slice PRD §17 handoff pattern).
      await emitFormsTemplateCreatedEvent(tx, {
        tenantId: ctx.tenantId,
        templateId: template.template_id,
        programId: template.program_id,
        countryOfCare: ctx.countryOfCare,
        templateVersion: template.template_version,
        actorId,
      });
    },
  );
}

/**
 * Publish a draft version. Pre-publish gates:
 *
 *   1. Tenant Clinical Lead approval recorded for any L3 (eligibility) edits
 *      per I-015 dual-control.
 *   2. Six-category I-030 static analysis against `research_data_use_consent_block`
 *      elements per FORMS_ENGINE v5.2 + Slice PRD §25.3 — reject publish
 *      if ANY of: branching, visibility, validation, eligibility/triage,
 *      pricing/commerce, outcome messaging depends on `research_consent_status`.
 *   3. L4 governance verification that any molecule-level L1 element resolves
 *      to a `MarketingCopy` entity in `approved` status per Slice PRD §25.1.
 *   4. Mode 2 input contract conformance per Slice PRD §10.
 *
 * On success: cascades prior published version → superseded; flips target
 * version → published; emits the corresponding governance audit + domain
 * event inside the same transaction.
 */
export async function publishVersion(
  _ctx: TenantContext,
  _actorId: string,
  _templateId: FormTemplateId,
  _input: PublishVersionRequest,
): Promise<FormTemplate> {
  // TODO: run static-analysis evaluator (six-category I-030 enforcement),
  // marketing-copy resolver, Mode 2 contract validator; on success
  // delegate to template-repo.publishVersion threading audit emission.
  throw new Error('not implemented');
}

/**
 * Resolve a template by ID. Returns null when not found OR when found in
 * a different tenant (tenant-blind 404 per I-025; the repository's RLS
 * binding plus the WHERE clause both enforce isolation).
 */
export async function getTemplate(
  _ctx: TenantContext,
  _templateId: FormTemplateId,
): Promise<FormTemplate | null> {
  throw new Error('not implemented');
}

/**
 * List all templates for the active tenant. Pagination is not implemented
 * at the scaffold layer — service signature reserves room for it.
 */
export async function listTemplates(_ctx: TenantContext): Promise<FormTemplate[]> {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------
// Deployment lifecycle (Pattern A: published-template → market deployment)
// ---------------------------------------------------------------------------

/**
 * Deploy a published template to its program's market binding.
 *
 * Cross-table precondition (enforced here at the service layer, NOT the DB):
 *   - The referenced template MUST exist in this tenant.
 *   - The template's status MUST be `published`. Drafts cannot deploy.
 *
 * Atomicity: same canonical pattern as createDraftTemplate. The deployment
 * INSERT, the audit emission, and the domain event INSERT all run in one
 * transaction. The composite FK (tenant_id, template_id) → forms_template
 * (tenant_id, template_id) makes cross-tenant binding structurally
 * impossible at write time per the slice scaffold R2 hardening.
 *
 * Throws BAD_REQUEST-equivalent errors that the handler maps to 400 via
 * the global error envelope:
 *   - 'forms.deployment.template_not_found' if the referenced template
 *     does not exist in this tenant
 *   - 'forms.deployment.template_not_published' if the template exists
 *     but its status is not 'published'
 *
 * The handler should wrap these into Fastify httpErrors.badRequest with
 * the canonical error code per ERROR_MODEL v5.1.
 */
export async function createDeployment(
  ctx: TenantContext,
  actorId: string,
  input: CreateDeploymentRequest,
): Promise<FormDeployment> {
  // Precondition 1: template must exist in this tenant.
  const template = await templateRepo.findTemplateById(
    ctx.tenantId,
    input.templateId as FormTemplateId,
  );
  if (template === null) {
    throw new Error('forms.deployment.template_not_found');
  }

  // Precondition 2: template must be published. Per FORMS_ENGINE v5.2
  // Pattern A, only a published version is deployable; drafts and
  // superseded/archived versions are not eligible.
  if (template.status !== 'published') {
    throw new Error('forms.deployment.template_not_published');
  }

  return submissionRepo.createActiveDeployment(
    ctx.tenantId,
    {
      templateId: input.templateId as FormTemplateId,
      programId: template.program_id,
    },
    async (tx, deployment) => {
      await emitFormsDeploymentCreatedAudit(
        {
          tenantId: ctx.tenantId,
          actorId,
          actorTenantId: ctx.tenantId,
          countryOfCare: ctx.countryOfCare,
          deploymentId: deployment.deployment_id,
          templateId: deployment.template_id,
          programId: deployment.program_id,
        },
        tx,
      );

      await emitFormsDeploymentCreatedEvent(tx, {
        tenantId: ctx.tenantId,
        deploymentId: deployment.deployment_id,
        templateId: deployment.template_id,
        programId: deployment.program_id,
        countryOfCare: ctx.countryOfCare,
        actorId,
      });
    },
  );
}
