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

// ---------------------------------------------------------------------------
// Read APIs — split by access posture (Codex snapshot-r1 HIGH closure
// 2026-05-03)
//
// Each underlying snapshot read has TWO entry points by design, NOT one
// function with a nullable-bypass argument. The prior scaffold accepted
// `ownership: { patientId: PatientId | null }` and skipped the patient
// equality check when `patientId === null`. That shape made it trivial to
// authorize a "clinician/admin" read by accident — a single forgotten arg,
// a refactor that drops the patient resolution, or a handler that calls
// the wrong shim is a silent privilege escalation. Per Codex finding:
// "Do not encode privileged bypass as nullable patient ownership."
//
// The split:
//
//   - `*AsPatient(...)` — REQUIRES a non-null `PatientId` at the type level.
//     Verifies the underlying submission's `patient_id` matches; null on
//     mismatch per I-025. This is the patient-app surface.
//
//   - `*AsClinician(...)` — explicit privileged-read contract. RLS-only.
//     Tightening to RBAC role checks happens when the Identity & Auth
//     slice lands (see TODO at each function). Until then, the function
//     name signals "you must have already authorized clinician scope at
//     the handler/middleware before calling this" — there is no nullable
//     argument that can be silently misused.
// ---------------------------------------------------------------------------

/**
 * Patient-facing read by submission ID. The patient surface MUST verify
 * the submission belongs to the calling patient before returning the
 * snapshot (snapshots are full PHI surface — same ownership invariant
 * as the submission itself).
 *
 * Returns null on:
 *   - snapshot missing,
 *   - submission missing (orphan snapshot — should never happen given the
 *     composite FK, but defense-in-depth),
 *   - patient_id mismatch.
 *
 * All three surface as the same byte-identical 404 envelope at the
 * handler per I-025.
 */
export async function getSnapshotForSubmissionAsPatient(
  ctx: TenantContext,
  patientId: PatientId,
  submissionId: FormSubmissionId,
  externalTx?: DbClient,
): Promise<FormSnapshot | null> {
  const snapshot = await snapshotRepo.findSnapshotBySubmissionId(
    ctx.tenantId,
    submissionId,
    externalTx,
  );
  if (snapshot === null) return null;

  const submission = await submissionRepo.findSubmissionById(
    ctx.tenantId,
    submissionId,
    externalTx,
  );
  if (submission === null || submission.patient_id !== patientId) {
    return null;
  }

  return snapshot;
}

/**
 * Clinician/admin read by submission ID. RLS-only — the caller is
 * responsible for authorizing clinician/admin scope at the handler or
 * middleware layer BEFORE invoking this function. There is no
 * patient-level cross-check because clinicians legitimately review
 * intakes across patients within a tenant per RBAC v1.1.
 *
 * **TODO (Identity & Auth slice):** when RBAC is wired, gate this
 * function with an explicit role assertion (clinician, tenant admin,
 * platform admin). Until then, the handler is expected to perform that
 * authorization. The function name itself documents the contract.
 */
export async function getSnapshotForSubmissionAsClinician(
  ctx: TenantContext,
  submissionId: FormSubmissionId,
  externalTx?: DbClient,
): Promise<FormSnapshot | null> {
  return snapshotRepo.findSnapshotBySubmissionId(ctx.tenantId, submissionId, externalTx);
}

/**
 * Patient-facing read by snapshot ID. Same ownership cross-check as
 * `getSnapshotForSubmissionAsPatient`: fetch the snapshot, then verify
 * the underlying submission belongs to the calling patient.
 */
export async function getSnapshotByIdAsPatient(
  ctx: TenantContext,
  patientId: PatientId,
  snapshotId: FormSnapshotId,
  externalTx?: DbClient,
): Promise<FormSnapshot | null> {
  const snapshot = await snapshotRepo.findSnapshotById(ctx.tenantId, snapshotId, externalTx);
  if (snapshot === null) return null;

  const submission = await submissionRepo.findSubmissionById(
    ctx.tenantId,
    snapshot.submission_id,
    externalTx,
  );
  if (submission === null || submission.patient_id !== patientId) {
    return null;
  }

  return snapshot;
}

/**
 * Clinician/admin read by snapshot ID. Same privileged contract as
 * `getSnapshotForSubmissionAsClinician`: RLS-only, caller authorizes
 * clinician/admin scope.
 */
export async function getSnapshotByIdAsClinician(
  ctx: TenantContext,
  snapshotId: FormSnapshotId,
  externalTx?: DbClient,
): Promise<FormSnapshot | null> {
  return snapshotRepo.findSnapshotById(ctx.tenantId, snapshotId, externalTx);
}
