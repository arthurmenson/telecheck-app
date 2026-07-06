/**
 * async-consult/internal/handlers/claim-consult-v1.ts —
 *   POST /v1/async-consults/:consult_id/claim — clinician claims a
 *   queued consult for review via the SECDEF wrapper
 *   `claim_consult_for_review()` (migration 059 §4; SI-020 R5 closure
 *   pattern), with same-tx audit emission:
 *
 *     - Cat B `async_consult.claim_expired_auto_released` — ONLY when
 *       the wrapper returned a non-NULL auto-released prior-claim id
 *       (migration 059 §4 STEP 2 released an expired claim to make room).
 *       Emitted FIRST (cause before effect).
 *     - Cat C `async_consult.case_claimed` — always on success.
 *
 * Error contract:
 *   - SQLSTATE 55006 (object_in_use; wrapper's structured
 *     claim_already_held rejection) → 409 with reason
 *     'claim_already_held'.
 *   - SQLSTATE P0002 (no_data_found; consult absent / cross-tenant) →
 *     tenant-blind 404 (I-025).
 *   - 42501 (tenant/actor-identity guards; the wrapper ALSO enforces
 *     claiming-clinician == calling-actor) → tenant-blind 403.
 *
 * Composition mirrors initiate-consult-v1.ts:
 *   withIdempotentExecution → withTenantContext → [withActorContext] →
 *   withDbRole('async_consult_clinician_reviewer') → wrapper SELECT →
 *   same-tx audit under restored app role.
 *
 * **Claim TTL:** claim_expires_at defaults to now + 30 minutes.
 * TODO(CCR): the review-claim TTL should resolve from tenant CCR config
 * (country_of_care-driven operational policy) when the tenant-config
 * slice surfaces the key; 30 minutes is the interim operational default.
 * Callers MAY override with a body `claim_expires_at` (must be future).
 *
 * Endpoint contract:
 *   Method   POST
 *   Path     /v1/async-consults/:consult_id/claim
 *   Body     { claim_expires_at?: ISO 8601 timestamp (future) } — optional
 *   Returns  201 + { claim_id, auto_released_claim_id: string | null }
 *            400 malformed; 401/403 Layer B; 403 on 42501;
 *            404 tenant-blind absent consult; 409 claim_already_held
 *
 * Spec references: migration 059 §4, migration 056 §4, AUDIT_EVENTS
 * v5.11 rows for case_claimed + claim_expired_auto_released, I-003,
 * I-023, I-025, I-027.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import {
  requireClinicianActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import {
  emitAsyncConsultCaseClaimedAudit,
  emitAsyncConsultClaimExpiredAutoReleasedAudit,
} from '../../audit.js';

import {
  isUlid,
  makeErrorEnvelope,
  parseIsoTimestamp,
  pgErrorCode,
  type ErrorEnvelopeBody,
} from './v1-shared.js';

/** Interim operational default pending the CCR-resolved TTL (see docstring). */
const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;

interface ClaimConsultV1Body {
  claim_expires_at?: string;
}

function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  const code = pgErrorCode(err);
  if (code === '55006') {
    // Structured claim_already_held rejection (migration 059 §4 STEP 2).
    void reply.code(409).send({
      reason: 'claim_already_held',
      ...makeErrorEnvelope(
        reqId,
        'internal.resource.conflict',
        'Consult already has an active unexpired review claim.',
      ),
    });
    return true;
  }
  if (code === 'P0002') {
    // no_data_found — consult absent or cross-tenant; tenant-blind 404.
    void reply
      .code(404)
      .send(makeErrorEnvelope(reqId, 'internal.resource.not_found', 'Consult not found.'));
    return true;
  }
  if (code === '23514') {
    // Lifecycle-triple guard (claim attempted against a consult that is
    // not in a claimable state) — tenant-blind 409.
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'Consult is not in a claimable state.',
        ),
      );
    return true;
  }
  return false;
}

interface ClaimConsultV1View {
  claim_id: string;
  auto_released_claim_id: string | null;
}

export async function claimConsultV1Handler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // Layer B — clinician only. The wrapper additionally enforces
  // claiming-clinician == SI-010 calling actor (defense-in-depth).
  const actor = requireClinicianActorContext(req);

  const params = (req.params ?? {}) as { consult_id?: string };
  if (!isUlid(params.consult_id)) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Path parameter consult_id must be a 26-char ULID.',
        ),
      );
  }
  const consultId = params.consult_id;

  // Optional claim_expires_at override; must parse and be in the future.
  const body = (req.body ?? {}) as ClaimConsultV1Body;
  let claimExpiresAt: Date;
  if (body.claim_expires_at !== undefined) {
    const parsed = parseIsoTimestamp(body.claim_expires_at);
    if (parsed === null || parsed.getTime() <= Date.now()) {
      return reply
        .code(400)
        .send(
          makeErrorEnvelope(
            req.id,
            'internal.request.invalid',
            'claim_expires_at must be a future ISO 8601 timestamp when supplied.',
          ),
        );
    }
    claimExpiresAt = parsed;
  } else {
    claimExpiresAt = new Date(Date.now() + DEFAULT_CLAIM_TTL_MS);
  }

  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);
  const actorNonce = req.actorNonce;

  return withIdempotentExecution<ClaimConsultV1View | ErrorEnvelopeBody>(
    req,
    reply,
    mapServiceError,
    async (tx) => {
      const claimId = ulid();
      const transitionId = ulid();

      const releasedClaimId = await withTenantContext<string | null>(tx, ctx.tenantId, async () => {
        const runClaim = async (): Promise<string | null> => {
          try {
            return await withDbRole(tx, 'async_consult_clinician_reviewer', async () => {
              const result = await tx.query<{ released_claim_id: string | null }>(
                'SELECT claim_consult_for_review($1, $2, $3, $4, $5, $6, $7, $8) AS released_claim_id',
                [
                  claimId,
                  ctx.tenantId,
                  consultId,
                  actor.accountId, // p_clinician_account_id — must equal SI-010 actor
                  claimExpiresAt.toISOString(),
                  transitionId,
                  actor.accountId, // p_actor_id
                  'clinician', // p_actor_role
                ],
              );
              return result.rows[0]?.released_claim_id ?? null;
            });
          } catch (err) {
            if (pgErrorCode(err) === '42501') {
              throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
            }
            throw err;
          }
        };

        if (typeof actorNonce === 'string' && actorNonce.length > 0) {
          return withActorContext(tx, actorNonce, runClaim);
        }
        return runClaim();
      });

      // Same-tx audit emission under the restored app role (I-003).
      // Cat B auto-release attestation FIRST (cause), then the Cat C
      // claim attestation (effect) — migration 059 §4 STEP 2 comment:
      // "Handler MUST emit Cat B async_consult.claim_expired_auto_released
      // using the returned id."
      if (releasedClaimId !== null) {
        await emitAsyncConsultClaimExpiredAutoReleasedAudit(
          {
            tenantId: ctx.tenantId,
            releasedClaimId,
            consultId,
            actorId: actor.accountId,
            actorTenantId,
            countryOfCare: ctx.countryOfCare,
          },
          tx,
        );
      }
      await emitAsyncConsultCaseClaimedAudit(
        {
          tenantId: ctx.tenantId,
          claimId,
          consultId,
          clinicianAccountId: actor.accountId,
          actorTenantId,
          countryOfCare: ctx.countryOfCare,
          claimExpiresAt: claimExpiresAt.toISOString(),
        },
        tx,
      );

      return {
        status: 201,
        view: { claim_id: claimId, auto_released_claim_id: releasedClaimId },
      };
    },
  );
}
