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
  FormTemplateId,
  FormVariant,
  FormVariantId,
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
  externalTx?: DbClient,
): Promise<FormDeployment | null> {
  return withTenantBoundConnection(
    tenantId,
    async (client: DbClient) => {
      const result = await client.query<FormDeployment>(
        `SELECT deployment_id, tenant_id, template_id, program_id,
                deployed_at, retired_at
           FROM forms_deployment
          WHERE deployment_id = $1 AND tenant_id = $2
          LIMIT 1`,
        [deploymentId, tenantId],
      );
      return result.rows[0] ?? null;
    },
    externalTx,
  );
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
    /**
     * Tenant-user identifier for the deployment author. Required to satisfy
     * `forms_deployment.deployed_by NOT NULL` (migration 006). Codex
     * deployment-not-null-r0 closure 2026-05-04 — the prior INSERT omitted
     * this column, which CI surfaced as `null value in column "deployed_by"
     * ... violates not-null constraint` once the test-pool override
     * (commit 4fb39b7) made the actual INSERT path observable end-to-end.
     */
    deployedBy: string;
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
          deployed_by, deployed_at, retired_at
       )
       SELECT
          $1, t.tenant_id, t.template_id, t.program_id,
          $4, NOW(), NULL
         FROM forms_template t
        WHERE t.tenant_id = $2
          AND t.template_id = $3
          AND t.status = 'published'
       RETURNING deployment_id, tenant_id, template_id, program_id,
                 deployed_at, retired_at`,
      [deploymentId, tenantId, input.templateId, input.deployedBy],
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
// Deployment retire — sentinel error codes
//
// Same tenant-blind 400 mapping pattern as createActiveDeployment +
// publishVersion: the handler maps both to the canonical I-025 envelope so
// the response NEVER differentiates "doesn't exist" from "exists in another
// tenant" from "exists but already retired."
// ---------------------------------------------------------------------------

export const DEPLOYMENT_NOT_FOUND = 'forms.deployment.not_found';
export const DEPLOYMENT_ALREADY_RETIRED = 'forms.deployment.already_retired';

/**
 * Retire an active deployment. Per Slice PRD §6.2 + §14.5 supersession
 * discipline + Pattern A immutability:
 *   - In-progress submissions assigned to this deployment continue to
 *     completion against the version they were assigned at start time
 *     (no mid-flow switching, no force-stop).
 *   - The deployment row stays in the table forever (audit trail per I-013);
 *     `retired_at` IS NOT NULL is the "retired" predicate that
 *     `findActiveDeployment` filters out.
 *
 * **Spec issue (filed inline 2026-05-03 per EHBG §12 SI/DSI escalation):**
 * the spec corpus (slice PRD v2.1 + AUDIT_EVENTS / DOMAIN_EVENTS v5.2)
 * does NOT enumerate canonical state transitions, audit actions, or
 * domain events for `forms_deployment.retire`. The route is registered
 * in the scaffold so a placeholder action ID (`forms_deployment_retired`)
 * is used here, mirroring the SPEC ISSUE pattern Engineering Lead
 * approved for `forms_template_created` / `forms_template_version_published`
 * pending Contracts Pack ratification. Engineering Lead must:
 *   - Add a FormDeployment state machine (active → retired) to State
 *     Machines v1.1, OR
 *   - Confirm the `retired_at IS NULL` predicate is the canonical state
 *     model (no enum), AND
 *   - Add `forms_deployment_retired` to AUDIT_EVENTS Category B + the
 *     corresponding DOMAIN_EVENTS aggregate event.
 *
 * **Idempotency:** the UPDATE has `WHERE retired_at IS NULL`. Retiring an
 * already-retired deployment surfaces as `DEPLOYMENT_ALREADY_RETIRED`
 * via the post-UPDATE existence re-check.
 *
 * @param tenantId — caller's tenant; RLS scoped by `set_tenant_context`.
 * @param deploymentId — deployment row to retire.
 * @param txCallback — emits audit + domain event in the same transaction;
 *                     failure rolls back the retire flip.
 * @param externalTx — test-only: shares the caller's transaction handle
 *                     instead of acquiring a fresh pool connection.
 *                     Mirror of the createDraftTemplate / publishVersion
 *                     pattern from Codex publishVersion-r1 MEDIUM closure.
 */
export async function retireDeployment(
  tenantId: TenantId,
  deploymentId: FormDeploymentId,
  txCallback: (tx: DbTransaction, retired: FormDeployment) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<FormDeployment> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    const result = await tx.query<FormDeployment>(
      `UPDATE forms_deployment
          SET retired_at = NOW()
        WHERE deployment_id = $1
          AND tenant_id = $2
          AND retired_at IS NULL
       RETURNING deployment_id, tenant_id, template_id, program_id,
                 deployed_at, retired_at`,
      [deploymentId, tenantId],
    );

    if (result.rows.length === 0) {
      // Either the deployment doesn't exist in this tenant OR it's
      // already retired. Disambiguate via a tenant-bound existence
      // re-check; both branches map to a tenant-blind 400 at the
      // handler so the choice is for the operator-facing error code,
      // not the wire-out shape.
      const existence = await tx.query<{ retired_at: Date | null }>(
        `SELECT retired_at FROM forms_deployment
          WHERE deployment_id = $1 AND tenant_id = $2`,
        [deploymentId, tenantId],
      );
      if (existence.rows.length === 0) {
        throw new Error(DEPLOYMENT_NOT_FOUND);
      }
      throw new Error(DEPLOYMENT_ALREADY_RETIRED);
    }

    const retired = result.rows[0]!;
    await txCallback(tx, retired);
    return retired;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// Submission sentinel error codes
//
// Same tenant-blind 400 mapping pattern as the deployment sentinels. Maps
// to a uniform wire-out 400 envelope per I-025; the structured code
// preserves observability granularity (NOT_FOUND vs WRONG_STATE).
// ---------------------------------------------------------------------------

export const SUBMISSION_NOT_FOUND = 'forms.submission.not_found';
export const SUBMISSION_NOT_IN_PROGRESS = 'forms.submission.not_in_progress';

/**
 * Sentinel error: at restore time, more than one in_progress submission
 * matched the (tenant, deployment, patient) tuple — defense-in-depth
 * against migration 008's unique index being missing or dropped (schema
 * drift). The service layer maps this to null per I-025 so the patient
 * surface sees a clean tenant-blind 404 rather than acting on ambiguous
 * data. Closes Codex resume-restore-r2 HIGH 2026-05-03.
 */
export const RESTORE_AMBIGUOUS_SUBMISSION = 'forms.restore.ambiguous_submission';

/**
 * Sentinel error: a patient already has an in_progress submission for the
 * same (tenant, deployment) tuple. Surfaces from migration 008's partial
 * unique index `uq_forms_submission_one_in_progress_per_tuple`. Translated
 * from a `23505` unique-violation in `createSubmission`.
 *
 * **Why this matters (Codex resume-restore-r1 HIGH closure 2026-05-03):**
 * the save-and-resume restore flow reconstructs the (resume_state ↔
 * submission) binding via (tenant, deployment, patient, status='in_progress')
 * because migration 006 has no `submission_id` column on
 * `forms_resume_state`. With multiple in-progress submissions on the same
 * tuple the LIMIT 1 was ambiguous — restore could write decrypted paused
 * responses to a fresh-start submission, silently corrupting it. The
 * partial unique index makes the tuple lookup unambiguous; this sentinel
 * is the friendly translation of the constraint violation.
 *
 * Handler maps to tenant-blind 400 per I-025.
 */
export const IN_PROGRESS_SUBMISSION_EXISTS = 'forms.submission.in_progress_exists';

// ---------------------------------------------------------------------------
// Submission reads
// ---------------------------------------------------------------------------

/**
 * Resolve a submission by ID under the caller's tenant. Returns null on miss
 * or cross-tenant (RLS-filtered) — handler maps null to a tenant-blind 404
 * per I-025. Same canonical pattern as `findTemplateById` / `findDeploymentById`.
 */
export async function findSubmissionById(
  tenantId: TenantId,
  submissionId: FormSubmissionId,
  externalTx?: DbClient,
): Promise<FormSubmission | null> {
  return withTenantBoundConnection(
    tenantId,
    async (client: DbClient) => {
      // Note: forms_submission columns per migration 006 differ from the
      // FormSubmission TypeScript shape — `started_at` doesn't exist as a
      // column; the type's `started_at` is mapped from `created_at`. Other
      // type fields (e.g. `delegate_id`, `submitted_at`) are direct.
      const result = await client.query<FormSubmission>(
        `SELECT submission_id,
                tenant_id,
                deployment_id,
                variant_id,
                patient_id,
                delegate_id,
                status,
                responses,
                created_at AS started_at,
                submitted_at
           FROM forms_submission
          WHERE submission_id = $1 AND tenant_id = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [submissionId, tenantId],
      );
      return result.rows[0] ?? null;
    },
    externalTx,
  );
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
/**
 * Insert a new submission row in `in_progress` status + run the caller's
 * txCallback (which emits audit + domain event) inside the same transaction.
 *
 * **Migration 006 conflict (flagged inline 2026-05-03 per EHBG §12 SI/DSI
 * escalation):** `forms_submission.patient_id` is NOT NULL, but Slice PRD
 * v2.1 §8.2 calls for a device-anonymous flow where pre-account patients
 * begin an intake without a resolved patient_id and the binding promotes
 * post-account-creation. Until the migration is patched (or a placeholder
 * "anonymous patient" identity is introduced), this repo enforces NOT NULL
 * at the type level — the service rejects null patientId before reaching
 * the SQL. The `versionId` and `deviceAnonymousToken` parameters from the
 * stub are omitted: there is no `version_id` column (template_version is
 * resolved via deployment_id → forms_template), and the device-anonymous
 * binding lives on the resume_state table per the slice scaffold.
 */
