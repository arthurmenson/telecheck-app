/** SI-020 §10: durable Billing creation precedes the atomic local consult write. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { withActorContext } from '../../../../lib/actor-context-binding.js';
import { withTransaction } from '../../../../lib/db.js';
import { emitDomainEvent } from '../../../../lib/domain-events.js';
import {
  IdempotencyReplayError,
  IdempotencyInFlightError,
  IdempotencyBodyMismatchError,
} from '../../../../lib/idempotency.js';
import { withIdempotentExecution } from '../../../../lib/idempotent-handler.js';
import { withTenantContext } from '../../../../lib/rls.js';
import { ulid } from '../../../../lib/ulid.js';
import { withDbRole } from '../../../../lib/with-db-role.js';
import {
  billingActor,
  billingFailure,
  BillingError,
  ensureConsultPayment,
} from '../../../billing/index.js';
import { emitAsyncConsultInitiatedAudit } from '../../audit.js';

import { makeErrorEnvelope, pgErrorCode } from './v1-shared.js';

const inputSchema = z
  .object({
    consult_type: z.literal('general'),
    program_id: z.null().optional(),
    initiation_source: z.enum([
      'program_enrollment',
      'care_tab',
      'mode_1_handoff',
      'medication_detail',
      'rpm_ccm_dashboard',
    ]),
    accepted_quote_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  })
  .strict();
export async function initiateConsultV1Handler(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<unknown> {
  void reply.header('Cache-Control', 'no-store');
  const actor = billingActor(req);
  if (actor.role !== 'patient') throw new BillingError('billing.actor_unavailable', 403);
  const parsed = inputSchema.safeParse(req.body);
  const key = req.headers['idempotency-key'];
  if (!parsed.success || typeof key !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(key))
    return reply
      .code(400)
      .send(
        makeErrorEnvelope(
          req.id,
          'internal.request.invalid',
          'A general consult selection and an accepted, unexpired server quote are required.',
        ),
      );
  try {
    // Billing commits its own reservation before provider I/O. A later local
    // rollback resumes the same intent; it never substitutes a new payment key.
    const payment = await ensureConsultPayment(actor, { ...parsed.data, program_id: null }, key);
    return await completeBilledConsult(req, reply, actor, payment);
  } catch (error) {
    if (billingFailure(error, reply, req.id)) return reply;
    throw error;
  }
}

/** Both original initiation and recovered reservations commit this same case boundary. */
export async function completeBilledConsult(
  req: FastifyRequest,
  reply: FastifyReply,
  actor: ReturnType<typeof billingActor>,
  payment: Awaited<ReturnType<typeof ensureConsultPayment>>,
): Promise<unknown> {
  try {
    return await withIdempotentExecution(
      req,
      reply,
      (error, res, id) => {
        if (billingFailure(error, res, id)) return true;
        if (pgErrorCode(error) === '42501') {
          void res
            .code(403)
            .send(
              makeErrorEnvelope(
                id,
                'internal.request.forbidden',
                'Insufficient scope for this request.',
              ),
            );
          return true;
        }
        return false;
      },
      async (tx) => {
        const row = await withTenantContext(tx, actor.context.tenantId, () =>
          withActorContext(tx, actor.nonce, () =>
            withDbRole(tx, 'async_consult_patient_initiator', async () => {
              const r = await tx.query<{
                consult_id: string;
                created: boolean;
                expected_turnaround_at: Date;
              }>('SELECT * FROM public.record_billed_consult_initiation($1,$2,$3)', [
                ulid(),
                payment.payment_id,
                ulid(),
              ]);
              return r.rows[0]!;
            }),
          ),
        );
        if (row.created) {
          await emitAsyncConsultInitiatedAudit(
            {
              tenantId: actor.context.tenantId,
              consultId: row.consult_id,
              patientId: actor.accountId,
              actorId: actor.accountId,
              actorTenantId: actor.context.tenantId,
              countryOfCare: actor.context.countryOfCare,
              consultType: payment.consult_type,
              programId: payment.program_id,
              initiationSource: payment.initiation_source,
              consultFeeCents: payment.amount_minor,
              currency: payment.currency,
              paymentProvider: payment.provider,
              expectedTurnaroundAt: row.expected_turnaround_at.toISOString(),
            },
            tx,
          );
          await emitDomainEvent(tx, {
            tenant_id: actor.context.tenantId,
            aggregate_type: 'consult',
            aggregate_id: row.consult_id,
            event_type: 'async_consult.initiated.v1',
            payload: {
              consult_id: row.consult_id,
              payment_intent_id: payment.payment_id,
              consult_fee_cents: payment.amount_minor,
              currency: payment.currency,
            },
            occurred_at: new Date().toISOString(),
          });
        }
        return {
          status: 201,
          view: {
            consult_id: row.consult_id,
            payment_intent_id: payment.payment_id,
            confirmation: {
              kind: 'retrieve',
              href: `/v1/billing/payment-intents/${payment.payment_id}/confirmation`,
              provider: payment.provider,
              mode: payment.provider_mode,
            },
          },
        };
      },
      (fn) =>
        withTransaction(async (tx) => {
          const validate = () =>
            withTenantContext(tx, actor.context.tenantId, () =>
              withActorContext(tx, actor.nonce, () =>
                withDbRole(tx, 'async_consult_patient_initiator', () =>
                  tx.query('SELECT public.billing_assert_live_patient()'),
                ),
              ),
            );
          try {
            const result = await fn(tx);
            await validate();
            return result;
          } catch (error) {
            // Cached metadata is still patient data. A blocked cache read must
            // recheck the live session before withIdempotentExecution replays it.
            if (
              error instanceof IdempotencyReplayError ||
              error instanceof IdempotencyInFlightError ||
              error instanceof IdempotencyBodyMismatchError
            )
              await validate();
            throw error;
          }
        }),
    );
  } catch (error) {
    if (billingFailure(error, reply, req.id)) return reply;
    throw error;
  }
}
