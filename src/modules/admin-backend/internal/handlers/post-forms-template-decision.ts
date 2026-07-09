/**
 * admin-backend/internal/handlers/post-forms-template-decision.ts —
 *   POST /v1/admin/templates/:template_id/reviews/:review_id/decision
 *
 * **PR scope:** Sprint 2 PR 3 — second WRITE handler for the Admin Backend
 * Basics slice (SI-023). Sibling of Sprint 2 PR 2 (submit-for-review).
 * This handler wires the reviewer-decision wrapper from migration 043 §3
 * + the same canonical Option-B write composition Sprint 2 PR 2
 * established:
 *
 *   withIdempotentExecution
 *     → withTransaction (helper-owned)
 *       → withTenantContext
 *         → withActorContext?
 *           → withDbRole('admin_template_reviewer')        // NOTE: distinct slice role from PR 2
 *             → SELECT record_forms_template_admin_decision($1..$5)
 *           ← role restored to telecheck_app_role
 *           → emitTemplateReviewDecisionAudit(tx)  // same tx, app role
 *
 * **Slice-role distinction (vs Sprint 2 PR 2):** the submit endpoint uses
 * `admin_basic_operator`; THIS decision endpoint uses
 * `admin_template_reviewer`. The two slice roles are distinct per
 * migration 043's grant matrix (REVOKE EXECUTE FROM PUBLIC; GRANT EXECUTE
 * TO admin_template_reviewer at line 563 for the decision wrapper). The
 * Option B `withDbRoleSafe`/`withDbRole` allowlist enumerates both per
 * `src/lib/with-db-role.ts` SLICE_ROLES tuple + foundation 051 §2 GRANT
 * memberships. Per the deferred-permissive Layer B posture (same as PR
 * 2), the handler uses `requireAdminRole(req)` as the conservative shim
 * until Sprint 4 lands the slice-role-specific membership check.
 *
 * Endpoint contract (per SI-023 §5 row 5 + CDM v1.10→v1.11 Amendment §4
 * endpoint list):
 *   Method   POST
 *   Path     /v1/admin/templates/:template_id/reviews/:review_id/decision
 *   Body     { decision: 'approve' | 'reject' | 'request_revision',
 *              decision_payload?: { review_notes?: string,
 *                                   required_revisions?: string[],
 *                                   ... } }
 *            The wrapper's p_decision_payload parameter is JSONB and the
 *            spec leaves the shape forward-extensible (different decision
 *            values carry different supporting fields). For v0.1 we accept
 *            arbitrary objects; the wrapper validates internal shape.
 *   Headers  Idempotency-Key: <ULID> (required per IDEMPOTENCY v5.1).
 *            NOTE: the wrapper itself ALSO takes a p_idempotency_key
 *            parameter (TEXT) per migration 043 §3 R2 MED-1 closure +
 *            P-042 R2 hard-floor item 6 ratifier "We go with A" — the
 *            wrapper's per-call idempotency_keys row is INSERTED AFTER
 *            the lifecycle_transition row. We pass the same
 *            Idempotency-Key header value (resolved by
 *            withIdempotentExecution) so both the foundation handler-side
 *            idempotency check + the wrapper-side per-decision
 *            idempotency check agree.
 *   Returns  201 + { review_id, decision } on first call
 *            400 on malformed body / unknown decision value
 *            401 if no authenticated actor (production fail-closed)
 *            403 if SECDEF LAYER C raises 42501 (tenant-scope mismatch
 *                / no actor bound) — tenant-blind per I-025
 *            404 on wrapper-side 02000 (review not found / wrong state)
 *            409 on wrapper-side 40001 (concurrent decision attempt) or
 *                handler-side idempotency conflict per IDEMPOTENCY v5.1
 *
 * **Wrapper signature mapped (migration 043 §3):**
 *   record_forms_template_admin_decision(
 *       p_tenant_id        TEXT,
 *       p_review_id        UUID,
 *       p_decision         TEXT,    -- 'approve' | 'reject' | 'request_revision'
 *       p_decision_payload JSONB,
 *       p_idempotency_key  TEXT
 *   ) RETURNS VOID
 *
 * Decision values map to lifecycle-transition triples per migration 043
 * §3 comment header (decision-value → triple #2/#3/#4). The wrapper
 * validates the decision value (22023 on unknown), enforces tenant-scope
 * (42501), enforces state-machine guards (40001 on wrong-state /
 * concurrent attempt), and enforces null-key rejection (23502).
 *
 * **Tenant-blind error envelope (I-025) + 42501 catch wraps ENTIRE
 * withDbRole call** — mirrors PR 1 + PR 2 + Crisis R2 MED-1 closure
 * 6943e29. `withDbRole` issues SET LOCAL ROLE BEFORE invoking its
 * callback; a role-membership gap or grant skew raises 42501 at that
 * pre-callback boundary, escaping a catch placed inside the callback.
 * Wrapping the `withDbRole(...)` Promise covers BOTH paths (privilege
 * acquisition + SECDEF wrapper LAYER C guard).
 *
 * **Layer B authorization (deferred-permissive):** per the Option 2
 * carryforward, proper role-membership LAYER B is deferred to Sprint 4
 * hardening. Sprint 2 PRs 1/2 use `requireAdminRole(req)` as the
 * conservative shim; THIS PR uses the same shim. TODO marker preserved
 * for the Sprint 4 canonical `requireSliceRoleMembership('admin_template_reviewer')`
 * swap — note the slice role is DIFFERENT from PR 2's
 * `admin_basic_operator` (Sprint 4 must thread per-endpoint slice-role).
 *
 * **Audit emission (I-003 + SI-023 §3 row 3):** the Cat A
 * `admin.template_review_decision` audit emission runs inside the same
 * transaction as the wrapper INSERT. The wrapper itself does NOT emit
 * audit (deferred to application layer per the Option 2 carryforward —
 * see migration 043 §3 in-line comment block); this handler closes that
 * gap. The audit detail echoes the decision value + the
 * decision_payload so the audit chain captures the reviewer's stated
 * rationale per I-027 attribution discipline.
 *
 * **Publish audit (admin.template_published_via_review_workflow):**
 * per SI-023 §3 row 4, the approve-path additionally triggers a
 * `admin.template_published_via_review_workflow` Cat A audit when the
 * wrapper transitions the template to published. For v0.1 of this
 * handler we emit ONLY the decision audit (row 3); the publish audit
 * lands as a follow-up PR alongside the publish-side application logic
 * if needed (the wrapper itself updates the parent forms_template row
 * per migration 043 §3 body but does NOT emit the publish audit). This
 * matches the Option 2 carryforward + keeps the PR's blast radius
 * narrow.
 *
 * Spec references:
 *   - SI-023 Admin Backend Basics Slice v1.0 §5 row 5 endpoint contract
 *     (RATIFIED 2026-05-22 P-041)
 *   - SI-023 §3 row 3 `admin.template_review_decision` Cat A audit
 *   - SI-023 §6 transition triples #2 (approve) + #3 (reject) + #4
 *     (request_revision)
 *   - CDM v1.10 → v1.11 Amendment §4.NEW8f wrapper body (RATIFIED 2026-05-22
 *     P-042 — Sub-decision 4 idempotency-ordering closure)
 *   - migrations/043_admin_backend_template_wrappers.sql §3 (decision wrapper)
 *   - migrations/051_app_role_acquisition_foundation.sql §2 (membership
 *     grant: telecheck_app_role IN admin_template_reviewer)
 *   - src/lib/with-db-role.ts (Option B SET LOCAL ROLE helper)
 *   - src/lib/idempotent-handler.ts (canonical handler-side idempotency
 *     wrapper)
 *   - I-003 (audit durability), I-023 (three-layer tenancy), I-025 (tenant-
 *     blind errors), I-027 (audit attribution), I-035 (append-only lifecycle)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import {
  resolveActorTenantIdForAudit,
  requireSliceRoleMembership,
} from '../../../../lib/auth-context.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import {
  emitTemplatePublishedViaReviewWorkflowAudit,
  emitTemplateReviewDecisionAudit,
  type TemplateReviewDecision,
} from '../../audit.js';

// ---------------------------------------------------------------------------
// ULID validation — `forms_template.template_id` is VARCHAR(26) ULID per
// migration 006. Validating at the HTTP boundary keeps the 400 response
// shape clean; the wrapper's downstream 02000 "review not found" path
// would still fire for a syntactically-valid-but-absent ULID — that case
// is the canonical "not found" envelope, not malformed-input.
// ---------------------------------------------------------------------------
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ---------------------------------------------------------------------------
// UUID v4-ish validation for review_id — `forms_template_admin_review.review_id`
// is UUID per migration 040 §1. Standard 8-4-4-4-12 hex form.
// ---------------------------------------------------------------------------
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// ---------------------------------------------------------------------------
// URL params schema — template_id is ULID, review_id is UUID.
// ---------------------------------------------------------------------------
const PathParamsSchema = z.object({
  template_id: z
    .string()
    .regex(ULID_PATTERN, 'template_id must be a 26-char Crockford-base32 ULID'),
  review_id: z.string().regex(UUID_PATTERN, 'review_id must be a UUID (8-4-4-4-12 hex form)'),
});

// ---------------------------------------------------------------------------
// Request body schema. The wrapper enumerates decision values per migration
// 043 §3 lines 348-352 (CHECK enforced via raise 22023 on unknown values).
// We mirror that allowlist at the HTTP boundary so unknown values get a
// clean 400 rather than the more opaque wrapper-raise → 22023 → 400 path.
//
// `decision_payload` is JSONB at the wrapper layer — we accept any
// JSON-serializable object for forward-compatibility (different decision
// values carry different supporting fields per SI-023 §4 +
// SI-023-spec-reserved future-extension policy). The wrapper itself
// performs decision-specific shape validation if any.
// ---------------------------------------------------------------------------
const DecisionBodySchema = z.object({
  decision: z.enum(['approve', 'reject', 'request_revision'] as const),
  decision_payload: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Service-error mapper for the withIdempotentExecution wrapper. Maps
 * wrapper-raised PG SQLSTATEs to canonical HTTP envelopes:
 *
 *   42501 → 403 tenant-blind (I-025)    — defensive re-route in case a
 *                                          future code path throws an
 *                                          unmapped 42501 past the inner
 *                                          try/catch.
 *   22023 → 400 (invalid decision)      — wrapper "unknown decision value"
 *                                          (also covered by the zod
 *                                          enum at the HTTP boundary;
 *                                          defensive).
 *   23502 → 400 (null idempotency key)  — wrapper rejects null key
 *                                          (also covered by withIdempotentExecution).
 *   02000 → 404 (review not found)      — wrapper "review_id not found"
 *                                          (also fires for wrong-tenant
 *                                          OR wrong-state — tenant-blind
 *                                          per I-025).
 *   40001 → 409 (concurrent decision)   — wrapper "another decision in
 *                                          flight" / serializable-conflict
 *                                          / wrong-state — handler
 *                                          surface follows IDEMPOTENCY
 *                                          contract retry-after.
 *
 * Returns `true` if the error was mapped (handler returns reply); `false`
 * to propagate to Fastify's global error handler.
 */
