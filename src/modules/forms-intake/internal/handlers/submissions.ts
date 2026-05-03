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
 * update handler — platform-floor; never disabled.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireTenantContext } from '../../../../lib/tenant-context.js';

/** POST /v0/forms/submissions — patient or delegate begins an intake. */
export async function startSubmissionHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  // TODO: validate body via StartSubmissionRequestSchema; resolve
  // patient_id (or device-anonymous token) from auth context; call
  // submissionService.startSubmission.
  throw new Error('not implemented');
}

/** GET /v0/forms/submissions/:submissionId — read submission state. */
export async function getSubmissionHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}

/**
 * PATCH /v0/forms/submissions/:submissionId/responses — auto-save partial
 * responses or explicit save-and-leave. Crisis detection runs first per
 * I-019.
 */
export async function updateSubmissionResponsesHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}

/**
 * POST /v0/forms/submissions/:submissionId/submit — final submission;
 * snapshots, runs eligibility, conditionally emits subscription handoff.
 */
export async function submitSubmissionHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}
