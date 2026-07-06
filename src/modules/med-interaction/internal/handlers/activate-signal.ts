/**
 * med-interaction/internal/handlers/activate-signal.ts —
 *   POST /v0/med-interaction/signals/:id/activate — transition an emitted
 *   signal to `active`; calls the SECDEF wrapper `record_signal_activation`
 *   from migration 050 §2 which acquires the per-(tenant, signal)
 *   advisory lock, verifies the current state is `emitted`, verifies no
 *   override is recorded (defense-in-depth with raw writer STEP 3.5),
 *   then delegates to the raw lifecycle writer to INSERT the
 *   `emitted → active / activation` transition row.
 *
 * **PR 8 of N — third write handler in this PR.**
 *
 * Same canonical Option B composition + 42501 → 403 mapping + same-tx
 * Cat A audit (this time the lifecycle-transition event) +
 * deferred-permissive Layer B per Option 2. See the file-level
 * docstrings in `create-evaluation.ts` + `emit-signal.ts` + the PR 7
 * reference `get-signal.ts` for the long-form pattern rationale.
 *
 * Endpoint contract:
 *   Method   POST
 *   Path     /v0/med-interaction/signals/:id/activate
 *   Params   id — VARCHAR(26) ULID — the interaction_signal_id
 *   Body     {
 *              metadata?:   JSON   // forwarded into the SECDEF wrapper's
 *                                  // p_metadata JSONB
 *            }
 *            (R2 HIGH-2 closure 2026-05-24: patient_id REMOVED from
 *             the body — derived server-side from
 *             interaction_signal -> interaction_engine_evaluation in
 *             same tx.)
 *   Returns  200 + { signal_id, transition_id, activated_at } on success
 *            400 on malformed :id / body
 *            401 if no authenticated actor (production fail-closed)
 *            403 on 42501 (insufficient scope OR cross-tenant signal_id)
 *            404 if the signal does not exist OR is not currently
 *                `emitted` OR has an override on file — all wrapper
 *                rejections (SQLSTATE 23514 from migration 050 §2)
 *                are mapped to tenant-blind 404 per I-025 (the wrapper
 *                exposes "current_state=..." and "signal_id=..." in
 *                error messages; the 404 envelope strips that).
 *            409 on idempotency replay / in-flight / body mismatch
 *
 * **Canonical lifecycle audit rule for this handler (R1 Finding 2 closure
 * 2026-05-23):**
 *   This handler emits EXACTLY ONE audit event per successful request:
 *     1. `interaction_signal_lifecycle_transition_emitted` (Cat A) with
 *        `from_state='emitted'`, `to_state='active'`,
 *        `transition_reason='activation'`.
 *   The unit test below asserts the exact emitter call sequence
 *   (`auditCalls` mock log shape) AND the from_state / to_state /
 *   transition_reason payload values. See `audit.ts` file-level docstring
 *   `CANONICAL LIFECYCLE AUDIT RULE` for the full cross-handler contract.
 *
 * **SECDEF wrapper signature (migration 050 §2):**
 *   record_signal_activation(
 *     p_id            VARCHAR(26),   -- ULID for the new transition row
 *     p_tenant_id     TEXT,
 *     p_signal_id     VARCHAR(26),
 *     p_actor_id      VARCHAR(26),
 *     p_metadata      JSONB
 *   ) RETURNS VOID
 *
 * **Why 404 (not 422) on wrapper rejection:**
 *   The wrapper raises SQLSTATE 23514 (`check_violation`) with messages
 *   that include the signal_id + current state — leaking those past the
 *   wire boundary would violate I-025 (tenant-blind error envelopes;
 *   "current state=overridden" effectively confirms cross-tenant
 *   existence when the requester would otherwise receive a 404). The
 *   handler maps 23514 to a tenant-blind 404 so the wire response is
 *   identical to "signal does not exist in this tenant," whether the
 *   actual failure mode is "wrong tenant," "wrong state," or "blocked
 *   by override."
 *
 * Spec references:
 *   - SI-019 Slice PRD v2.0 §5 (POST /signals/:id/activate contract) +
 *     §6 (audit catalog — lifecycle_transition_emitted Option A add)
 *   - CDM v1.6 → v1.7 Amendment §6.NEW3 (record_signal_activation wrapper)
 *   - migration 050 §2 (record_signal_activation SECDEF)
 *   - I-002, I-003, I-025, I-027 (carryforward from create-evaluation.ts)
 *   - get-signal.ts (PR 7 reference for 42501 → 403)
 *   - emit-signal.ts (sibling — SECDEF wrapper call shape)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { resolveActorTenantIdForAudit } from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitSignalLifecycleTransitionAudit } from '../../audit.js';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function isUlid(s: unknown): s is string {
  return typeof s === 'string' && ULID_PATTERN.test(s);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Activate-signal request body.
 *
 * **R2 HIGH-2 closure (Codex 2026-05-24):** `patient_id` is no longer
 * accepted as request input. The audit `target_patient_id` is derived
 * server-side from the durable `interaction_signal -> interaction_engine_evaluation`
 * join in the same transaction. Body-supplied `patient_id` was a
 * forgery vector — a caller could activate signal A but emit the
 * lifecycle audit under patient B, corrupting the patient-scoped
 * audit hash-chain partition AND misrouting any patient-facing
 * lifecycle-change consumer that filters by `target_patient_id`.
 * Per AUDIT_EVENTS v5.3 hash-chain partition rule, an audit row
 * whose `target_patient_id` does not match the durable record
 * lands in the wrong partition.
 *
 * If a future API contract requires accepting `patient_id` for
 * idempotency-replay disambiguation, it MUST be validated equal to
 * the DB-derived value (fail-closed 404 on mismatch per I-025).
 */