function mapServiceError(err: unknown, reply: FastifyReply, requestId: string): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  // All envelopes are GENERIC — they MUST NOT echo tenant ids or wrapper
  // detail text per I-025 tenant-blind discipline.
  if (code === '42501') {
    void reply.code(403).send({
      error: {
        code: 'admin.forbidden',
        message: 'Insufficient scope for this request.',
        request_id: requestId,
      },
    });
    return true;
  }
  if (code === '22023') {
    void reply.code(400).send({
      error: {
        code: 'admin.invalid_decision',
        message: 'Invalid decision value.',
        request_id: requestId,
      },
    });
    return true;
  }
  if (code === '23502') {
    void reply.code(400).send({
      error: {
        code: 'admin.missing_idempotency_key',
        message: 'Idempotency-Key header is required.',
        request_id: requestId,
      },
    });
    return true;
  }
  if (code === '02000') {
    void reply.code(404).send({
      error: {
        code: 'admin.review_not_found',
        message: 'Review not found.',
        request_id: requestId,
      },
    });
    return true;
  }
  if (code === '40001') {
    void reply.code(409).send({
      error: {
        code: 'admin.review_decision_in_flight',
        message: 'A concurrent decision is in flight for this review. Retry after a brief delay.',
        request_id: requestId,
      },
    });
    return true;
  }
  return false;
}

