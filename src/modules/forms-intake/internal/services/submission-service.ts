/**
 * forms-intake/internal/services/submission-service.ts — submission lifecycle business logic.
 *
 * Owns:
 *   - Variant assignment (PostHog feature-flag-driven sticky-per-patient
 *     traffic split per Slice PRD §14.2).
 *   - Save-and-resume orchestration per Slice PRD §8.
 *   - Eligibility evaluation hand-off (FORMS_ENGINE v5.2 intake lifecycle
 *     step 3) and Mode 2 input contract emission per Slice PRD §10.
 *   - Subscription handoff to Pharmacy + Refill per Slice PRD §17 — emits
 *     `intake_subscription_intent` domain event.
 *   - Crisis detection per I-019 on free-text fields (platform-floor;
 *     never disabled; calls lib/crisis-detection.ts).
 *
 * Spec references:
 *   - Slice PRD v2.1 §7 (onboarding flow), §8 (save-and-resume), §14
 *     (A/B testing native), §16 (abandonment recovery), §17 (subscription
 *     handoff).
 *   - INVARIANT I-019 crisis detection always-on.
 *   - INVARIANT I-023 every PHI write tenant-scoped via RLS + app filter.
 *   - DOMAIN_EVENTS v5.2 `intake_response` aggregate.
 */

import type { TenantContext } from '../../../../lib/tenant-context.js';
import type {
  ResumeSubmissionRequest,
  StartSubmissionRequest,
  SubmitSubmissionRequest,
  UpdateSubmissionResponsesRequest,
} from '../../schemas.js';
import type { FormSubmission, FormSubmissionId, PatientId } from '../types.js';

/**
 * Begin a new submission. Resolves variant assignment via PostHog feature
 * flag (sticky per patient per §14.2), creates the submission row, emits
 * `intake_response.started` domain event + the corresponding audit record,
 * all inside the same transaction.
 */
export async function startSubmission(
  _ctx: TenantContext,
  _actor: { actorId: string; patientId: PatientId | null },
  _input: StartSubmissionRequest,
): Promise<FormSubmission> {
  // TODO: resolve variant (PostHog SDK), persist submission, emit domain
  // event + audit inside the txCallback per submission-repo.createSubmission.
  throw new Error('not implemented');
}

/**
 * Persist partial-progress responses (auto-save per §8.1 or explicit
 * "Save and continue later" per §8.2). When `pause === true`, also creates
 * the ResumeState + emits `forms_resume_state.saved` domain event.
 *
 * Crisis detection per I-019 runs over any free-text response BEFORE the
 * write commits — surfaces a hard escalation path if triggered.
 */
export async function updateResponses(
  _ctx: TenantContext,
  _actor: { actorId: string; patientId: PatientId | null },
  _submissionId: FormSubmissionId,
  _input: UpdateSubmissionResponsesRequest,
): Promise<FormSubmission> {
  throw new Error('not implemented');
}

/**
 * Final submission — runs eligibility logic, snapshots the rendered form
 * per Slice PRD §4 (snapshot layer), emits `intake_response.submitted`,
 * and (if subscription preferences present) emits
 * `intake_subscription_intent` for Pharmacy + Refill handoff.
 */
export async function submitSubmission(
  _ctx: TenantContext,
  _actor: { actorId: string; patientId: PatientId },
  _submissionId: FormSubmissionId,
  _input: SubmitSubmissionRequest,
): Promise<FormSubmission> {
  // TODO: snapshot via snapshot-repo; transition status; emit domain events;
  // emit audit; conditionally emit intake_subscription_intent.
  throw new Error('not implemented');
}

/**
 * Resume a paused submission. Validates the resume token, expiry, and
 * tenant binding; emits the `forms_resume_state.restored` audit per §8.5.
 */
export async function resumeSubmission(
  _ctx: TenantContext,
  _actor: { actorId: string; patientId: PatientId | null },
  _input: ResumeSubmissionRequest,
): Promise<FormSubmission> {
  throw new Error('not implemented');
}

/**
 * Read a submission by ID. Tenant-blind 404 per I-025 — returns null when
 * not found OR when found in a different tenant.
 */
export async function getSubmission(
  _ctx: TenantContext,
  _submissionId: FormSubmissionId,
): Promise<FormSubmission | null> {
  throw new Error('not implemented');
}
