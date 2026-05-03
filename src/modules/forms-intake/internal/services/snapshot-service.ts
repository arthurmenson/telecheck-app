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

import type { DbClient } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import * as snapshotRepo from '../repositories/snapshot-repo.js';
import * as submissionRepo from '../repositories/submission-repo.js';
import type {
  FormSnapshot,
  FormSnapshotId,
  FormSubmissionId,
  FormVersionId,
  PatientId,
} from '../types.js';

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
 * Read a snapshot by submission ID. Used by clinician case-review surfaces.
 *
 * **Patient-level access enforcement (mirrors the
 * `submission-service.getSubmission` pattern landed via the submissions-r1
 * CRITICAL-2 closure 2026-05-03):** RLS scopes by tenant, but a tenant
 * admin / clinician request must additionally prove ownership semantics.
 * This service is consumed by clinician review surfaces today, where the
 * clinician's authorization isn't patient-level (per RBAC v1.1, clinicians
 * have tenant-scope review rights). For PATIENT-facing access (a patient
 * viewing their own snapshot post-submit), the caller MUST pass
 * `ownership.patientId` and we cross-check against the underlying
 * submission's patient_id; mismatch returns null per I-025.
 *
 * `ownership.patientId === null` means "tenant-admin / clinician path —
 * skip patient-level check; rely on RLS". Both modes return null on miss.
 */
export async function getSnapshotForSubmission(
  ctx: TenantContext,
  submissionId: FormSubmissionId,
  ownership: { patientId: PatientId | null },
  externalTx?: DbClient,
): Promise<FormSnapshot | null> {
  const snapshot = await snapshotRepo.findSnapshotBySubmissionId(
    ctx.tenantId,
    submissionId,
    externalTx,
  );
  if (snapshot === null) return null;

  if (ownership.patientId !== null) {
    // Patient-facing access — confirm the underlying submission belongs to
    // this patient. Tenant-blind null on mismatch per I-025.
    const submission = await submissionRepo.findSubmissionById(
      ctx.tenantId,
      submissionId,
      externalTx,
    );
    if (submission === null || submission.patient_id !== ownership.patientId) {
      return null;
    }
  }

  return snapshot;
}

export async function getSnapshotById(
  ctx: TenantContext,
  snapshotId: FormSnapshotId,
  ownership: { patientId: PatientId | null },
  externalTx?: DbClient,
): Promise<FormSnapshot | null> {
  const snapshot = await snapshotRepo.findSnapshotById(ctx.tenantId, snapshotId, externalTx);
  if (snapshot === null) return null;

  if (ownership.patientId !== null) {
    const submission = await submissionRepo.findSubmissionById(
      ctx.tenantId,
      snapshot.submission_id,
      externalTx,
    );
    if (submission === null || submission.patient_id !== ownership.patientId) {
      return null;
    }
  }

  return snapshot;
}
