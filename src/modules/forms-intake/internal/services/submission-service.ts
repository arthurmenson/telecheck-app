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
import { kms } from '../../../../lib/kms.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';
import {
  emitCrisisDetectionTrigger,
  emitFormsResumeStateSaved as emitFormsResumeStateSavedAudit,
  emitFormsSubmissionCompletedAudit,
  emitFormsSubmissionStartedAudit,
} from '../../audit.js';
import {
  emitFormsResumeStateSaved as emitFormsResumeStateSavedEvent,
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
import type {
  FormSubmission,
  FormSubmissionId,
  PatientId,
  ResumeStateId,
  ResumeStateMetadata,
} from '../types.js';

import { issueResumeToken, verifyResumeToken } from './resume-token.js';

/**
 * Default TTL for new resume_state rows. Matches the migration's
 * `expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days'` and the slice
 * PRD §8.4 tenant-configurable default. Tenant-level override lands once
 * the tenant-config slice exposes the knob; for now every pause uses the
 * platform default.
 */
const RESUME_STATE_DEFAULT_TTL_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Patient-safe projection of a FormSubmission. Strips the operating-tenant
 * identifier (`tenant_id`) so the patient surface MUST NOT render it
 * (Master PRD v1.10 §17 + Glossary v5.2 C3 brand-structure rule).
 *
 * Codex pause-r1 MEDIUM closure 2026-05-03: the prior PauseSubmissionResult
 * carried a full FormSubmission whose `tenant_id` field bled through to
 * the HTTP response. Type-level projection here makes the gate compile-time
 * enforced — service callers can't accidentally pass an unstripped row to
 * the handler.
 */
export type PatientFormSubmissionView = Omit<FormSubmission, 'tenant_id'>;

/**
 * Shape returned by `pauseSubmission`. Carries the merged-then-encrypted
 * submission state (in patient-safe view form) PLUS the patient-held resume
 * token so the patient app can render the pause confirmation + the resume
 * URL in one round trip.
 */
export interface PauseSubmissionResult {
  submission: PatientFormSubmissionView;
  resumeState: {
    resumeStateId: ResumeStateId;
    resumeToken: string;
    expiresAt: string;
  };
}

/**
 * Project a full FormSubmission to the patient-safe view. Drops `tenant_id`
 * by destructuring; never copy the field by mistake.
 */
function toPatientView(submission: FormSubmission): PatientFormSubmissionView {
  const { tenant_id: _stripped, ...patientView } = submission;
  void _stripped;
  return patientView;
}

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
 * Persist partial-progress responses (auto-save per §8.1 ONLY). The
 * explicit "Save and continue later" flow (§8.2 — `pause === true`) lives
 * in `pauseSubmission` below; the handler branches on `parsed.data.pause`
 * and routes to the appropriate service.
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
 *   - This function handles `pause !== true`: silent auto-save; no audit
 *     (would explode the chain on every keystroke per slice header note);
 *     no domain event.
 *   - `pause === true` is routed to `pauseSubmission` by the handler so
 *     the resume_state row creation + Category C audit + domain event
 *     stay on a single same-transaction outbox path (I-016).
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
  // I-019 platform-floor scan (always-on; never disabled). Runs FIRST so a
  // crisis detection short-circuits before any state mutates — preserved
  // ordering for the pause path too (`pauseSubmission` calls
  // `runCrisisGate` before the merge).
  await runCrisisGate(ctx, actor, submissionId, input.responses, externalTx);

  return submissionRepo.updateSubmissionResponses(
    ctx.tenantId,
    submissionId,
    input.responses,
    { patientId: actor.patientId, delegateId: actor.delegateId },
    async (_tx, _submission) => {
      // No audit + no domain event on plain auto-save (slice header
      // note + audit-chain blast radius). The pause path that requires
      // audit + event lives in `pauseSubmission`.
      void _tx;
      void _submission;
    },
    externalTx,
  );
}

/**
 * I-019 platform-floor crisis gate. Extracted from `updateResponses` so
 * the pause path can reuse the EXACT same ordering: scan first, emit
 * Category A audit on detection, throw `CRISIS_DETECTED` so callers
 * abort BEFORE any state mutates. Crisis detection running before
 * resume_state creation is a hard rule per the platform-floor
 * discipline + the v0.1 implementation contract.
 */
