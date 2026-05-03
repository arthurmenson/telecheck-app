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

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import {
  emitFormsDeploymentCreated as emitFormsDeploymentCreatedAudit,
  emitFormsDeploymentRetired as emitFormsDeploymentRetiredAudit,
  emitFormsTemplateCreated as emitFormsTemplateCreatedAudit,
  emitFormsTemplateVersionPublished as emitFormsTemplateVersionPublishedAudit,
} from '../../audit.js';
import {
  emitFormsDeploymentCreated as emitFormsDeploymentCreatedEvent,
  emitFormsDeploymentRetired as emitFormsDeploymentRetiredEvent,
  emitFormsTemplateCreated as emitFormsTemplateCreatedEvent,
  emitFormsTemplateVersionPublished as emitFormsTemplateVersionPublishedEvent,
} from '../../events.js';
import type {
  CreateDeploymentRequest,
  CreateTemplateRequest,
  PublishVersionRequest,
} from '../../schemas.js';
import * as submissionRepo from '../repositories/submission-repo.js';
import * as templateRepo from '../repositories/template-repo.js';
import type {
  FormDeployment,
  FormDeploymentId,
  FormTemplate,
  FormTemplateId,
  FormTemplateSummary,
} from '../types.js';

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
  externalTx?: DbTransaction,
): Promise<FormTemplate> {
  return templateRepo.createDraftTemplate(
    ctx.tenantId,
    {
      programId: input.programCatalogEntryId,
      countryOfCare: ctx.countryOfCare,
      name: input.name,
      // The actorId resolved by the handler is the authoring tenant_user_id
      // and lands in the NOT NULL `created_by` column. Once the Identity
      // slice replaces the header shim with real session resolution,
      // actorId will be a validated ULID by construction.
      createdBy: actorId,
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
    externalTx,
  );
}

/**
 * Sentinel error code thrown by `publishVersion` when the four governance
 * pre-publish gates aren't implemented yet AND the deployment hasn't
 * explicitly opted into the gate-bypass via the env flag.
 *
 * Per Codex publishVersion-r1 CRITICAL closure 2026-05-03: the gates
 * (I-030 static analysis, MarketingCopy resolution, Mode 2 contract,
 * L3 dual-control) ARE the safety floor for publishing. Until they're
 * implemented, the publish path MUST fail closed in production —
 * shipping the durability + supersession plumbing without the gates
 * was a "draft becomes published with no governance" hazard. Tests +
 * local dev opt in via `FORMS_PUBLISH_GATES_BYPASS = 'unsafe-test-only'`.
 */
export const PUBLISH_GATES_NOT_IMPLEMENTED = 'forms.publish.gates_not_implemented';

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
 *
 * **Pre-publish gate scaffolding (fail-closed at this commit):**
 * The four governance gates arrive with the v1.10 governance work (I-030
 * static analyzer, MarketingCopy resolver, Mode 2 contract validator, L3
 * dual-control). At this commit, the publish path FAILS CLOSED in
 * production — without the gates, a draft with prohibited
 * `research_consent_status` dependencies, unapproved marketing copy, or
 * malformed Mode 2 contract could promote to published. The durability +
 * supersession + audit-emission pattern is implemented end-to-end so the
 * gates can slot in front without restructuring the write path.
 *
 * Bypass for local dev / integration tests:
 *   `FORMS_PUBLISH_GATES_BYPASS='unsafe-test-only'`
 * The literal string is intentionally hostile so production deployments
 * can't accidentally set it via routine env config (no `'true'` /
 * `'enabled'` typo path).
 *
 * **Sentinel-throw error contract (mirrors createDeployment):**
 *   - `forms.publish.version_not_found` — version doesn't exist in this
 *     tenant. Maps to a tenant-blind 400 (NOT 404) so we don't leak
 *     cross-tenant existence per I-025.
 *   - `forms.publish.version_not_draft` — version exists but its status
 *     is not `draft` (already published, superseded, or archived).
 *     I-013 immutability enforcement; maps to 400.
 *
 * @param ctx — tenant context resolved from the request.
 * @param actorId — operator authoring the publish action; flows into
 *                  audit envelope `actor_id` + domain-event payload.
 * @param versionId — Pattern A: each row of forms_template IS a version,
 *                    so the URL's `:versionId` segment maps directly to
 *                    `forms_template.template_id`. The handler also
 *                    receives `:templateId` from the path for REST
 *                    symmetry; it's currently unused at the service
 *                    layer (no separate template-family identity exists
 *                    in the data model yet — see SPEC ISSUE in routes.ts).
 * @param input — PublishVersionRequest body (just optional change notes
 *                at scaffold; the Tenant Clinical Lead sign-off arrives
 *                via the consent module + the audit chain, not this body).
 */
