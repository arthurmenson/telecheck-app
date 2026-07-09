/**
 * subscription/internal/handlers/transition-handlers.ts — the four
 * patient-sovereign HTTP transitions (OpenAPI v0.2 §20.3-20.6):
 *
 *   POST /v0/subscriptions/:subscription_id/pause   (pause_request; 200)
 *   POST /v0/subscriptions/:subscription_id/resume  (resume;        200)
 *   POST /v0/subscriptions/:subscription_id/switch  (switch_request; 202)
 *   POST /v0/subscriptions/:subscription_id/cancel  (cancel_request; 200)
 *
 * All four are state-changing → wrapped in withIdempotentExecution
 * (Idempotency-Key header required; IDEMPOTENCY v5.1, tenant-scoped).
 *
 * Composition (the service owns the innermost withDbRole + same-tx audit;
 * see internal/service.ts docstring):
 *
 *   withIdempotentExecution                (reserve-then-execute)
 *     └─ withTransaction                    (helper-owned)
 *        └─ set_tenant_context              (helper-owned, before reserve)
 *        └─ withTenantContext               (this handler — documented
 *           └─ executeSubscriptionTransition   service-contract wrap)
 *              └─ withDbRole(<slice role>)  (service-owned)
 *              └─ emit §15 audit (same tx, restored app role)
 *
 * No withActorContext: the subscription service derives the actor identity
 * from the handler-passed SubscriptionActor (resolved from the verified JWT
 * subject), not from a DB-side current_actor_*() call — so no SI-010 nonce
 * binding is needed on this path. The migration 077 helper grants are
 * future-proofing for a later predicate that reads the actor DB-side.
 *
 * Outcome → HTTP mapping (mapOutcomeToResult):
 *   transitioned  → success status (200, or 202 for switch) + tenant-blind view
 *   not_found     → 404 tenant-blind (I-025: absent / cross-tenant / not-owned
 *                   are indistinguishable — the service self-scopes patient reads)
 *   invalid_state → 409 (the service emitted the I-003 rejection audit and the
 *                   tx COMMITS with it — bare suppression forbidden)
 *   guard_failed  → 400 (invalid_pause_duration) / 403 (actor_not_permitted) /
 *                   422 (other business-rule guard)
 *
 * Spec references: OpenAPI v0.2 §20.3-20.6, State Machines v1.1 §15,
 * CDM v1.2 §4.7/§4.8, I-003/I-023/I-025/I-027, IDEMPOTENCY v5.1,
 * migrations/075-077.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { resolveActorTenantIdForAudit } from '../../../../lib/auth-context.js';
import {
  withIdempotentExecution,
  type ServiceErrorMapper,
} from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import {
  executeSubscriptionTransition,
  type SubscriptionActor,
  type TransitionContext,
  type TransitionOutcome,
} from '../service.js';
import type { SubscriptionTransition } from '../state-machine.js';
import { CANCEL_REASONS, DEFLECTION_OUTCOMES, PAUSE_REASONS, SWITCH_REASONS } from '../types.js';

import {
  isProductIdShape,
  isSubscriptionIdShape,
  makeErrorEnvelope,
  parseIsoTimestamp,
  pgErrorCode,
  resolveWriteActor,
  toSubscriptionView,
  type ErrorEnvelopeBody,
  type SubscriptionView,
} from './shared.js';

// ---------------------------------------------------------------------------
// Service-error mapper (withIdempotentExecution contract)
// ---------------------------------------------------------------------------

const mapSubscriptionServiceError: ServiceErrorMapper = (err, reply, reqId): boolean => {
  const code = pgErrorCode(err);
  if (code === '42501') {
    void reply
      .code(403)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.auth.insufficient_scope',
          'Insufficient scope for this request.',
        ),
      );
    return true;
  }
  // 23514 (a durable CHECK the boundary validation missed — e.g. the 90-day
  // pause window) / 23503 (composite FK — cannot normally fire on these
  // transitions since they touch no FK columns): tenant-blind 400.
  if (code === '23514' || code === '23503') {
    void reply
      .code(400)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.request.invalid',
          'Request violates a subscription integrity constraint.',
        ),
      );
    return true;
  }
  return false;
};

// ---------------------------------------------------------------------------
// Outcome → { status, view }
// ---------------------------------------------------------------------------

function mapOutcomeToResult(
  outcome: TransitionOutcome,
  reqId: string,
  successStatus: number,
): { status: number; view: SubscriptionView | ErrorEnvelopeBody } {
  switch (outcome.outcome) {
    case 'transitioned':
      return { status: successStatus, view: toSubscriptionView(outcome.row) };
    case 'not_found':
      return {
        status: 404,
        view: makeErrorEnvelope(reqId, 'internal.resource.not_found', 'Subscription not found.'),
      };
    case 'invalid_state':
      return {
        status: 409,
        view: makeErrorEnvelope(
          reqId,
          'internal.subscription.invalid_state_transition',
          `Subscription is ${outcome.currentStatus}; this action requires ${outcome.expectedFrom}.`,
        ),
      };
    case 'guard_failed':
      if (outcome.reason === 'actor_not_permitted') {
        return {
          status: 403,
          view: makeErrorEnvelope(
            reqId,
            'internal.auth.insufficient_scope',
            'Actor not permitted for this transition.',
          ),
        };
      }
      if (outcome.reason === 'invalid_pause_duration') {
        return {
          status: 400,
          view: makeErrorEnvelope(
            reqId,
            'internal.subscription.invalid_pause_duration',
            'pause_until must be in the future and within 90 days of now.',
          ),
        };
      }
      return {
        status: 422,
        view: makeErrorEnvelope(
          reqId,
          'internal.subscription.business_rule_violation',
          `Transition rejected: ${outcome.reason}.`,
        ),
      };
  }
}

// ---------------------------------------------------------------------------
// Shared transition runner
// ---------------------------------------------------------------------------

interface RunTransitionArgs {
  transition: SubscriptionTransition;
  successStatus: number;
  pauseUntil?: Date;
  cancelReason?: string;
  eventData?: Record<string, unknown>;
}

async function runTransition(
  req: FastifyRequest,
  reply: FastifyReply,
  actor: SubscriptionActor,
  subscriptionId: string,
  args: RunTransitionArgs,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);
  const transitionCtx: TransitionContext = {
    tenantId: ctx.tenantId,
    countryOfCare: ctx.countryOfCare,
    actorTenantIdForAudit: actorTenantId,
  };

  return withIdempotentExecution<SubscriptionView | ErrorEnvelopeBody>(
    req,
    reply,
    mapSubscriptionServiceError,
    async (tx) => {
      let result: { status: number; view: SubscriptionView | ErrorEnvelopeBody } | undefined;
      await withTenantContext(tx, ctx.tenantId, async () => {
        const outcome = await executeSubscriptionTransition(tx, {
          ctx: transitionCtx,
          actor,
          subscriptionId,
          transition: args.transition,
          ...(args.pauseUntil !== undefined ? { pauseUntil: args.pauseUntil } : {}),
          ...(args.cancelReason !== undefined ? { cancelReason: args.cancelReason } : {}),
          ...(args.eventData !== undefined ? { eventData: args.eventData } : {}),
        });
        result = mapOutcomeToResult(outcome, req.id, args.successStatus);
      });
      // withTenantContext always runs its callback synchronously-awaited, so
      // `result` is assigned by the time we get here.
      return result as { status: number; view: SubscriptionView | ErrorEnvelopeBody };
    },
  );
}

// ---------------------------------------------------------------------------
// POST /:subscription_id/pause  (§20.3)
// ---------------------------------------------------------------------------

interface PauseBody {
  reason?: string;
  pause_until?: string;
  notes?: string;
}

export async function pauseSubscriptionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const actor = resolveWriteActor(req);
  const params = (req.params ?? {}) as { subscription_id?: string };
  if (!isSubscriptionIdShape(params.subscription_id)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Path parameter subscription_id must be a canonical sub_<ULID>.',
        ),
      );
  }

  const body = (req.body ?? {}) as PauseBody;
  const pauseUntil = parseIsoTimestamp(body.pause_until);
  if (
    !PAUSE_REASONS.includes(body.reason as (typeof PAUSE_REASONS)[number]) ||
    pauseUntil === null ||
    (body.notes !== undefined && typeof body.notes !== 'string')
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          `Invalid pause body: reason (one of ${PAUSE_REASONS.join('|')}) and pause_until ` +
            '(ISO 8601 timestamp) are required; notes optional.',
        ),
      );
  }

  return runTransition(req, reply, actor, params.subscription_id, {
    transition: 'pause_request',
    successStatus: 200,
    pauseUntil,
    eventData: { reason: body.reason, ...(body.notes !== undefined ? { notes: body.notes } : {}) },
  });
}

// ---------------------------------------------------------------------------
// POST /:subscription_id/resume  (§20.4)
// ---------------------------------------------------------------------------

export async function resumeSubscriptionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const actor = resolveWriteActor(req);
  const params = (req.params ?? {}) as { subscription_id?: string };
  if (!isSubscriptionIdShape(params.subscription_id)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Path parameter subscription_id must be a canonical sub_<ULID>.',
        ),
      );
  }

  return runTransition(req, reply, actor, params.subscription_id, {
    transition: 'resume',
    successStatus: 200,
    eventData: {},
  });
}

// ---------------------------------------------------------------------------
// POST /:subscription_id/switch  (§20.5) — initiates the switch (ACTIVE →
// SWITCHING); the actual product rebind happens at clinician switch_approve
// (an exported service function, no HTTP surface at v0.2). Returns 202: the
// switch is pending clinician review. The requested new_product_id is
// recorded in the switching_initiated event_data (queryable via the events
// endpoint); NO review_case_id is minted here (the clinical review case is a
// cross-module concern with no ratified entity in this slice — named
// follow-up in the module README).
// ---------------------------------------------------------------------------

interface SwitchBody {
  new_product_id?: string;
  reason?: string;
  notes?: string;
}

export async function switchSubscriptionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const actor = resolveWriteActor(req);
  const params = (req.params ?? {}) as { subscription_id?: string };
  if (!isSubscriptionIdShape(params.subscription_id)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Path parameter subscription_id must be a canonical sub_<ULID>.',
        ),
      );
  }

  const body = (req.body ?? {}) as SwitchBody;
  if (
    !isProductIdShape(body.new_product_id) ||
    !SWITCH_REASONS.includes(body.reason as (typeof SWITCH_REASONS)[number]) ||
    (body.notes !== undefined && typeof body.notes !== 'string')
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          `Invalid switch body: new_product_id (canonical prd_<ULID>) and reason ` +
            `(one of ${SWITCH_REASONS.join('|')}) are required; notes optional.`,
        ),
      );
  }

  return runTransition(req, reply, actor, params.subscription_id, {
    transition: 'switch_request',
    successStatus: 202,
    eventData: {
      new_product_id: body.new_product_id,
      reason: body.reason,
      ...(body.notes !== undefined ? { notes: body.notes } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// POST /:subscription_id/cancel  (§20.6) — ACTIVE → CANCELLATION_PENDING.
// Deflection metadata is NON-BLOCKING (the patient's choice to cancel is
// sovereign per §15; deflection is recorded, never used to reject). The
// current period continues until end_period (a system transition).
// ---------------------------------------------------------------------------

interface CancelBody {
  reason?: string;
  feedback?: string;
  deflection_attempted?: boolean;
  deflection_outcome?: string;
}

export async function cancelSubscriptionHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const actor = resolveWriteActor(req);
  const params = (req.params ?? {}) as { subscription_id?: string };
  if (!isSubscriptionIdShape(params.subscription_id)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Path parameter subscription_id must be a canonical sub_<ULID>.',
        ),
      );
  }

  const body = (req.body ?? {}) as CancelBody;
  const deflectionAttempted = body.deflection_attempted === true;
  // deflection_outcome is required IFF deflection_attempted; when present it
  // must be a canonical value. When deflection was not attempted, an outcome
  // must NOT be supplied.
  const deflectionOutcomeValid = deflectionAttempted
    ? DEFLECTION_OUTCOMES.includes(body.deflection_outcome as (typeof DEFLECTION_OUTCOMES)[number])
    : body.deflection_outcome === undefined || body.deflection_outcome === null;
  if (
    !CANCEL_REASONS.includes(body.reason as (typeof CANCEL_REASONS)[number]) ||
    typeof body.deflection_attempted !== 'boolean' ||
    !deflectionOutcomeValid ||
    (body.feedback !== undefined && typeof body.feedback !== 'string')
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          `Invalid cancel body: reason (one of ${CANCEL_REASONS.join('|')}) and ` +
            'deflection_attempted (boolean) are required; deflection_outcome ' +
            `(one of ${DEFLECTION_OUTCOMES.join('|')}) required iff deflection_attempted; ` +
            'feedback optional.',
        ),
      );
  }

  // body.reason is validated to be a CANCEL_REASONS member above; narrow it.
  const reason = body.reason as (typeof CANCEL_REASONS)[number];
  return runTransition(req, reply, actor, params.subscription_id, {
    transition: 'cancel_request',
    successStatus: 200,
    cancelReason: reason,
    eventData: {
      reason,
      deflection_attempted: deflectionAttempted,
      ...(deflectionAttempted ? { deflection_outcome: body.deflection_outcome } : {}),
      ...(body.feedback !== undefined ? { feedback: body.feedback } : {}),
    },
  });
}