export async function createSubmission(
  tenantId: TenantId,
  input: {
    deploymentId: FormDeploymentId;
    variantId: FormVariantId | null;
    patientId: PatientId;
    delegateId: string | null;
  },
  txCallback: (tx: DbTransaction, submission: FormSubmission) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<FormSubmission> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    const submissionId = ulid();

    // Cross-table precondition: deployment must exist in this tenant AND
    // be active (retired_at IS NULL). The composite FK already enforces
    // tenant binding; the WHERE clause adds the active-deployment guard
    // atomically with the INSERT (TOCTOU-safe per the createActiveDeployment
    // pattern). Variant validation is deferred — variants are scaffolded
    // but the FK is added by ALTER post-table-create and the assignment
    // logic isn't wired yet.
    // Explicit type casts on the SELECT-target params close a pg parameter
    // type-inference hazard: when the same `$2` (tenant_id) appears in both
    // the SELECT projection (no type context) AND the WHERE comparison
    // (varchar context), pg fails with "inconsistent types deduced for
    // parameter $2." The casts pin every projected param to varchar so
    // both usages resolve consistently.
    let result;
    try {
      result = await tx.query<FormSubmission>(
        `INSERT INTO forms_submission (
            submission_id, tenant_id, deployment_id, variant_id,
            patient_id, delegate_id,
            status, responses, mode_2_eligible,
            created_at, updated_at
         )
         SELECT
            $1::varchar, $2::varchar, d.deployment_id, $3::varchar,
            $4::varchar, $5::varchar,
            'in_progress', '{}'::jsonb, FALSE,
            NOW(), NOW()
           FROM forms_deployment d
          WHERE d.tenant_id = $2::varchar
            AND d.deployment_id = $6::varchar
            AND d.retired_at IS NULL
         RETURNING submission_id, tenant_id, deployment_id, variant_id,
                   patient_id, delegate_id, status, responses,
                   created_at AS started_at, submitted_at`,
        [
          submissionId,
          tenantId,
          input.variantId,
          input.patientId,
          input.delegateId,
          input.deploymentId,
        ],
      );
    } catch (err: unknown) {
      // 23505 = unique_violation. The only relevant unique constraint that
      // can fire on this INSERT is migration 008's partial unique index
      // `uq_forms_submission_one_in_progress_per_tuple` —
      // (tenant, deployment, patient) with at most one in_progress row.
      // Translates to IN_PROGRESS_SUBMISSION_EXISTS so the handler maps
      // to a tenant-blind 400 with structured code that preserves
      // operator-facing distinction from DEPLOYMENT_NOT_FOUND. Closes
      // Codex resume-restore-r1 HIGH 2026-05-03.
      //
      // Defense-in-depth: a malformed `submission_id` collision (variant_id
      // is also fresh) would also raise 23505, but `submissionId = ulid()`
      // makes that probabilistically impossible (122 bits of entropy). If
      // someone hits both unique constraints in one INSERT, the
      // application-layer message is still safe to render — the tuple
      // gate is the dominant cause.
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505') {
        throw new Error(IN_PROGRESS_SUBMISSION_EXISTS);
      }
      throw err;
    }

    if (result.rows.length === 0) {
      // Zero rows from RETURNING means the SELECT predicate filtered:
      // deployment doesn't exist in this tenant, OR is retired.
      // Maps to a tenant-blind 400 at the handler — the structured code
      // (DEPLOYMENT_NOT_FOUND) preserves observability granularity.
      throw new Error(DEPLOYMENT_NOT_FOUND);
    }

    const submission = result.rows[0]!;
    await txCallback(tx, submission);
    return submission;
  }, externalTx);
}

