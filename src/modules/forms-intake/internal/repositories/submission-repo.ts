/**
 * forms-intake/internal/repositories/submission-repo.ts — Submission +
 * Deployment + Variant + ResumeState DB access.
 *
 * Tables (per migration 006_forms_intake.sql):
 *   - forms_deployments
 *   - forms_submissions
 *   - forms_variants
 *   - forms_resume_states
 *
 * RLS pattern: identical to template-repo — `withTransaction` for writes
 * that emit audit + events; `withTenantBoundConnection` for reads.
 *
 * Spec references:
 *   - Slice PRD v2.1 §4 (variant + resume state added to four-layer model)
 *   - Slice PRD v2.1 §8 (save-and-resume; tenant-scoped per §5.1)
 *   - Slice PRD v2.1 §14 (A/B testing native; sticky variant per patient)
 *   - INVARIANT I-023 (every PHI table tenant-scoped via RLS)
 */

import {
  type DbClient,
  type DbTransaction,
  withTenantBoundConnection,
  withTransaction,
} from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import { ulid } from '../../../../lib/ulid.js';

import type {
  FormDeployment,
  FormDeploymentId,
  FormSubmission,
  FormSubmissionId,
  FormVariant,
  FormVariantId,
  FormVersionId,
  PatientId,
  ResumeState,
  ResumeStateId,
  SubmissionStatus,
} from '../types.js';

// ---------------------------------------------------------------------------
// Deployment reads (cross-module-safe via index.ts public interface)
// ---------------------------------------------------------------------------

/**
 * Public-interface helper used by Pharmacy + Refill (per Slice PRD §11
 * subscription handoff dependencies). Returns the active deployment for a
 * given (tenant, program) pair so cross-module callers do not need to
 * directly query forms tables — preserves ADR-001 module boundary.
 */
export async function findActiveDeployment(
  tenantId: TenantId,
  programCatalogEntryId: string,
): Promise<FormDeployment | null> {
  return withTenantBoundConnection(tenantId, async (client: DbClient) => {
    // Aligned to migration 006 column set (Codex slice-scaffold-r1
    // MEDIUM finding closure 2026-05-02): singular table names; the
    // active-deployment semantic is retired_at IS NULL (no `status`
    // column on forms_deployment); join on the composite (tenant_id,
    // template_id) FK that the v0.2 composite-FK refactor established.
    const result = await client.query<FormDeployment>(
      `SELECT d.deployment_id, d.tenant_id, d.template_id,
              d.program_id, d.deployed_at, d.retired_at
         FROM forms_deployment d
         JOIN forms_template t
           ON t.tenant_id = d.tenant_id AND t.template_id = d.template_id
        WHERE d.tenant_id = $1
          AND t.program_id = $2
          AND d.retired_at IS NULL
        ORDER BY d.deployed_at DESC
        LIMIT 1`,
      [tenantId, programCatalogEntryId],
    );
    return result.rows[0] ?? null;
  });
}

export async function findDeploymentById(
  tenantId: TenantId,
  deploymentId: FormDeploymentId,
): Promise<FormDeployment | null> {
  return withTenantBoundConnection(tenantId, async (client: DbClient) => {
    const result = await client.query<FormDeployment>(
      `SELECT deployment_id, tenant_id, template_id, program_id,
              deployed_at, retired_at
         FROM forms_deployment
        WHERE deployment_id = $1 AND tenant_id = $2
        LIMIT 1`,
      [deploymentId, tenantId],
    );
    return result.rows[0] ?? null;
  });
}

// ---------------------------------------------------------------------------
// Deployment writes
// ---------------------------------------------------------------------------

/**
 * Sentinel error code thrown by createActiveDeployment when the
 * INSERT...SELECT predicate filters the template (because the template
 * doesn't exist OR isn't in 'published' status). The service layer's
 * pre-check normally catches both cases with nicer error mapping; this
 * sentinel covers the TOCTOU race where the template status flips
 * between the pre-check and the INSERT.
 */
export const DEPLOYMENT_TEMPLATE_PRECONDITION_FAILED =
  'forms.deployment.template_precondition_failed';

/**
 * Create an active deployment binding a published template to its program.
 *
 * **Concurrency-safe precondition (Codex handler-2 HIGH closure
 * 2026-05-02):** the prior implementation accepted programId as a
 * parameter and trusted the service-layer pre-check that the template
 * was published. Between the pre-check and the INSERT, another request
 * could supersede or archive the template, leaving an active deployment
 * pointing at a non-deployable template.
 *
 * This implementation uses INSERT ... SELECT ... WHERE so the
 * `published` status check + the program_id read happen atomically in
 * the same statement that writes the deployment row. RETURNING zero
 * rows means the predicate filtered (template missing OR status !=
 * 'published') — the service layer maps this to a tenant-blind 400.
 *
 * The composite FK (tenant_id, template_id) → forms_template (tenant_id,
 * template_id) provides the cross-tenant guarantee independently.
 *
 * Same atomicity discipline as createDraftTemplate: txCallback emits
 * audit + domain event inside the same transaction; failure rolls back
 * the INSERT.
 */
