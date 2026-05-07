/**
 * forms-intake/internal/handlers/submissions.ts — patient-facing submission handlers.
 *
 * Endpoints (per Slice PRD v2.1 §7 onboarding + §8 save-and-resume):
 *   - POST   /v0/forms/submissions                          start submission
 *   - GET    /v0/forms/submissions/:submissionId            read submission
 *   - PATCH  /v0/forms/submissions/:submissionId/responses  update partial responses (auto-save / pause)
 *   - POST   /v0/forms/submissions/:submissionId/submit     final submission
 *
 * Crisis detection per I-019 runs over any free-text response in the
 * update handler — platform-floor; never disabled. (Currently DEFERRED;
 * the crisis-detection module is also stubbed at this commit.)
 *
 * Patient identity resolution: `x-patient-id` header shim (same pattern
 * as `resolveActorId`'s header shim in templates.ts). Production
 * fail-closed unless `ALLOW_ACTOR_HEADER_AUTH=true`. The Identity & Auth
 * slice replaces both shims when it lands.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { markIdempotencyManagedByHandler } from '../../../../lib/idempotency.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import {
  StartSubmissionRequestSchema,
  SubmitSubmissionRequestSchema,
  UpdateSubmissionResponsesRequestSchema,
} from '../../schemas.js';
import {
  DEPLOYMENT_NOT_FOUND,
  IN_PROGRESS_SUBMISSION_EXISTS,
  RESUME_STATE_IDENTITY_REQUIRED,
  SUBMISSION_NOT_FOUND,
  SUBMISSION_NOT_IN_PROGRESS,
} from '../repositories/submission-repo.js';
import {
  CRISIS_DETECTED,
  RESPONSE_PAYLOAD_TOO_LARGE,
  toPatientView,
} from '../services/submission-service.js';
import * as submissionService from '../services/submission-service.js';
import type { PatientId } from '../types.js';

/**
 * Resolve the acting actor's identity. Two-tier resolution:
 *   1. PREFERRED: req.actorContext populated by authContextPlugin
 *      (Identity slice JWT verification — landed 2d45f98)
 *   2. FALLBACK: x-actor-id header (gated by ALLOW_ACTOR_HEADER_AUTH;
 *      production fail-closed unless the env opt-in is set)
 *
 * The fallback exists for the transition period where some handlers
 * have been migrated to JWT and some haven't. Once every handler has
 * migrated, the fallback path will be retired.
 */
function resolveActorId(req: FastifyRequest): string {
  // Tier 1: real auth via req.actorContext
  if (req.actorContext !== undefined) {
    return req.actorContext.accountId;
  }

  // Tier 2: header shim (test/dev convenience)
  const isProd = process.env['NODE_ENV'] === 'production';
  const optIn = process.env['ALLOW_ACTOR_HEADER_AUTH'] === 'true';
  if (isProd && !optIn) {
    throw req.server.httpErrors.unauthorized(
      'Actor identity could not be authenticated for this request.',
    );
  }
  const headerValue = req.headers['x-actor-id'];
  const actorId = typeof headerValue === 'string' && headerValue.length > 0 ? headerValue : null;
  if (actorId === null) {
    throw req.server.httpErrors.unauthorized('No actor identity resolved for this request.');
  }
  return actorId;
}

/**
 * Resolve the patient identity for a submission request. Two-tier
 * resolution mirroring resolveActorId.
 *
 * **Slice PRD §8.2 device-anonymous flow (DEFERRED):** see the prior
 * comment — migration 006 declares forms_submission.patient_id NOT NULL,
 * so the shim refuses null patient_id today.
 */
function resolvePatient(req: FastifyRequest): { patientId: PatientId; delegateId: string | null } {
  // Tier 1: req.actorContext (JWT-resolved). The patient's account_id
  // IS the patient_id at v1.0 (Account = Patient per CDM §3.2;
  // separate Patient entity is deferred per Identity Spec §1.X).
  if (req.actorContext !== undefined) {
    return {
      patientId: req.actorContext.accountId,
      delegateId: req.actorContext.delegateId,
    };
  }

  // Tier 2: header shim
  const isProd = process.env['NODE_ENV'] === 'production';
  const optIn = process.env['ALLOW_ACTOR_HEADER_AUTH'] === 'true';
  if (isProd && !optIn) {
    throw req.server.httpErrors.unauthorized(
      'Patient identity could not be authenticated for this request.',
    );
  }
  const patientHeader = req.headers['x-patient-id'];
  const patientId =
    typeof patientHeader === 'string' && patientHeader.length > 0 ? patientHeader : null;
  if (patientId === null) {
    throw req.server.httpErrors.unauthorized('No patient identity resolved for this request.');
  }

  const delegateHeader = req.headers['x-delegate-id'];
  const delegateId =
    typeof delegateHeader === 'string' && delegateHeader.length > 0 ? delegateHeader : null;

  return { patientId, delegateId };
}

