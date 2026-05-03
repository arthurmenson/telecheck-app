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

import { findActiveDeployment } from './internal/repositories/submission-repo.js';
import type { TenantId } from '../../lib/glossary.js';
import type { FormDeployment, ProgramCatalogEntryId } from './internal/types.js';

// ---------------------------------------------------------------------------
// Public type re-exports
//
// Only types that cross the module boundary are re-exported here. The
// internal four-layer payload types (FormVersion, FormSnapshot, etc.) stay
// private — cross-module consumers receive opaque IDs, not the four-layer
// payload directly. This preserves the extraction-ready boundary per ADR-001.
// ---------------------------------------------------------------------------

export type { FormDeployment } from './internal/types.js';
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
