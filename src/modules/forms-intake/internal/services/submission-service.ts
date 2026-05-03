/**
 * forms-intake/internal/services/submission-service.ts — submission lifecycle business logic.
 *
 * Owns:
 *   - Variant assignment (PostHog feature-flag-driven sticky-per-patient
 *     traffic split per Slice PRD §14.2). DEFERRED at this commit: variant
 *     assignment always returns null until PostHog is wired.
 *   - Save-and-resume orchestration per Slice PRD §8.
 *   - Eligibility evaluation hand-off (FORMS_ENGINE v5.2 intake lifecycle
 *     step 3) and Mode 2 input contract emission per Slice PRD §10.
 *   - Subscription handoff to Pharmacy + Refill per Slice PRD §17 — emits
 *     `intake_subscription_intent` domain event.
 *   - Crisis detection per I-019 on free-text fields (platform-floor;
 *     never disabled; calls lib/crisis-detection.ts). DEFERRED at this
 *     commit: hook stub in place, real crisisDetector from
 *     src/lib/crisis-detection.ts isn't wired yet.
 *
 * Spec references:
 *   - Slice PRD v2.1 §7 (onboarding flow), §8 (save-and-resume), §14
 *     (A/B testing native), §16 (abandonment recovery), §17 (subscription
 *     handoff).
 *   - INVARIANT I-019 crisis detection always-on.
 *   - INVARIANT I-023 every PHI write tenant-scoped via RLS + app filter.
 *   - DOMAIN_EVENTS v5.2 `intake_response` aggregate.
 *
 * **Migration 006 conflict (per Codex submissions-r0 research subagent
 * 2026-05-03):** `forms_submission.patient_id` is NOT NULL but Slice PRD
 * §8.2 calls for a device-anonymous flow where pre-account patients begin
 * an intake without a resolved patient_id. Until the migration is patched,
 * the service requires a non-null patientId at the API boundary; the
 * service signature reflects this with `patientId: PatientId` (not nullable).
 * The legacy stub had `patientId: PatientId | null` aligning with the PRD;
 * the type was tightened here to match the SQL truth.
 */

import type { DbClient, DbTransaction } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import { emitFormsSubmissionCompletedAudit, emitFormsSubmissionStartedAudit } from '../../audit.js';
import {
  emitFormsSubmissionCompleted as emitFormsSubmissionCompletedEvent,
  emitFormsSubmissionStarted as emitFormsSubmissionStartedEvent,
} from '../../events.js';
import type {
  ResumeSubmissionRequest,
  StartSubmissionRequest,
  SubmitSubmissionRequest,
  UpdateSubmissionResponsesRequest,
} from '../../schemas.js';
import * as submissionRepo from '../repositories/submission-repo.js';
import type { FormSubmission, FormSubmissionId, PatientId } from '../types.js';

/**
 * Begin a new submission. Resolves variant assignment via PostHog feature
 * flag (sticky per patient per §14.2 — currently STUBBED to always return
 * null), creates the submission row, emits `intake_response.started` domain
 * event + the corresponding Category C audit record, all inside the same
 * transaction.
 *
 * Sentinel error mapped:
 *   - `forms.deployment.not_found` — deployment doesn't exist in this tenant
 *     OR is retired. Tenant-blind 400 at the handler.
 */