/**
 * Map repo/service-layer sentinel errors to canonical HTTP responses per
 * I-025 + ERROR_MODEL v5.1. All map to a uniform 400 envelope; the
 * structured code preserves operator-facing distinction for observability.
 */
function isHandledSentinel(message: string): boolean {
  return (
    message === DEPLOYMENT_NOT_FOUND ||
    message === SUBMISSION_NOT_FOUND ||
    message === SUBMISSION_NOT_IN_PROGRESS ||
    message === RESUME_STATE_IDENTITY_REQUIRED ||
    message === IN_PROGRESS_SUBMISSION_EXISTS
  );
}

/**
 * Module-local service-error mapper for `withIdempotentExecution`. The
 * forms-intake module surfaces preconditions as string-sentinel Error
 * objects, which are caught + remapped to Fastify httpErrors INSIDE the
 * body callback (so the surrounding tx rolls back and the reservation is
 * purged). No domain-specific Error classes flow up to this mapper, so it
 * is a deliberate no-op — unmapped errors propagate to Fastify's global
 * error handler.
 */
function mapServiceError(): boolean {
  return false;
}

/**
 * POST /v0/forms/submissions — patient or delegate begins an intake.
 *
 * Sentinel error mapping (tenant-blind 400 per I-025):
 *   - DEPLOYMENT_NOT_FOUND — deployment doesn't exist in tenant OR retired.
 */
export async function startSubmissionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // SI-006 reserve-then-execute: mark managed-by-handler at the TOP so
  // the legacy onSend hook NEVER writes a cache row for this request,
  // regardless of code path. See templates.ts createTemplateHandler for
  // the full body-mismatch-on-retry rationale.
  markIdempotencyManagedByHandler(req);

  const ctx = requireTenantContext(req);
  const actorId = resolveActorId(req);
  const { patientId, delegateId } = resolvePatient(req);

  const parsed = StartSubmissionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    try {
      const submission = await submissionService.startSubmission(
        ctx,
        { actorId, patientId, delegateId },
        parsed.data,
        tx,
      );
      // Patient surface — strip tenant_id per Master PRD v1.10 §17 +
      // Glossary v5.2 C3 (Codex patient-surface-r0 closure 2026-05-04).
      // Projection happens INSIDE the body so the cached response is
      // post-projection (no tenant_id leak per I-025).
      return { status: 201, view: toPatientView(submission) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isHandledSentinel(message)) {
        // Throw inside body() so the surrounding tx rolls back and the
        // idempotency reservation is purged — clean retry possible.
        throw req.server.httpErrors.badRequest(
          'The requested deployment is not available for new submissions.',
        );
      }
      throw err;
    }
  });
}

/**
 * GET /v0/forms/submissions/:submissionId — read submission state.
 *
 * 200 hit / 404 tenant-blind miss. Patient ownership is enforced — if
 * the resolved actor's `patientId` doesn't match the submission's
 * `patient_id`, the service returns null and the handler emits the
 * same 404 envelope as a missing row (Codex submissions-r1 CRITICAL-2
 * closure 2026-05-03; the prior implementation didn't resolve patient
 * identity on this endpoint at all, so any patient in the tenant could
 * read any other patient's PHI by guessing submission_id).
 *
 * Tenant-admin support flows that need to read across patients within
 * a tenant arrive via a separate (audited, break-glass-style) read
 * path per I-024 — they are NOT this endpoint.
 */
export async function getSubmissionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const { patientId, delegateId } = resolvePatient(req);

  const params = req.params as Record<string, unknown>;
  const submissionIdParam = params['submissionId'];
  if (typeof submissionIdParam !== 'string' || submissionIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `submissionId` is required.');
  }

  const submission = await submissionService.getSubmission(
    ctx,
    { patientId, delegateId },
    submissionIdParam,
  );
  if (submission === null) {
    throw req.server.httpErrors.notFound('Form submission not found.');
  }
  // Patient surface — strip tenant_id (Codex patient-surface-r0 2026-05-04).
  return reply.code(200).send(toPatientView(submission));
}

