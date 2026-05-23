/**
 * override-signal.ts — POST /v0/med-interaction/signals/:id/override
 *
 * **PR scope:** Sprint 1 PR 9. Calls SECDEF wrapper
 * `record_interaction_signal_override` from migration 050 §6 under
 * `medication_interaction_override_recorder` slice role.
 *
 * **Fail-closed posture (v0.1):** the wrapper RAISES SQLSTATE `0A000`
 * (feature_not_supported) per Codex R1 closure 2026-05-23 pending the
 * upstream SI-024.1 JWT-binding helper landing (the wrapper body cannot
 * resolve the clinician-credential evidence without it). For v0.1 we
 * still WIRE the handler (so the route exists + integration tests can
 * cover the fail-closed path) but the wrapper itself returns 0A000 →
 * mapped here to 503 Service Unavailable tenant-blind per I-025.
 *
 * **KMS envelope deferral:** the wrapper takes 8 KMS-envelope columns
 * for the override-rationale ciphertext. For v0.1 we pass NULL for all
 * 8 (the migration 047 all-or-none CHECK constraint permits all-NULL).
 * When the KMS-per-tenant adapter is wired in handler context, an
 * `override_rationale` plaintext body field will be encrypted client-
 * side + the 8 envelope columns populated.
 *
 * **Cat A audit emission on REJECTION (I-003 bare-suppression-forbidden):**
 * even the fail-closed path emits Cat A `interaction_signal_lifecycle_transition_emitted`
 * with `rejection_reason: 'feature_not_supported_evidence_source_missing'`
 * + `to_state: 'rejected'` so the audit chain captures the attempt
 * per I-003 discipline. Audit emit runs in the SAME tx as the failed
 * wrapper call.
 *
 * Wrapper signature (migration 050 §6 — 14 params; 8 KMS cols + 6 misc):
 *   record_interaction_signal_override(
 *     p_override_id, p_lifecycle_transition_id, p_tenant_id, p_signal_id,
 *     p_clinician_account_id,
 *     p_override_rationale_kms_envelope_ciphertext, ...dek_id, ...iv, ...tag,
 *     ...alg, ...alg_version, ...aad, ...encrypted_at,
 *     p_metadata
 *   ) RETURNS VOID
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
  clinician_account_id: z.string().regex(ULID_PATTERN),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // override_rationale (plaintext) intentionally NOT in v0.1 — KMS envelope deferred.
});

function mapServiceError(err: unknown, reply: FastifyReply, requestId: string): boolean {
  if (typeof err !== 'object' || err === null || !('code' in err)) return false;
  const code = (err as { code?: unknown }).code;
  if (code === '42501') {
    reply.code(403).send({
      error: { code: 'med_interaction.forbidden', message: 'Insufficient scope for this request.', request_id: requestId },
    });
    return true;
  }
  if (code === '0A000') {
    reply.code(503).send({
      error: { code: 'med_interaction.override_capability_not_yet_available', message: 'Signal override capability is not yet available in this deployment.', request_id: requestId },
    });
    return true;
  }
  if (code === '02000' || code === '23514') {
    reply.code(404).send({
      error: { code: 'med_interaction.signal_not_found_or_wrong_state', message: 'Signal not found or not in an override-eligible state.', request_id: requestId },
    });
    return true;
  }
  return false;
}

export async function overrideSignalHandler(
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
  const { clinician_account_id: clinicianAccountId, metadata = {} } = bodyParsed.data;

  const actorId =
    req.actorContext?.accountId ??
    (req.headers['x-actor-id'] as string | undefined) ??
    'unknown';
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution(req, reply, mapServiceError, async (tx, idempotencyCtx) => {
    const overrideId = idempotencyCtx.idempotencyKey;
    const lifecycleTransitionId = `${overrideId.slice(0, 25)}T`; // deterministic-derived; OK for v0.1
    return withTenantContext(tx, ctx.tenantId, async () => {
      const run = async (): Promise<{ status: number; view: { signal_id: string; status: 'overridden' } }> => {
        let wrapperFailedWith0A000 = false;
        try {
          await withDbRole(tx, 'medication_interaction_override_recorder', async () => {
            // 14-param wrapper call; 8 KMS-envelope cols passed NULL per v0.1
            // deferral (all-or-none CHECK in migration 047 permits all-NULL).
            await tx.query(
              'SELECT record_interaction_signal_override($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)',
              [
                overrideId,
                lifecycleTransitionId,
                ctx.tenantId,
                signalId,
                clinicianAccountId,
                null, null, null, null, null, null, null, null, // 8 KMS envelope cols
                JSON.stringify(metadata),
              ],
            );
          });
        } catch (err) {
          if (
            typeof err === 'object' &&
            err !== null &&
            'code' in err
          ) {
            const code = (err as { code?: unknown }).code;
            if (code === '42501') {
              throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
            }
            if (code === '0A000') {
              wrapperFailedWith0A000 = true;
              // Fall through to emit rejection audit, then re-throw to surface 503.
            } else {
              throw err;
            }
          } else {
            throw err;
          }
        }

        // I-003 bare-suppression-forbidden: emit Cat A audit on BOTH success
        // and rejection (the fail-closed path is still a real attempt that
        // belongs in the audit chain).
        const txTyped: DbTransaction = tx;
        await emitSignalLifecycleTransitionAudit(
          {
            tenantId: ctx.tenantId,
            signalId,
            transitionId: lifecycleTransitionId,
            patientId: null,
            actorId,
            actorTenantId,
            countryOfCare: ctx.countryOfCare,
            fromState: 'active',
            toState: wrapperFailedWith0A000 ? 'rejected' : 'overridden',
            transitionReason: wrapperFailedWith0A000
              ? 'override_rejected_feature_not_supported_evidence_source_missing'
              : 'override',
          },
          txTyped,
        );

        if (wrapperFailedWith0A000) {
          // Re-throw the 0A000 so mapServiceError surfaces it as 503.
          throw Object.assign(new Error('override_capability_not_yet_available'), { code: '0A000' });
        }

        return { status: 201, view: { signal_id: signalId, status: 'overridden' } };
      };

      if (req.actorNonce !== undefined) {
        return withActorContext(tx, req.actorNonce, run);
      }
      return run();
    });
  });
}