export async function publishVersion(
  ctx: TenantContext,
  actorId: string,
  versionId: FormTemplateId,
  input: PublishVersionRequest,
  externalTx?: DbTransaction,
): Promise<FormTemplate> {
  // FAIL-CLOSED gate per Codex publishVersion-r1 CRITICAL closure
  // (2026-05-03). Until the four governance gates below are implemented,
  // publishing in production is unsafe — a draft with prohibited
  // research_consent_status dependencies, unapproved marketing copy, or
  // malformed Mode 2 contract could promote to published.
  //
  // The bypass env value is intentionally a hostile sentinel string
  // ('unsafe-test-only') so a routine env config typo can't accidentally
  // open the gate in production. Even with NODE_ENV=test, the bypass
  // must be explicit.
  const gateBypass = process.env['FORMS_PUBLISH_GATES_BYPASS'];
  if (gateBypass !== 'unsafe-test-only') {
    throw new Error(PUBLISH_GATES_NOT_IMPLEMENTED);
  }

  // TODO (deferred — v1.10 governance work):
  //   1. Run six-category I-030 static analyzer over presentation_content +
  //      branching_logic + eligibility_logic + approval_governance for any
  //      reference to research_consent_status. Reject publish on any hit.
  //   2. Walk presentation_content for molecule-level L1 references; for each
  //      MarketingCopy id, verify the entity exists in `approved` status.
  //      Reject publish on any unapproved reference.
  //   3. Walk approval_governance for Mode 2 contract assertions; reject if
  //      contract validator flags any field.
  //   4. Verify L3 dual-control: the calling actor MUST NOT be the same
  //      operator who authored any pending eligibility-logic change. Cross-
  //      check against the audit chain.
  // All four gates land here — before the repo delegate — so a gate
  // failure aborts before any DB write. When they land, the FAIL-CLOSED
  // env check above can be removed (the gates themselves become the
  // safety floor); until then it's the only thing keeping publish from
  // shipping unsafe drafts.

  return templateRepo.publishVersion(
    ctx.tenantId,
    versionId,
    async (tx, published, supersededVersionId) => {
      // Capture the audit envelope so we can thread its audit_id into the
      // domain event — without that correlation a subscriber can't prove
      // the wire-side event corresponds to the immutable Category B audit
      // record (Codex publishVersion-r1 HIGH closure 2026-05-03).
      const auditEnvelope = await emitFormsTemplateVersionPublishedAudit(
        {
          tenantId: ctx.tenantId,
          actorId,
          actorTenantId: ctx.tenantId,
          countryOfCare: ctx.countryOfCare,
          templateId: published.template_id,
          versionId: published.template_id, // Pattern A: version IS the template row
          programId: published.program_id,
          templateVersion: published.template_version,
          priorPublishedVersionId: supersededVersionId,
          changeNotes: input.changeNotes ?? null,
        },
        tx,
      );

      await emitFormsTemplateVersionPublishedEvent(tx, {
        tenantId: ctx.tenantId,
        templateId: published.template_id,
        versionId: published.template_id,
        programId: published.program_id,
        countryOfCare: ctx.countryOfCare,
        templateVersion: published.template_version,
        priorPublishedVersionId: supersededVersionId,
        actorId,
        changeNotes: input.changeNotes ?? null,
        auditId: auditEnvelope.audit_id,
      });
    },
    externalTx,
  );
}

/**
 * Resolve a template by ID. Returns null when not found OR when found in
 * a different tenant (tenant-blind 404 per I-025; the repository's RLS
 * binding plus the WHERE clause both enforce isolation).
 */
export async function getTemplate(
  ctx: TenantContext,
  templateId: FormTemplateId,
  externalTx?: DbClient,
): Promise<FormTemplate | null> {
  return templateRepo.findTemplateById(ctx.tenantId, templateId, externalTx);
}

/**
 * List a paginated page of templates for the active tenant. Returns
 * `FormTemplateSummary[]` (no JSONB layer payloads — see types.ts).
 * Codex forms-admin-r1 MEDIUM closure 2026-05-03: the prior unbounded
 * list was a tenant-local DoS vector for any tenant that accumulated
 * many large templates.
 *
 * Cursor is the last template_id from the prior page (keyset pagination).
 * Limit is clamped at the repo layer to LIST_TEMPLATES_MAX_LIMIT.
 */
