/**
 * supersede-signal.ts — POST /v0/med-interaction/signals/:id/supersede
 *
 * **PR scope:** Sprint 1 PR 9 — supersede handler (operational, mirrors
 * Med-Int PR 8 emit-signal / activate-signal pattern). Calls SECDEF
 * wrapper `record_signal_supersession` from migration 050 §3 under
 * `medication_interaction_engine_evaluator` slice role. Emits Cat A
 * `interaction_signal_lifecycle_transition_emitted` same-tx with the
 * wrapper INSERT per I-003 durability.
 *
 * Wrapper signature (migration 050 §3):
 *   record_signal_supersession(
 *     p_id                        VARCHAR(26),
 *     p_tenant_id                 TEXT,
 *     p_signal_id                 VARCHAR(26),
 *     p_replacement_evaluation_id VARCHAR(26),
 *     p_actor_id                  VARCHAR(26),
 *     p_metadata                  JSONB
 *   ) RETURNS VOID
 *
 * Body shape: { replacement_evaluation_id: ULID, metadata?: object }
 *
 * 42501 → tenant-blind 403 (R2 MED-1 closure pattern; wraps ENTIRE
 * withDbRole call). 02000/23514 → 404 (signal not found / wrong state).
 * 23505 → 409 (already superseded).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { resolveActorTenantIdForAudit } from '../../../../lib/auth-context.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitSignalLifecycleTransitionAudit } from '../../audit.js';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const PathParamsSchema = z.object({
  id: z.string().regex(ULID_PATTERN, 'signal id must be a 26-char Crockford-base32 ULID'),
});

const BodySchema = z.object({
  replacement_evaluation_id: z
    .string()
    .regex(ULID_PATTERN, 'replacement_evaluation_id must be a 26-char ULID'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function mapServiceError(err: unknown, reply: FastifyReply, requestId: string): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === '42501') {
    void reply.code(403).send({
      error: {
        code: 'med_interaction.forbidden',
        message: 'Insufficient scope for this request.',
        request_id: requestId,
      },
    });
    return true;
  }
  if (code === '02000' || code === '23514') {
    void reply.code(404).send({
      error: {
        code: 'med_interaction.signal_not_found_or_wrong_state',
        message: 'Signal not found or not in a superseded-eligible state.',
        request_id: requestId,
      },
    });
    return true;
  }
  if (code === '23505') {
    void reply.code(409).send({
      error: {
        code: 'med_interaction.signal_already_superseded',
        message: 'Signal already superseded.',
        request_id: requestId,
      },
    });
    return true;
  }
  return false;
}

export async function supersedeSignalHandler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);
  const paramsParsed = PathParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid path params: ${paramsParsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`,
    );
  }
  const { id: signalId } = paramsParsed.data;

  const bodyParsed = BodySchema.safeParse(req.body ?? {});
  if (!bodyParsed.success) {
    throw req.server.httpErrors.badRequest(
      `Invalid request body: ${bodyParsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`,
    );
  }
  const { replacement_evaluation_id: replacementEvalId, metadata = {} } = bodyParsed.data;

  const actorId =
    req.actorContext?.accountId ?? (req.headers['x-actor-id'] as string | undefined) ?? 'unknown';
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  // Deterministic transition row id (ULID-ish) derived from idempotency key
  // would happen inside withIdempotentExecution; for v0.1 we generate a
  // server-side ULID via the wrapper's caller-supplied p_id parameter.
  // The wrapper itself enforces uniqueness on (tenant_id, p_id).

  return withIdempotentExecution(req, reply, mapServiceError, async (tx, idempotencyCtx) => {
    const transitionId = idempotencyCtx.idempotencyKey; // ULID-shaped per IDEMPOTENCY v5.1
    return withTenantContext(tx, ctx.tenantId, async () => {
      const run = async (): Promise<{
        status: number;
        view: { signal_id: string; status: 'superseded' };
      }> => {
        try {
          await withDbRole(tx, 'medication_interaction_engine_evaluator', async () => {
            await tx.query('SELECT record_signal_supersession($1, $2, $3, $4, $5, $6::jsonb)', [
              transitionId,
              ctx.tenantId,
              signalId,
              replacementEvalId,
              actorId,
              JSON.stringify(metadata),
            ]);
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

        const txTyped: DbTransaction = tx;
        await emitSignalLifecycleTransitionAudit(
          {
            tenantId: ctx.tenantId,
            signalId,
            transitionId,
            patientId: null,
            actorId,
            actorTenantId,
            countryOfCare: ctx.countryOfCare,
            fromState: 'active',
            toState: 'superseded',
            transitionReason: 'supersession',
          },
          txTyped,
        );

        return { status: 201, view: { signal_id: signalId, status: 'superseded' } };
      };

      if (req.actorNonce !== undefined) {
        return withActorContext(tx, req.actorNonce, run);
      }
      return run();
    });
  });
}
