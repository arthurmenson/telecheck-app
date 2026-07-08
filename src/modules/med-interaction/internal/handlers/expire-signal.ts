/**
 * expire-signal.ts — POST /v0/med-interaction/signals/:id/expire
 *
 * **PR scope:** Sprint 1 PR 9. Calls SECDEF wrapper
 * `record_signal_expiry` from migration 050 §5 under
 * `medication_interaction_engine_evaluator` (scheduler) slice role.
 *
 * **Fail-closed posture (STANDS after the migration 070 evidence-unlock
 * pass):** the wrapper RAISES SQLSTATE `0A000` per Codex R1 closure
 * 2026-05-23. The precisely-narrowed remaining deferral (migration 070
 * header): SI-019 §6.NEW6's elapsed-time predicate
 * `now() > emission_time + per_basis_duration` needs the CCR-driven
 * per-basis cadence config table (duration formula per
 * `time_window_basis`), which is still absent from the code repo. The
 * structural preflights (time_window_basis non-null → 23514; emission row
 * exists → 02000) run first; only a structurally-valid expiry attempt
 * reaches the 0A000. Mapped here to 503 tenant-blind per I-025.
 *
 * **Cat A audit emission on REJECTION (savepoint-recovered):** I-003
 * bare-suppression-forbidden — the rejected attempt belongs in the audit
 * chain. On live PostgreSQL the failed wrapper call ABORTS the
 * transaction, so the attempt is wrapped in a SAVEPOINT: on 0A000 the
 * handler ROLLBACKs TO the savepoint, emits the rejection attestation in
 * the recovered tx, and RETURNS the 503 envelope (not a throw — a throw
 * would roll back the whole business tx and destroy the attestation).
 * The idempotency record then replays the same 503 for the same key,
 * which is the honest deterministic outcome while the capability is
 * spec-gated. (The v0.1 scaffold emitted the audit directly into the
 * aborted tx and re-threw — which on live PG would have surfaced 25P02 →
 * 500 and persisted nothing; corrected in the evidence-unlock PR.)
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
        view:
          | { signal_id: string; status: 'expired' }
          | { error: { code: string; message: string; request_id: string } };
      }> => {
        // SAVEPOINT around the wrapper attempt: a failed SQL statement
        // aborts the tx on live PostgreSQL; the savepoint lets the handler
        // recover the tx to emit the I-003 rejection attestation. The
        // ROLLBACK TO also unwinds withDbRole's SET LOCAL ROLE, so the
        // audit INSERT runs under the session app role.
        let rejected = false;
        await tx.query('SAVEPOINT med_interaction_wrapper_attempt');
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
          await tx.query('RELEASE SAVEPOINT med_interaction_wrapper_attempt');
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT med_interaction_wrapper_attempt');
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code?: unknown }).code === '0A000'
          ) {
            rejected = true;
          } else {
            // 42501 → mapper 403; 02000/23514 → mapper 404; others → 500.
            // Structured rejections are absorbed AFTER the business tx
            // rolls back (withIdempotentExecution → mapServiceError).
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
          // RETURN (don't throw) so the recovered tx COMMITS the rejection
          // attestation — I-003 bare-suppression-forbidden. Envelope shape
          // matches the mapServiceError 0A000 branch verbatim.
          return {
            status: 503,
            view: {
              error: {
                code: 'med_interaction.expiry_capability_not_yet_available',
                message: 'Signal expiry capability is not yet available in this deployment.',
                request_id: req.id,
              },
            },
          };
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