/**
 * Persist partial-progress responses (Slice PRD §8.1 auto-save).
 *
 * **Merge semantics (Codex submissions-r1 HIGH closure 2026-05-03):**
 * the prior implementation replaced the entire `responses` JSONB
 * wholesale, so a PATCH client sending a delta of changed fields
 * would silently wipe every previously-saved key. The route is
 * `PATCH` and the schema docstring says "partial-progress save"; the
 * SQL now uses `responses || $1::jsonb` (top-level shallow merge) so
 * a delta preserves prior keys. Nested objects are still replaced
 * wholesale by `||` — that's a known PG JSONB-merge limitation; the
 * top-level shape is flat (`field_<id>: value`) per migration 006
 * comments so this is acceptable for v1.
 *
 * **Ownership enforcement (Codex submissions-r1 CRITICAL-2 closure
 * 2026-05-03):** the WHERE clause now also filters by `patient_id`
 * (and, when set, `delegate_id`) so a different patient in the same
 * tenant can't tamper with another patient's intake. A mismatch
 * surfaces as the same SUBMISSION_NOT_FOUND sentinel as a missing
 * row — tenant-blind per I-025.
 *
 * I-013 immutability: only `in_progress` submissions accept responses
 * updates. The WHERE clause includes `status = 'in_progress'`; a
 * submitted/withdrawn/etc. row gets the SUBMISSION_NOT_IN_PROGRESS
 * sentinel via a follow-up existence check (same pattern as
 * `retireDeployment`).
 */