/**
 * PATCH /v0/forms/submissions/:submissionId/responses — auto-save partial
 * responses (`pause` undefined or false) OR explicit save-and-leave
 * (`pause === true`). Branches on `parsed.data.pause`:
 *
 *   - `pause !== true`: routes to `submissionService.updateResponses`,
 *     which does the merge + auto-save (no audit, no event, no
 *     resume_state row).
 *   - `pause === true`: routes to `submissionService.pauseSubmission`,
 *     which merges + encrypts + creates the resume_state row + emits
 *     the Category C audit + the `forms_resume_state.saved` domain
 *     event in a single same-tx outbox path (I-016). The response
 *     shape includes the resume token so the patient app can render
 *     the resume URL immediately.
 *
 * Crisis detection runs FIRST in BOTH branches per I-019 platform-floor.
 * A positive detection emits the Category A audit and surfaces 409
 * crisis_detected; no merge, no resume_state row.
 *
 * Sentinel error mapping (tenant-blind 400 per I-025):
 *   - SUBMISSION_NOT_FOUND            → 400
 *   - SUBMISSION_NOT_IN_PROGRESS      → 400 (I-013 immutability)
 *   - RESUME_STATE_IDENTITY_REQUIRED  → 400 (defensive — v0.1 entrypoint
 *     always supplies patient identity)
 *
 * **No tenant_id leak** in either branch — pause response carries only
 * the submission state (already tenant_id-bearing at the type layer
 * because FormSubmission includes it; SPEC ISSUE flagged below) and the
 * resume metadata (no tenant_id).
 *
 * **SPEC ISSUE flag (preserved):** the `FormSubmission` type still carries
 * `tenant_id` — which the auto-save endpoint already returns. The
 * patient-surface rule (Master PRD §17 + Glossary v5.2 C3) calls for
 * `tenant_id` removal on patient surfaces; the existing endpoint is in
 * scope for that closure separately. The pause path's NEW surface (the
 * `resumeState` block) deliberately omits tenant_id; the legacy
 * `submission` block matches whatever the auto-save endpoint already
 * returns to keep client compatibility.
 */
export async function updateSubmissionResponsesHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  markIdempotencyManagedByHandler(req); // SI-006: see startSubmissionHandler.

  const ctx = requireTenantContext(req);
  const actorId = resolveActorId(req);
  const { patientId, delegateId } = resolvePatient(req);

  const params = req.params as Record<string, unknown>;
  const submissionIdParam = params['submissionId'];
  if (typeof submissionIdParam !== 'string' || submissionIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `submissionId` is required.');
  }

  const parsed = UpdateSubmissionResponsesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  // The helper's generic TView is bound to a single shape; the two branches
  // here return different shapes (PauseSubmissionResult vs PatientFormSubmissionView).
  // Widening to `unknown` keeps both branches assignable without altering
  // the wire-out — the cached response body is the projected view either way.
  return withIdempotentExecution<unknown>(req, reply, mapServiceError, async (tx) => {
    try {
      if (parsed.data.pause === true) {
        // Explicit save-and-leave path — slice PRD §8.2. PauseSubmissionResult
        // already carries a tenant_id-stripped submission view, so no
        // additional projection step is required.
        const result = await submissionService.pauseSubmission(
          ctx,
          { actorId, patientId, delegateId },
          submissionIdParam,
          parsed.data,
          tx,
        );
        return { status: 200, view: result };
      }

      const submission = await submissionService.updateResponses(
        ctx,
        { actorId, patientId, delegateId },
        submissionIdParam,
        parsed.data,
        tx,
      );
      // Patient surface — strip tenant_id (Codex patient-surface-r0 2026-05-04).
      // Projection happens INSIDE the body so the cached response is
      // post-projection (no tenant_id leak per I-025).
      return { status: 200, view: toPatientView(submission) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === CRISIS_DETECTED) {
        // Per I-019 platform-floor, a positive crisis detection is NOT a
        // generic 400. The patient surface needs to render crisis
        // resources + emergency-contact paths (Slice PRD §13). We use
        // HTTP 409 Conflict with a structured error code so the client
        // can branch — the response is intentionally distinguishable
        // from other 4xx classes. The Category A `crisis_detection_trigger`
        // audit was already committed (in its own tx) before this throw,
        // so the rollback of the surrounding tx does not cancel the
        // escalation record.
        //
        // SI-006 PR-F2 r3 (Codex 2026-05-07 HIGH closure): RETURN the 409
        // as a successful body() result instead of THROWING. Throwing
        // here would cause withIdempotency to roll back the reservation,
        // and a client retry with the same Idempotency-Key + body would
        // re-execute the crisis gate and emit a DUPLICATE Category A
        // audit (violating IDEMPOTENCY v5.1 exactly-once + polluting
        // crisis-ops data). Returning a cached 409 means retries replay
        // from cache without re-running the scanner.
        return {
          status: 409,
          view: {
            error: {
              code: 'internal.resource.conflict',
              message:
                'Crisis content was detected in the response payload; escalation required.',
              request_id: req.id,
            },
          },
        };
      }
      if (message === RESPONSE_PAYLOAD_TOO_LARGE) {
        // Closes Codex submissions-r1 verify-r2 HIGH 2026-05-03: a deeply
        // nested response payload (within Fastify's 1 MiB body limit) used
        // to overflow the recursive crisis scanner's call stack and surface
        // as a 5xx — bypassing I-019 escalation. The scanner is now
        // iterative with explicit depth + node-count budgets; payloads
        // exceeding either budget surface here and reject with HTTP 413.
        // The Category A audit is NOT emitted on this path because no
        // string was scanned — there's no detection to record. The rejection
        // is documented at the I-025 envelope layer as a malformed payload.
        //
        // SI-006 PR-F2 r3: also return-as-cached so retries replay the
        // 413 instead of re-executing the failing scanner. Same
        // exactly-once rationale as CRISIS_DETECTED above.
        return {
          status: 413,
          view: {
            error: {
              code: 'internal.request.payload_too_large',
              message:
                'The response payload is too deeply nested or too large to process.',
              request_id: req.id,
            },
          },
        };
      }
      if (isHandledSentinel(message)) {
        // SI-006 PR-F2 r3: return-as-cached for the same exactly-once
        // reason. State-machine guard violations are deterministic
        // outcomes of (input, current state) — replay should return the
        // same 400 without re-attempting the state mutation.
        return {
          status: 400,
          view: {
            error: {
              code: 'internal.request.semantically_invalid',
              message:
                'The requested form submission cannot be updated in its current state.',
              request_id: req.id,
            },
          },
        };
      }
      throw err;
    }
  });
}

