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

import crypto from 'crypto';

import { crisisDetector } from '../../../../lib/crisis-detection.js';
import { type DbClient, type DbTransaction, withTransaction } from '../../../../lib/db.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import {
  emitCrisisDetectionTrigger,
  emitFormsSubmissionCompletedAudit,
  emitFormsSubmissionStartedAudit,
} from '../../audit.js';
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
import type { FormSubmission, FormSubmissionId, PatientId, ResumeStateMetadata } from '../types.js';

import { verifyResumeToken } from './resume-token.js';

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
 * Sentinel error code thrown by `updateResponses` when the I-019 crisis
 * detector fires on a free-text response value. The Category A
 * `crisis_detection_trigger` audit is committed BEFORE this throw — the
 * audit is the authoritative escalation record per Slice PRD §13 and
 * I-003 forbids bare-suppressing the detection. The handler maps this
 * sentinel to a specific HTTP envelope so the patient surface gets a
 * crisis-resources prompt rather than a generic 4xx.
 *
 * Closes Codex submissions-r1 CRITICAL-1 2026-05-03.
 */
export const CRISIS_DETECTED = 'forms.submission.crisis_detected';

/**
 * Sentinel error code thrown by `scanResponsesForCrisis` when an incoming
 * response payload exceeds the depth or node-count budget. The handler
 * maps this to HTTP 413 Payload Too Large.
 *
 * **Why this exists (Codex submissions-r1 verify-r2 HIGH closure
 * 2026-05-03):** the previous recursive walker leaned on JS call-stack
 * recursion; an attacker-controlled payload of thousands of nested
 * objects/arrays (well within the 1 MiB Fastify body limit) could trigger
 * `RangeError: Maximum call stack size exceeded` BEFORE any string was
 * examined. The RangeError isn't `CRISIS_DETECTED`, so the calling
 * `updateResponses` would have thrown it as an internal server error —
 * the I-019 escalation audit + 409 crisis-resources surface would never
 * fire even when the payload contained crisis text. The iterative
 * traversal below cannot blow the call stack, and the explicit budget
 * gives a deterministic 4xx (with audit) instead of a 5xx.
 */
export const RESPONSE_PAYLOAD_TOO_LARGE = 'forms.submission.response_payload_too_large';

/** Maximum nesting depth tolerated in a response payload. Realistic forms
 * with group/repeater hierarchies stay well under 10; 64 is generous. */
const MAX_RESPONSE_DEPTH = 64;

/** Maximum total node count examined during crisis scan. 50_000 covers
 * even pathologically-large legitimate payloads while bounding work. */
const MAX_RESPONSE_NODES = 50_000;

/**
 * Iteratively walk a response payload and call the platform-singleton
 * `crisisDetector` on every string value found at any depth. Returns the
 * first positive detection (narrowed to the `crisisDetected: true`
 * variant) or null.
 *
 * **Why iterate (Codex submissions-r1 verify-r2 HIGH closure
 * 2026-05-03):** the request schema is `responses: z.record(z.unknown())`
 * — values may be objects, arrays, strings, or any JSON. A recursive
 * walker (the previous shape) was bypassable by submitting a deeply
 * nested payload that overflowed the call stack before any string was
 * examined. Stack-based traversal with explicit depth + node-count
 * bounds closes the bypass; payloads exceeding the bounds throw
 * `RESPONSE_PAYLOAD_TOO_LARGE` and are rejected with HTTP 413, never
 * silently swallowed.
 *
 * **Why pre-existing schema validation isn't enough:** Zod's
 * `z.record(z.unknown())` deliberately admits arbitrary structure —
 * Forms Engine v5.2 requires this to support extensible field types.
 * The depth/node bound here is a Defense-in-Depth gate at the I-019
 * detection layer, not a schema constraint.
 */