interface ActivateSignalBody {
  metadata?: Record<string, unknown>;
}

function assertLayerBAuthorized(req: FastifyRequest): void {
  if (req.actorContext !== undefined) {
    return;
  }
  const isProd = process.env['NODE_ENV'] === 'production';
  if (isProd) {
    throw req.server.httpErrors.unauthorized(
      'Actor identity could not be authenticated for this request.',
    );
  }
}

function mapServiceError(): boolean {
  return false;
}

interface ActivateSignalView {
  signal_id: string;
  transition_id: string;
  activated_at: string;
}

export async function activateSignalHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  assertLayerBAuthorized(req);

  // §1 — Path-param validation (HTTP-boundary; mirrors get-signal.ts §3).
  const params = req.params as Record<string, unknown>;
  const rawId = params['id'];
  if (typeof rawId !== 'string' || rawId.length === 0) {
    throw req.server.httpErrors.badRequest('Path param `id` is required.');
  }
  if (!isUlid(rawId)) {
    throw req.server.httpErrors.badRequest(
      'Path param `id` must be a 26-character Crockford-base32 ULID.',
    );
  }
  const signalId = rawId;

  // §2 — Body validation. Only `metadata` is body-supplied; the audit
  // target patient_id is DB-derived in the wrapper-call body below
  // (R2 HIGH-2 closure 2026-05-24).
  const body = (req.body ?? {}) as ActivateSignalBody;
  if (body.metadata !== undefined && !isObject(body.metadata)) {
    return reply.code(400).send({
      error: {
        code: 'internal.request.invalid',
        message: 'metadata, when supplied, must be a JSON object.',
        request_id: req.id,
      },
    });
  }
  const metadata = body.metadata ?? {};

  const actorNonce = req.actorNonce;
  const actorId = req.actorContext?.accountId ?? 'system';
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution<ActivateSignalView>(req, reply, mapServiceError, async (tx) => {
    const transitionId = ulid();
    const activatedAt = new Date();

    const callWrappers = async (): Promise<void> => {
      try {
        await withDbRole(tx, 'medication_interaction_engine_evaluator', async () => {
          // §1 — Call the SECDEF wrapper to perform the activation.
          // The wrapper acquires the per-(tenant, signal) advisory
          // lock, validates current state == 'emitted', validates
          // no override is recorded (defense-in-depth), then
          // delegates to the raw lifecycle writer.
          await tx.query('SELECT record_signal_activation($1, $2, $3, $4, $5::jsonb)', [
            transitionId,
            ctx.tenantId,
            signalId,
            actorId,
            JSON.stringify(metadata),
          ]);

          // §2 — Derive the audit `target_patient_id` from the
          // durable `interaction_signal -> interaction_engine_evaluation`
          // join in the same tx (R2 HIGH-2 closure 2026-05-24).
          // The prior version accepted a body-supplied patient_id
          // (optional, defaulting to null) which landed the audit
          // record on the platform hash-chain partition instead of
          // the patient partition for the normal "no body" case,
          // and allowed forgery to an arbitrary patient ULID when
          // a value WAS supplied. Deriving from the durable
          // relationship eliminates both failure modes.
          //
          // The lookup runs AFTER record_signal_activation succeeds —
          // the wrapper already validated the signal exists in the
          // current tenant (raising 42501 or 23514 on mismatch);
          // a missing row here is therefore an unexpected race
          // (e.g. concurrent DELETE between activation and lookup)
          // and is mapped to a tenant-blind 404.
          const patientRow = await tx.query(
            `SELECT e.patient_id
                   FROM interaction_signal AS s
                   JOIN interaction_engine_evaluation AS e
                     ON e.tenant_id = s.tenant_id
                    AND e.id        = s.evaluation_id
                  WHERE s.tenant_id = $1 AND s.id = $2`,
            [ctx.tenantId, signalId],
          );
          const patientRows = patientRow.rows as Array<{ patient_id: string }>;
          const derivedPatientId = patientRows[0]?.patient_id;
          if (typeof derivedPatientId !== 'string' || derivedPatientId.length === 0) {
            throw req.server.httpErrors.notFound('Interaction signal not found.');
          }

          // §3 — Cat A audit `interaction_signal_lifecycle_transition_emitted`
          // in the SAME tx. Per Option A (SI-019 Sub-decision 3 item 5
          // 2026-05-20), every INSERT into
          // interaction_signal_lifecycle_transition emits this audit
          // event (subscribed by the projection refresher + patient-
          // facing lifecycle-change push surfaces).
          await emitSignalLifecycleTransitionAudit(
            {
              tenantId: ctx.tenantId,
              signalId,
              transitionId,
              patientId: derivedPatientId,
              actorId,
              actorTenantId,
              countryOfCare: ctx.countryOfCare,
              fromState: 'emitted',
              toState: 'active',
              transitionReason: 'activation',
            },
            tx,
          );
        });
      } catch (err) {
        if (typeof err === 'object' && err !== null && 'code' in err) {
          const code = (err as { code?: unknown }).code;
          // 42501 → tenant-blind 403 (I-025).
          if (code === '42501') {
            throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
          }
          // 23514 (check_violation) is the wrapper's signal_not_emitted
          // / activation_blocked_by_override rejection path; map to
          // tenant-blind 404 so the wire response does not differentiate
          // "wrong state" / "blocked by override" from "doesn't exist
          // in this tenant" (I-025).
          if (code === '23514') {
            throw req.server.httpErrors.notFound('Interaction signal not found.');
          }
        }
        throw err;
      }
    };

    await withTenantContext(tx, ctx.tenantId, async () => {
      if (typeof actorNonce === 'string' && actorNonce.length > 0) {
        await withActorContext(tx, actorNonce, callWrappers);
      } else {
        await callWrappers();
      }
    });

    return {
      status: 200,
      view: {
        signal_id: signalId,
        transition_id: transitionId,
        activated_at: activatedAt.toISOString(),
      },
    };
  });
}
