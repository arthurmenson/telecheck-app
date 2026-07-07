/**
 * async-consult/internal/handlers/ai-preparation-v1.ts —
 *   POST /v1/async-consults/:consult_id/ai-preparation — record a
 *   completed AI case preparation on the P-038 canonical chain via the
 *   SECDEF wrapper `record_consult_ai_preparation_completed()`
 *   (migration 059 §3; EXECUTE granted to `ai_service_account` at
 *   migration 064), with same-tx Cat C
 *   `async_consult.ai_preparation_started` +
 *   `async_consult.ai_preparation_completed` audit emission
 *   (AUDIT_EVENTS v5.11 rows 4-5).
 *
 * This is OpenAPI v0.4 endpoint #4 (P-038 §7): caller class
 * "AI Service (internal)". It closes the staging-smoke step 4.5
 * stand-in (PR #230 recorded TODO): the consult lifecycle advance
 * submitted → processing → queued now flows through the ratified
 * HTTP + RBAC + SECDEF wrapper + audit path instead of raw SQL.
 *
 * Composition mirrors submit-intake-v1.ts (canonical write stack):
 *   withIdempotentExecution → withTenantContext → [withActorContext] →
 *   withDbRole('ai_service_account') → wrapper SELECT → same-tx audit
 *   under restored app role.
 *
 * **v0.1 preparation posture:** the AI-service caller supplies the
 * COMPLETED preparation artifacts — the clinical summary arrives
 * PRE-ENCRYPTED as the 8-field KMS envelope (I-026) from the internal
 * service boundary, exactly the v1-shared.ts posture the intake +
 * decision endpoints use. The in-process Mode 1 preparation pipeline
 * (LLM call → summary generation → app-side envelope encryption →
 * this recording step) lands when a real LLM provider replaces
 * NullLLMProvider (ADR-020; AI-RESIL-001). Until then the endpoint is
 * the recording surface, and the caller (staging smoke / future AI
 * worker) provides the envelope. TODO(async-consult hardening): same
 * app-side-KMS TODO as v1-shared.ts.
 *
 * **Atomic wrapper semantics (migration 059 §3):** entering from
 * `submitted`, the wrapper writes BOTH canonical transitions
 * (ai_processing_started: submitted → processing; then
 * ai_processing_completed: processing → queued) around the
 * clinical_summary INSERT in one call. Entering from `processing`
 * (retry after a partial prior attempt) it writes only the completion.
 * Any other current state raises `check_violation` (23514),
 * tenant-blindly per I-025 → mapped to 409 here.
 *
 * Endpoint contract:
 *   Method   POST
 *   Path     /v1/async-consults/:consult_id/ai-preparation
 *   Body     {
 *              patient_id:       ULID (the consult subject; composite-FK
 *                                validated against the consult row),
 *              prepared_by_mode: 'mode_1' | 'mode_2',
 *              ai_provider:      'anthropic' | 'aws_bedrock' |
 *                                'azure_openai' | 'null_local_dev',
 *              model_id:         string,
 *              summary_envelope: 8-field KMS envelope (I-026),
 *              interaction_signals_snapshot?: object (default {}),
 *              recommendation?:  'prescribe' | 'recommend' | 'refer' |
 *                                'decline' | 'request_more_data' |
 *                                'escalate_to_sync' | null
 *            }
 *   Returns  201 + { summary_id } on success
 *            400 on malformed body / partial envelope
 *            401 unauthenticated; 403 non-ai_service actor / 42501
 *            409 when the consult is not in a preparation-capable state
 *                or the (consult, patient) reference does not match
 *
 * Spec references: migration 059 §3 + 064, migration 056 §3
 * (consult_clinical_summary CHECKs), P-038 §3 row 4 + §7 endpoint #4,
 * AUDIT_EVENTS v5.11 rows 4-6, State Machines v1.3 consult_lifecycle,
 * ADR-029 / WORKLOAD_TAXONOMY v5.2 (mode → workload class), I-003,
 * I-023, I-025, I-026, I-027.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import {
  requireAiServiceActorContext,
  resolveActorTenantIdForAudit,
} from '../../../../lib/auth-context.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { requireTenantContext } from '../../../../lib/tenant-context.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import { emitAsyncConsultAiPreparationAudits } from '../../audit.js';

import {
  decodeKmsEnvelope,
  isNonEmptyString,
  isUlid,
  makeErrorEnvelope,
  pgErrorCode,
  type ErrorEnvelopeBody,
} from './v1-shared.js';

// Enumerations from the migration 056 §3 consult_clinical_summary CHECKs.
// Validated at the boundary so a bad value 400s with a client-actionable
// message instead of surfacing as a DB check_violation (which the service
// error mapper folds into the tenant-blind state-guard 409).
const PREPARED_BY_MODES = new Set(['mode_1', 'mode_2']);
const AI_PROVIDERS = new Set(['anthropic', 'aws_bedrock', 'azure_openai', 'null_local_dev']);
const RECOMMENDATIONS = new Set([
  'prescribe',
  'recommend',
  'refer',
  'decline',
  'request_more_data',
  'escalate_to_sync',
]);

interface AiPreparationV1Body {
  patient_id?: string;
  prepared_by_mode?: string;
  ai_provider?: string;
  model_id?: string;
  summary_envelope?: unknown;
  interaction_signals_snapshot?: unknown;
  recommendation?: unknown;
}

function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  const code = pgErrorCode(err);
  if (code === '23514') {
    // Wrapper state guard: absent / cross-tenant / non-preparation-capable
    // consult all raise the SAME check_violation (tenant-blind by
    // construction; I-025).
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'Consult is not in a preparation-capable state.',
        ),
      );
    return true;
  }
  if (code === '23503') {
    // Composite FK failure (consult/patient mismatch) — tenant-blind 409;
    // do not differentiate which reference failed (I-025).
    void reply
      .code(409)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.resource.conflict',
          'AI preparation does not match an eligible consult for this patient.',
        ),
      );
    return true;
  }
  return false;
}

interface AiPreparationV1View {
  summary_id: string;
}

export async function aiPreparationV1Handler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  const ctx = requireTenantContext(req);

  // Layer B — AI-service caller class only (P-038 §7 endpoint #4:
  // "AI Service (internal)"). Patients, clinicians, and admins never
  // record AI preparations.
  const actor = requireAiServiceActorContext(req);

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
  const body = (req.body ?? {}) as AiPreparationV1Body;
  const envelope = decodeKmsEnvelope(body.summary_envelope);
  const signalsSnapshot =
    body.interaction_signals_snapshot === undefined ? {} : body.interaction_signals_snapshot;
  const recommendation = body.recommendation === undefined ? null : body.recommendation;
  if (
    !isUlid(body.patient_id) ||
    typeof body.prepared_by_mode !== 'string' ||
    !PREPARED_BY_MODES.has(body.prepared_by_mode) ||
    typeof body.ai_provider !== 'string' ||
    !AI_PROVIDERS.has(body.ai_provider) ||
    !isNonEmptyString(body.model_id) ||
    envelope === null ||
    typeof signalsSnapshot !== 'object' ||
    signalsSnapshot === null ||
    Array.isArray(signalsSnapshot) ||
    (recommendation !== null &&
      (typeof recommendation !== 'string' || !RECOMMENDATIONS.has(recommendation)))
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid AI-preparation body: patient_id (26-char ULID), prepared_by_mode ' +
            '(mode_1|mode_2), ai_provider (anthropic|aws_bedrock|azure_openai|null_local_dev), ' +
            'model_id, and a complete summary_envelope (ciphertext_b64, dek_id, iv_b64, ' +
            'tag_b64, alg, alg_version, aad_b64, encrypted_at) are required; ' +
            'interaction_signals_snapshot must be an object when present; recommendation ' +
            'must be one of prescribe|recommend|refer|decline|request_more_data|' +
            'escalate_to_sync when present.',
        ),
      );
  }
  const patientId = body.patient_id;
  const preparedByMode = body.prepared_by_mode as 'mode_1' | 'mode_2';
  const aiProvider = body.ai_provider;
  const modelId = body.model_id;

  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);
  const actorNonce = req.actorNonce;

  return withIdempotentExecution<AiPreparationV1View | ErrorEnvelopeBody>(
    req,
    reply,
    mapServiceError,
    async (tx) => {
      const summaryId = ulid();
      // The wrapper consumes the started transition id only on the
      // submitted-entry path (skipped when retrying from processing);
      // both are supplied fresh and the unused one is discarded.
      const startedTransitionId = ulid();
      const completedTransitionId = ulid();

      await withTenantContext(tx, ctx.tenantId, async () => {
        const runPreparation = async (): Promise<void> => {
          try {
            await withDbRole(tx, 'ai_service_account', async () => {
              await tx.query(
                'SELECT record_consult_ai_preparation_completed($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)',
                [
                  summaryId,
                  ctx.tenantId,
                  consultId,
                  patientId,
                  preparedByMode,
                  aiProvider,
                  modelId,
                  envelope.ciphertext,
                  envelope.dekId,
                  envelope.iv,
                  envelope.tag,
                  envelope.alg,
                  envelope.algVersion,
                  envelope.aad,
                  envelope.encryptedAt.toISOString(),
                  JSON.stringify(signalsSnapshot),
                  recommendation,
                  startedTransitionId,
                  completedTransitionId,
                  actor.accountId, // p_actor_id — the AI-service principal
                  'ai_service', // p_actor_role (State Machines v1.3 CHECK)
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
          await withActorContext(tx, actorNonce, runPreparation);
        } else {
          await runPreparation();
        }
      });

      // Same-tx Cat C audits under the restored app role (I-003).
      await emitAsyncConsultAiPreparationAudits(
        {
          tenantId: ctx.tenantId,
          summaryId,
          consultId,
          patientId,
          actorId: actor.accountId,
          actorTenantId,
          countryOfCare: ctx.countryOfCare,
          preparedByMode,
          aiProvider,
          modelId,
          recommendation,
        },
        tx,
      );

      return {
        status: 201,
        view: { summary_id: summaryId },
      };
    },
  );
}
