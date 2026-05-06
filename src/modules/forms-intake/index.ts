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
 * getSubmissionForBinding — used by Async Consult slice to verify a
 * forms_submission row before binding it to a consult at the
 * INTAKE → SUBMITTED transition. Returns the full submission record
 * (or null if not found / cross-tenant filtered).
 *
 * Caller MUST verify the returned submission's `patient_id` matches
 * the consult's patient_id AND `status` is terminal ('submitted'
 * or 'completed' — NOT 'in_progress' or 'paused') before binding.
 *
 * Per Codex async-consult-r9 HIGH closure 2026-05-05: this cross-slice
 * surface exists specifically to prevent same-tenant attackers from
 * binding incomplete or wrong-patient submissions to consults via a
 * known submission_id.
 */
export async function getSubmissionForBinding(
  tenantId: TenantId,
  submissionId: FormSubmissionId,
  externalTx?: DbClient,
): Promise<FormSubmission | null> {
  return findSubmissionById(tenantId, submissionId, externalTx);
}