export async function updateSubmissionResponses(
  tenantId: TenantId,
  submissionId: FormSubmissionId,
  responsePatch: Record<string, unknown>,
  ownership: { patientId: PatientId; delegateId: string | null },
  txCallback: (tx: DbTransaction, submission: FormSubmission) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<FormSubmission> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    const result = await tx.query<FormSubmission>(
      `UPDATE forms_submission
          SET responses = COALESCE(responses, '{}'::jsonb) || $1::jsonb,
              updated_at = NOW()
        WHERE submission_id = $2
          AND tenant_id = $3
          AND patient_id = $4
          AND delegate_id IS NOT DISTINCT FROM $5::varchar
          AND status = 'in_progress'
          AND deleted_at IS NULL
       RETURNING submission_id, tenant_id, deployment_id, variant_id,
                 patient_id, delegate_id, status, responses,
                 created_at AS started_at, submitted_at`,
      [
        JSON.stringify(responsePatch),
        submissionId,
        tenantId,
        ownership.patientId,
        ownership.delegateId,
      ],
    );

    if (result.rows.length === 0) {
      const existence = await tx.query<{
        status: string;
        patient_id: string;
        delegate_id: string | null;
      }>(
        `SELECT status, patient_id, delegate_id FROM forms_submission
          WHERE submission_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [submissionId, tenantId],
      );
      // Three ways to land here, mapped to two sentinels:
      //   - Row doesn't exist in this tenant at all → NOT_FOUND.
      //   - Row exists but ownership doesn't match (patient_id mismatch
      //     OR delegate_id null-safe mismatch) → also NOT_FOUND
      //     (tenant-blind per I-025; never differentiate "you don't
      //     own this" from "doesn't exist" — would leak existence).
      //   - Row exists, ownership matches, but status isn't in_progress →
      //     NOT_IN_PROGRESS.
      if (existence.rows.length === 0) {
        throw new Error(SUBMISSION_NOT_FOUND);
      }
      const row = existence.rows[0]!;
      if (row.patient_id !== ownership.patientId) {
        throw new Error(SUBMISSION_NOT_FOUND);
      }
      // Null-safe delegate equality. Mirrors the SQL `IS NOT DISTINCT FROM`
      // on the UPDATE WHERE so a wrong-delegate or null-vs-non-null
      // mismatch surfaces tenant-blind, not as NOT_IN_PROGRESS.
      // (Codex submissions-r1 verify-r1 HIGH closure 2026-05-03.)
      if (row.delegate_id !== ownership.delegateId) {
        throw new Error(SUBMISSION_NOT_FOUND);
      }
      throw new Error(SUBMISSION_NOT_IN_PROGRESS);
    }

    const submission = result.rows[0]!;
    await txCallback(tx, submission);
    return submission;
  }, externalTx);
}

/**
 * Transition a submission's status. Currently used for `in_progress →
 * submitted` (final submit). The function clamps allowed transitions at
 * the SQL level — only `in_progress` rows can transition to `submitted`
 * via this code path. Other transitions (review → approved, etc.) live
 * in slices that own those workflows (Async Consult, Pharmacy + Refill).
 *
 * **Snapshot capture (DEFERRED — separate slice work):** when status flips
 * to `submitted`, the submission's rendered form should be captured into
 * `forms_snapshot` per FORMS_ENGINE v5.2 §Snapshot construction +
 * Slice PRD v2.1 §4 four-layer model. The snapshot-service.ts file owns
 * this; it's stubbed today. The status transition + audit + domain event
 * are committed atomically here; the snapshot capture will hook into the
 * txCallback once the snapshot-service builds the rendered tree.
 */
export async function transitionSubmissionStatus(
  tenantId: TenantId,
  submissionId: FormSubmissionId,
  newStatus: SubmissionStatus,
  ownership: { patientId: PatientId; delegateId: string | null },
  txCallback: (tx: DbTransaction, submission: FormSubmission) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<FormSubmission> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    // For now only the in_progress → submitted transition is supported by
    // this code path. The migration's CHECK enum allows further states
    // (under_review, approved, declined, withdrawn) but those belong to
    // downstream slices.
    if (newStatus !== 'submitted') {
      throw new Error(
        `transitionSubmissionStatus: only 'submitted' is supported at this layer ` +
          `(received '${newStatus}'). Other lifecycle transitions are owned by ` +
          `downstream slices (Async Consult, Pharmacy + Refill).`,
      );
    }

    const result = await tx.query<FormSubmission>(
      `UPDATE forms_submission
          SET status = 'submitted',
              submitted_at = NOW(),
              updated_at = NOW()
        WHERE submission_id = $1
          AND tenant_id = $2
          AND patient_id = $3
          AND delegate_id IS NOT DISTINCT FROM $4::varchar
          AND status = 'in_progress'
          AND deleted_at IS NULL
       RETURNING submission_id, tenant_id, deployment_id, variant_id,
                 patient_id, delegate_id, status, responses,
                 created_at AS started_at, submitted_at`,
      [submissionId, tenantId, ownership.patientId, ownership.delegateId],
    );

    if (result.rows.length === 0) {
      const existence = await tx.query<{
        status: string;
        patient_id: string;
        delegate_id: string | null;
      }>(
        `SELECT status, patient_id, delegate_id FROM forms_submission
          WHERE submission_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
        [submissionId, tenantId],
      );
      if (existence.rows.length === 0) {
        throw new Error(SUBMISSION_NOT_FOUND);
      }
      const row = existence.rows[0]!;
      if (row.patient_id !== ownership.patientId) {
        // Tenant-blind: don't differentiate "not yours" from "doesn't exist."
        throw new Error(SUBMISSION_NOT_FOUND);
      }
      // Null-safe delegate equality (verify-r1 HIGH closure).
      if (row.delegate_id !== ownership.delegateId) {
        throw new Error(SUBMISSION_NOT_FOUND);
      }
      throw new Error(SUBMISSION_NOT_IN_PROGRESS);
    }

    const submission = result.rows[0]!;
    await txCallback(tx, submission);
    return submission;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// Variant repo (A/B test infrastructure per Slice PRD §14)
// ---------------------------------------------------------------------------

/**
 * Sentinel error: the deployment + variant_template precondition didn't
 * hold at INSERT time — either the deployment doesn't exist in this
 * tenant, the deployment is retired, OR the variant_template doesn't
 * exist in this tenant. The composite FKs at the DB layer enforce
 * tenant alignment (variant_template_id MUST belong to the same
 * tenant as deployment_id); a violation surfaces here.
 *
 * Same tenant-blind-400 mapping pattern as DEPLOYMENT_TEMPLATE_PRECONDITION_FAILED.
 */
export const VARIANT_PRECONDITION_FAILED = 'forms.variant.precondition_failed';

/**
 * Sentinel error: a variant with the same (deployment_id, label) already
 * exists. Per migration 006 §uq_variant_label_per_deployment a
 * deployment may carry at most one Control + at most one each of A/B/C/D.
 * Surfaces from the unique-constraint violation; service layer maps to
 * a tenant-blind 400.
 */
export const VARIANT_LABEL_CONFLICT = 'forms.variant.label_conflict';

/**
 * Create a new A/B variant arm for a deployment.
 *
 * Three concurrent-safety layers (Codex variants-r1 closure 2026-05-03):
 *
 *   1. **Pessimistic row lock on the deployment** via `SELECT ... FOR UPDATE`.
 *      Closes Codex variants-r1 HIGH-1 (TOCTOU on concurrent retire).
 *      The prior implementation used a plain INSERT...SELECT predicate
 *      against `retired_at IS NULL`; under READ COMMITTED a concurrent
 *      `retireDeployment` UPDATE could interleave: variant-create reads
 *      pre-retire state, retire UPDATEs and commits, variant-create
 *      INSERTs an active variant on a now-retired deployment. The
 *      `FOR UPDATE` on the deployment row blocks the variant-create
 *      until any in-flight retire commits, then the `retired_at IS NULL`
 *      predicate re-evaluates against the post-commit state — so a
 *      concurrent retire deterministically causes the variant-create to
 *      see 0 rows and throw VARIANT_PRECONDITION_FAILED.
 *
 *   2. **Publish-status gate on `variant_template`** via
 *      `t.status = 'published'`. Closes Codex variants-r1 HIGH-2 (the
 *      prior implementation only checked tenant alignment, allowing a
 *      tenant admin to attach a draft / superseded / archived template
 *      as an active variant arm — bypassing I-013 published-version
 *      immutability + I-015 dual-control + I-030 research-consent
 *      static analysis that publishVersion enforces). Same-tenant draft
 *      content NEVER routes to active intake traffic.
 *
 *   3. **Composite FKs** at the DB layer enforce same-tenant alignment
 *      independently as belt-and-suspenders.
 *
 * The unique-label-per-deployment constraint surfaces as `23505`
 * SQLSTATE; translated to `VARIANT_LABEL_CONFLICT`. Predicate-zero-rows
 * (any of: deployment missing/retired, template missing/unpublished,
 * cross-tenant) surfaces as `VARIANT_PRECONDITION_FAILED`. The service
 * layer maps both to the same tenant-blind 400 envelope per I-025;
 * operator-facing distinction is preserved through the structured codes.
 */
export async function createVariant(
  tenantId: TenantId,
  input: {
    deploymentId: FormDeploymentId;
    variantTemplateId: FormTemplateId;
    label: 'control' | 'A' | 'B' | 'C' | 'D';
    trafficPercent: number;
    createdBy: string;
  },
  txCallback: (tx: DbTransaction, variant: FormVariant) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<FormVariant> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    const variantId = ulid();

    // ---------------------------------------------------------------------
    // Step 1 — acquire the deployment FOR UPDATE lock as its OWN
    // statement.
    //
    // **Codex variants-r3 HIGH closure 2026-05-03 (READ COMMITTED snapshot
    // semantics):** the prior implementation packed lock acquisition and
    // the NOT EXISTS winner-check into a single INSERT...SELECT. Under
    // PostgreSQL READ COMMITTED, a statement's snapshot is taken at
    // statement start. SELECT ... FOR UPDATE can wait on the deployment
    // row, but the OTHER subqueries in the SAME statement do NOT take a
    // fresh post-wait snapshot. So the race was: create starts while
    // promote is uncommitted, snapshots no_winner_yet's NOT EXISTS as
    // 'no winner' (because promote hadn't committed yet), blocks on the
    // deployment lock, then once promote committed and released its
    // lock, create's INSERT proceeded with the stale 'no winner'
    // result and wrote a new active arm on a now-finalized deployment.
    //
    // Splitting into two statements in the same tx forces the second
    // statement to take a FRESH snapshot AFTER the first statement
    // returns. Each pg statement gets its own snapshot under READ
    // COMMITTED; concurrent commits between statements are visible to
    // the next statement. So the post-lock-acquisition INSERT below
    // sees promote's committed winner row in its NOT EXISTS check and
    // rejects deterministically.
    //
    // The deployment FOR UPDATE additionally serializes against
    // retireDeployment + variant promote (both take the same row lock).
    // Lock ordering is consistent: deployment-then-variant.
    // ---------------------------------------------------------------------
    const lockResult = await tx.query<{ deployment_id: string }>(
      `SELECT deployment_id
         FROM forms_deployment
        WHERE tenant_id = $1::varchar
          AND deployment_id = $2::varchar
          AND retired_at IS NULL
        FOR UPDATE`,
      [tenantId, input.deploymentId],
    );
    if (lockResult.rows.length === 0) {
      throw new Error(VARIANT_PRECONDITION_FAILED);
    }
    // Once FOR UPDATE is held, retired_at on this row is frozen for the
    // duration of this tx. No concurrent retire can flip it under us;
    // no concurrent promote can finalize a winner without first
    // contending for the same lock.

    // ---------------------------------------------------------------------
    // Step 2 — INSERT...SELECT with the publish gate + NOT EXISTS
    // no-winner guard, as a SEPARATE statement. Fresh snapshot taken
    // here sees any winner committed by a serialized promote.
    //
    // We do NOT take FOR UPDATE on the variant_template — supersede /
    // archive of a published version is governed by its own state-machine
    // guards (I-013 immutability + the version state machine in
    // State Machines v1.1) and a row lock here would block publish flows
    // for no benefit.
    // ---------------------------------------------------------------------
    let result;
    try {
      result = await tx.query<FormVariant>(
        `INSERT INTO forms_variant (
            variant_id, tenant_id, deployment_id,
            variant_label, variant_template_id,
            traffic_percent, status, created_by
         )
         SELECT
            $1::varchar, $2::varchar, $6::varchar,
            $3::varchar, t.template_id,
            $4::int, 'active', $5::varchar
           FROM forms_template t
          WHERE t.tenant_id = $2::varchar
            AND t.template_id = $7::varchar
            AND t.status = 'published'
            AND NOT EXISTS (
              SELECT 1 FROM forms_variant
               WHERE tenant_id = $2::varchar
                 AND deployment_id = $6::varchar
                 AND status = 'winner'
            )
         RETURNING variant_id, tenant_id, deployment_id,
                   variant_label, variant_template_id,
                   traffic_percent, posthog_flag_key,
                   status, created_by, retired_by, retired_reason,
                   created_at, updated_at, retired_at`,
        [
          variantId,
          tenantId,
          input.label,
          input.trafficPercent,
          input.createdBy,
          input.deploymentId,
          input.variantTemplateId,
        ],
      );
    } catch (err: unknown) {
      // 23505 = unique_violation. The only unique constraint that fires here
      // is `uq_variant_label_per_deployment` (variant_id is a fresh ULID).
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505') {
        throw new Error(VARIANT_LABEL_CONFLICT);
      }
      throw err;
    }

    if (result.rows.length === 0) {
      // Either variant_template predicate filtered (missing / unpublished)
      // OR the no-winner NOT EXISTS rejected (deployment finalized).
      // Same tenant-blind 400 envelope.
      throw new Error(VARIANT_PRECONDITION_FAILED);
    }

    const variant = result.rows[0]!;
    await txCallback(tx, variant);
    return variant;
  }, externalTx);
}

