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

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import * as snapshotRepo from '../repositories/snapshot-repo.js';
import * as submissionRepo from '../repositories/submission-repo.js';
import * as templateRepo from '../repositories/template-repo.js';
import type {
  FormSnapshot,
  FormSnapshotId,
  FormSubmission,
  FormSubmissionId,
  PatientId,
} from '../types.js';

/**
 * Sentinel error: the snapshot couldn't be built because the submission's
 * deployment, deployment's template, or one of those preconditions
 * couldn't be resolved within the caller's tenant context. Service-layer
 * callers (e.g., `submitSubmission`) re-throw to roll back the encompassing
 * tx; the handler maps the bubbled-up error to a tenant-blind 400 per I-025.
 */
export const SNAPSHOT_BUILD_PRECONDITION_FAILED = 'forms.snapshot.build_precondition_failed';

/**
 * Build and persist a snapshot at submission time per Slice PRD v2.1 §4.
 *
 * Captures the immutable point-in-time view of the form the patient just
 * submitted: the four template layers (L1 presentation / L2 branching /
 * L3 eligibility / L4 approval governance), the responses, the
 * template_version pin, and (when available) the CCR resolution pack and
 * variant assignment.
 *
 * **What's captured at v0.1 vs. what's deferred:** the migration 006
 * comment for `presented_content` describes a richer shape with rendered
 * sections, `ccr_resolution_snapshot`, `research_consent_text_version`, and
 * `l4_approval_governance_snapshot`. Several of those depend on upstream
 * slices that don't exist yet:
 *   - Variant rendering — PostHog feature-flag adapter not wired (variant
 *     assignment in startSubmission is stubbed to null).
 *   - CCR runtime — country-conditional resolution is its own contract slice.
 *   - Research consent — landing in the research-data slice (ADR-028).
 *
 * For v0.1 the snapshot captures what's deterministically available:
 *   - The four template-layer JSONB blobs as-is from forms_template
 *     (so even after later supersede/archive of the template, the rendered
 *     content the patient saw is reconstructible).
 *   - The submission's responses at submit time.
 *   - The template_version pin so audit can join back to the canonical
 *     template version.
 *   - `ccr_resolution_snapshot: null` + `variant_id: null` with a SPEC
 *     ISSUE note inline; both flip to populated values once their
 *     upstream slices land.
 *
 * **Atomicity:** `externalTx` is required (not optional) because this
 * function is intended to be called from `submitSubmission` inside its
 * existing transaction so the snapshot INSERT, the submission status flip,
 * the audit emission, and the domain event all commit together. Calling
 * outside a tx (when `externalTx` is undefined) opens a fresh tx via
 * `createSnapshot` — useful for retroactive capture but NOT the canonical
 * call shape.
 *
 * Append-only — there is intentionally no `updateSnapshot()` exported.
 * Migration 006 also REVOKEs UPDATE / DELETE on forms_snapshot from
 * PUBLIC (defense-in-depth at the DB layer).
 */
export async function buildAndPersistSnapshot(
  ctx: TenantContext,
  input: {
    submission: FormSubmission;
  },
  externalTx?: DbTransaction,
): Promise<FormSnapshot> {
  // Step 1 — resolve the deployment to learn the template_id. The
  // submission carries deployment_id directly; we read the deployment row
  // under RLS via the externalTx (so RLS is consistent with the caller's
  // tenant scope).
  const deployment = await submissionRepo.findDeploymentById(
    ctx.tenantId,
    input.submission.deployment_id,
    externalTx,
  );
  if (deployment === null) {
    throw new Error(SNAPSHOT_BUILD_PRECONDITION_FAILED);
  }

  // Step 2 — resolve the template to get the four JSONB layers + the
  // template_version pin. Template might have been superseded since the
  // submission was started; we capture WHAT THE PATIENT SAW per Pattern A
  // immutability — the snapshot is the durable record. (Supersession of a
  // template doesn't delete the row from forms_template; the historical
  // template_version is still readable.)
  const template = await templateRepo.findTemplateById(
    ctx.tenantId,
    deployment.template_id,
    externalTx,
  );
  if (template === null) {
    throw new Error(SNAPSHOT_BUILD_PRECONDITION_FAILED);
  }

  // Step 3 — project to the canonical presented_content JSONB shape.
  // Comment in migration 006 describes the future-rich shape; at v0.1 we
  // capture what's deterministically available + null-with-SPEC-ISSUE for
  // the upstream-blocked fields. The shape is forward-compatible: when
  // CCR runtime lands, ccr_resolution_snapshot flips from null to the
  // resolved object without changing the JSONB key set.
  const presentedContent = {
    template_layers: {
      presentation_content: template.presentation_content,
      branching_logic: template.branching_logic,
      eligibility_logic: template.eligibility_logic,
      approval_governance: template.approval_governance,
    },
    responses: input.submission.responses,
    captured_at_iso: new Date().toISOString(),
    // SPEC ISSUE per EHBG §12: ccr_resolution_snapshot is null at v0.1
    // pending CCR runtime contract slice. Migration 006's presented_content
    // comment lists this field; it's surfaced here as null so the JSONB
    // key set is forward-stable and downstream consumers don't see a
    // missing key when CCR lands.
    ccr_resolution_snapshot: null,
    // SPEC ISSUE: variant assignment is stubbed in startSubmission until
    // PostHog feature-flag adapter lands. The submission's variant_id is
    // therefore typically null at v0.1; surfaced here so the snapshot
    // records what variant (if any) the patient was assigned to.
    variant_id: input.submission.variant_id,
    // SPEC ISSUE: research_consent_text_version lands with the research-
    // data slice (ADR-028). Surfaced as null at v0.1.
    research_consent_text_version: null,
  };

  return snapshotRepo.createSnapshot(
    ctx.tenantId,
    {
      submissionId: input.submission.submission_id,
      templateId: template.template_id,
      templateVersion: template.template_version,
      presentedContent,
    },
    async (_tx, _snapshot) => {
      // No additional audit/event on the snapshot insert — submitSubmission
      // already emits the Category C `forms_submission_completed` audit +
      // `intake_response.submitted` domain event around the snapshot call.
      // A separate snapshot audit would double-count the same patient
      // action. The snapshot row itself IS the audit material per Slice
      // PRD §4.
      void _tx;
      void _snapshot;
    },
    externalTx,
  );
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
