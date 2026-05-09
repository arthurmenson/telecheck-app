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

import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ResumeSubmissionRequestSchema } from '../../schemas.js';
import * as submissionService from '../services/submission-service.js';
import type { PatientId } from '../types.js';

/**
 * Module-local service-error mapper for `withIdempotentExecution`. The
 * forms-intake module surfaces preconditions as string-sentinel Error
 * objects, which are caught + remapped to Fastify httpErrors INSIDE the
 * body callback. No domain-specific Error classes flow up to this mapper,
 * so it is a deliberate no-op — unmapped errors propagate to Fastify's
 * global error handler.
 */
function mapServiceError(): boolean {
  return false;
}

/**
 * Resolve the request's patient identity for the resume metadata read.
 *
 * Mirrors the same shim pattern as `submissions.ts` (production fail-closed
 * unless `ALLOW_ACTOR_HEADER_AUTH=true`); the Identity & Auth slice
 * replaces both shims when it lands.
 *
 * **Anonymous-flow caveat:** for the device-anonymous resume path
 * (Slice PRD §8.2), the patient is not yet registered and identity is
 * carried by `x-device-anonymous-token` instead of `x-patient-id`. This
 * shim reads BOTH headers and returns whichever is present; the service
 * layer matches against the row's identity anchor (patient_id OR
 * device_anonymous_token, never both).
 *
 * Either header is required — bearing only the resume token is no longer
 * sufficient (Codex resume-r1 HIGH closure 2026-05-03).
 */
function resolveResumeOwnership(req: FastifyRequest): {
  patientId: PatientId | null;
  deviceAnonymousToken: string | null;
} {
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

  const deviceHeader = req.headers['x-device-anonymous-token'];
  const deviceAnonymousToken =
    typeof deviceHeader === 'string' && deviceHeader.length > 0 ? deviceHeader : null;

  if (patientId === null && deviceAnonymousToken === null) {
    throw req.server.httpErrors.unauthorized(
      'No patient or device-anonymous identity resolved for this request.',
    );
  }
  return { patientId, deviceAnonymousToken };
}

/**
 * Resolve the acting actor's identity. Mirrors `submissions.ts resolveActorId`
 * — kept duplicated rather than extracted so each handler-file's auth
 * boundary is obvious. Centralization happens when the Identity & Auth
 * slice lands.
 *
 * Required for the restore-write path because the audit emission needs an
 * `actor_id` distinct from the patient identity (an actor may pause/resume
 * on behalf of themselves OR via delegate-context — the delegate flow
 * isn't gated through resume_state today but the audit emitter's signature
 * carries actorId so future delegate-restore lands without a service
 * signature change).
 */
function resolveActorId(req: FastifyRequest): string {
  // Tier 1 JWT (preferred via authContextPlugin); Tier 2 header shim.
  if (req.actorContext !== undefined) {
    return req.actorContext.accountId;
  }
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
 * POST /v0/forms/resume — resume a paused submission via token.
 *
 * Pipeline (every step's failure mode surfaces as a tenant-blind 404 per
 * I-025; the service returns null on every gate trip):
 *
 *   1. Resolve tenant context (`requireTenantContext` fails closed per
 *      I-023).
 *   2. Resolve actor + ownership identity via the local shims (production
 *      fail-closed unless `ALLOW_ACTOR_HEADER_AUTH=true`).
 *   3. Parse + validate body (`ResumeSubmissionRequestSchema`).
 *   4. Call `submissionService.resumeSubmission` which atomically:
 *      verifies the token, decrypts the partial responses, merges them
 *      onto the in-progress submission row, flips the resume_state to
 *      `completed` (replay-protection), and emits the Category C audit —
 *      all in a single same-tx outbox path (I-016).
 *   5. Map null → 404 with the canonical "form resume state not found."
 *      message. Per I-025 the response is byte-identical regardless of
 *      which underlying gate tripped.
 *
 * The successful response is the patient-facing submission view
 * (`PatientFormSubmissionView` — no `tenant_id`).
 *
 * **v0.1 identity caveat:** the service requires `actor.patientId`
 * non-null because migration 006 declares `forms_submission.patient_id
 * NOT NULL` and the merge UPDATE reuses that constraint. The shim
 * delivers either patientId or deviceAnonymousToken; for the restore
 * path we only proceed if patientId resolves. Anonymous-flow restore
 * activates with the same migration patch that unblocks anonymous-flow
 * pause.
 */
export async function resumeSubmissionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actorId = resolveActorId(req);
  const ownership = resolveResumeOwnership(req);

  const parsed = ResumeSubmissionRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${parsed.error.issues
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ')}`,
    );
  }

  // The service signature requires a non-null patientId at v0.1 (see
  // file-level identity caveat above). If only the device-anonymous
  // token is presented, surface the same tenant-blind 404 — anonymous-
  // flow restore is not yet wired. This 404 is thrown BEFORE the
  // idempotent body opens its tx, so no reservation is left behind.
  if (ownership.patientId === null) {
    throw req.server.httpErrors.notFound('Form resume state not found.');
  }
  const resolvedPatientId = ownership.patientId;

  return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
    const restored = await submissionService.resumeSubmission(
      ctx,
      {
        actorId,
        patientId: resolvedPatientId,
        deviceAnonymousToken: ownership.deviceAnonymousToken,
      },
      parsed.data.resumeToken,
      tx,
    );
    if (restored === null) {
      // Tenant-blind 404 per I-025. Throw inside body() so the surrounding
      // tx rolls back and the idempotency reservation is purged — clean
      // retry possible. (We deliberately do NOT cache the 404 envelope
      // here: a 404 on resume can flip to 200 once the resume_state row's
      // identity gates are re-satisfied via a corrected request, so a
      // cached 404 would block legitimate retries.)
      throw req.server.httpErrors.notFound('Form resume state not found.');
    }
    // The service returns PatientFormSubmissionView — already projected
    // (no tenant_id) per Master PRD §17 + Glossary v5.2 C3.
    return { status: 200, view: restored };
  });
}

/**
 * GET /v0/forms/resume/:resumeToken — inspect resume-state metadata
 * (without restoring). Used by the patient app to render
 * "[N]% complete · Resume" before the user clicks.
 *
 * Token verification + ownership + tenant-blind 404 mapping is owned by
 * the service layer. The handler:
 *   1. Resolves the request's tenant via `requireTenantContext` (I-023
 *      fail-closed).
 *   2. Resolves patient OR device-anonymous identity via the auth shim
 *      (Codex resume-r1 HIGH closure 2026-05-03 — the resume token is no
 *      longer the sole authorization factor; bearing the URL is not enough).
 *   3. Extracts the token from the path param (string-required).
 *   4. Calls `getResumeStateMetadata` which returns null on any failure
 *      mode (bad signature, expired, cross-tenant, wrong actor, wrong
 *      status, missing).
 *   5. Maps null → 404 with the canonical "form resume state not found"
 *      message. Per I-025 the response is byte-identical regardless of
 *      which underlying gate tripped.
 */
export async function getResumeStateHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const ownership = resolveResumeOwnership(req);

  const params = req.params as Record<string, unknown>;
  const tokenParam = params['resumeToken'];
  if (typeof tokenParam !== 'string' || tokenParam.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `resumeToken` is required.');
  }

  const metadata = await submissionService.getResumeStateMetadata(ctx, ownership, tokenParam);
  if (metadata === null) {
    throw req.server.httpErrors.notFound('Form resume state not found.');
  }
  return reply.code(200).send(metadata);
}