function scanResponsesForCrisis(
  tenantId: string,
  responses: Record<string, unknown>,
): { crisisType: string } | null {
  type Frame = { value: unknown; depth: number };
  const stack: Frame[] = [{ value: responses, depth: 0 }];
  let nodesExamined = 0;

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break; // unreachable; for type narrowing
    nodesExamined += 1;
    if (nodesExamined > MAX_RESPONSE_NODES) {
      throw new Error(RESPONSE_PAYLOAD_TOO_LARGE);
    }
    if (frame.depth > MAX_RESPONSE_DEPTH) {
      throw new Error(RESPONSE_PAYLOAD_TOO_LARGE);
    }
    const { value, depth } = frame;

    if (typeof value === 'string') {
      const outcome = crisisDetector.detect(value, tenantId, 'form_response');
      if (outcome.crisisDetected) {
        return { crisisType: outcome.crisisType };
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        stack.push({ value: item, depth: depth + 1 });
      }
      continue;
    }
    if (value !== null && typeof value === 'object') {
      for (const child of Object.values(value as Record<string, unknown>)) {
        stack.push({ value: child, depth: depth + 1 });
      }
      continue;
    }
    // Numbers, booleans, null, undefined — no crisis text possible.
  }
  return null;
}

/**
 * Persist partial-progress responses (auto-save per §8.1 or explicit
 * "Save and continue later" per §8.2). When `pause === true`, also creates
 * the ResumeState + emits `forms_resume_state.saved` domain event.
 *
 * **Crisis detection (I-019 platform-floor — Codex submissions-r1
 * CRITICAL-1 closure 2026-05-03):** every string value in the response
 * payload is scanned by the platform-singleton `crisisDetector` BEFORE
 * the responses persist. On detection:
 *   1. Emit Category A `crisis_detection_trigger` audit in its OWN
 *      transaction (the audit MUST be durable even though the response
 *      write doesn't proceed — bare suppression forbidden per I-003).
 *   2. Throw the `CRISIS_DETECTED` sentinel; the handler maps it to a
 *      HTTP response that surfaces crisis resources to the patient
 *      (Slice PRD §13 escalation pathway).
 *   3. The responses write does NOT commit — escalation takes precedence.
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
 *   - `forms.submission.crisis_detected` — I-019 detection fired.
 *   - `forms.submission.not_found` — submission doesn't exist in this
 *     tenant OR isn't owned by the resolved actor. Tenant-blind 400.
 *   - `forms.submission.not_in_progress` — submission exists but its
 *     status isn't `in_progress`. I-013 immutability. Tenant-blind 400.
 */
