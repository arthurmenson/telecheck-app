/**
 * admin-backend/internal/handlers/post-forms-template-submit.ts —
 *   POST /v1/admin/templates/:template_id/submit-for-review
 *
 * **PR scope:** Sprint 2 PR 2 — first WRITE handler for the Admin Backend
 * Basics slice (SI-023). Follows Sprint 2 PR 1's GET handler which
 * established the canonical Option-B `withDbRole` composition (foundation
 * 051 + `src/lib/with-db-role.ts`). This PR introduces the canonical write
 * composition for the slice:
 *
 *   withIdempotentExecution
 *     → withTransaction (helper-owned)
 *       → withTenantContext
 *         → withActorContext?
 *           → withDbRole('admin_basic_operator')
 *             → SELECT submit_forms_template_for_admin_review($1, $2)
 *           ← role restored to telecheck_app_role
 *           → emitTemplateSubmittedForReviewAudit(tx)  // same tx, app role
 *
 * **Why audit emission runs AFTER the withDbRole callback returns** — the
 * `admin_basic_operator` slice role does NOT hold `INSERT` on
 * `audit_records`. Restoring to `telecheck_app_role` (which the foundation
 * audit emitter's INSERT path expects) before emit is the only way to
 * preserve same-transaction durability + I-003 audit completeness while
 * keeping the elevated-role surface as narrow as the SECDEF wrapper call
 * itself. `withDbRole`'s finally-block restoration (foundation 051 §R1
 * HIGH-1 closure) makes this composition correct: the audit emit runs
 * inside the same tx + tenant context but under the app role, not the
 * slice role.
 *
 * Endpoint contract (per SI-023 §5 row 4 + CDM v1.10→v1.11 Amendment §4
 * endpoint list):
 *   Method   POST
 *   Path     /v1/admin/templates/:template_id/submit-for-review
 *   Body     {} (no application-layer body fields — the SECDEF wrapper
 *            consumes only p_tenant_id + p_template_id; the body is
 *            present for IDEMPOTENCY contract conformance — same key +
 *            same body = idempotent replay)
 *   Headers  Idempotency-Key: <ULID> (required per IDEMPOTENCY v5.1)
 *   Returns  201 + { review_id } on initial submission OR revision
 *            resubmission (both paths return the wrapper's UUID — initial
 *            creates a new review_id; resubmission reuses the existing
 *            revision_requested review_id per migration 043 §1)
 *            400 on malformed body / missing template_id
 *            401 if no authenticated actor (production fail-closed)
 *            403 if SECDEF LAYER C raises 42501 (tenant-scope mismatch
 *                / no actor bound) — tenant-blind per I-025
 *            409 on idempotency conflicts (body_mismatch / in_flight) per
 *                IDEMPOTENCY v5.1 + on wrapper-side 40001 (in-flight
 *                pending review for same template) per migration 043 §1
 *            404 on wrapper-side 02000 (template not found)
 *
 * **Wrapper signature mapped (migration 043 §1):**
 *   submit_forms_template_for_admin_review(
 *       p_tenant_id   TEXT,
 *       p_template_id TEXT  -- VARCHAR(26) ULID at forms_template(template_id)
 *   ) RETURNS UUID  -- review_id (initial OR existing revision-requested)
 *
 * **Tenant-blind error envelope (I-025):** the 42501 catch wraps the
 * ENTIRE `withDbRole` call (mirrors get-crisis-operational-health R2 MED-1
 * closure 3a4144b). `withDbRole` issues SET LOCAL ROLE BEFORE invoking
 * its callback; a role-membership gap or grant skew would raise 42501 at
 * that pre-callback boundary, escaping a catch placed inside the
 * callback. Wrapping the `withDbRole(...)` Promise covers BOTH paths
 * (privilege acquisition + SECDEF wrapper LAYER C guard).
 *
 * **Layer B authorization (deferred-permissive):** per the Option 2
 * carryforward (recorded in src/modules/admin-backend/README.md), proper
 * role-membership LAYER B is deferred to Sprint 4 hardening. The Sprint 2
 * PR 1 sibling GET uses `requireAdminRole(req)` as the conservative shim;
 * we use the same shim here so a non-admin actor cannot trigger a
 * template-submission attempt that would only fail later at the SECDEF
 * LAYER A EXECUTE-grant boundary (which only authorizes
 * `admin_basic_operator`). TODO marker preserved for the Sprint 4
 * canonical `requireSliceRoleMembership('admin_basic_operator')` swap.
 *
 * **Audit emission (I-003 + SI-023 §3 row 2):** the Cat A
 * `admin.template_submitted_for_review` audit emission runs inside the
 * same transaction as the wrapper INSERT. The wrapper itself does NOT
 * emit audit (deferred to application layer per the Option 2 carryforward
 * — see migration 043 §1 in-line comment block); this handler closes
 * that gap. The `path` discriminator (initial_submission vs
 * revision_resubmission) is derived from the lifecycle-transition table
 * within the same tx so the audit payload accurately reflects which
 * wrapper path executed.
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 §5 row 4 endpoint contract
 *     (RATIFIED 2026-05-22 P-041)
 *   - SI-023 §3 row 2 `admin.template_submitted_for_review` Cat A audit
 *   - SI-023 §6 transition triples #1 (initial_submission) + #5
 *     (revision_resubmission)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW8e wrapper body (RATIFIED 2026-05-22
 *     P-042)
 *   - migrations/043_admin_backend_template_wrappers.sql §1 (submit wrapper)
 *   - migrations/051_app_role_acquisition_foundation.sql §2 (membership
 *     grant: telecheck_app_role IN admin_basic_operator)
 *   - src/lib/with-db-role.ts (Option B SET LOCAL ROLE helper)
 *   - src/lib/idempotent-handler.ts (canonical handler-side idempotency
 *     wrapper; same pattern as async-consult + consent state-change
 *     handlers per SI-006 reserve-then-execute)
 *   - I-003 (audit durability), I-023 (three-layer tenancy), I-025 (tenant-
 *     blind errors), I-027 (audit attribution), I-035 (append-only lifecycle)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { resolveActorTenantIdForAudit } from '../../../../lib/auth-context.js';
import { withActorContext } from '../../../../lib/actor-context-binding.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { requireAdminRole } from '../../../../lib/admin-role.js';
import { emitTemplateSubmittedForReviewAudit } from '../../audit.js';

// ---------------------------------------------------------------------------
// ULID validation — `forms_template.template_id` is VARCHAR(26) ULID per
// migration 006. Validating at the HTTP boundary keeps the 400 response
// shape clean (the wrapper's 02000 "template not found" path would still
// fire for a syntactically-valid-but-absent ULID — that case is the
// canonical "not found" envelope, not malformed-input).
// ---------------------------------------------------------------------------
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ---------------------------------------------------------------------------
// Request body schema (zod). The submit wrapper signature consumes only
// p_tenant_id (from the request tenant context) + p_template_id (from the
// URL path). The HTTP body is intentionally empty — the IDEMPOTENCY v5.1
// contract still requires a stable body hash for replay-safety, and an
// empty object `{}` is the canonical "no application fields" payload.
//
// We use `z.object({})` rather than `z.unknown()` so a caller sending
// arbitrary unexpected fields gets a clear 400 — the wrapper is fixed-
// signature and silently ignoring unknown body fields would create a
// retry/replay ambiguity (body hash differs → 409 body_mismatch on retry).
// ---------------------------------------------------------------------------
const SubmitTemplateBodySchema = z.object({}).strict();

// ---------------------------------------------------------------------------
// URL params schema — `template_id` is a 26-char ULID.
// ---------------------------------------------------------------------------
const PathParamsSchema = z.object({
  template_id: z
    .string()
    .regex(ULID_PATTERN, 'template_id must be a 26-char Crockford-base32 ULID'),
});

// ---------------------------------------------------------------------------
// Latest-transition row shape — used to derive the `path` discriminator
// (initial_submission vs revision_resubmission) for the audit payload.
// Mirrors `forms_template_admin_review_lifecycle_transition` columns from
// migration 040.
// ---------------------------------------------------------------------------
interface LatestTransitionRow {
  transition_reason: string;
}

/**
 * Service-error mapper for the withIdempotentExecution wrapper. Maps
 * wrapper-raised PG SQLSTATEs to canonical HTTP envelopes:
 *
 *   42501 → 403 tenant-blind (I-025)        — already handled inside the
 *                                              handler body via the
 *                                              wrapping try/catch; we
 *                                              re-route here defensively
 *                                              in case a future code path
 *                                              throws an unmapped 42501.
 *   02000 → 404 (tenant-blind not-found)    — wrapper "template not found"
 *   40001 → 409 (already-in-flight)         — wrapper "already-in-flight"
 *                                              for a pending_review or
 *                                              revision_requested review
 *                                              on the same template
 *
 * Returns `true` if the error was mapped (handler returns reply); `false`
 * to propagate to Fastify's global error handler.
 */