/**
 * POST /v1/admin/templates/:template_id/reviews/:review_id/decision
 */
export async function postFormsTemplateDecisionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Phase 1 — tenant context (foundation tenantContextPlugin; throws if
  // absent → tenant-blind 400 via error-envelope).
  const ctx = requireTenantContext(req);

  // Phase 2 — LAYER B authorization (SI-023 §5 slice-role-membership gate;
  // Sprint 4 hardening). Binds `admin_template_reviewer` — the DISTINCT
  // slice role for the decision endpoint per SI-023 §5 endpoint 5 (submit
  // + dashboards use admin_basic_operator; decision uses
  // admin_template_reviewer). Bound role threaded into `withDbRole` below
  // (single source of truth). The DB EXECUTE-grant floor enforces the
  // distinction: record_forms_template_admin_decision is EXECUTE-granted
  // ONLY to admin_template_reviewer per migration 043's grant matrix, so
  // binding admin_basic_operator here would raise 42501 → tenant-blind 403.
  const sliceRole = requireSliceRoleMembership(req, 'admin_template_reviewer');

  // Phase 3 — URL params validation at the HTTP boundary.
  const paramsParsed = PathParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    const messages = paramsParsed.error.issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw req.server.httpErrors.badRequest(`Invalid path params: ${messages}`);
  }
  const { review_id: reviewId, template_id: templateId } = paramsParsed.data;

  // Phase 4 — body validation.
  const bodyParsed = DecisionBodySchema.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    const messages = bodyParsed.error.issues
      .map((e) => `${e.path.join('.')}: ${e.message}`)
      .join('; ');
    throw req.server.httpErrors.badRequest(`Invalid request body: ${messages}`);
  }
  const { decision, decision_payload: decisionPayload = {} } = bodyParsed.data;

  // Phase 5 — actor attribution (for audit emission). The decider
  // principal_id is bound INSIDE the SECDEF wrapper from
  // `current_actor_account_id()` (SI-010 trust anchor; caller cannot
  // forge — see migration 043 §3 lines 381-386). The application layer's
  // actor-id resolution here is the SAME identity at the audit-emission
  // layer (the request's authenticated actor); they MUST agree per
  // I-027 attribution discipline.
  const actorId =
    req.actorContext?.accountId ?? (req.headers['x-actor-id'] as string | undefined) ?? 'unknown';
  // Audit-attribution tenant: F-4 R5+R6 closure (auth-context.ts) — must be
  // a usable tenant identifier; rejects platform_admin header-shim path
  // outright; safe to fall back to ctx.tenantId for non-platform-admin
  // legacy paths since the role shim already verified tenant binding.
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution(req, reply, mapServiceError, async (tx, idempotencyCtx) => {
    // tx is the OPEN business transaction from withIdempotentExecution.
    // The wrapper's per-decision idempotency_key parameter receives the
    // SAME key that withIdempotentExecution resolved from the
    // Idempotency-Key header — both sides agree on the canonical key.
    const wrapperIdempotencyKey = idempotencyCtx.idempotencyKey;

    return withTenantContext(tx, ctx.tenantId, async () => {
      const run = async (): Promise<{
        status: number;
        view: { review_id: string; decision: TemplateReviewDecision };
      }> => {
        // R2 MED-1 closure parity (mirrors get-crisis-operational-health.ts +
        // post-forms-template-submit.ts): the 42501 catch MUST wrap the
        // ENTIRE withDbRole call, not just the inner SELECT. withDbRole
        // issues SET LOCAL ROLE BEFORE invoking its callback; a role-
        // membership gap would raise 42501 at that pre-callback boundary,
        // escaping a catch inside the callback. Wrapping the
        // withDbRole(...) Promise covers BOTH paths (privilege acquisition
        // + SECDEF wrapper LAYER C tenant-scope guard).
        try {
          await withDbRole(tx, sliceRole, async () => {
            // Call the SECDEF wrapper. RETURNS VOID. The wrapper inserts
            // the lifecycle_transition row + optionally publishes the
            // template (approve-path) atomically per migration 043 §3.
            await tx.query(
              'SELECT record_forms_template_admin_decision($1, $2, $3, $4::jsonb, $5)',
              [
                ctx.tenantId,
                reviewId,
                decision,
                JSON.stringify(decisionPayload),
                wrapperIdempotencyKey,
              ],
            );
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
        // app role holds the audit_records INSERT grant.
        const txTyped: DbTransaction = tx;
        await emitTemplateReviewDecisionAudit(
          {
            tenantId: ctx.tenantId,
            reviewId,
            formsTemplateId: templateId,
            deciderPrincipalId: actorId,
            deciderActorTenantId: actorTenantId,
            countryOfCare: ctx.countryOfCare,
            decision,
            decisionPayload,
          },
          txTyped,
        );

        // Sprint 4 — approve-path publish audit (SI-023 §3 row 4). The
        // wrapper atomically UPDATEs forms_template.status → published on
        // decision='approve' (transition triple #2, the canonical publish
        // path per SI-023 §6). The `admin.template_published_via_review_workflow`
        // Cat A audit fires IFF the decision was approve — deterministic
        // from the decision value (no separate DB read needed). Same tx as
        // the wrapper INSERT + decision audit, under the restored app role
        // (I-003 durability). reject / request_revision do NOT publish, so
        // no publish audit on those paths.
        if (decision === 'approve') {
          await emitTemplatePublishedViaReviewWorkflowAudit(
            {
              tenantId: ctx.tenantId,
              reviewId,
              formsTemplateId: templateId,
              deciderPrincipalId: actorId,
              deciderActorTenantId: actorTenantId,
              countryOfCare: ctx.countryOfCare,
            },
            txTyped,
          );
        }

        return {
          status: 201,
          view: { review_id: reviewId, decision },
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