export async function updateResponses(
  ctx: TenantContext,
  actor: { actorId: string; patientId: PatientId; delegateId: string | null },
  submissionId: FormSubmissionId,
  input: UpdateSubmissionResponsesRequest,
  externalTx?: DbTransaction,
): Promise<FormSubmission> {
  // I-019 platform-floor scan (always-on; never disabled).
  const crisis = scanResponsesForCrisis(ctx.tenantId, input.responses);
  if (crisis !== null) {
    // Emit the Category A audit in its own transaction so it commits even
    // though the response write below does NOT run. The escalation event
    // MUST be durable per I-003 + I-019; we cannot let it ride on the
    // same tx that we're about to abort.
    //
    // When externalTx is supplied (test mode), share that tx — the audit
    // commits with the test's outer transaction same as anything else.
    await withTransaction(async (tx) => {
      await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
      await emitCrisisDetectionTrigger(
        {
          tenantId: ctx.tenantId,
          actorId: actor.actorId,
          actorTenantId: ctx.tenantId,
          countryOfCare: ctx.countryOfCare,
          targetPatientId: actor.patientId,
          detectionSource: 'form_response',
          crisisType: crisis.crisisType,
          resourceType: 'forms_submission',
          resourceId: submissionId,
        },
        tx,
      );
    }, externalTx);
    throw new Error(CRISIS_DETECTED);
  }

  return submissionRepo.updateSubmissionResponses(
    ctx.tenantId,
    submissionId,
    input.responses,
    { patientId: actor.patientId, delegateId: actor.delegateId },
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
    { patientId: actor.patientId, delegateId: actor.delegateId },
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
 * **Still DEFERRED** (the patient-side restoration of partial responses
 * lives behind several open dependencies):
 *
 *   - Migration 006 has no `submission_id` column on `forms_resume_state`,
 *     so the (resume_state ↔ submission) binding required to surface a
 *     restored FormSubmission is not yet representable in storage. Either
 *     migration 007 must add it or the service must reconstruct via
 *     `(tenant, deployment, patient, status='in_progress')`.
 *   - The pause/write side that *creates* resume_state rows isn't wired
 *     yet (`updateResponses` `pause === true` path is still TODO), so
 *     end-to-end POST /v0/forms/resume cannot be tested without seeding
 *     rows directly via SQL. Defer until the pause side lands.
 *   - KMS-decryption of `encrypted_partial_responses` requires the
 *     `kms.decrypt(tenant, ciphertext)` integration that the v0.1 stub
 *     gates behind NODE_ENV=test only. Production wiring lands with the
 *     Identity & Auth slice or its successor.
 *
 * The metadata-only read path (`getResumeStateMetadata` below) does NOT
 * depend on any of the above and IS shipping in this batch.
 */
export async function resumeSubmission(
  _ctx: TenantContext,
  _actor: { actorId: string; patientId: PatientId | null },
  _input: ResumeSubmissionRequest,
): Promise<FormSubmission> {
  throw new Error('not implemented');
}

/**
 * Read the metadata view of a resume_state — what the patient app surfaces
 * on the dashboard ("[N]% complete · Resume") before the patient clicks.
 * Metadata only: deployment_id, progress, section, expiry, last_saved_at —
 * NEVER decrypts `encrypted_partial_responses`, NEVER returns tenant_id
 * (per Master PRD §17 + Glossary v5.2 patient-surface rule: internal
 * operating-tenant identifiers must not render in patient APIs).
 *
 * Token validation pipeline (Codex resume-r1 closure 2026-05-03 elevated
 * the token from sole-bearer-of-authorization to one factor among several):
 *
 *   1. `verifyResumeToken` checks structure + HMAC signature + token-level
 *      expiry. Returns null on any failure (constant-time HMAC compare).
 *   2. The token's tenant_id binding MUST match the request's resolved
 *      tenant context. A token issued in tenant A presented in tenant B
 *      surfaces as the same null shape as a missing row (I-025
 *      tenant-blind).
 *   3. The repo lookup (`findResumeStateById`) is RLS-guarded. Even if a
 *      token survived steps 1-2 with cross-tenant identity (it shouldn't,
 *      but defense-in-depth), RLS rejects the row.
 *   4. **Patient/device ownership** (Codex resume-r1 HIGH closure): the
 *      row's identity anchor MUST match the request's resolved actor.
 *      For known-patient rows (`patient_id NOT NULL`), `ownership.patientId`
 *      must equal `row.patient_id`. For anonymous-flow rows
 *      (`device_anonymous_token NOT NULL`), `ownership.deviceAnonymousToken`
 *      must equal `row.device_anonymous_token`. Without this gate the URL
 *      token is a single-factor bearer credential — anyone who scrapes
 *      a forwarded link or browser-history entry could read same-tenant
 *      resume metadata. Mismatch surfaces as null per I-025.
 *   5. The row's `status` must be `active`. `completed` (already restored)
 *      and `expired` (cleanup-job processed) both surface as null per
 *      I-025; we never differentiate "wrong state" from "missing" in the
 *      patient surface.
 *   6. The row's `expires_at` must be in the future. The token-level
 *      expiry from step 1 SHOULD agree with this, but defense-in-depth:
 *      if a token expiry is somehow ahead of the row expiry, the row
 *      check still rejects.
 *
 * Returns null on every failure mode. Handler maps null to a tenant-blind
 * 404 envelope per I-025 ERROR_MODEL v5.1.
 */
export async function getResumeStateMetadata(
  ctx: TenantContext,
  ownership: { patientId: PatientId | null; deviceAnonymousToken: string | null },
  resumeToken: string,
  externalTx?: DbClient,
): Promise<ResumeStateMetadata | null> {
  const verified = verifyResumeToken(resumeToken);
  if (verified === null) return null;

  // Step 2: token tenant_id binding must match request context. Caller's
  // tenant is the source of truth; never trust the token's claim alone.
  if (verified.tenantId !== ctx.tenantId) return null;

  // Step 3: RLS-guarded lookup by primary key.
  const row = await submissionRepo.findResumeStateById(
    ctx.tenantId,
    verified.resumeStateId,
    externalTx,
  );
  if (row === null) return null;

  // Step 4: patient/device ownership gate (Codex resume-r1 HIGH closure).
  // The row carries exactly one identity anchor (the migration's CHECK
  // constraint enforces `patient_id IS NOT NULL OR device_anonymous_token
  // IS NOT NULL`). Match the request's resolved actor against whichever
  // anchor is present; reject otherwise.
  if (row.patient_id !== null) {
    // Known-patient row: actor must be that patient.
    if (ownership.patientId === null) return null;
    if (row.patient_id !== ownership.patientId) return null;
  } else if (row.device_anonymous_token !== null) {
    // Anonymous-flow row: actor must hold the device-anonymous token.
    // Compared with constant-time equality so token equality timing
    // cannot be probed — same discipline as the HMAC compare.
    if (ownership.deviceAnonymousToken === null) return null;
    if (!timingSafeStringEqual(row.device_anonymous_token, ownership.deviceAnonymousToken)) {
      return null;
    }
  } else {
    // Defensive: a row with neither identity anchor shouldn't exist
    // (DB CHECK constraint), but if one slipped in via another path we
    // refuse to surface metadata. Safe-by-default.
    return null;
  }

  // Step 5: status gate.
  if (row.status !== 'active') return null;

  // Step 6: row-level expiry gate (defense-in-depth alongside token-level).
  if (Date.parse(row.expires_at) <= Date.now()) return null;

  // Per the patient-surface rule (Master PRD §17 + Glossary v5.2 C3),
  // tenant_id is internal operating-tenant identity and MUST NOT appear
  // in patient-facing API responses. We project only the non-internal
  // fields the dashboard needs to render the "[N]% complete · Resume" tile.
  return {
    resume_state_id: row.resume_state_id,
    deployment_id: row.deployment_id,
    current_section_index: row.current_section_index,
    progress_percent: row.progress_percent,
    status: row.status,
    expires_at: row.expires_at,
    last_saved_at: row.last_saved_at,
  };
}

/**
 * Constant-time string equality. Wraps `crypto.timingSafeEqual` with the
 * length check that crypto's primitive throws on, so callers can pass two
 * potentially-mismatched-length strings without an exception.
 */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Read a submission by ID. Tenant-blind 404 per I-025 — returns null when
 * not found, in a different tenant, OR not owned by the resolved actor
 * (Codex submissions-r1 CRITICAL-2 closure 2026-05-03 — patient-level
 * access enforcement; the prior implementation only checked tenant scope
 * via RLS, so any patient in the same tenant could read another
 * patient's PHI by guessing a submission_id).
 *
 * `ownership` is required: the caller MUST identify whose data is being
 * read. If the row's `patient_id` doesn't match `ownership.patientId`,
 * the function returns null (NOT a thrown sentinel) so the surface
 * shape matches "row absent" exactly per I-025.
 */
export async function getSubmission(
  ctx: TenantContext,
  ownership: { patientId: PatientId; delegateId: string | null },
  submissionId: FormSubmissionId,
  externalTx?: DbClient,
): Promise<FormSubmission | null> {
  const submission = await submissionRepo.findSubmissionById(
    ctx.tenantId,
    submissionId,
    externalTx,
  );
  if (submission === null) {
    return null;
  }
  // Patient-level access check — must match the row's owner. Delegate
  // path: when the row carries a delegate_id, the actor's delegateId
  // must also match (no rotating delegates mid-flow).
  if (submission.patient_id !== ownership.patientId) {
    return null;
  }
  if (submission.delegate_id !== null && submission.delegate_id !== ownership.delegateId) {
    return null;
  }
  return submission;
}
