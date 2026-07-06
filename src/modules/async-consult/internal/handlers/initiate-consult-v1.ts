/**
 * async-consult/internal/handlers/initiate-consult-v1.ts —
 *   POST /v1/async-consults — initiate a consult on the P-038 canonical
 *   entity chain via the SECDEF wrapper `record_consult_initiation()`
 *   (migration 059 §1), with same-tx Cat C `async_consult.initiated`
 *   audit emission.
 *
 * **Sprint 10 PR 6 — first handler of the /v1/async-consults surface.**
 * Distinct from the Sprint-9 legacy surface (POST /v0/async-consult →
 * migration 020 `consults` tables), which remains mounted unchanged.
 *
 * Composition (canonical write stack; med-interaction create-evaluation +
 * crisis post-crisis-event precedents):
 *
 *   withIdempotentExecution                 (Idempotency-Key reserve-then-
 *     └─ withTransaction                     execute per IDEMPOTENCY v5.1)
 *        └─ withTenantContext
 *           └─ withActorContext             (when SI-010 nonce bound)
 *              └─ withDbRole('async_consult_patient_initiator')
 *                 └─ SELECT record_consult_initiation(...)
 *        └─ emitAsyncConsultInitiatedAudit  (same tx, AFTER withDbRole
 *                                            returns — restored app role)
 *
 * 42501 → tenant-blind 403 wraps the ENTIRE withDbRole call (I-025;
 * R2 MED-1 closure pattern — covers SET LOCAL ROLE acquisition AND the
 * wrapper's SI-010 tenant/actor guards).
 *
 * **Caller class (Layer B):** patient principal ONLY at PR 6. The
 * migration 059 wrapper supports delegate initiation (p_delegate_id +
 * active book_consults delegation validation), and migration 055 ships
 * `async_consult_delegate_initiator`, but:
 *   (a) this wire surface derives the patient anchor from the verified
 *       actor identity (no body patient_id — the SI-025 P-045 lesson:
 *       identity comes from the trust anchor, not the request body), and
 *   (b) there is no established delegate-detection primitive that binds
 *       "this authenticated patient is currently acting as a delegate
 *       FOR patient X" at the HTTP layer (ActorContext.delegateId exists
 *       but no module consumes it as a write-path principal switch yet).
 * TODO(async-consult delegate path): when the Consent slice surfaces the
 * delegate-principal binding, add the delegate branch here — body gains
 * patient_id, the gate validates the delegation, and withDbRole switches
 * to 'async_consult_delegate_initiator'. Until then a request whose
 * actor carries delegate context is rejected 403 (fail-closed; sentence
 * below documents the deferral to the caller).
 *
 * Endpoint contract:
 *   Method   POST
 *   Path     /v1/async-consults
 *   Body     {
 *              consult_type:           'program_pathway' | 'general',
 *              program_id?:            string (required iff program_pathway),
 *              initiation_source:      'program_enrollment'|'care_tab'|
 *                                      'mode_1_handoff'|'medication_detail'|
 *                                      'rpm_ccm_dashboard',
 *              consult_fee_cents:      integer >= 0,
 *              currency:               3-letter code,
 *              payment_provider:       'stripe'|'mtn_momo'|'flutterwave'|
 *                                      'mock_local_dev',
 *              payment_intent_id:      ULID (opaque handle until the
 *                                      Billing slice lands; migration 056
 *                                      deferred-FK TODO),
 *              expected_turnaround_at: ISO 8601 timestamp
 *            }
 *   Returns  201 + { consult_id } on success
 *            400 on malformed body
 *            401 when unauthenticated
 *            403 on non-patient role / delegate context / 42501
 *            409 on idempotency replay-mismatch / in-flight
 *
 * Spec references: migration 059 §1 (wrapper contract), migration 056 §1
 * (consult row shape + enums), AUDIT_EVENTS v5.11 async_consult.initiated,
 * I-003, I-023, I-025, I-027, IDEMPOTENCY v5.1.
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
import { emitAsyncConsultInitiatedAudit } from '../../audit.js';

import {
  isNonEmptyString,
  isUlid,
  makeErrorEnvelope,
  parseIsoTimestamp,
  pgErrorCode,
  type ErrorEnvelopeBody,
} from './v1-shared.js';

// ---------------------------------------------------------------------------
// Body shape + validation (enums mirror migration 056 §1 CHECK constraints)
// ---------------------------------------------------------------------------

const VALID_CONSULT_TYPES: ReadonlySet<string> = new Set(['program_pathway', 'general']);
const VALID_INITIATION_SOURCES: ReadonlySet<string> = new Set([
  'program_enrollment',
  'care_tab',
  'mode_1_handoff',
  'medication_detail',
  'rpm_ccm_dashboard',
]);
const VALID_PAYMENT_PROVIDERS: ReadonlySet<string> = new Set([
  'stripe',
  'mtn_momo',
  'flutterwave',
  'mock_local_dev',
]);

interface InitiateConsultV1Body {
  consult_type?: string;
  program_id?: string;
  initiation_source?: string;
  consult_fee_cents?: number;
  currency?: string;
  payment_provider?: string;
  payment_intent_id?: string;
  expected_turnaround_at?: string;
}

// ---------------------------------------------------------------------------
// Service-error mapper (withIdempotentExecution contract). 23514 (a CHECK
// the boundary validation missed) and 23503 (patient FK — cannot normally
// fire since the anchor is the verified actor identity) both map to
// tenant-blind 400 per I-025.
// ---------------------------------------------------------------------------

function mapServiceError(err: unknown, reply: FastifyReply, reqId: string): boolean {
  const code = pgErrorCode(err);
  if (code === '23514' || code === '23503') {
    void reply
      .code(400)
      .send(
        makeErrorEnvelope(
          reqId,
          'internal.request.invalid',
          'Initiation request violates a consult integrity constraint.',
        ),
      );
    return true;
  }
  return false;
}

interface InitiateConsultV1View {
  consult_id: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function initiateConsultV1Handler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  // Phase 1 — tenant context.
  const ctx = requireTenantContext(req);

  // Phase 2 — Layer B: patient principal only (see file docstring for the
  // delegate-path deferral). requirePatientActorContext throws 401
  // (unauthenticated) / 403 (role mismatch) via typed errors the global
  // envelope formats tenant-blind.
  const actor = requirePatientActorContext(req);
  if (actor.delegateId !== null) {
    // TODO(async-consult delegate path): switch to
    // async_consult_delegate_initiator + body patient_id + delegation
    // validation when the Consent slice surfaces the delegate-principal
    // binding. Fail closed until then.
    throw req.server.httpErrors.forbidden(
      'Delegate-initiated consults are not yet supported on this endpoint.',
    );
  }

  // Phase 3 — body validation.
  const body = (req.body ?? {}) as InitiateConsultV1Body;
  const expectedTurnaroundAt = parseIsoTimestamp(body.expected_turnaround_at);
  const programIdValid =
    body.consult_type === 'program_pathway'
      ? isNonEmptyString(body.program_id)
      : body.program_id === undefined || body.program_id === null;
  if (
    !isNonEmptyString(body.consult_type) ||
    !VALID_CONSULT_TYPES.has(body.consult_type) ||
    !programIdValid ||
    !isNonEmptyString(body.initiation_source) ||
    !VALID_INITIATION_SOURCES.has(body.initiation_source) ||
    typeof body.consult_fee_cents !== 'number' ||
    !Number.isInteger(body.consult_fee_cents) ||
    body.consult_fee_cents < 0 ||
    !isNonEmptyString(body.currency) ||
    body.currency.length !== 3 ||
    !isNonEmptyString(body.payment_provider) ||
    !VALID_PAYMENT_PROVIDERS.has(body.payment_provider) ||
    !isUlid(body.payment_intent_id) ||
    expectedTurnaroundAt === null
  ) {
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'Invalid initiate body: consult_type (program_pathway|general), program_id ' +
            '(required iff program_pathway), initiation_source (5-value enum), ' +
            'consult_fee_cents (integer >= 0), currency (3-letter code), ' +
            'payment_provider (4-value enum), payment_intent_id (26-char ULID), and ' +
            'expected_turnaround_at (ISO 8601 timestamp) are required.',
        ),
      );
  }

  const consultType = body.consult_type;
  const programId = body.consult_type === 'program_pathway' ? (body.program_id as string) : null;
  const initiationSource = body.initiation_source;
  const consultFeeCents = body.consult_fee_cents;
  const currency = body.currency;
  const paymentProvider = body.payment_provider;
  const paymentIntentId = body.payment_intent_id;

  // NOTE (migration 059 §1 documented TODO): payment_intent_id is an
  // OPAQUE handle until the Billing slice lands billing_payment_intent —
  // boundary validation here is shape-only (ULID); tenant-coherence
  // validation arrives with the deferred FK.

  // Phase 4 — audit attribution.
  const actorTenantId = resolveActorTenantIdForAudit(req, ctx.tenantId);
  const actorNonce = req.actorNonce;

  // Phase 5 — idempotency wrap + tx composition + same-tx audit.
  return withIdempotentExecution<InitiateConsultV1View | ErrorEnvelopeBody>(
    req,
    reply,
    mapServiceError,
    async (tx) => {
      const consultId = ulid();
      const transitionId = ulid();

      await withTenantContext(tx, ctx.tenantId, async () => {
        const runInitiate = async (): Promise<void> => {
          try {
            await withDbRole(tx, 'async_consult_patient_initiator', async () => {
              await tx.query(
                'SELECT record_consult_initiation($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)',
                [
                  consultId,
                  ctx.tenantId,
                  actor.accountId, // p_patient_id — trust-anchor identity, never body-supplied
                  null, // p_delegate_id — patient-principal-only at PR 6
                  consultType,
                  programId,
                  initiationSource,
                  consultFeeCents,
                  currency,
                  paymentIntentId,
                  paymentProvider,
                  expectedTurnaroundAt.toISOString(),
                  transitionId,
                  actor.accountId, // p_actor_id
                  'patient', // p_actor_role (056 transition_by_actor_role enum)
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
          await withActorContext(tx, actorNonce, runInitiate);
        } else {
          await runInitiate();
        }
      });

      // Same-tx Cat C audit emission under the restored app role (I-003:
      // a throw here rolls the wrapper effect back too — no suppression).
      await emitAsyncConsultInitiatedAudit(
        {
          tenantId: ctx.tenantId,
          consultId,
          patientId: actor.accountId,
          actorId: actor.accountId,
          actorTenantId,
          countryOfCare: ctx.countryOfCare,
          consultType,
          programId,
          initiationSource,
          consultFeeCents,
          currency,
          paymentProvider,
          expectedTurnaroundAt: expectedTurnaroundAt.toISOString(),
        },
        tx,
      );

      return {
        status: 201,
        view: { consult_id: consultId },
      };
    },
  );
}