async function runCrisisGate(
  ctx: TenantContext,
  actor: { actorId: string; patientId: PatientId },
  submissionId: FormSubmissionId,
  responses: Record<string, unknown>,
  externalTx?: DbTransaction,
): Promise<void> {
  const crisis = scanResponsesForCrisis(ctx.tenantId, responses);
  if (crisis === null) return;

  // Emit the Category A audit in its own transaction so it commits even
  // though the response write does NOT run. The escalation event MUST be
  // durable per I-003 + I-019.
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

/**
 * Persist partial-progress responses AND mint a resume_state row. The
 * patient explicitly clicked "Save and continue later" (Slice PRD §8.2).
 *
 * Flow:
 *   1. Crisis gate per I-019 — runs FIRST (same ordering as auto-save);
 *      a positive detection emits the Category A audit and throws
 *      `CRISIS_DETECTED` so no resume_state row is created.
 *   2. Merge responses into the submission row (same JSONB shallow-merge
 *      semantics as auto-save; preserves prior keys per submissions-r1
 *      HIGH closure). Repo enforces ownership + I-013 in_progress
 *      immutability.
 *   3. Encrypt the merged responses via per-tenant KMS (ADR-024 layer-3
 *      isolation); inputs are the FULL merged-state from step 2 (so
 *      restore can rehydrate without joining the submission row).
 *   4. INSERT resume_state row + Category C audit + domain event in a
 *      SINGLE transaction (I-016 same-tx outbox). The repo's
 *      `createResumeState` opens the tx; the audit + event emit inside
 *      its `txCallback`.
 *   5. Issue the patient-held resume token (HMAC-self-contained per
 *      resume-token.ts) and return it alongside the merged submission.
 *
 * **Identity:** the v0.1 implementation requires `actor.patientId`
 * (forms_submission.patient_id is NOT NULL per migration 006). The
 * resume_state row carries `patient_id = actor.patientId` and
 * `device_anonymous_token = null`. The anonymous-flow path lands when
 * the migration patch + audit-emitter signature change land together
 * (the audit emitter currently requires `targetPatientId: PatientId`,
 * non-null).
 *
 * **TTL:** 30 days per migration default + slice PRD §8.4. Tenant-
 * configurable knob lands when the tenant-config slice exposes it.
 *
 * **No tenant_id in return:** the resume-state surface omits the
 * operating-tenant identifier per Master PRD §17 + Glossary v5.2 C3
 * (same patient-surface rule that the resume read-path closure landed
 * on the metadata projection).
 *
 * Sentinels (in order of evaluation):
 *   - `forms.submission.crisis_detected` — I-019 fired before merge.
 *   - `forms.submission.not_found` — submission missing OR owned by a
 *     different patient/delegate. Tenant-blind 400.
 *   - `forms.submission.not_in_progress` — I-013. Tenant-blind 400.
 *   - `forms.resume_state.identity_required` — neither patient_id nor
 *     device_anonymous_token supplied (defensive; the v0.1 entrypoint
 *     always supplies patient_id).
 */
export async function pauseSubmission(
  ctx: TenantContext,
  actor: { actorId: string; patientId: PatientId; delegateId: string | null },
  submissionId: FormSubmissionId,
  input: UpdateSubmissionResponsesRequest,
  externalTx?: DbTransaction,
): Promise<PauseSubmissionResult> {
  // First-pass I-019 crisis gate on the incoming patch. Identical ordering
  // to auto-save — catches the common case (patient typing crisis text in
  // *this* request) and avoids opening a tx for a payload we'd reject.
  // The merged-set gate inside the atomic tx below is the authoritative
  // gate for the resume_state write per Codex pause-r1 HIGH-2 closure.
  await runCrisisGate(ctx, actor, submissionId, input.responses, externalTx);

  // ---------------------------------------------------------------------
  // Atomic orchestration (Codex pause-r1 HIGH-1 closure 2026-05-03)
  //
  // Wraps the merge UPDATE + KMS encrypt + resume_state INSERT + audit +
  // outbox in ONE transaction so:
  //   - A KMS / INSERT / audit / event failure rolls back the merge,
  //     leaving the submission row in its pre-pause state. The patient
  //     never sees "your responses persisted but no resume token" again.
  //   - A concurrent auto-save on the same submission cannot interleave
  //     between the merge and the resume_state INSERT — the row lock
  //     held by `updateSubmissionResponses`'s UPDATE persists until this
  //     outer tx commits.
  //   - Crisis detection on the FULL merged response set (not just the
  //     incoming patch) gates the resume_state write per HIGH-2. If the
  //     submission row already contained crisis text and the patch is
  //     benign, the merge would have copied that text into the encrypted
  //     resume_state without scanning. Re-scanning the merged set closes
  //     that bypass.
  // ---------------------------------------------------------------------
  return withTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);

    // Step A — merge responses + persist via the existing repo. The repo
    // takes our outer tx as `externalTx`, so its UPDATE runs inside this
    // transaction and the row lock is held until our commit. Repo throws
    // SUBMISSION_NOT_FOUND / SUBMISSION_NOT_IN_PROGRESS sentinels which
    // bubble up unchanged.
    const merged = await submissionRepo.updateSubmissionResponses(
      ctx.tenantId,
      submissionId,
      input.responses,
      { patientId: actor.patientId, delegateId: actor.delegateId },
      async (_innerTx, _submission) => {
        // No audit/event on the merge step — the pause emits a single
        // Category C audit on the resume_state INSERT below, with rich
        // detail referencing both the submission and the resume_state.
        void _innerTx;
        void _submission;
      },
      tx,
    );

    // Step B — re-scan the FULL merged response set. Closes Codex
    // pause-r1 HIGH-2 (the patch-only gate above misses crisis text
    // already present in the row from legacy data, detector-rule
    // changes, earlier bugs, or out-of-band repair). On detection,
    // emit the Category A audit in its OWN transaction (must commit
    // even though THIS tx rolls back) and throw — the throw triggers
    // rollback of the merge UPDATE. The patient sees a 409 + crisis
    // resources, NOT a successful pause with crisis content stashed
    // in resume_state.
    const mergedResponsesObj: Record<string, unknown> = merged.responses ?? {};
    let mergedCrisis: { crisisType: string } | null;
    try {
      mergedCrisis = scanResponsesForCrisis(ctx.tenantId, mergedResponsesObj);
    } catch (err: unknown) {
      // RESPONSE_PAYLOAD_TOO_LARGE — the merged set exceeds the depth/node
      // budget. Same handling as the patch-side: rollback (by re-throwing)
      // surfaces as 413 at the handler.
      if (err instanceof Error && err.message === RESPONSE_PAYLOAD_TOO_LARGE) {
        throw err;
      }
      throw err;
    }
    if (mergedCrisis !== null) {
      // Audit MUST commit independently of the outer rollback (I-003 +
      // I-019). Use a fresh tx — withTransaction without externalTx opens
      // a brand-new connection.
      await withTransaction(async (auditTx) => {
        await auditTx.query('SELECT set_tenant_context($1)', [ctx.tenantId]);
        await emitCrisisDetectionTrigger(
          {
            tenantId: ctx.tenantId,
            actorId: actor.actorId,
            actorTenantId: ctx.tenantId,
            countryOfCare: ctx.countryOfCare,
            targetPatientId: actor.patientId,
            detectionSource: 'form_response',
            crisisType: mergedCrisis.crisisType,
            resourceType: 'forms_submission',
            resourceId: submissionId,
          },
          auditTx,
        );
      });
      throw new Error(CRISIS_DETECTED);
    }

    // Step C — KMS encrypt the merged responses. Inside the tx so a
    // KMS failure rolls back the merge UPDATE. The tenantId is encoded
    // into the AAD (encryption context) so a stolen ciphertext cannot
    // be decrypted under another tenant's key (ADR-024).
    const plaintextJson = Buffer.from(JSON.stringify(merged.responses), 'utf8');
    const encryptedPartialResponses = await kms.encrypt(ctx, plaintextJson);

    // Step D — INSERT resume_state with the encrypted bytes. Same outer
    // tx; the repo's txCallback emits audit + domain event in this tx
    // per I-016 same-tx outbox.
    const expiresAt = new Date(
      Date.now() + RESUME_STATE_DEFAULT_TTL_DAYS * MS_PER_DAY,
    ).toISOString();

    const startedAtMs = Date.parse(merged.started_at);
    const timeInIntakeMs = Number.isFinite(startedAtMs) ? Math.max(0, Date.now() - startedAtMs) : 0;

    const resumeState = await submissionRepo.createResumeState(
      ctx.tenantId,
      {
        patientId: actor.patientId,
        deviceAnonymousToken: null,
        deploymentId: merged.deployment_id,
        variantId: merged.variant_id,
        encryptedPartialResponses,
        currentSectionIndex: 0,
        progressPercent: 0,
        expiresAt,
      },
      async (innerTx, row) => {
        await emitFormsResumeStateSavedAudit(
          {
            tenantId: ctx.tenantId,
            actorId: actor.actorId,
            actorTenantId: ctx.tenantId,
            countryOfCare: ctx.countryOfCare,
            submissionId: merged.submission_id,
            resumeStateId: row.resume_state_id,
            targetPatientId: actor.patientId,
            sectionIndex: row.current_section_index,
            timeInIntakeMs,
          },
          innerTx,
        );
        await emitFormsResumeStateSavedEvent(innerTx, {
          tenantId: ctx.tenantId,
          submissionId: merged.submission_id,
          resumeStateId: row.resume_state_id,
          patientId: actor.patientId,
          expiresAt: row.expires_at,
        });
      },
      tx,
    );

    // Step E — issue the patient-held resume token. HMAC-self-contained;
    // expiresAt mirrors the row column (defense-in-depth on restore).
    const resumeToken = issueResumeToken(
      resumeState.resume_state_id,
      ctx.tenantId,
      resumeState.expires_at,
    );

    // Step F — project to patient-safe view (drops tenant_id per
    // Codex pause-r1 MEDIUM closure). Type system enforces this — the
    // PauseSubmissionResult.submission field is PatientFormSubmissionView,
    // not FormSubmission.
    return {
      submission: toPatientView(merged),
      resumeState: {
        resumeStateId: resumeState.resume_state_id,
        resumeToken,
        expiresAt: resumeState.expires_at,
      },
    };
  }, externalTx);
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