function mapServiceError(err: unknown, reply: FastifyReply, _reqId: string): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  // All envelopes are GENERIC — they MUST NOT echo tenant ids or wrapper
  // detail text per I-025 tenant-blind discipline.
  if (code === '42501') {
    reply.code(403).send({
      error: {
        code: 'admin.forbidden',
        message: 'Insufficient scope for this request.',
        request_id: _reqId,
      },
    });
    return true;
  }
  if (code === '02000') {
    reply.code(404).send({
      error: {
        code: 'admin.template_not_found',
        message: 'Template not found.',
        request_id: _reqId,
      },
    });
    return true;
  }
  if (code === '40001') {
    reply.code(409).send({
      error: {
        code: 'admin.template_review_in_flight',
        message:
          'Template already has an in-flight admin review. Resolve or cancel it before re-submitting.',
        request_id: _reqId,
      },
    });
    return true;
  }
  return false;
}

/**
 * POST /v1/admin/templates/:template_id/submit-for-review
 */
export async function postFormsTemplateSubmitHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Phase 1 — tenant context (foundation tenantContextPlugin; throws if
  // absent → tenant-blind 400 via error-envelope).
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization (admin role gate). See file-header
  // docstring for the deferred-permissive rationale + Sprint 4 swap TODO.
  //
  // TODO(SI-023 Sprint 4): replace with explicit
  // `requireSliceRoleMembership('admin_basic_operator')` once identity
  // surfaces per-actor slice-role membership. Until then the admin-role
  // shim provides the conservative gate (admin identities only) without
  // leaving the endpoint open to any authenticated actor.
  requireAdminRole(req);

  // Phase 3 — URL params validation at the HTTP boundary.
  const paramsParsed = PathParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    const messages = paramsParsed.error.issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw req.server.httpErrors.badRequest(`Invalid path params: ${messages}`);
  }
  const { template_id: templateId } = paramsParsed.data;

  // Phase 4 — body validation (strict empty object). The wrapper signature
  // takes only (p_tenant_id, p_template_id); rejecting unknown body fields
  // avoids retry/replay ambiguity vs the IDEMPOTENCY body-hash check.
  const bodyParsed = SubmitTemplateBodySchema.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    const messages = bodyParsed.error.issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw req.server.httpErrors.badRequest(`Invalid request body: ${messages}`);
  }

  // Phase 5 — actor attribution (for audit emission). The submitter
  // principal_id is bound INSIDE the SECDEF wrapper from
  // `current_actor_account_id()` (SI-010 trust anchor; caller cannot
  // forge — see migration 043 §1). The application layer's actor-id
  // resolution here is the SAME identity at the audit-emission layer
  // (the request's authenticated actor); they MUST agree per I-027
  // attribution discipline. For v0.1 we read from req.actorContext
  // when present, falling back to the x-actor-id legacy header shim
  // per the admin-role.ts Tier 2 retirement pattern.
  const actorId =
    req.actorContext?.accountId ??
    (req.headers['x-actor-id'] as string | undefined) ??
    'unknown';
  // Audit-attribution tenant: F-4 R5+R6 closure (auth-context.ts) — must be
  // a usable tenant identifier; rejects platform_admin header-shim path
  // outright; safe to fall back to ctx.tenantId for non-platform-admin
  // legacy paths since the role shim already verified tenant binding.
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution(req, reply, mapServiceError, async (tx, _idempotencyCtx) => {
    // tx is the OPEN business transaction from withIdempotentExecution.
    // withTransaction inside that helper has already been entered + tenant
    // context bound at the idempotency_keys row level. We bind tenant
    // context AGAIN here via withTenantContext to satisfy the SECDEF
    // wrapper's LAYER C check (which reads current_actor_account_tenant_id()
    // not the idempotency-keys tenant binding).
    return withTenantContext(tx, ctx.tenantId, async () => {
      const run = async (): Promise<{ status: number; view: { review_id: string } }> => {
        // R2 MED-1 closure parity (mirrors get-crisis-operational-health.ts
        // lines 195-230): the 42501 catch MUST wrap the ENTIRE withDbRole
        // call, not just the inner SELECT. withDbRole issues SET LOCAL ROLE
        // BEFORE invoking its callback; a role-membership gap would raise
        // 42501 at that pre-callback boundary, escaping a catch inside the
        // callback. Wrapping the withDbRole(...) Promise covers BOTH the
        // privilege-acquisition path AND the SECDEF wrapper's LAYER C
        // tenant-scope guard.
        let reviewId: string;
        try {
          reviewId = await withDbRole(tx, 'admin_basic_operator', async () => {
            // Call the SECDEF wrapper. RETURNS UUID (initial review_id OR
            // existing revision_requested review_id).
            const wrapperResult = await tx.query<{ review_id: string }>(
              'SELECT submit_forms_template_for_admin_review($1, $2) AS review_id',
              [ctx.tenantId, templateId],
            );
            const row = wrapperResult.rows[0];
            if (row === undefined || typeof row.review_id !== 'string') {
              // Defensive: the wrapper always RETURNs a UUID on success;
              // missing row would indicate an unexpected upstream change.
              throw new Error(
                'submit_forms_template_for_admin_review returned no row; ' +
                  'expected RETURNS UUID per migration 043 §1.',
              );
            }
            return row.review_id;
          });
        } catch (err) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code?: unknown }).code === '42501'
          ) {
            throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
          }
          throw err;
        }

        // Same-transaction Cat A audit emission (I-003 durability). Runs
        // AFTER withDbRole's finally-block restores telecheck_app_role; the
        // app role holds the audit_records INSERT grant. Derive the `path`
        // discriminator from the latest lifecycle_transition row for this
        // review_id (initial_submission OR revision_resubmission per the
        // migration 043 §1 wrapper body).
        const txTyped: DbTransaction = tx;
        const latestTransition = await txTyped.query<LatestTransitionRow>(
          `SELECT transition_reason
             FROM forms_template_admin_review_lifecycle_transition
            WHERE tenant_id = $1 AND review_id = $2
            ORDER BY transition_at DESC, id DESC
            LIMIT 1`,
          [ctx.tenantId, reviewId],
        );
        const transitionReason = latestTransition.rows[0]?.transition_reason;
        // The wrapper always inserts exactly one lifecycle_transition row
        // per call (either initial_submission triple #1 or
        // revision_resubmission triple #5); fall back defensively.
        const path: 'initial_submission' | 'revision_resubmission' =
          transitionReason === 'revision_resubmission'
            ? 'revision_resubmission'
            : 'initial_submission';

        await emitTemplateSubmittedForReviewAudit(
          {
            tenantId: ctx.tenantId,
            reviewId,
            formsTemplateId: templateId,
            submitterPrincipalId: actorId,
            submitterActorTenantId: actorTenantId,
            countryOfCare: ctx.countryOfCare,
            path,
          },
          tx,
        );

        return {
          status: 201,
          view: { review_id: reviewId },
        };
      };

      // Compose withActorContext when the SI-010 nonce is present (the
      // wrapper's LAYER C check + internal actor binding depends on it).
      // Without a nonce the wrapper itself fail-closes with 42501 ("no
      // actor account bound") — mapped by the outer try/catch to a
      // tenant-blind 403 per I-025.
      if (req.actorNonce !== undefined) {
        return withActorContext(tx, req.actorNonce, run);
      }
      return run();
    });
  });
}