export async function createActiveDeployment(
  tenantId: TenantId,
  input: {
    templateId: FormDeploymentId;
  },
  txCallback: (tx: DbTransaction, deployment: FormDeployment) => Promise<void>,
): Promise<FormDeployment> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    const deploymentId = ulid();

    // INSERT ... SELECT pattern: the SELECT enforces both tenant-match AND
    // status='published' AT THE TIME OF THE INSERT. If another transaction
    // flipped the template's status between any prior service-layer check
    // and this statement, the SELECT returns zero rows → INSERT writes
    // nothing → RETURNING is empty → we throw the sentinel error which the
    // service layer maps to a tenant-blind 400.
    //
    // FOR UPDATE on the inner SELECT would also work but is unnecessary
    // here: the row-level lock that PostgreSQL acquires on the inserted
    // row is not what protects us — the SELECT predicate is. If a
    // concurrent UPDATE on the template runs between two such INSERTs,
    // both INSERTs see snapshot-consistent state per their own
    // transactions and either both succeed (status was still 'published'
    // for both) or one fails (the template was unpublished before the
    // second SELECT ran). Both outcomes are correct.
    const result = await tx.query<FormDeployment>(
      `INSERT INTO forms_deployment (
          deployment_id, tenant_id, template_id, program_id,
          deployed_at, retired_at
       )
       SELECT
          $1, t.tenant_id, t.template_id, t.program_id,
          NOW(), NULL
         FROM forms_template t
        WHERE t.tenant_id = $2
          AND t.template_id = $3
          AND t.status = 'published'
       RETURNING deployment_id, tenant_id, template_id, program_id,
                 deployed_at, retired_at`,
      [deploymentId, tenantId, input.templateId],
    );

    if (result.rows.length === 0) {
      // Template either doesn't exist in this tenant OR isn't published
      // (TOCTOU race or service-layer pre-check skipped). Throw the
      // sentinel; the service layer maps to a tenant-blind 400.
      throw new Error(DEPLOYMENT_TEMPLATE_PRECONDITION_FAILED);
    }

    const deployment = result.rows[0]!;
    await txCallback(tx, deployment);
    return deployment;
  });
}

// ---------------------------------------------------------------------------
// Submission writes
// ---------------------------------------------------------------------------

/**
 * Create a new submission (patient or delegate begins intake). Variant
 * assignment per Slice PRD §14.2 happens in the service layer (PostHog
 * feature-flag-driven traffic split, sticky per patient).
 *
 * Same `withTransaction` discipline as template-repo: callers MUST emit
 * audit + domain events inside the same transaction so rollback discards
 * everything.
 */
export async function createSubmission(
  _tenantId: TenantId,
  _input: {
    deploymentId: FormDeploymentId;
    versionId: FormVersionId;
    variantId: FormVariantId | null;
    patientId: PatientId | null;
    deviceAnonymousToken: string | null;
  },
  _txCallback: (tx: DbTransaction, submission: FormSubmission) => Promise<void>,
): Promise<FormSubmission> {
  void withTransaction;
  throw new Error('not implemented');
}

/**
 * Persist partial-progress responses. Auto-save (Slice PRD §8.1) calls this
 * on every field blur. Wrapped in a transaction so the response patch +
 * resume-state-touch (last-active timestamp bump) commit atomically.
 */
export async function updateSubmissionResponses(
  _tenantId: TenantId,
  _submissionId: FormSubmissionId,
  _responsePatch: Record<string, unknown>,
  _txCallback: (tx: DbTransaction) => Promise<void>,
): Promise<FormSubmission> {
  throw new Error('not implemented');
}

export async function transitionSubmissionStatus(
  _tenantId: TenantId,
  _submissionId: FormSubmissionId,
  _newStatus: SubmissionStatus,
  _txCallback: (tx: DbTransaction) => Promise<void>,
): Promise<FormSubmission> {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------
// Variant repo (A/B test infrastructure per Slice PRD §14)
// ---------------------------------------------------------------------------

export async function createVariant(
  _tenantId: TenantId,
  _input: {
    templateId: string;
    parentVersionId: FormVersionId;
    label: string;
    trafficSplitPercent: number;
  },
  _txCallback: (tx: DbTransaction, variant: FormVariant) => Promise<void>,
): Promise<FormVariant> {
  throw new Error('not implemented');
}

export async function findVariantById(
  _tenantId: TenantId,
  _variantId: FormVariantId,
): Promise<FormVariant | null> {
  // TODO: SELECT under withTenantBoundConnection.
  throw new Error('not implemented');
}

export async function promoteVariantToWinner(
  _tenantId: TenantId,
  _variantId: FormVariantId,
  _txCallback: (tx: DbTransaction) => Promise<void>,
): Promise<FormVariant> {
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------
// Resume state repo
// ---------------------------------------------------------------------------

export async function createResumeState(
  _tenantId: TenantId,
  _input: {
    submissionId: FormSubmissionId;
    patientId: PatientId | null;
    expiresAt: string;
  },
  _txCallback: (tx: DbTransaction, resumeState: ResumeState) => Promise<void>,
): Promise<ResumeState> {
  throw new Error('not implemented');
}

export async function findResumeStateByToken(
  _tenantId: TenantId,
  _resumeToken: string,
): Promise<ResumeState | null> {
  // TODO: SELECT under withTenantBoundConnection. Lookup by hashed token
  // (the raw token is encrypted at rest per ADR-024 KMS).
  throw new Error('not implemented');
}

export async function expireResumeState(
  _tenantId: TenantId,
  _resumeStateId: ResumeStateId,
  _txCallback: (tx: DbTransaction) => Promise<void>,
): Promise<void> {
  throw new Error('not implemented');
}
