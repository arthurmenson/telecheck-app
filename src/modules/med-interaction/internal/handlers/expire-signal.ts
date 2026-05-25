/**
 * expire-signal.ts — POST /v0/med-interaction/signals/:id/expire
 *
 * **PR scope:** Sprint 1 PR 9. Calls SECDEF wrapper
 * `record_signal_expiry` from migration 050 §5 under
 * `medication_interaction_engine_evaluator` (scheduler) slice role.
 *
 * **Fail-closed posture (v0.1):** the wrapper RAISES SQLSTATE `0A000`
 * per Codex R1 closure 2026-05-23 — wrapper body fails-closed pending
 * the per-basis cadence config table (needed for window-end-time check
 * "now() > emission_time + time_window"). Mapped here to 503
 * Service Unavailable tenant-blind per I-025.
 *
 * **Cat A audit emission on REJECTION:** same I-003 pattern as
 * override-signal.ts + resolve-signal.ts — even rejection paths emit
 * Cat A `interaction_signal_lifecycle_transition_emitted`.
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
  id: z.string().regex(ULID_PATTERN, 'signal id must be a 26-char ULID'),
});
const BodySchema = z.object({
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
  if (code === '0A000') {
    void reply.code(503).send({
      error: {
        code: 'med_interaction.expiry_capability_not_yet_available',
        message: 'Signal expiry capability is not yet available in this deployment.',
        request_id: requestId,
      },
    });
    return true;
  }
  if (code === '02000' || code === '23514') {
    void reply.code(404).send({
      error: {
        code: 'med_interaction.signal_not_found_or_wrong_state',
        message: 'Signal not found or not in an expire-eligible state.',
        request_id: requestId,
      },
    });
    return true;
  }
  return false;
}

export async function expireSignalHandler(
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
  const { metadata = {} } = bodyParsed.data;

  const actorId =
    req.actorContext?.accountId ?? (req.headers['x-actor-id'] as string | undefined) ?? 'unknown';
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution(req, reply, mapServiceError, async (tx, idempotencyCtx) => {
    const transitionId = idempotencyCtx.idempotencyKey;
    return withTenantContext(tx, ctx.tenantId, async () => {
      const run = async (): Promise<{
        status: number;
        view: { signal_id: string; status: 'expired' };
      }> => {
        let rejected = false;
        try {
          await withDbRole(tx, 'medication_interaction_engine_evaluator', async () => {
            await tx.query('SELECT record_signal_expiry($1, $2, $3, $4, $5::jsonb)', [
              transitionId,
              ctx.tenantId,
              signalId,
              actorId,
              JSON.stringify(metadata),
            ]);
          });
        } catch (err) {
          if (typeof err === 'object' && err !== null && 'code' in err) {
            const code = (err as { code?: unknown }).code;
            if (code === '42501') {
              throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
            }
            if (code === '0A000') {
              rejected = true;
            } else {
              throw err;
            }
          } else {
            throw err;
          }
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
            toState: rejected ? 'rejected' : 'expired',
            transitionReason: rejected
              ? 'expire_rejected_feature_not_supported_cadence_config_missing'
              : 'expiry',
          },
          txTyped,
        );

        if (rejected) {
          throw Object.assign(new Error('expiry_capability_not_yet_available'), { code: '0A000' });
        }

        return { status: 201, view: { signal_id: signalId, status: 'expired' } };
      };

      if (req.actorNonce !== undefined) {
        return withActorContext(tx, req.actorNonce, run);
      }
      return run();
    });
  });
}
