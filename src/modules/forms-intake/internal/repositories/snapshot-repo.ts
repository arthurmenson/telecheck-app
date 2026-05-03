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
import type { FormSnapshot, FormSnapshotId, FormSubmissionId, FormVersionId } from '../types.js';

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
): Promise<FormSnapshot | null> {
  return withTenantBoundConnection(tenantId, async (client: DbClient) => {
    // Aligned to migration 006 column set (Codex slice-scaffold-r1
    // MEDIUM finding closure 2026-05-02): singular table name
    // `forms_snapshot`, primary key `snapshot_id`, references
    // `template_id` (no version_id; the template_version is captured
    // inside presented_content per FORMS_ENGINE v5.2 + the canonical
    // §4.1 seed).
    const result = await client.query<FormSnapshot>(
      `SELECT snapshot_id, tenant_id, submission_id, template_id,
              presented_content, captured_at
         FROM forms_snapshot
        WHERE submission_id = $1 AND tenant_id = $2
        LIMIT 1`,
      [submissionId, tenantId],
    );
    return result.rows[0] ?? null;
  });
}

export async function findSnapshotById(
  _tenantId: TenantId,
  _snapshotId: FormSnapshotId,
): Promise<FormSnapshot | null> {
  // TODO: SELECT under withTenantBoundConnection.
  throw new Error('not implemented');
}

// ---------------------------------------------------------------------------
// Writes (append-only)
// ---------------------------------------------------------------------------

/**
 * Persist a new snapshot. INSERT-only — there is intentionally no
 * `updateSnapshot()` / `deleteSnapshot()` exported from this module.
 *
 * Same `withTransaction` discipline so the snapshot INSERT, the submission
 * status transition, and the audit/domain-event emission all commit
 * together (or roll back together).
 */
export async function createSnapshot(
  _tenantId: TenantId,
  _input: {
    submissionId: FormSubmissionId;
    versionId: FormVersionId;
    renderedLayout: unknown;
    renderedBranching: unknown;
    renderedEligibility: unknown;
    renderedApprovalGovernance: unknown;
    ccrResolutionPack: unknown;
  },
  _txCallback: (tx: DbTransaction, snapshot: FormSnapshot) => Promise<void>,
): Promise<FormSnapshot> {
  void withTransaction; // referenced so import is not lint-pruned.
  throw new Error('not implemented');
}