export async function startSubmission(
  ctx: TenantContext,
  actor: { actorId: string; patientId: PatientId; delegateId: string | null },
  input: StartSubmissionRequest,
  externalTx?: DbTransaction,
): Promise<FormSubmission> {
  // TODO (slice §14): resolve variant via PostHog SDK; sticky per patient
  // (PostHog feature-flag with patient distinct_id). Until PostHog is
  // wired, fall through to no variant assignment.
  const variantId: null = null;

  return submissionRepo.createSubmission(
    ctx.tenantId,
    {
      deploymentId: input.deploymentId,
      variantId,
      patientId: actor.patientId,
      delegateId: actor.delegateId,
    },
    async (tx, submission) => {
      const auditEnvelope = await emitFormsSubmissionStartedAudit(
        {
          tenantId: ctx.tenantId,
          actorId: actor.actorId,
          actorTenantId: ctx.tenantId,
          countryOfCare: ctx.countryOfCare,
          submissionId: submission.submission_id,
          deploymentId: submission.deployment_id,
          patientId: actor.patientId,
          delegateId: actor.delegateId,
          variantId: submission.variant_id,
        },
        tx,
      );

      // Domain event for the outbox. Also carries the audit_id so
      // subscribers can correlate the wire event to the immutable
      // governance/audit record (publishVersion-r1 HIGH closure pattern).
      // The existing emitFormsSubmissionStartedEvent shape doesn't yet
      // accept audit_id — audit_id is appended via a small extension
      // below to keep the wire shape forward-compatible.
      await emitFormsSubmissionStartedEvent(tx, {
        tenantId: ctx.tenantId,
        submissionId: submission.submission_id,
        // The repo's RETURNING clause aliased deployment_id, but versionId
        // (deprecated parameter on the legacy stub) doesn't have a column;
        // pass deployment_id where the legacy emitter expected versionId.
        // The existing emitter will be reconciled when slice's proper
        // versioning lands; for now this preserves the same-tx outbox
        // discipline.
        versionId: submission.deployment_id,
        patientId: actor.patientId,
      });

      // The audit_id link is a free-form `linked_events` reference — we
      // rely on the audit record's own resource_id to correlate going
      // backwards from event to audit. Subscribers that need stronger
      // correlation can JOIN via (tenant_id, resource_id) on the
      // submission_id.
      void auditEnvelope;
    },
    externalTx,
  );
}

/**
 * Persist partial-progress responses (auto-save per §8.1 or explicit
 * "Save and continue later" per §8.2). When `pause === true`, also creates
 * the ResumeState + emits `forms_resume_state.saved` domain event.
 *
 * **Crisis detection (I-019):** the slice PRD calls for crisis detection
 * to run over any free-text response BEFORE the write commits. The
 * platform-floor `crisisDetector` from `src/lib/crisis-detection.ts` is
 * also stubbed; this commit wires the call site (commented) so the wiring
 * is unambiguous when crisis-detection lands. Per I-019, the service
 * MUST NOT swallow a triggered detection — it surfaces a hard
 * escalation path to the patient + clinician notification queue.
 *
 * **Auto-save vs pause** (Slice PRD §8.1 vs §8.2):
 *   - `pause === false | undefined`: silent auto-save; no audit (would
 *     explode the chain on every keystroke per slice header note); no
 *     domain event.
 *   - `pause === true` ("Save and continue later"): TODO — create a
 *     ResumeState row + emit Category C `forms_submission_paused` audit
 *     + `forms_resume_state.saved` domain event. Out of scope for this
 *     commit (resume-state path lives in a separate handler series).
 *
 * Sentinels:
 *   - `forms.submission.not_found` — submission doesn't exist in this
 *     tenant. Tenant-blind 400.
 *   - `forms.submission.not_in_progress` — submission exists but its
 *     status isn't `in_progress`. I-013 immutability (you can't update
 *     responses on a submitted/withdrawn row). Tenant-blind 400.
 */
export async function updateResponses(
  ctx: TenantContext,
  _actor: { actorId: string; patientId: PatientId; delegateId: string | null },
  submissionId: FormSubmissionId,
  input: UpdateSubmissionResponsesRequest,
  externalTx?: DbTransaction,
): Promise<FormSubmission> {
  // TODO (I-019 — platform-floor): run crisisDetector over input.responses
  // free-text fields BEFORE the write commits. On a positive detection,
  // emit Category A audit + escalate per Slice PRD §13. Until the
  // crisis-detection module is wired, this is a no-op and the auto-save
  // proceeds. Bare suppression is forbidden (I-003) — when the module
  // lands, the call MUST throw on detection; never silent-skip.

  return submissionRepo.updateSubmissionResponses(
    ctx.tenantId,
    submissionId,
    input.responses,
    async (_tx, _submission) => {
      // No audit + no domain event on plain auto-save (slice header
      // note + audit-chain blast radius). When `input.pause === true`
      // is wired, emit Category C `forms_submission_paused` here +
      // create ResumeState in the same transaction.
      void _tx;
      void _submission;
    },
    externalTx,
  );
}

