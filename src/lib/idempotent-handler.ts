/**
 * idempotent-handler.ts — Shared handler-side helper for the SI-006
 * reserve-then-execute idempotency pattern.
 *
 * Sprint 32 / SI-006 PR-C extraction. PR-B introduced this helper as a
 * file-local function in `src/modules/async-consult/internal/handlers/consults.ts`.
 * PR-C migrates a second module (consent) to the same pattern; rather
 * than duplicate the helper in three places (async-consult + consent
 * + future state-mutating slices), it lives here.
 *
 * Usage from a Fastify state-changing handler:
 *
 *   return withIdempotentExecution(req, reply, mapServiceError, async (tx) => {
 *     const result = await someService.doStateChange(ctx, actor, ..., tx);
 *     return { status: 200, view: toPatientView(result) };
 *   });
 *
 * The helper now manages cache reservation, write, and completion entirely
 * inside the handler-owned transaction. No separate per-handler flag-set
 * is required — the legacy onSend cache-write hook (and its companion
 * `markIdempotencyManagedByHandler` opt-out flag) were removed in Sprint
 * 33 PR-E + Sprint 34 cleanup-sweep respectively. Every state-changing
 * handler uses this helper or `withIdempotency` directly.
 *
 * Spec references:
 *   - docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md (v0.2)
 *   - PR-A: src/lib/idempotency.ts withIdempotency helper
 *   - PR-B: src/modules/async-consult/internal/handlers/consults.ts
 *     (introduced this pattern as a local function)
 *   - I-025 (tenant-blind error envelopes; the helper enforces this
 *     by passing the projected view from body() into the cache, NOT
 *     the raw service result that may carry tenant_id)
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { type DbTransaction, withTransaction } from './db.js';
import {
  IdempotencyBodyMismatchError,
  IdempotencyInFlightError,
  IdempotencyReplayError,
  type IdempotencyCtx,
  buildIdempotencyCtx,
  withIdempotency,
} from './idempotency.js';
import { requireTenantContext } from './tenant-context.js';

/**
 * Function signature handlers pass for service-error mapping. Return
 * `true` if the error was mapped to an HTTP response (handler returns
 * `reply` after the helper returns); return `false` to propagate the
 * throw up to Fastify's global error handler.
 *
 * Mirrors the existing `mapServiceError` shape in async-consult/consent
 * handlers — each module owns its own mapping function (different
 * service errors, different status codes); the helper just calls it.
 */
export type ServiceErrorMapper = (err: unknown, reply: FastifyReply, reqId: string) => boolean;

/**
 * Build an error envelope for the canonical idempotency 409 responses.
 * Mirrors the per-handler `makeErrorEnvelope` shape used in
 * async-consult/consent handlers.
 */
interface IdempotencyErrorEnvelope {
  error: { code: string; message: string; request_id: string };
}

function envelope(reqId: string, code: string, message: string): IdempotencyErrorEnvelope {
  return { error: { code, message, request_id: reqId } };
}

/**
 * Wrap a state-changing handler body in:
 *   1. Build IdempotencyCtx from the request.
 *   2. Open a business transaction; set tenant context.
 *   3. Reserve via `withIdempotency`; the body callback runs the
 *      service call and returns `{ status, view }` (the view is the
 *      caller-projected response — must NOT carry tenant_id per I-025).
 *   4. On success: reply with `view` at `status`.
 *   5. On idempotency errors: replay (cached status + body) or 409.
 *   6. On service errors: route via `mapServiceError`.
 *   7. On unhandled: throw (Fastify global error handler takes over).
 *
 * The caller does not need any separate flag-set or opt-out call — the
 * helper owns cache management for every code path it handles, and the
 * legacy onSend cache-write hook that necessitated such a flag was
 * removed in Sprint 33 PR-E.
 */
export async function withIdempotentExecution<TView>(
  req: FastifyRequest,
  reply: FastifyReply,
  mapServiceError: ServiceErrorMapper,
  body: (
    tx: DbTransaction,
    /**
     * The IdempotencyCtx used to reserve this request's cache slot.
     * Passed to body callbacks so they can forward it into service-
     * layer audit-dedupe claims (Sprint 34 audit-dedupe SI). Body
     * callbacks that don't need it can ignore the parameter.
     */
    idempotencyCtx: IdempotencyCtx,
  ) => Promise<{ status: number; view: TView }>,
): Promise<unknown> {
  const tenantCtx = requireTenantContext(req);
  const idempotencyCtx = buildIdempotencyCtx(req);

  try {
    const payload = await withTransaction(async (tx) => {
      // Set tenant context BEFORE calling withIdempotency — the
      // idempotency_keys table has FORCE RLS; absent context fails
      // closed via tenant_context_not_set.
      await tx.query('SELECT set_tenant_context($1)', [tenantCtx.tenantId]);

      return await withIdempotency(tx, idempotencyCtx, async () => {
        const result = await body(tx, idempotencyCtx);
        return { status: result.status, body: result.view };
      });
    });

    return reply.code(payload.status).send(payload.body);
  } catch (err) {
    if (err instanceof IdempotencyReplayError) {
      // Cache hit on completed record. Replay status + body verbatim.
      return reply.code(err.cachedStatus).send(err.cachedBody);
    }
    if (err instanceof IdempotencyInFlightError) {
      return reply.code(409).send(envelope(req.id, 'internal.idempotency.in_flight', err.hint));
    }
    if (err instanceof IdempotencyBodyMismatchError) {
      return reply
        .code(409)
        .send(
          envelope(
            req.id,
            'internal.idempotency.body_mismatch',
            'Idempotency key already used with a different request body. Generate a new Idempotency-Key for a different request.',
          ),
        );
    }
    if (mapServiceError(err, reply, req.id)) return reply;
    throw err;
  }
}