/**
 * Read a variant by primary key under the caller's tenant via RLS. Returns
 * null on miss or cross-tenant — handler maps null to a tenant-blind 404
 * per I-025. Same canonical pattern as `findSubmissionById`.
 */
export async function findVariantById(
  tenantId: TenantId,
  variantId: FormVariantId,
  externalTx?: DbClient,
): Promise<FormVariant | null> {
  return withTenantBoundConnection(
    tenantId,
    async (client: DbClient) => {
      const result = await client.query<FormVariant>(
        `SELECT variant_id, tenant_id, deployment_id,
                variant_label, variant_template_id,
                traffic_percent, posthog_flag_key,
                status, created_by, retired_by, retired_reason,
                created_at, updated_at, retired_at
           FROM forms_variant
          WHERE variant_id = $1 AND tenant_id = $2
          LIMIT 1`,
        [variantId, tenantId],
      );
      return result.rows[0] ?? null;
    },
    externalTx,
  );
}

/**
 * Sentinel error: the target variant doesn't exist in this tenant. Same
 * tenant-blind 400 mapping pattern as VARIANT_PRECONDITION_FAILED;
 * preserves operator-facing distinction for observability.
 */
export const VARIANT_NOT_FOUND = 'forms.variant.not_found';

/**
 * Sentinel error: the target variant exists but isn't in `active` status.
 * Per Slice PRD §14.5, only active variants are eligible for winner-promotion;
 * a retired or already-winner variant rejects the transition.
 */
export const VARIANT_NOT_ACTIVE = 'forms.variant.not_active';

/**
 * Promote a winner variant + retire all other active variants on the same
 * deployment. Per Slice PRD §14.5:
 *   - The target variant transitions `active → winner`.
 *   - All OTHER active variants on the same (tenant, deployment) pair
 *     transition `active → retired` with `retired_by` + `retired_reason`
 *     captured for audit.
 *   - In-progress submissions assigned to losing variants are NOT
 *     touched — they complete on their assigned variant per Pattern A
 *     immutability (no mid-flow switching, same discipline as deployment
 *     retire).
 *
 * Concurrent-safety:
 *   - The target variant SELECT uses `FOR UPDATE` so a concurrent
 *     promote-the-same-variant or retire-the-same-variant deterministically
 *     serializes. Mirrors the variant-create lock discipline (closes the
 *     analogous TOCTOU class addressed in variants-r1 HIGH-1).
 *   - The losers' UPDATE uses a predicate `status = 'active' AND variant_id
 *     != $target` so any concurrent winner-promotion that already retired
 *     a sibling won't re-write its `retired_at`.
 *
 * Sentinels (handler maps both to tenant-blind 400 per I-025):
 *   - VARIANT_NOT_FOUND — target variant not in tenant.
 *   - VARIANT_NOT_ACTIVE — target exists but isn't active.
 *
 * The txCallback receives the promoted variant and the IDs of retired
 * losers so the service layer can emit one Category B audit per retire
 * alongside the winner-promotion audit, all in the same transaction.
 */
