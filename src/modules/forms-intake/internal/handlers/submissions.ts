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

import { requireTenantContext } from '../../../../lib/tenant-context.js';
import {
  StartSubmissionRequestSchema,
  SubmitSubmissionRequestSchema,
  UpdateSubmissionResponsesRequestSchema,
} from '../../schemas.js';
import {
  DEPLOYMENT_NOT_FOUND,
  SUBMISSION_NOT_FOUND,
  SUBMISSION_NOT_IN_PROGRESS,
} from '../repositories/submission-repo.js';
import * as submissionService from '../services/submission-service.js';
import type { PatientId } from '../types.js';

/**
 * Resolve the acting actor's identity. Same shim + production-fail-closed
 * gate as templates.ts (kept duplicated rather than extracted to keep each
 * handler-file's auth boundary obvious; centralization happens when the
 * Identity & Auth slice lands).
 */
function resolveActorId(req: FastifyRequest): string {
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
 * Resolve the patient identity for a submission request. Production
 * fail-closed gated by the same `ALLOW_ACTOR_HEADER_AUTH` env opt-in.
 *
 * **Slice PRD §8.2 device-anonymous flow (DEFERRED):** the spec PRD calls
 * for a pre-account flow where patient_id is null and a
 * `deviceAnonymousToken` carries identity until the account creates.
 * Migration 006 declares `forms_submission.patient_id` NOT NULL, so this
 * shim refuses null patient_id today. Once the migration is patched
 * (or a placeholder "anonymous patient" identity lands), the shim relaxes.
 *
 * Optional `x-delegate-id` header; null when absent (the patient is
 * completing their own form, the normal case).
 */
function resolvePatient(req: FastifyRequest): { patientId: PatientId; delegateId: string | null } {
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
    message === SUBMISSION_NOT_IN_PROGRESS
  );
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

  try {
    const submission = await submissionService.startSubmission(
      ctx,
      { actorId, patientId, delegateId },
      parsed.data,
    );
    return reply.code(201).send(submission);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isHandledSentinel(message)) {
      throw req.server.httpErrors.badRequest(
        'The requested deployment is not available for new submissions.',
      );
    }
    throw err;
  }
}

/**
 * GET /v0/forms/submissions/:submissionId — read submission state.
 *
 * 200 hit / 404 tenant-blind miss. Same pattern as getTemplate +
 * getDeployment.
 *
 * **Patient-level access (DEFERRED to Identity slice):** today the only
 * scoping is RLS (tenant). A future enhancement requires the resolved
 * actor + patient to MATCH the submission's `(patient_id, delegate_id)` —
 * otherwise a tenant_admin reading a patient's intake is allowed (which
 * may be intended for support flows but should be audited as
 * break-glass-equivalent per I-024).
 */
export async function getSubmissionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  const params = req.params as Record<string, unknown>;
  const submissionIdParam = params['submissionId'];
  if (typeof submissionIdParam !== 'string' || submissionIdParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `submissionId` is required.');
  }

  const submission = await submissionService.getSubmission(ctx, submissionIdParam);
  if (submission === null) {
    throw req.server.httpErrors.notFound('Form submission not found.');
  }
  return reply.code(200).send(submission);
}

/**
 * PATCH /v0/forms/submissions/:submissionId/responses — auto-save partial
 * responses or explicit save-and-leave. Crisis detection runs first per
 * I-019 (currently DEFERRED — wiring stub in service layer).
 *
 * Sentinel error mapping:
 *   - SUBMISSION_NOT_FOUND       → 400
 *   - SUBMISSION_NOT_IN_PROGRESS → 400 (I-013 immutability)
 */
export async function updateSubmissionResponsesHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
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

  try {
    const submission = await submissionService.updateResponses(
      ctx,
      { actorId, patientId, delegateId },
      submissionIdParam,
      parsed.data,
    );
    return reply.code(200).send(submission);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isHandledSentinel(message)) {
      throw req.server.httpErrors.badRequest(
        'The requested form submission cannot be updated in its current state.',
      );
    }
    throw err;
  }
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

  try {
    const submission = await submissionService.submitSubmission(
      ctx,
      { actorId, patientId, delegateId },
      submissionIdParam,
      parsed.data,
    );
    return reply.code(200).send(submission);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isHandledSentinel(message)) {
      throw req.server.httpErrors.badRequest(
        'The requested form submission cannot be submitted in its current state.',
      );
    }
    throw err;
  }
}