/**
 * POST /v0/forms/submissions/:submissionId/submit — final submission;
 * snapshots, runs eligibility, conditionally emits subscription handoff.
 *
 * **Body (optional):** attestation block per SubmitSubmissionRequestSchema.
 * The responses themselves were persisted via the update endpoint — this
 * call only flips status + emits the audit + domain event chain.
 *
 * Sentinel error mapping:
 *   - SUBMISSION_NOT_FOUND       → 400
 *   - SUBMISSION_NOT_IN_PROGRESS → 400 (already submitted, etc.)
 */
export async function submitSubmissionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  markIdempotencyManagedByHandler(req); // SI-006: see startSubmissionHandler.

  const ctx = requireTenantContext(req);
  const actorId = resolveActorId(req);
  const { patientId, delegateId } = resolvePatient(req);

  const params = req.params as Record<string, unknown>;
  const submissionIdParam = params['submissionId'];
  if (typeof submissionIdParam !== 'string' || submissionIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `submissionId` is required.');
  }

  // Body is optional (just `attestation?`). Empty body resolves to {} for the
  // schema's `.optional()` to apply cleanly.
  const parsed = SubmitSubmissionRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  // <unknown> widening: success path returns PatientFormSubmissionView,
  // sentinel-catch path returns an error envelope. Both shapes are
  // valid cached bodies; the helper's TView is bound to a single type
  // so we widen.
  return withIdempotentExecution<unknown>(req, reply, mapServiceError, async (tx) => {
    try {
      const submission = await submissionService.submitSubmission(
        ctx,
        { actorId, patientId, delegateId },
        submissionIdParam,
        parsed.data,
        tx,
      );
      // Patient surface — strip tenant_id (Codex patient-surface-r0 2026-05-04).
      // Projection happens INSIDE the body so the cached response is
      // post-projection (no tenant_id leak per I-025).
      return { status: 200, view: toPatientView(submission) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isHandledSentinel(message)) {
        // SI-006 PR-F2 r3: return-as-cached so retries replay the 400
        // instead of re-executing the state-machine guard. Same
        // exactly-once rationale as the update handler's sentinel
        // catch above.
        return {
          status: 400,
          view: {
            error: {
              code: 'internal.request.semantically_invalid',
              message:
                'The requested form submission cannot be submitted in its current state.',
              request_id: req.id,
            },
          },
        };
      }
      throw err;
    }
  });
}
