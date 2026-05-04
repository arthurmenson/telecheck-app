/**
 * forms-intake/internal/repositories/snapshot-repo.ts — immutable Snapshot DB access.
 *
 * Per FORMS_ENGINE v5.2 + Slice PRD v2.1 §4: Snapshot is the append-only
 * record of EXACTLY what the patient saw at submission time, including the
 * resolved CCR pack used to render the form. Snapshots are write-once;
 * any UPDATE/DELETE is an I-013-style invariant violation (analogous to
 * audit-record append-only discipline).
 *
 * Tables (per migration 006_forms_intake.sql):
 *   - forms_snapshots(id, tenant_id, submission_id, version_id,
 *                     rendered_layout, rendered_branching, rendered_eligibility,
 *                     rendered_approval_governance, ccr_resolution_pack, created_at)
 *
 * Spec references:
 *   - FORMS_ENGINE v5.2 §Form versioning (immutable at publish)
 *   - Slice PRD v2.1 §4 (snapshot layer concept)
 *   - INVARIANT I-013 (published versions immutable; analogous floor here)
 *   - INVARIANT I-023 (tenant-scoped table; RLS enforced)
 *   - INVARIANT I-016 (immutable; INSERT failure surfaces — same posture
 *     as domain events)
 */

import {
  type DbClient,
  type DbTransaction,
  withTenantBoundConnection,
  withTransaction,
} from '../../../../lib/db.js';
import type { TenantId } from '../../../../lib/glossary.js';
import { ulid } from '../../../../lib/ulid.js';
import type { FormSnapshot, FormSnapshotId, FormSubmissionId, FormTemplateId } from '../types.js';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Fetch the snapshot for a submission. Used by clinicians during review
 * (Slice PRD §3 — clinician consumes intake data read-only).
 */
export async function findSnapshotBySubmissionId(
  tenantId: TenantId,
  submissionId: FormSubmissionId,
  externalTx?: DbClient,
): Promise<FormSnapshot | null> {
  return withTenantBoundConnection(
    tenantId,
    async (client: DbClient) => {
      // Aligned to migration 006 column set (Codex slice-scaffold-r1
      // MEDIUM finding closure 2026-05-02): singular table name
      // `forms_snapshot`, primary key `snapshot_id`, references
      // `template_id` (no version_id; the template_version is captured
      // inside presented_content per FORMS_ENGINE v5.2 + the canonical
      // §4.1 seed).
      const result = await client.query<FormSnapshot>(
        `SELECT snapshot_id, tenant_id, submission_id, template_id,
                template_version, presented_content, created_at
         FROM forms_snapshot
        WHERE submission_id = $1 AND tenant_id = $2
        LIMIT 1`,
        [submissionId, tenantId],
      );
      return result.rows[0] ?? null;
    },
    externalTx,
  );
}

/**
 * Fetch a snapshot by primary key under the caller's tenant via RLS.
 * Returns null on miss or cross-tenant — handler maps null to a tenant-blind
 * 404 per I-025. Same canonical pattern as `findSubmissionById`.
 */
export async function findSnapshotById(
  tenantId: TenantId,
  snapshotId: FormSnapshotId,
  externalTx?: DbClient,
): Promise<FormSnapshot | null> {
  return withTenantBoundConnection(
    tenantId,
    async (client: DbClient) => {
      const result = await client.query<FormSnapshot>(
        `SELECT snapshot_id, tenant_id, submission_id, template_id,
                  template_version, presented_content, created_at
           FROM forms_snapshot
          WHERE snapshot_id = $1 AND tenant_id = $2
          LIMIT 1`,
        [snapshotId, tenantId],
      );
      return result.rows[0] ?? null;
    },
    externalTx,
  );
}

// ---------------------------------------------------------------------------
// Writes (append-only)
// ---------------------------------------------------------------------------

/**
 * Sentinel error: the SELECT predicate on the cross-table preconditions
 * filtered (the submission doesn't exist in this tenant, OR the template
 * doesn't exist / is mismatched). Same tenant-blind 400 mapping pattern
 * as DEPLOYMENT_TEMPLATE_PRECONDITION_FAILED.
 */
