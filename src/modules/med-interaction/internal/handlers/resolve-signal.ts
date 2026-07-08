/**
 * resolve-signal.ts — POST /v0/med-interaction/signals/:id/resolve
 *
 * **PR scope:** Sprint 1 PR 9. Calls SECDEF wrapper
 * `record_signal_resolution` from migration 050 §4.
 *
 * **Fail-closed posture (STANDS after the migration 070 evidence-unlock
 * pass).** The precisely-narrowed remaining deferral (migration 070
 * header): of SI-019 §6.NEW5's 3 evidence checks, check (1)'s source NOW
 * EXISTS (`medication_request.discontinued.v1` rows in
 * domain_events_outbox, emitted by Pharmacy since TLC-055) — but the
 * wrapper stays fail-closed because (i) check (3)'s protocol-specific
 * washout-period configuration has no code-repo source, (ii) the app-role
 * caller `medication_interaction_resolution_subscriber` is still not
 * created (migration 055 §0 declined; Async Consult domain-event
 * subscriber registry absent) so the wrapper has NO app-role EXECUTE
 * grant, and (iii) the wrapper's p_discontinuation_event_id VARCHAR(26)
 * must be reconciled with the outbox's UUID event_id (migration 004
 * recorded SPEC ISSUE). The handler call therefore fails at the PG
 * EXECUTE check with 42501 BEFORE the wrapper body's 0A000 — both paths
 * converge to a 503 tenant-blind response per the mapper below.
 *
 * **Cat A audit emission on REJECTION (savepoint-recovered):** I-003
 * bare-suppression-forbidden — the rejected attempt belongs in the audit
 * chain. On live PostgreSQL the failed wrapper call ABORTS the
 * transaction, so the attempt is wrapped in a SAVEPOINT: on 42501/0A000
 * the handler ROLLBACKs TO the savepoint, emits the rejection attestation
 * in the recovered tx, and RETURNS the 503 envelope (not a throw — a
 * throw would roll back the whole business tx and destroy the
 * attestation). (The v0.1 scaffold emitted the audit directly into the
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
    void reply.code(503).send({
      error: {
        code: 'med_interaction.resolution_capability_not_yet_available',
        message: 'Signal resolution capability is not yet available in this deployment.',
        request_id: requestId,
      },
    });
    return true;
  }
  if (code === '02000' || code === '23514') {
    void reply.code(404).send({
      error: {
        code: 'med_interaction.signal_not_found_or_wrong_state',
        message: 'Signal not found or not in a resolve-eligible state.',
        request_id: requestId,
      },
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
    req.actorContext?.accountId ?? (req.headers['x-actor-id'] as string | undefined) ?? 'unknown';
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution(req, reply, mapServiceError, async (tx, idempotencyCtx) => {
    const transitionId = idempotencyCtx.idempotencyKey;
    return withTenantContext(tx, ctx.tenantId, async () => {
      const run = async (): Promise<{
        status: number;
        view:
          | { signal_id: string; status: 'resolved' }
          | { error: { code: string; message: string; request_id: string } };
      }> => {
        // SAVEPOINT around the wrapper attempt: a failed SQL statement
        // aborts the tx on live PostgreSQL; the savepoint lets the handler
        // recover the tx to emit the I-003 rejection attestation. The
        // ROLLBACK TO also unwinds withDbRole's SET LOCAL ROLE, so the
        // audit INSERT runs under the session app role.
        let rejected = false;
        let rejectionCode: string | undefined;
        await tx.query('SAVEPOINT med_interaction_wrapper_attempt');
        try {
          // NOTE: app role for resolve has NO GRANT per migration 050 §4
          // (DEFERRED to medication_interaction_resolution_subscriber when
          // Async Consult subscriber registry lands — deferral restated in
          // migration 070's header). Uses
          // medication_interaction_engine_evaluator as the closest-available
          // app role; the PG EXECUTE check fails with 42501 → converges to
          // the same fail-closed 503 as the wrapper-body 0A000.
          await withDbRole(tx, 'medication_interaction_engine_evaluator', async () => {
            await tx.query('SELECT record_signal_resolution($1, $2, $3, $4, $5, $6::jsonb)', [
              transitionId,
              ctx.tenantId,
              signalId,
              discontinuationEventId,
              actorId,
              JSON.stringify(metadata),
            ]);
          });
          await tx.query('RELEASE SAVEPOINT med_interaction_wrapper_attempt');
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT med_interaction_wrapper_attempt');
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
          // RETURN (don't throw) so the recovered tx COMMITS the rejection
          // attestation — I-003 bare-suppression-forbidden. Envelope shape
          // matches the mapServiceError 42501/0A000 branch verbatim.
          return {
            status: 503,
            view: {
              error: {
                code: 'med_interaction.resolution_capability_not_yet_available',
                message: 'Signal resolution capability is not yet available in this deployment.',
                request_id: req.id,
              },
            },
          };
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
