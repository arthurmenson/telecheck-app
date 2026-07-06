/**
 * async-consult/internal/handlers/submit-intake-v1.ts —
 *   POST /v1/async-consults/:consult_id/intake — record an intake
 *   submission on the P-038 canonical chain via the SECDEF wrapper
 *   `record_consult_intake_submission()` (migration 059 §2), with
 *   same-tx Cat C `async_consult.intake_submitted` audit emission.
 *
 * Composition mirrors initiate-consult-v1.ts (canonical write stack;
 * see that file's docstring):
 *   withIdempotentExecution → withTenantContext → [withActorContext] →
 *   withDbRole('async_consult_patient_initiator') → wrapper SELECT →
 *   same-tx audit under restored app role.
 *
 * **KMS envelope posture:** the intake payload arrives PRE-ENCRYPTED as
 * the 8-field KMS envelope (I-026) from an internal service boundary —
 * see v1-shared.ts file docstring for the crisis-precedent rationale +
 * the app-side-encryption hardening TODO. All 8 fields are REQUIRED
 * (migration 056 §2 columns are NOT NULL).
 *
 * **State-guard error contract (migration 059 §2):** the wrapper raises
 * `check_violation` (23514) tenant-blindly when the consult is absent,
 * cross-tenant, or not in an intake-capable state (initiated / intake /
 * awaiting_data). Mapped to a tenant-blind 409 here — the single merged
 * error cannot differentiate existence per I-025.
 *
 * Endpoint contract:
 *   Method   POST
 *   Path     /v1/async-consults/:consult_id/intake
 *   Body     {
 *              template_id:      ULID,
 *              template_version: string,
 *              intake_payload_envelope: {
 *                ciphertext_b64, dek_id (ULID), iv_b64, tag_b64,
 *                alg, alg_version, aad_b64, encrypted_at (ISO 8601)
 *              }
 *            }
 *   Returns  201 + { submission_id } on success
 *            400 on malformed body / partial envelope
 *            401 unauthenticated; 403 non-patient / delegate / 42501
 *            409 when the consult is not in an intake-capable state
 *
 * Spec references: migration 059 §2, migration 056 §2, AUDIT_EVENTS
 * v5.11 async_consult.intake_submitted, I-003, I-023, I-025, I-026, I-027.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import {
  requirePatientActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitAsyncConsultIntakeSubmittedAudit } from '../../audit.js';

import {
  decodeKmsEnvelope,
  isNonEmptyString,
  isUlid,
  makeErrorEnvelope,
  pgErrorCode,
  type ErrorEnvelopeBody,
} from './v1-shared.js';

interface SubmitIntakeV1Body {
  template_id?: string;
  template_version?: string;
  intake_payload_envelope?: unknown;
}

function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  const code = pgErrorCode(err);
  if (code === '23514') {
    // Wrapper state guard: absent / cross-tenant / non-intake-capable
    // consult all raise the SAME check_violation (tenant-blind by
    // construction; I-025).
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'Consult is not in an intake-capable state.',
        ),
      );
    return true;
  }
  if (code === '23503') {
    // Composite FK failure (consult/patient or template mismatch) —
    // tenant-blind 409; do not differentiate which reference failed.
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'Intake submission does not match an eligible consult for this account.',
        ),
      );
    return true;
  }
  return false;
}

interface SubmitIntakeV1View {
  submission_id: string;
}

export async function submitIntakeV1Handler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // Layer B — patient principal only (delegate deferral per
  // initiate-consult-v1.ts docstring).
  const actor = requirePatientActorContext(req);
  if (actor.delegateId !== null) {
    throw req.server.httpErrors.forbidden(
      'Delegate intake submission is not yet supported on this endpoint.',
    );
  }

  // Path param.
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

  // Body validation.
  const body = (req.body ?? {}) as SubmitIntakeV1Body;
  const envelope = decodeKmsEnvelope(body.intake_payload_envelope);
  if (!isUlid(body.template_id) || !isNonEmptyString(body.template_version) || envelope === null) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid intake body: template_id (26-char ULID), template_version, and a ' +
            'complete intake_payload_envelope (ciphertext_b64, dek_id, iv_b64, tag_b64, ' +
            'alg, alg_version, aad_b64, encrypted_at) are required.',
        ),
      );
  }
  const templateId = body.template_id;
  const templateVersion = body.template_version;

  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);
  const actorNonce = req.actorNonce;

  return withIdempotentExecution<SubmitIntakeV1View | ErrorEnvelopeBody>(
    req,
    reply,
    mapServiceError,
    async (tx) => {
      const submissionId = ulid();
      // The wrapper consumes the lead-in transition id only on the
      // initiated / awaiting_data entry paths and the submitted
      // transition id only on the initiated / intake paths — both are
      // supplied fresh; the unused one is discarded by the wrapper.
      const leadInTransitionId = ulid();
      const submittedTransitionId = ulid();

      await withTenantContext(tx, ctx.tenantId, async () => {
        const runSubmit = async (): Promise<void> => {
          try {
            await withDbRole(tx, 'async_consult_patient_initiator', async () => {
              await tx.query(
                'SELECT record_consult_intake_submission($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)',
                [
                  submissionId,
                  ctx.tenantId,
                  consultId,
                  actor.accountId, // p_patient_id — trust-anchor identity
                  templateId,
                  templateVersion,
                  envelope.ciphertext,
                  envelope.dekId,
                  envelope.iv,
                  envelope.tag,
                  envelope.alg,
                  envelope.algVersion,
                  envelope.aad,
                  envelope.encryptedAt.toISOString(),
                  leadInTransitionId,
                  submittedTransitionId,
                  actor.accountId, // p_actor_id
                  'patient', // p_actor_role
                ],
              );
            });
          } catch (err) {
            if (pgErrorCode(err) === '42501') {
              throw req.server.httpErrors.forbidden('Insufficient scope for this request.');
            }
            throw err;
          }
        };

        if (typeof actorNonce === 'string' && actorNonce.length > 0) {
          await withActorContext(tx, actorNonce, runSubmit);
        } else {
          await runSubmit();
        }
      });

      // Same-tx Cat C audit under the restored app role (I-003).
      await emitAsyncConsultIntakeSubmittedAudit(
        {
          tenantId: ctx.tenantId,
          submissionId,
          consultId,
          patientId: actor.accountId,
          actorId: actor.accountId,
          actorTenantId,
          countryOfCare: ctx.countryOfCare,
          templateId,
          templateVersion,
        },
        tx,
      );

      return {
        status: 201,
        view: { submission_id: submissionId },
      };
    },
  );
}