export async function listTemplates(
  ctx: TenantContext,
  opts: { limit: number; cursor?: string | null },
  externalTx?: DbClient,
): Promise<FormTemplateSummary[]> {
  return templateRepo.listTemplatesForTenant(ctx.tenantId, opts, externalTx);
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
  const template = await templateRepo.findTemplateById(ctx.tenantId, input.templateId);
  if (template === null) {
    throw new Error('forms.deployment.template_not_found');
  }

  // Precondition 2: template must be published. Per FORMS_ENGINE v5.2
  // Pattern A, only a published version is deployable; drafts and
  // superseded/archived versions are not eligible.
  if (template.status !== 'published') {
    throw new Error('forms.deployment.template_not_published');
  }

  // The repo uses INSERT ... SELECT with status='published' in the predicate
  // so the precondition is re-verified atomically with the INSERT — closing
  // the TOCTOU race where a concurrent supersession could fire between this
  // service-layer check and the actual write. The pre-check above is for
  // clean error mapping (distinguishing not_found vs not_published); the
  // repo's atomic check is the correctness guarantee.
  try {
    return await submissionRepo.createActiveDeployment(
      ctx.tenantId,
      {
        templateId: input.templateId,
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
  } catch (err) {
    // The repo throws DEPLOYMENT_TEMPLATE_PRECONDITION_FAILED when its
    // INSERT...SELECT predicate filters out the template (TOCTOU race
    // between our service-layer pre-check and the atomic INSERT). Map
    // back to the canonical service-layer error so the handler maps it
    // to a tenant-blind 400 the same as the pre-check failures.
    if (
      err instanceof Error &&
      err.message === submissionRepo.DEPLOYMENT_TEMPLATE_PRECONDITION_FAILED
    ) {
      throw new Error('forms.deployment.template_not_published');
    }
    throw err;
  }
}

/**
 * Resolve a deployment by ID. Returns null when not found OR when found in
 * a different tenant (tenant-blind 404 per I-025; the repository's RLS
 * binding plus the WHERE clause both enforce isolation).
 */
export async function getDeployment(
  ctx: TenantContext,
  deploymentId: FormDeploymentId,
  externalTx?: DbClient,
): Promise<FormDeployment | null> {
  return submissionRepo.findDeploymentById(ctx.tenantId, deploymentId, externalTx);
}

/**
 * Retire an active deployment. Per Slice PRD §6.2 supersession discipline +
 * Pattern A immutability, retirement does not halt in-progress submissions
 * on this deployment's template version — those continue to completion.
 * The deployment row stays in the table (audit trail per I-013); the
 * `retired_at IS NULL` predicate in `findActiveDeployment` filters it out
 * for new intakes.
 *
 * Sentinel errors thrown:
 *   - `forms.deployment.not_found` — deployment doesn't exist in this
 *     tenant. Tenant-blind per I-025.
 *   - `forms.deployment.already_retired` — exists, but `retired_at` is
 *     already populated. Idempotency-respecting clients SHOULD treat this
 *     as a no-op rather than an error; the handler still maps it to 400
 *     with the canonical code so observability can distinguish.
 *
 * **Spec issue (per submission-repo.retireDeployment header):** the slice
 * PRD + Contracts Pack do not enumerate the deployment retire transition,
 * audit action, or domain event. Engineering Lead amendment pending per
 * EHBG §12 SI/DSI escalation.
 */
export async function retireDeployment(
  ctx: TenantContext,
  actorId: string,
  deploymentId: FormDeploymentId,
  externalTx?: DbTransaction,
): Promise<FormDeployment> {
  return submissionRepo.retireDeployment(
    ctx.tenantId,
    deploymentId,
    async (tx, retired) => {
      // Capture audit envelope; thread audit_id into the domain event for
      // correlation per the publishVersion-r1 HIGH closure pattern.
      const auditEnvelope = await emitFormsDeploymentRetiredAudit(
        {
          tenantId: ctx.tenantId,
          actorId,
          actorTenantId: ctx.tenantId,
          countryOfCare: ctx.countryOfCare,
          deploymentId: retired.deployment_id,
          templateId: retired.template_id,
          programId: retired.program_id,
          retiredAt: retired.retired_at ?? new Date().toISOString(),
        },
        tx,
      );

      await emitFormsDeploymentRetiredEvent(tx, {
        tenantId: ctx.tenantId,
        deploymentId: retired.deployment_id,
        templateId: retired.template_id,
        programId: retired.program_id,
        countryOfCare: ctx.countryOfCare,
        actorId,
        auditId: auditEnvelope.audit_id,
      });
    },
    externalTx,
  );
}
