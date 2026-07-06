/**
 * async-consult/internal/handlers/record-decision-v1.ts —
 *   POST /v1/async-consults/:consult_id/decision — record the clinician
 *   decision via the SECDEF wrapper `record_consult_clinician_decision()`
 *   (migration 059 §6; extends SI-005 P-021), with same-tx Cat A audit
 *   emission per decision shape:
 *
 *     - async_consult.clinician_decision_recorded — ALWAYS.
 *     - async_consult.prescribing_recorded — decision_type='prescribe'
 *       only, after the decision_recorded event.
 *     - async_consult.clinician_decision_rationale_disagreement —
 *       agreement_with_ai_recommendation='disagreed' only, last.
 *
 * The wrapper atomically: INSERTs the decision row (the migration 056
 * validate-claim trigger + 5-column composite FK enforce deciding ==
 * claiming clinician against an ACTIVE claim), releases the claim
 * one-way (release_reason='decision_recorded'), and writes the
 * decision + outcome lifecycle transitions.
 *
 * Error contract:
 *   - 42501 (tenant guard / deciding-clinician != calling-actor) →
 *     tenant-blind 403.
 *   - 23503 (composite claim FK — claim_id/patient_id/clinician mismatch
 *     or no such claim) → tenant-blind 409.
 *   - 23514 (decision-shape CHECKs / lifecycle-triple guard / released
 *     claim) → tenant-blind 409.
 *
 * **KMS envelope posture:** decision rationale arrives PRE-ENCRYPTED as
 * the 8-field envelope (see v1-shared.ts docstring; I-026; NOT NULL
 * columns per migration 056 §5).
 *
 * **claim_id + patient_id are body-supplied:** the claim response gave
 * the caller claim_id; the consult read gave patient_id. The wrapper's
 * 5-column composite FK + actor-identity guard make a forged pairing
 * fail closed (23503 / 42501) — the body fields are binding hints, not
 * trust anchors.
 *
 * Endpoint contract:
 *   Method   POST
 *   Path     /v1/async-consults/:consult_id/decision
 *   Body     {
 *              claim_id:      ULID,
 *              patient_id:    ULID,
 *              decision_type: 'prescribe'|'recommend'|'refer'|'decline'|
 *                             'request_more_data'|'escalate_to_sync',
 *              agreement_with_ai_recommendation:
 *                             'accepted'|'modified'|'disagreed'|
 *                             'no_ai_recommendation',
 *              decision_rationale_envelope: { 8-field KMS envelope },
 *              interaction_signals_reviewed_ids: ULID[] (may be empty),
 *              prescription_details_id?: ULID (required iff prescribe),
 *              referral_target_id?:      ULID (required iff refer)
 *            }
 *   Returns  201 + { decision_id }
 *            400 malformed; 401/403 Layer B; 403 on 42501;
 *            409 claim/lifecycle conflicts
 *
 * Spec references: migration 059 §6, migration 056 §5, AUDIT_EVENTS
 * v5.11 async_consult decision rows, I-003, I-012 note (prescribe gate
 * executes in the Pharmacy medication_request flow the opaque
 * prescription_details_id binds to; P-038 §12 OQ2), I-023, I-025, I-027.
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
  emitAsyncConsultClinicianDecisionRecordedAudit,
  emitAsyncConsultDecisionRationaleDisagreementAudit,
  emitAsyncConsultPrescribingRecordedAudit,
} from '../../audit.js';

import {
  decodeKmsEnvelope,
  isNonEmptyString,
  isUlid,
  makeErrorEnvelope,
  pgErrorCode,
  type ErrorEnvelopeBody,
} from './v1-shared.js';

const VALID_DECISION_TYPES: ReadonlySet<string> = new Set([
  'prescribe',
  'recommend',
  'refer',
  'decline',
  'request_more_data',
  'escalate_to_sync',
]);
const VALID_AGREEMENTS: ReadonlySet<string> = new Set([
  'accepted',
  'modified',
  'disagreed',
  'no_ai_recommendation',
]);

interface RecordDecisionV1Body {
  claim_id?: string;
  patient_id?: string;
  decision_type?: string;
  agreement_with_ai_recommendation?: string;
  decision_rationale_envelope?: unknown;
  interaction_signals_reviewed_ids?: unknown;
  prescription_details_id?: string;
  referral_target_id?: string;
}

function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  const code = pgErrorCode(err);
  if (code === '23503') {
    // Composite claim FK: claim/consult/patient/clinician pairing does
    // not reference an existing claim row. Tenant-blind 409.
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'Decision does not match an active review claim held by this clinician.',
        ),
      );
    return true;
  }
  if (code === '23514' || code === 'P0002') {
    // Lifecycle-triple / decision-shape / released-claim guards.
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'Consult is not in a decision-capable state.',
        ),
      );
    return true;
  }
  return false;
}

interface RecordDecisionV1View {
  decision_id: string;
}

export async function recordDecisionV1Handler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // Layer B — clinician only. The wrapper enforces deciding-clinician ==
  // SI-010 calling actor + the composite FK enforces deciding == claiming.
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

  // Body validation (mirrors migration 056 §5 CHECK constraints,
  // including the prescription-iff-prescribe + referral-iff-refer pairs).
  const body = (req.body ?? {}) as RecordDecisionV1Body;
  const envelope = decodeKmsEnvelope(body.decision_rationale_envelope);
  const signalsRaw = body.interaction_signals_reviewed_ids;
  const signalsValid = Array.isArray(signalsRaw) && signalsRaw.every((s) => isUlid(s));
  const decisionType = body.decision_type;
  const prescriptionValid =
    decisionType === 'prescribe'
      ? isUlid(body.prescription_details_id)
      : body.prescription_details_id === undefined || body.prescription_details_id === null;
  const referralValid =
    decisionType === 'refer'
      ? isUlid(body.referral_target_id)
      : body.referral_target_id === undefined || body.referral_target_id === null;
  if (
    !isUlid(body.claim_id) ||
    !isUlid(body.patient_id) ||
    !isNonEmptyString(decisionType) ||
    !VALID_DECISION_TYPES.has(decisionType) ||
    !isNonEmptyString(body.agreement_with_ai_recommendation) ||
    !VALID_AGREEMENTS.has(body.agreement_with_ai_recommendation) ||
    envelope === null ||
    !signalsValid ||
    !prescriptionValid ||
    !referralValid
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid decision body: claim_id (ULID), patient_id (ULID), decision_type ' +
            '(6-value enum), agreement_with_ai_recommendation (4-value enum), a complete ' +
            'decision_rationale_envelope, interaction_signals_reviewed_ids (array of ' +
            'ULIDs; may be empty), prescription_details_id (required iff prescribe), and ' +
            'referral_target_id (required iff refer) are required.',
        ),
      );
  }

  const claimId = body.claim_id;
  const patientId = body.patient_id;
  const agreement = body.agreement_with_ai_recommendation;
  const signalsReviewedIds = signalsRaw;
  const prescriptionDetailsId =
    decisionType === 'prescribe' ? (body.prescription_details_id as string) : null;
  const referralTargetId = decisionType === 'refer' ? (body.referral_target_id as string) : null;

  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);
  const actorNonce = req.actorNonce;

  return withIdempotentExecution<RecordDecisionV1View | ErrorEnvelopeBody>(
    req,
    reply,
    mapServiceError,
    async (tx) => {
      const decisionId = ulid();
      const decisionTransitionId = ulid();
      // The outcome transition id is consumed only on the non-
      // request_more_data paths; supplied fresh either way.
      const outcomeTransitionId = ulid();

      await withTenantContext(tx, ctx.tenantId, async () => {
        const runDecision = async (): Promise<void> => {
          try {
            await withDbRole(tx, 'async_consult_clinician_reviewer', async () => {
              await tx.query(
                'SELECT record_consult_clinician_decision($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)',
                [
                  decisionId,
                  ctx.tenantId,
                  consultId,
                  patientId,
                  claimId,
                  actor.accountId, // p_clinician_account_id — must equal SI-010 actor
                  decisionType,
                  agreement,
                  envelope.ciphertext,
                  envelope.dekId,
                  envelope.iv,
                  envelope.tag,
                  envelope.alg,
                  envelope.algVersion,
                  envelope.aad,
                  envelope.encryptedAt.toISOString(),
                  signalsReviewedIds,
                  prescriptionDetailsId,
                  referralTargetId,
                  decisionTransitionId,
                  outcomeTransitionId,
                  actor.accountId, // p_actor_id
                  'clinician', // p_actor_role
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
          await withActorContext(tx, actorNonce, runDecision);
        } else {
          await runDecision();
        }
      });

      // Same-tx Cat A audit set under the restored app role (I-003; the
      // per-decision-type emission contract is pinned in audit.ts +
      // asserted by the unit tests — drift between the two is a defect):
      //   1. clinician_decision_recorded — ALWAYS.
      //   2. prescribing_recorded — prescribe only.
      //   3. clinician_decision_rationale_disagreement — disagreed only.
      await emitAsyncConsultClinicianDecisionRecordedAudit(
        {
          tenantId: ctx.tenantId,
          decisionId,
          consultId,
          patientId,
          claimId,
          clinicianAccountId: actor.accountId,
          actorTenantId,
          countryOfCare: ctx.countryOfCare,
          decisionType,
          agreementWithAiRecommendation: agreement,
          interactionSignalsReviewedIds: signalsReviewedIds,
          prescriptionDetailsId,
          referralTargetId,
        },
        tx,
      );
      if (decisionType === 'prescribe') {
        await emitAsyncConsultPrescribingRecordedAudit(
          {
            tenantId: ctx.tenantId,
            decisionId,
            consultId,
            patientId,
            clinicianAccountId: actor.accountId,
            actorTenantId,
            countryOfCare: ctx.countryOfCare,
            prescriptionDetailsId: prescriptionDetailsId as string,
          },
          tx,
        );
      }
      if (agreement === 'disagreed') {
        await emitAsyncConsultDecisionRationaleDisagreementAudit(
          {
            tenantId: ctx.tenantId,
            decisionId,
            consultId,
            patientId,
            clinicianAccountId: actor.accountId,
            actorTenantId,
            countryOfCare: ctx.countryOfCare,
            decisionType,
          },
          tx,
        );
      }

      return {
        status: 201,
        view: { decision_id: decisionId },
      };
    },
  );
}