export async function promoteVariantToWinner(
  tenantId: TenantId,
  variantId: FormVariantId,
  retiredBy: string,
  rationale: string,
  txCallback: (
    tx: DbTransaction,
    promoted: FormVariant,
    retiredLoserIds: FormVariantId[],
  ) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<FormVariant> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    // Step 1 — read the target variant to learn which deployment it
    // belongs to. Read-only; no lock yet because we need the deployment_id
    // to take the deployment-level lock first (consistent lock ordering
    // with createVariant per Codex variants-promote-r1 HIGH closure
    // 2026-05-03).
    const targetMeta = await tx.query<{ deployment_id: string }>(
      `SELECT deployment_id
         FROM forms_variant
        WHERE variant_id = $1 AND tenant_id = $2`,
      [variantId, tenantId],
    );
    if (targetMeta.rows.length === 0) {
      throw new Error(VARIANT_NOT_FOUND);
    }
    const deploymentId = targetMeta.rows[0]!.deployment_id;

    // Step 2 — DEPLOYMENT-LEVEL serialization lock. createVariant already
    // takes `SELECT ... FOR UPDATE` on the same forms_deployment row
    // before inserting an active variant arm. Acquiring it here in the
    // promote path serializes promote vs. concurrent create on the same
    // deployment: either (a) create commits before this lock is acquired,
    // and the new arm is included in our sibling-retire below, OR (b)
    // create blocks behind us, and after we commit the deployment is
    // already in a winner state — create's INSERT...SELECT predicate on
    // forms_variant doesn't gate by deployment status, but its CROSS JOIN
    // with the deployment lock means the create transaction sees our
    // committed promotion before its own predicate evaluates. (Closes
    // Codex variants-promote-r1 HIGH 2026-05-03 — corrupted-experiment
    // race where a sibling created mid-promotion would survive as an
    // un-retired active arm.)
    //
    // Lock ordering: deployment then variant. Both promote AND create
    // take this exact order; concurrent promote-vs-promote on different
    // deployments cannot deadlock (different rows); concurrent
    // promote-vs-promote on the same deployment serializes through the
    // deployment lock; concurrent promote-vs-create on the same
    // deployment serializes through the deployment lock.
    await tx.query(
      `SELECT 1 FROM forms_deployment
        WHERE deployment_id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [deploymentId, tenantId],
    );

    // Step 3 — re-read the target variant under FOR UPDATE so concurrent
    // promote-vs-promote on the same target serializes here. Status is
    // re-validated under the lock; a concurrent promote that completed
    // first will have flipped status to 'winner' and our re-read sees
    // it as such.
    const target = await tx.query<{ status: string; deployment_id: string }>(
      `SELECT status, deployment_id
         FROM forms_variant
        WHERE variant_id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [variantId, tenantId],
    );
    if (target.rows.length === 0) {
      // Variant deleted between step 1 and step 3 (shouldn't happen given
      // forms_variant has no DELETE path today, but defensive).
      throw new Error(VARIANT_NOT_FOUND);
    }
    const targetRow = target.rows[0]!;
    if (targetRow.status !== 'active') {
      throw new Error(VARIANT_NOT_ACTIVE);
    }

    // Promote the target.
    const promoteResult = await tx.query<FormVariant>(
      `UPDATE forms_variant
          SET status = 'winner', updated_at = NOW()
        WHERE variant_id = $1 AND tenant_id = $2 AND status = 'active'
       RETURNING variant_id, tenant_id, deployment_id,
                 variant_label, variant_template_id,
                 traffic_percent, posthog_flag_key,
                 status, created_by, retired_by, retired_reason,
                 created_at, updated_at, retired_at`,
      [variantId, tenantId],
    );
    if (promoteResult.rows.length === 0) {
      // The FOR UPDATE above proved status === 'active' under our lock;
      // if zero rows came back the only explanation is RLS swap or a
      // concurrent transaction that broke the lock contract. Surface
      // tenant-blind.
      throw new Error(VARIANT_NOT_ACTIVE);
    }
    const promoted = promoteResult.rows[0]!;

    // Retire all OTHER active variants on the same deployment. Predicate
    // `status = 'active'` is intentional — concurrent winner-promotions
    // on a sibling variant of the same deployment would have already
    // acquired their own FOR UPDATE locks; if a sibling already retired
    // by such a concurrent transaction, this UPDATE skips it (no double
    // retire-stamp).
    const retireResult = await tx.query<{ variant_id: string }>(
      `UPDATE forms_variant
          SET status = 'retired',
              retired_at = NOW(),
              retired_by = $3,
              retired_reason = $4,
              updated_at = NOW()
        WHERE tenant_id = $1
          AND deployment_id = $2
          AND variant_id != $5
          AND status = 'active'
       RETURNING variant_id`,
      [tenantId, targetRow.deployment_id, retiredBy, rationale, variantId],
    );
    const retiredLoserIds = retireResult.rows.map((r) => r.variant_id);

    await txCallback(tx, promoted, retiredLoserIds);
    return promoted;
  }, externalTx);
}

// ---------------------------------------------------------------------------
// Resume state repo
// ---------------------------------------------------------------------------

/**
 * Read the resume_state row by primary key, scoped to the caller's tenant
 * via RLS. Returns null on miss OR cross-tenant (RLS rejects) — handler
 * maps null to a tenant-blind 404 per I-025.
 *
 * **Why "by ID" not "by token":** the patient-held token is HMAC-signed
 * envelope material owned by the service layer (resume-token.ts); the
 * repo accepts the verified resume_state_id string after token decode +
 * signature check. Keeping the cryptographic concerns out of the repo
 * preserves a clean RLS/SQL boundary.
 *
 * Renamed from the legacy `findResumeStateByToken` stub on 2026-05-03;
 * the old signature implied the repo would do hashed-token lookup, but
 * migration 006 has no `resume_token_hash` column. The HMAC-self-contained
 * design replaces that storage requirement entirely.
 */
export async function findResumeStateById(
  tenantId: TenantId,
  resumeStateId: ResumeStateId,
  externalTx?: DbClient,
): Promise<ResumeState | null> {
  return withTenantBoundConnection(
    tenantId,
    async (client: DbClient) => {
      const result = await client.query<ResumeState>(
        `SELECT resume_state_id,
                tenant_id,
                patient_id,
                device_anonymous_token,
                deployment_id,
                variant_id,
                encrypted_partial_responses,
                current_section_index,
                progress_percent,
                status,
                expires_at,
                created_at,
                updated_at,
                last_saved_at,
                resumed_at
           FROM forms_resume_state
          WHERE resume_state_id = $1
            AND tenant_id = $2
            AND deleted_at IS NULL
          LIMIT 1`,
        [resumeStateId, tenantId],
      );
      return result.rows[0] ?? null;
    },
    externalTx,
  );
}

