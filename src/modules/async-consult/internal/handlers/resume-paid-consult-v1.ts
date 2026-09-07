import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  billingActor,
  billingFailure,
  BillingError,
  resumeConsultPayment,
} from '../../../billing/index.js';

import { completeBilledConsult } from './initiate-consult-v1.js';

const id = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
export async function resumePaidConsultV1Handler(req: FastifyRequest, reply: FastifyReply) {
  void reply.header('Cache-Control', 'no-store');
  const actor = billingActor(req);
  if (actor.role !== 'patient') throw new BillingError('billing.actor_unavailable', 403);
  const params = z.object({ payment_id: id }).strict().safeParse(req.params);
  if (
    !params.success ||
    !id.safeParse(req.headers['idempotency-key']).success ||
    !z
      .object({})
      .strict()
      .safeParse(req.body ?? {}).success ||
    !z.object({}).strict().safeParse(req.query).success
  )
    throw new BillingError('billing.request_invalid', 400);
  try {
    const payment = await resumeConsultPayment(actor, params.data.payment_id);
    return await completeBilledConsult(req, reply, actor, payment);
  } catch (error) {
    if (billingFailure(error, reply, req.id)) return reply;
    throw error;
  }
}
