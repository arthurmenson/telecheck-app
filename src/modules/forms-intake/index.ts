/**
 * forms-intake/index.ts — public interface for the Forms/Intake Engine module.
 *
 * Per ADR-001 modular monolith: only the names re-exported below are
 * legitimate cross-module imports. Anything under `./internal/*` is
 * module-private and MUST NOT be imported from other modules — the ESLint
 * `import/no-restricted-paths` rule will catch regressions.
 *
 * Cross-module callers (e.g., Pharmacy + Refill consuming the active
 * deployment for a program per Slice PRD §11 dependencies) use the
 * exported helpers below; they MUST NOT reach into the repositories.
 *
 * Spec references:
 *   - ADR-001 (modular monolith — extraction-ready boundaries)
 *   - Slice PRD v2.1 §11 (subscription handoff to Pharmacy + Refill)
 *   - Slice PRD v2.1 §17 (`intake_subscription_intent` event consumed by Pharmacy + Refill)
 */

import type { DbClient } from '../../lib/db.js';
import type { TenantId } from '../../lib/glossary.js';

import {
  findActiveDeployment,
  findSubmissionById,
} from './internal/repositories/submission-repo.js';
import type {
  FormDeployment,
  FormSubmission,
  FormSubmissionId,
  ProgramCatalogEntryId,
} from './internal/types.js';

// ---------------------------------------------------------------------------
// Public type re-exports
//
// Only types that cross the module boundary are re-exported here. The
// internal four-layer payload types (FormVersion, FormSnapshot, etc.) stay
// private — cross-module consumers receive opaque IDs, not the four-layer
// payload directly. This preserves the extraction-ready boundary per ADR-001.
// ---------------------------------------------------------------------------

export type { FormDeployment, FormSubmission } from './internal/types.js';
export type {
  FormDeploymentId,
  FormSubmissionId,
  FormTemplateId,
  FormVersionId,
  ProgramCatalogEntryId,
} from './internal/types.js';

// ---------------------------------------------------------------------------
// Plugin re-export — for src/app.ts registration only.
// ---------------------------------------------------------------------------

export { formsIntakePlugin } from './plugin.js';

// ---------------------------------------------------------------------------
// Public functions for cross-module consumers
// ---------------------------------------------------------------------------

/**
 * getActiveDeployment — used by Pharmacy + Refill (and other modules per
 * Slice PRD §11) to look up the active form deployment for a (tenant,
 * program) pair WITHOUT querying the forms tables directly.
 *
 * Returns null on miss (caller maps to a tenant-blind 404 per I-025).
 */
export async function getActiveDeployment(
  tenantId: TenantId,
  programCatalogEntryId: ProgramCatalogEntryId,
): Promise<FormDeployment | null> {
  return findActiveDeployment(tenantId, programCatalogEntryId);
}

/**
 * Result type for `verifySubmissionBindingEligibility`. Encapsulates
 * the authorization decision without exposing full submission PHI
 * across the module boundary.
 */
export type SubmissionBindingValidity =
  | { valid: true }
  | { valid: false; reason: 'not_found' | 'wrong_patient' | 'wrong_status' };

/**
 * verifySubmissionBindingEligibility — authorization-enforcing
 * forms-intake helper for cross-slice binding (Async Consult,
 * future Refill, etc.).
 *
 * Per Codex async-consult-r10 HIGH closure 2026-05-05: this REPLACES
 * the earlier `getSubmissionForBinding` which exposed the full
 * `FormSubmission` (including PHI `responses` payload) across the
 * module boundary. That was a trust-boundary regression — any
 * cross-module caller could read PHI by supplying tenantId +
 * submissionId without proving patient ownership.
 *
 * This function enforces all 3 binding-eligibility checks INSIDE
 * forms-intake (verifying tenant scope, patient ownership, status
 * eligibility) and returns ONLY a minimal {valid, reason?}
 * authorization result. PHI never crosses the module boundary.
 *
 * Tenant-blind error reporting: all three failure modes
 * (not_found / wrong_patient / wrong_status) are returned with
 * the same shape; the caller can choose to map to a uniform
 * tenant-blind error envelope per I-025 if appropriate. Not_found
 * AND wrong_patient AND cross-tenant are indistinguishable by the
 * caller's external surface — only wrong_status reveals the
 * submission's existence (acceptable because by the time we get
 * to status-check, the caller has already proven patient ownership).
 */
export async function verifySubmissionBindingEligibility(
  tenantId: TenantId,
  submissionId: FormSubmissionId,
  expectedPatientId: string,
  externalTx?: DbClient,
): Promise<SubmissionBindingValidity> {
  const submission = await findSubmissionById(tenantId, submissionId, externalTx);
  if (submission === null) {
    return { valid: false, reason: 'not_found' };
  }
  if (submission.patient_id !== expectedPatientId) {
    // Tenant-blind from the cross-patient perspective: don't reveal
    // whether the submission belongs to a different patient.
    return { valid: false, reason: 'wrong_patient' };
  }
  // Bind-eligible statuses (post-patient-submission lifecycle states).
  const bindEligibleStatuses: ReadonlyArray<FormSubmission['status']> = [
    'submitted',
    'ai_evaluated',
    'physician_reviewed',
    'approved',
  ];
  if (!bindEligibleStatuses.includes(submission.status)) {
    return { valid: false, reason: 'wrong_status' };
  }
  return { valid: true };
}