/**
 * Sentinel error: caller did not supply at least one identity anchor. The
 * migration's `chk_resume_identity` CHECK requires `patient_id IS NOT NULL OR
 * device_anonymous_token IS NOT NULL`. We pre-validate at the repo layer so
 * the caller gets a structured sentinel rather than a raw 23514
 * check_violation surfacing at the SQL boundary. Maps to a tenant-blind 400
 * at the handler.
 */
export const RESUME_STATE_IDENTITY_REQUIRED = 'forms.resume_state.identity_required';

/**
 * Insert a new resume_state row + run the caller's `txCallback` (which
 * commits the audit + domain event) inside the same transaction.
 *
 * **Same-tx outbox discipline (I-016):** the audit-record INSERT and the
 * domain-event-outbox INSERT live inside `txCallback`; if either throws,
 * the resume_state row is rolled back too. Callers MUST NOT swallow the
 * throw.
 *
 * **Identity guard (CHECK chk_resume_identity):** at least one of
 * `patientId` or `deviceAnonymousToken` must be non-null. Both null surfaces
 * as the `RESUME_STATE_IDENTITY_REQUIRED` sentinel before SQL runs.
 *
 * **Composite-FK alignment:** the migration's `fk_resume_state_deployment`
 * is `(tenant_id, deployment_id) → forms_deployment` and
 * `fk_resume_state_variant` is the triple-composite
 * `(tenant_id, deployment_id, variant_id) → forms_variant` (only fires when
 * `variant_id IS NOT NULL`). Both are tenant-bound at the DB layer; this
 * function adds an explicit `set_tenant_context` for layer-2 RLS coverage.
 *
 * **SPEC ISSUE per EHBG §12** (preserved from prior stub):
 *
 *   - migration 006 has no `submission_id` column on `forms_resume_state`,
 *     yet the slice §8 narrative implies a 1:1 binding from a paused
 *     submission to its resume_state. The service layer reconstructs the
 *     binding via `(tenant_id, deployment_id, patient_id, status='in_progress')`
 *     on `forms_submission` until migration 007 adds the column.
 *
 *   - `device_anonymous_token` (anonymous-flow path) intersects the broader
 *     §8.2 device-anonymous flow that today is blocked by
 *     `forms_submission.patient_id NOT NULL`. The pause path therefore
 *     only exercises `patientId IS NOT NULL` end-to-end at v0.1; the
 *     `deviceAnonymousToken` parameter is plumbed through for forward-
 *     compat with the anonymous flow once the migration patch lands.
 *
 * Type casts on the SELECT params close the same pg parameter type-
 * inference hazard handled in `createSubmission` — every projected param
 * is pinned to its expected type so a parameter that appears in both a
 * SELECT projection and a WHERE comparison resolves consistently.
 */
export async function createResumeState(
  tenantId: TenantId,
  input: {
    patientId: PatientId | null;
    deviceAnonymousToken: string | null;
    deploymentId: FormDeploymentId;
    variantId: FormVariantId | null;
    encryptedPartialResponses: Buffer;
    currentSectionIndex: number;
    progressPercent: number;
    expiresAt: string;
  },
  txCallback: (tx: DbTransaction, resumeState: ResumeState) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<ResumeState> {
  if (input.patientId === null && input.deviceAnonymousToken === null) {
    // Migration's chk_resume_identity would also reject this with a 23514
    // — but the structured sentinel preserves the operator-facing error
    // code and lets the handler map to a tenant-blind 400.
    throw new Error(RESUME_STATE_IDENTITY_REQUIRED);
  }

  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    const resumeStateId = ulid();

    // Explicit casts on every parameter close the pg type-inference hazard
    // documented on `createSubmission` (a $n that appears in both a
    // projection AND a comparison without context fails with "inconsistent
    // types deduced for parameter $n"). Pinned types: $5::bytea for the
    // encrypted payload, $9::timestamptz for the expiry, smallint for
    // progress_percent (matches the migration's SMALLINT column).
    const result = await tx.query<ResumeState>(
      `INSERT INTO forms_resume_state (
          resume_state_id, tenant_id,
          patient_id, device_anonymous_token,
          deployment_id, variant_id,
          encrypted_partial_responses,
          current_section_index, progress_percent,
          status, expires_at,
          created_at, updated_at, last_saved_at
       )
       VALUES (
          $1::varchar, $2::varchar,
          $3::varchar, $4::text,
          $5::varchar, $6::varchar,
          $7::bytea,
          $8::int, $9::smallint,
          'active', $10::timestamptz,
          NOW(), NOW(), NOW()
       )
       RETURNING resume_state_id,
                 tenant_id,
                 patient_id,
                 device_anonymous_token,
                 deployment_id,
                 variant_id,
                 encrypted_partial_responses,
                 current_section_index,
                 progress_percent,
                 status,
                 expires_at,
                 created_at,
                 updated_at,
                 last_saved_at,
                 resumed_at`,
      [
        resumeStateId,
        tenantId,
        input.patientId,
        input.deviceAnonymousToken,
        input.deploymentId,
        input.variantId,
        input.encryptedPartialResponses,
        input.currentSectionIndex,
        input.progressPercent,
        input.expiresAt,
      ],
    );

    // RETURNING on a plain INSERT...VALUES never returns zero rows on
    // success; a zero-row outcome would mean the INSERT was filtered (it
    // can't be — there's no SELECT predicate) or threw. Defensive guard
    // surfaces a clear error rather than a confusing TS narrowing failure
    // downstream.
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('forms.resume_state.insert_returned_zero_rows');
    }

    await txCallback(tx, row);
    return row;
  }, externalTx);
}

/**
 * Sentinel error: the resume_state row exists in this tenant but is not in
 * `active` status (already completed, expired, or RLS-filtered to zero
 * rows). Replay protection: once a successful restore has flipped the row
 * to `completed`, a second presentation of the same token cannot mutate
 * state. Maps to a tenant-blind null at the service layer per I-025.
 */
export const RESUME_STATE_NOT_RESTORABLE = 'forms.resume_state.not_restorable';