export const SNAPSHOT_PRECONDITION_FAILED = 'forms.snapshot.precondition_failed';

/**
 * Sentinel error: a snapshot already exists for this submission. The
 * append-only discipline means a second INSERT for the same submission_id
 * is a defect — surfaces from the migration's primary-key collision OR
 * from idempotency-aware callers detecting an existing row. Translated
 * from a `23505` unique violation on the snapshot_id PK (which is
 * generated as a fresh ULID, so the only realistic 23505 vector is a
 * future composite uniqueness constraint on submission_id; defensive
 * naming today).
 */
export const SNAPSHOT_ALREADY_EXISTS = 'forms.snapshot.already_exists';

/**
 * Persist a new snapshot. INSERT-only — there is intentionally no
 * `updateSnapshot()` / `deleteSnapshot()` exported from this module.
 * Migration 006 also REVOKEs UPDATE / DELETE on `forms_snapshot` from
 * PUBLIC, so even a buggy UPDATE statement at the application layer
 * fails at the DB.
 *
 * Same `withTransaction` discipline as createSubmission: the caller's
 * `txCallback` runs in the same transaction (e.g., to emit a Category C
 * `forms_submission_completed` audit alongside the snapshot write) so
 * rollback discards both the snapshot and the audit if either fails.
 *
 * **Concurrency-safe precondition (mirrors createActiveDeployment +
 * createVariant):** the INSERT...SELECT predicate atomically verifies
 * that the submission and template both exist in this tenant at INSERT
 * time. The composite FKs `(tenant_id, submission_id) → forms_submission`
 * and `(tenant_id, template_id) → forms_template` provide the cross-tenant
 * guarantee independently.
 *
 * Returns SNAPSHOT_PRECONDITION_FAILED on predicate-zero-rows and
 * SNAPSHOT_ALREADY_EXISTS on PK / future-composite-uniqueness violation.
 */
export async function createSnapshot(
  tenantId: TenantId,
  input: {
    submissionId: FormSubmissionId;
    templateId: FormTemplateId;
    templateVersion: number;
    presentedContent: unknown;
  },
  txCallback: (tx: DbTransaction, snapshot: FormSnapshot) => Promise<void>,
  externalTx?: DbTransaction,
): Promise<FormSnapshot> {
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);

    const snapshotId = ulid();

    let result;
    try {
      result = await tx.query<FormSnapshot>(
        `INSERT INTO forms_snapshot (
            snapshot_id, tenant_id, submission_id, template_id,
            template_version, presented_content
         )
         SELECT
            $1::varchar, s.tenant_id, s.submission_id, t.template_id,
            $5::int, $6::jsonb
           FROM forms_submission s
           JOIN forms_template t
             ON t.tenant_id = s.tenant_id
          WHERE s.tenant_id = $2::varchar
            AND s.submission_id = $3::varchar
            AND s.deleted_at IS NULL
            AND t.tenant_id = $2::varchar
            AND t.template_id = $4::varchar
         RETURNING snapshot_id, tenant_id, submission_id, template_id,
                   template_version, presented_content, created_at`,
        [
          snapshotId,
          tenantId,
          input.submissionId,
          input.templateId,
          input.templateVersion,
          JSON.stringify(input.presentedContent),
        ],
      );
    } catch (err: unknown) {
      // 23505 = unique_violation. The PK is a fresh ULID so collision is
      // probabilistically impossible; defensive translation in case a
      // future migration adds a composite uniqueness constraint on
      // (tenant_id, submission_id).
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505') {
        throw new Error(SNAPSHOT_ALREADY_EXISTS);
      }
      throw err;
    }

    if (result.rows.length === 0) {
      throw new Error(SNAPSHOT_PRECONDITION_FAILED);
    }

    const snapshot = result.rows[0]!;
    await txCallback(tx, snapshot);
    return snapshot;
  }, externalTx);
}