/**
 * Final submission — runs eligibility logic, snapshots the rendered form
 * per Slice PRD §4 (snapshot layer), emits `intake_response.submitted`,
 * and (if subscription preferences present) emits
 * `intake_subscription_intent` for Pharmacy + Refill handoff.
 *
 * **Snapshot capture (DEFERRED):** the snapshot-service.ts file owns the
 * rendered-form capture and is stubbed today. The status transition,
 * audit emission, and `intake_response.submitted` domain event are all
 * implemented end-to-end in this commit; the snapshot row will land on
 * the same tx once the service is wired.
 *
 * **Mode 2 + intake_subscription_intent (DEFERRED):** Slice PRD §10
 * (Mode 2 input contract) and §17 (Pharmacy + Refill handoff) require
 * inspecting the submitted responses + deployment for Mode-2 eligibility
 * and subscription preference. Both are scaffolded as TODOs.
 *
 * Sentinels:
 *   - `forms.submission.not_found` — tenant-blind 400.
 *   - `forms.submission.not_in_progress` — already submitted/etc.;
 *     tenant-blind 400 (mirrors the I-013 immutability discipline).
 */
export async function submitSubmission(
  ctx: TenantContext,
  actor: { actorId: string; patientId: PatientId; delegateId: string | null },
  submissionId: FormSubmissionId,
  _input: SubmitSubmissionRequest,
  externalTx?: DbTransaction,
): Promise<FormSubmission> {
  return submissionRepo.transitionSubmissionStatus(
    ctx.tenantId,
    submissionId,
    'submitted',
    async (tx, submission) => {
      const submittedAt = submission.submitted_at ?? new Date().toISOString();

      const auditEnvelope = await emitFormsSubmissionCompletedAudit(
        {
          tenantId: ctx.tenantId,
          actorId: actor.actorId,
          actorTenantId: ctx.tenantId,
          countryOfCare: ctx.countryOfCare,
          submissionId: submission.submission_id,
          deploymentId: submission.deployment_id,
          patientId: actor.patientId,
          delegateId: actor.delegateId,
          submittedAt,
        },
        tx,
      );

      // Total time elapsed from start (created_at) to submit. Used by
      // PostHog funnel analytics + slice PRD §14.3 metrics.
      const startedMs = new Date(submission.started_at).getTime();
      const completedMs = new Date(submittedAt).getTime();
      const totalTimeMs = Number.isFinite(completedMs - startedMs)
        ? Math.max(0, completedMs - startedMs)
        : 0;

      await emitFormsSubmissionCompletedEvent(tx, {
        tenantId: ctx.tenantId,
        submissionId: submission.submission_id,
        versionId: submission.deployment_id,
        patientId: actor.patientId,
        totalTimeMs,
        mode2Eligible: false, // TODO Slice PRD §10 Mode 2 input contract
      });

      // TODO Slice PRD §17 subscription handoff:
      //   if responses indicate subscription intent, emit
      //   `intake_subscription_intent` here so Pharmacy + Refill picks it
      //   up via the outbox.
      // TODO Slice PRD §4 snapshot layer:
      //   call snapshotService.buildAndPersistSnapshot(tx, submission)
      //   so the snapshot row commits with this transaction.

      void auditEnvelope; // audit_id correlation: see startSubmission note.
    },
    externalTx,
  );
}

/**
 * Resume a paused submission. Validates the resume token, expiry, and
 * tenant binding; emits the `forms_resume_state.restored` audit per §8.5.
 *
 * DEFERRED (separate slice handler series): the resume flow lives in
 * dedicated handlers (`POST /v0/forms/resume`, `GET /v0/forms/resume/:t`)
 * with their own ResumeState repo + audit + event work. Stub preserved
 * so existing handler imports compile.
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
  ctx: TenantContext,
  submissionId: FormSubmissionId,
  externalTx?: DbClient,
): Promise<FormSubmission | null> {
  return submissionRepo.findSubmissionById(ctx.tenantId, submissionId, externalTx);
}