/**
 * Find the patient's currently-in-progress submission for the (tenant,
 * deployment, patient) tuple — the row that the resume_state row was
 * encrypted FROM at pause time and that the restore path will merge the
 * decrypted responses BACK INTO.
 *
 * **Why this query shape (SPEC ISSUE flagged in createResumeState):**
 * migration 006 has no `submission_id` column on `forms_resume_state`, so
 * the (resume_state ↔ submission) binding has to be reconstructed at
 * restore time. The pause path persists the merged responses onto the
 * existing forms_submission row before encrypting; the matching submission
 * is therefore the in_progress row for the (tenant, deployment, patient)
 * tuple.
 *
 * **Disambiguity invariant (Codex resume-restore-r1 HIGH closure
 * 2026-05-03):** migration 008 added a partial unique index
 * `uq_forms_submission_one_in_progress_per_tuple ON forms_submission
 * (tenant_id, deployment_id, patient_id) WHERE status = 'in_progress'
 * AND deleted_at IS NULL`, so AT MOST ONE row matches the tuple at any
 * time. Without that index, a patient who started a fresh submission
 * after pausing an earlier one would have two in_progress rows; the
 * LIMIT 1 below would pick the most recent (the fresh start) and
 * restore would silently overwrite the fresh start's progress with the
 * decrypted paused responses. The unique index makes the LIMIT 1
 * unambiguous; `createSubmission` translates the constraint violation
 * into the IN_PROGRESS_SUBMISSION_EXISTS sentinel so the second start
 * rejects with a clear error. ORDER BY created_at DESC + LIMIT 1 is
 * preserved as belt-and-suspenders.
 *
 * Returns null on miss OR cross-tenant (RLS-filtered) — service layer
 * maps null to a tenant-blind 404 per I-025.
 *
 * **Why patient-only (not delegate):** the resume_state row carries
 * patient_id + device_anonymous_token but no delegate_id. The pause path
 * gates on delegate-equality at the submission UPDATE; the restore-side
 * matching is one step looser by design — a patient resuming their own
 * intake from a different device that doesn't carry the original delegate
 * context still locates the in_progress row. Delegate-equality is then
 * re-enforced via `updateSubmissionResponses`'s ownership block at the
 * actual merge UPDATE so cross-delegate tampering is blocked at the write
 * layer. This is consistent with the metadata read which does not consider
 * delegate either.
 */
export async function findInProgressSubmissionForRestore(
  tenantId: TenantId,
  deploymentId: FormDeploymentId,
  patientId: PatientId,
  externalTx?: DbClient,
): Promise<FormSubmission | null> {
  return withTenantBoundConnection(
    tenantId,
    async (client: DbClient) => {
      // **Defense-in-depth count check (Codex resume-restore-r2 HIGH closure
      // 2026-05-03):** the partial unique index from migration 008 ensures
      // at most one matching row, but the application MUST NOT trust an
      // invariant it doesn't verify. If migration 008 was skipped, dropped
      // by an operator, or quietly rolled back during an upgrade, restore
      // would silently corrupt data by writing decrypted paused responses
      // onto the wrong submission row.
      //
      // Fetch up to 2 rows (LIMIT 2) and explicitly check the count. If
      // more than one matches, throw RESTORE_AMBIGUOUS_SUBMISSION; the
      // service layer surfaces null per I-025 so the patient sees a clean
      // tenant-blind 404 rather than an action on ambiguous data.
      const result = await client.query<FormSubmission>(
        `SELECT submission_id,
                tenant_id,
                deployment_id,
                variant_id,
                patient_id,
                delegate_id,
                status,
                responses,
                created_at AS started_at,
                submitted_at
           FROM forms_submission
          WHERE tenant_id = $1
            AND deployment_id = $2
            AND patient_id = $3
            AND status = 'in_progress'
            AND deleted_at IS NULL
          ORDER BY created_at DESC
          LIMIT 2`,
        [tenantId, deploymentId, patientId],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length > 1) {
        // Schema-drift / index-missing scenario. Fail closed.
        throw new Error(RESTORE_AMBIGUOUS_SUBMISSION);
      }
      return result.rows[0]!;
    },
    externalTx,
  );
}

/**
 * Mark a resume_state row as `completed` after a successful restore.
 *
 * **Replay protection:** the WHERE predicate filters by `status = 'active'`,
 * so a second concurrent restore attempt with the same token (or a retry
 * after a successful first restore) sees zero rows updated and surfaces
 * `RESUME_STATE_NOT_RESTORABLE`. Combined with the same-outer-tx
 * orchestration at the service layer (I-016), this is what prevents the
 * patient hitting "Resume" twice from corrupting the merged responses via
 * a phantom second-merge attempt.
 *
 * **Same-tx outbox (I-016):** the txCallback emits the Category C
 * `forms_resume_state.restored` audit (placeholder action_id
 * `config_change_validated` per the SPEC ISSUE flagged on
 * `emitFormsResumeStateRestored`). Audit emission happens INSIDE this
 * function's transaction so a failure there rolls back the status flip
 * AND the upstream submission UPDATE that the service layer wraps around
 * this call.
 *
 * **`externalTx` for atomic orchestration:** the service-layer
 * `resumeSubmission` opens a single outer tx and threads it through the
 * restore pipeline (decrypt + merge UPDATE + this status flip + audit).
 * Without externalTx, this function would acquire its own transaction
 * and the resume_state status flip + audit would commit independently of
 * the merge UPDATE — violating I-016. Production callers MUST pass the
 * outer tx; the externalTx-less branch exists only for direct test usage.
 *
 * Sentinel:
 *   - `RESUME_STATE_NOT_RESTORABLE` — the row doesn't exist in this tenant
 *     OR isn't in 'active' status (already completed / expired). Service
 *     layer treats this as a null return per I-025 tenant-blind.
 */
export async function markResumeStateCompleted(
  tenantId: TenantId,
  resumeStateId: ResumeStateId,
  txCallback: (tx: DbTransaction) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<void> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    const result = await tx.query<{ resume_state_id: string }>(
      `UPDATE forms_resume_state
          SET status = 'completed',
              resumed_at = NOW(),
              updated_at = NOW()
        WHERE resume_state_id = $1
          AND tenant_id = $2
          AND status = 'active'
          AND deleted_at IS NULL
       RETURNING resume_state_id`,
      [resumeStateId, tenantId],
    );

    if (result.rows.length === 0) {
      // Row missing in this tenant OR already in non-active status.
      // Service layer maps to null per I-025 — never differentiate at
      // the wire layer.
      throw new Error(RESUME_STATE_NOT_RESTORABLE);
    }

    await txCallback(tx);
  }, externalTx);
}
