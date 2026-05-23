/**
 * resolve-signal.ts — POST /v0/med-interaction/signals/:id/resolve
 *
 * **PR scope:** Sprint 1 PR 9. Calls SECDEF wrapper
 * `record_signal_resolution` from migration 050 §4.
 *
 * **Fail-closed posture (v0.1):** the wrapper RAISES SQLSTATE `0A000`
 * pending the Async Consult discontinuation-event log migration. Per
 * the GRANT matrix in migration 050 §4 the wrapper has NO app-role
 * EXECUTE grant (only the owner can EXECUTE — "DEFERRED: role exists
 * only after Async Consult subscriber registry lands"). The handler
 * call therefore fails at the PG EXECUTE check with 42501 BEFORE the
 * wrapper body's 0A000 — both paths converge to a 503 tenant-blind
 * response per the mapper below.
 *
 * **Cat A audit emission on REJECTION:** same I-003 pattern as
 * override-signal.ts — even rejection paths emit Cat A
 * `interaction_signal_lifecycle_transition_emitted` with rejection
 * reason captured in detail.
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
import { emitSignalLifecycleTransitionAudit } from '../../audit.js';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PathParamsSchema = z.object({
  id: z.string().regex(ULID_PATTERN, 'signal id must be a 26-char ULID'),
});
const BodySchema = z.object({
  discontinuation_event_id: z.string().regex(ULID_PATTERN),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function mapServiceError(err: unknown, reply: FastifyReply, requestId: string): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: unknown }).code;
  // Per migration 050 §4: no app-role GRANT on resolve wrapper → 42501 at
  // PG EXECUTE check converges to the same client-facing 503 as the
  // wrapper-body 0A000. Both mean "resolution capability not yet
  // available in this deployment." Tenant-blind per I-025.
  if (code === '42501' || code === '0A000') {
    reply.code(503).send({
      error: { code: 'med_interaction.resolution_capability_not_yet_available', message: 'Signal resolution capability is not yet available in this deployment.', request_id: requestId },
    });
    return true;
  }
  if (code === '02000' || code === '23514') {
    reply.code(404).send({
      error: { code: 'med_interaction.signal_not_found_or_wrong_state', message: 'Signal not found or not in a resolve-eligible state.', request_id: requestId },
    });
    return true;
  }
  return false;
}

export async function resolveSignalHandler(
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
  const { discontinuation_event_id: discontinuationEventId, metadata = {} } = bodyParsed.data;

  const actorId =
    req.actorContext?.accountId ??
    (req.headers['x-actor-id'] as string | undefined) ??
    'unknown';
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution(req, reply, mapServiceError, async (tx, idempotencyCtx) => {
    const transitionId = idempotencyCtx.idempotencyKey;
    return withTenantContext(tx, ctx.tenantId, async () => {
      const run = async (): Promise<{ status: number; view: { signal_id: string; status: 'resolved' } }> => {
        let rejected = false;
        let rejectionCode: string | undefined;
        try {
          // NOTE: app role for resolve has NO GRANT per migration 050 §4
          // (DEFERRED to medication_interaction_resolution_subscriber when
          // Async Consult subscriber registry lands). v0.1 uses
          // medication_interaction_engine_evaluator anyway since that's
          // the closest-available app role; PG EXECUTE check fails with
          // 42501 → mapped to 503 per mapServiceError.
          await withDbRole(tx, 'medication_interaction_engine_evaluator', async () => {
            await tx.query(
              'SELECT record_signal_resolution($1, $2, $3, $4, $5, $6::jsonb)',
              [transitionId, ctx.tenantId, signalId, discontinuationEventId, actorId, JSON.stringify(metadata)],
            );
          });
        } catch (err) {
          if (typeof err === 'object' && err !== null && 'code' in err) {
            const code = (err as { code?: unknown }).code;
            if (code === '42501' || code === '0A000') {
              rejected = true;
              rejectionCode = String(code);
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
            toState: rejected ? 'rejected' : 'resolved',
            transitionReason: rejected
              ? `resolve_rejected_${rejectionCode === '0A000' ? 'feature_not_supported' : 'execute_not_granted'}`
              : 'resolution',
          },
          txTyped,
        );

        if (rejected) {
          throw Object.assign(new Error('resolution_capability_not_yet_available'), { code: rejectionCode });
        }

        return { status: 201, view: { signal_id: signalId, status: 'resolved' } };
      };

      if (req.actorNonce !== undefined) {
        return withActorContext(tx, req.actorNonce, run);
      }
      return run();
    });
  });
}
