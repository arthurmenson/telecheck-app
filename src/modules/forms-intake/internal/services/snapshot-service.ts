/**
 * forms-intake/internal/services/snapshot-service.ts — snapshot business logic.
 *
 * Owns:
 *   - Building the immutable snapshot at submission time per Slice PRD v2.1
 *     §4 (snapshot layer concept) — captures rendered four-layer output
 *     plus the resolved CCR pack (per §25.4 Layer 4 CCR Runtime resolution).
 *   - Read access for clinician review (Slice PRD §3 — clinician consumes
 *     intake data read-only).
 *
 * Spec references:
 *   - FORMS_ENGINE v5.2 §Form versioning + immutability
 *   - Slice PRD v2.1 §4 (snapshot layer)
 *   - Slice PRD v2.1 §25.4 (Layer 4 CCR Runtime resolution captured in snapshot)
 *   - INVARIANT I-013 (immutable published versions; analogous floor here)
 */

import type { TenantContext } from '../../../../lib/tenant-context.js';
import type { FormSnapshot, FormSnapshotId, FormSubmissionId, FormVersionId } from '../types.js';

/**
 * Build and persist a snapshot at submission time. Captures the rendered
 * L1/L2/L3/L4 output AND the CCR resolution pack used at render time so
 * the audit trail can reconstruct EXACTLY what the patient saw and what
 * country-conditional gates applied.
 *
 * Append-only — there is intentionally no `updateSnapshot()` exported.
 */
export async function buildAndPersistSnapshot(
  _ctx: TenantContext,
  _input: {
    submissionId: FormSubmissionId;
    versionId: FormVersionId;
  },
): Promise<FormSnapshot> {
  // TODO: render the four-layer output for the submission's variant + CCR
  // pack; insert via snapshot-repo.createSnapshot under withTransaction.
  throw new Error('not implemented');
}

/**
 * Read a snapshot by submission ID. Used by clinician case review surfaces.
 */
export async function getSnapshotForSubmission(
  _ctx: TenantContext,
  _submissionId: FormSubmissionId,
): Promise<FormSnapshot | null> {
  throw new Error('not implemented');
}

export async function getSnapshotById(
  _ctx: TenantContext,
  _snapshotId: FormSnapshotId,
): Promise<FormSnapshot | null> {
  throw new Error('not implemented');
}
