/**
 * forms-intake/internal/handlers/resume.ts — save-and-resume handlers.
 *
 * Endpoints (per Slice PRD v2.1 §8 save-and-resume):
 *   - POST   /v0/forms/resume                       resume a paused submission via token
 *   - GET    /v0/forms/resume/:resumeToken          inspect resume-state metadata
 *
 * The resume token validates against tenant scope: a token issued in
 * Tenant X is rejected with a tenant-blind 404 when presented in Tenant Y
 * per I-025.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireTenantContext } from '../../../../lib/tenant-context.js';

/** POST /v0/forms/resume — resume a paused submission via token. */
export async function resumeSubmissionHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  // TODO: validate body via ResumeSubmissionRequestSchema; lookup
  // ResumeState by token (hashed); validate expiry + tenant match; call
  // submissionService.resumeSubmission.
  throw new Error('not implemented');
}

/**
 * GET /v0/forms/resume/:resumeToken — inspect resume-state metadata
 * (without restoring). Used by the patient app to render
 * "[N]% complete — Resume" before the user clicks.
 */
export async function getResumeStateHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw new Error('not implemented');
}
