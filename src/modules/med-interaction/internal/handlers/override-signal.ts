/**
 * override-signal.ts — POST /v0/med-interaction/signals/:id/override
 *
 * **OPERATIONAL since migration 070** (the evidence-unlock migration that
 * executed migration 050 §6's own fail-closed closure directive). The
 * v0.1 fail-closed scaffold (wrapper RAISE 0A000 → 503) is retired; this
 * handler now records real clinician overrides through the SECDEF wrapper
 * `record_interaction_signal_override` (migration 070 §1).
 *
 * **LAYER B (clinician role-membership) — TIGHTENED for this endpoint.**
 * Per the ratifier Option 2 carryforward (SI-024.1 JWT-binding replaced by
 * SI-010 actor binding; LAYER B realized at the Fastify route layer), the
 * handler applies `requireClinicianActorContext()` — the canonical
 * clinician role gate (TLC-055 PR E / TLC-058 precedent used by pharmacy
 * clinician writes + async-consult claim/record-decision). Non-clinician
 * JWTs get 403 before any DB work; missing auth gets 401. Defense-in-depth:
 * the wrapper's STEP 4 re-verifies at the DB layer that the SI-010-bound
 * actor IS p_clinician_account_id AND holds a live clinician accounts row
 * (rejects `unauthorized_role` / 42501 otherwise). The clinician account id
 * is DERIVED from the authenticated actor — it is not body-supplied.
 *
 * **KMS envelope — REQUIRED.** The 8 override_rationale_kms_envelope_*
 * columns are NOT NULL (migration 047 §3). The rationale arrives
 * PRE-ENCRYPTED as the 8-field wire envelope (`override_rationale_envelope`)
 * per the async-consult follow-up-messages precedent (I-026); plaintext
 * rationale never transits this server. Partial/malformed envelopes are
 * rejected 400 at the HTTP boundary. (The former v0.1 body shape passed 8
 * NULLs — that was only reachable because the fail-closed wrapper RAISEd
 * before the INSERT; with the operational wrapper the envelope is
 * mandatory.)
 *
 * **Two-event Cat A audit rule (forward contract from PR 9, now ACTIVE):**
 * on wrapper success this is the ONLY med-interaction handler emitting TWO
 * audit events in the same tx: (1) canonical `interaction_signal_override`
 * (the cause — rationale field carries a KMS-envelope reference, never
 * plaintext) then (2) `interaction_signal_lifecycle_transition_emitted`
 * (active → overridden — the state-machine effect). See audit.ts CANONICAL
 * LIFECYCLE AUDIT RULE.
 *
 * **Wrapper rejections** are absorbed AFTER the caller tx has rolled back,
 * per the ratified SI-019 Sub-decision 8 caller-transaction discipline
 * ("Implementations that need to 'absorb' the rejection MUST do so AFTER
 * the caller transaction has ROLLBACK-ed"). Mapping (tenant-blind, I-025):
 *   - 42501 (tenant guard / unauthorized_role)          → 403
 *   - 02000 / 23514 (not found / not active)            → 404
 *   - 55000 (medication_not_on_list — SI-019 STEP 3)    → 409
 *
 * Wrapper signature (migrations 050 §6 / 070 §1 — 14 params):
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

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import {
  requireClinicianActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import {
  emitSignalLifecycleTransitionAudit,
  emitSignalOverrideRecordedAudit,
} from '../../audit.js';

import { decodeKmsEnvelope } from './kms-envelope.js';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PathParamsSchema = z.object({
  id: z.string().regex(ULID_PATTERN, 'signal id must be a 26-char ULID'),
});
// strictObject: the retired v0.1 shape's body-supplied `clinician_account_id`
// is REJECTED — the overriding clinician is the authenticated actor (SI-010
// binding; a body-supplied id would be either redundant or a forgery vector).
const BodySchema = z.strictObject({
  override_rationale_envelope: z.unknown(),
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
  if (code === '55000') {
    // SI-019 Sub-decision 8 STEP 3 structured rejection
    // (`medication_not_on_list`; migration 070 §1). Same-tenant state
    // conflict — tenant-blindness (I-025) is preserved because the signal
    // itself resolved inside the caller's tenant scope.
    void reply.code(409).send({
      error: {
        code: 'med_interaction.medication_not_on_active_list',
        message:
          'One or more medications involved in this signal are no longer on the ' +
          "patient's medication list; the signal must be re-evaluated (superseded " +
          'or resolved) instead of overridden.',
        request_id: requestId,
      },
    });
    return true;
  }
  if (code === '02000' || code === '23514') {
    void reply.code(404).send({
      error: {
        code: 'med_interaction.signal_not_found_or_wrong_state',
        message: 'Signal not found or not in an override-eligible state.',
        request_id: requestId,
      },
    });
    return true;
  }
  if (code === '23505') {
    // STEP 7 unique_violation safety net (duplicate override id outside the
    // idempotency-key path).
    void reply.code(409).send({
      error: {
        code: 'med_interaction.override_already_recorded',
        message: 'An override with this identity has already been recorded.',
        request_id: requestId,
      },
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

  // LAYER B — clinician role gate (Option 2 realization; throws 401/403
  // before any parsing or DB work). The overriding clinician account id is
  // DERIVED from the authenticated actor, never body-supplied.
  const actor = requireClinicianActorContext(req);
  const clinicianAccountId = actor.accountId;

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
  const envelope = decodeKmsEnvelope(bodyParsed.data.override_rationale_envelope);
  if (envelope === null) {
    throw req.server.httpErrors.badRequest(
      'Invalid request body: a complete override_rationale_envelope (ciphertext_b64, ' +
        'dek_id, iv_b64, tag_b64, alg, alg_version, aad_b64, encrypted_at) is required — ' +
        'the override rationale is persisted KMS-envelope-only (migration 047 §3).',
    );
  }

  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);

  return withIdempotentExecution(req, reply, mapServiceError, async (tx, idempotencyCtx) => {
    const overrideId = idempotencyCtx.idempotencyKey;
    const lifecycleTransitionId = `${overrideId.slice(0, 25)}T`; // deterministic-derived; OK for v0.1
    return withTenantContext(tx, ctx.tenantId, async () => {
      const run = async (): Promise<{
        status: number;
        view: { signal_id: string; override_id: string; status: 'overridden' };
      }> => {
        // Wrapper call. Rejections (42501 / 02000 / 23514 / 55000 / 23505)
        // propagate: withIdempotentExecution rolls the business tx back,
        // THEN mapServiceError absorbs — per the ratified Sub-decision 8
        // caller discipline. No wrapper effect exists to attest on those
        // paths (STEP 5/6 never committed), so no audit is emitted for
        // them; the structured rejection surfaces as the tenant-blind
        // envelope (NOT bare suppression).
        await withDbRole(tx, 'medication_interaction_override_recorder', async () => {
          await tx.query(
            'SELECT record_interaction_signal_override($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)',
            [
              overrideId,
              lifecycleTransitionId,
              ctx.tenantId,
              signalId,
              clinicianAccountId,
              envelope.ciphertext,
              envelope.dekId,
              envelope.iv,
              envelope.tag,
              envelope.alg,
              envelope.algVersion,
              envelope.aad,
              envelope.encryptedAt.toISOString(),
              JSON.stringify(metadata),
            ],
          );
        });

        // Two-event Cat A rule (same tx as the wrapper INSERTs — Option 2
        // same-transaction durability contract): cause first, effect second.
        const txTyped: DbTransaction = tx;
        await emitSignalOverrideRecordedAudit(
          {
            tenantId: ctx.tenantId,
            signalId,
            overrideId,
            clinicianAccountId,
            actorTenantId,
            patientId: null,
            countryOfCare: ctx.countryOfCare,
          },
          txTyped,
        );
        await emitSignalLifecycleTransitionAudit(
          {
            tenantId: ctx.tenantId,
            signalId,
            transitionId: lifecycleTransitionId,
            patientId: null,
            actorId: clinicianAccountId,
            actorTenantId,
            countryOfCare: ctx.countryOfCare,
            fromState: 'active',
            toState: 'overridden',
            transitionReason: 'override',
          },
          txTyped,
        );

        return {
          status: 201,
          view: { signal_id: signalId, override_id: overrideId, status: 'overridden' },
        };
      };

      if (req.actorNonce !== undefined) {
        return withActorContext(tx, req.actorNonce, run);
      }
      // No actor nonce → the SI-010 GUC is unbound and the wrapper's STEP 0
      // tenant guard fails closed with 42501 → 403. Run anyway (fail-closed
      // at the DB trust anchor) rather than special-casing here.
      return run();
    });
  });
}
