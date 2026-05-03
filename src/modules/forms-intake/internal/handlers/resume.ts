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
 *
 * **Token model (HMAC-self-contained):** see
 * `internal/services/resume-token.ts`. The token is signed with
 * `config.resumeTokenSecret` and encodes (resume_state_id, tenant_id,
 * expires_at_ms). No `resume_token_hash` column required on
 * forms_resume_state — defers a migration ALTER while keeping the patient
 * surface stable. Captured as a SPEC ISSUE per EHBG §12.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { requireTenantContext } from '../../../../lib/tenant-context.js';
import * as submissionService from '../services/submission-service.js';

/**
 * POST /v0/forms/resume — resume a paused submission via token.
 *
 * **Still STUBBED** at this commit; the response-restoration flow has
 * unresolved dependencies documented at `submissionService.resumeSubmission`:
 *   - migration 006 lacks the (resume_state ↔ submission) binding column,
 *   - the pause/write path is not yet wired,
 *   - KMS-decryption of `encrypted_partial_responses` is gated to
 *     NODE_ENV=test only at v0.1.
 *
 * The handler is preserved so route registration continues to compile and
 * a single coherent slice header documents the deferral. The metadata-only
 * `GET /v0/forms/resume/:resumeToken` IS live and IS the preview-of-resume
 * the patient app uses today.
 */
export async function resumeSubmissionHandler(
  req: FastifyRequest,
  _reply: FastifyReply,
): Promise<unknown> {
  void requireTenantContext(req);
  throw req.server.httpErrors.notImplemented(
    'POST /v0/forms/resume is not yet wired; use GET /v0/forms/resume/:resumeToken for metadata.',
  );
}

/**
 * GET /v0/forms/resume/:resumeToken — inspect resume-state metadata
 * (without restoring). Used by the patient app to render
 * "[N]% complete · Resume" before the user clicks.
 *
 * Token verification + tenant-blind 404 mapping is owned by the service
 * layer. The handler:
 *   1. Resolves the request's tenant via `requireTenantContext` (I-023
 *      fail-closed).
 *   2. Extracts the token from the path param (string-required).
 *   3. Calls `getResumeStateMetadata` which returns null on any failure
 *      mode (bad signature, expired, cross-tenant, wrong status, missing).
 *   4. Maps null → 404 with the canonical "form resume state not found"
 *      message. Per I-025 the response is byte-identical regardless of
 *      which underlying gate tripped.
 */
export async function getResumeStateHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  const params = req.params as Record<string, unknown>;
  const tokenParam = params['resumeToken'];
  if (typeof tokenParam !== 'string' || tokenParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `resumeToken` is required.');
  }

  const metadata = await submissionService.getResumeStateMetadata(ctx, tokenParam);
  if (metadata === null) {
    throw req.server.httpErrors.notFound('Form resume state not found.');
  }
  return reply.code(200).send(metadata);
}
