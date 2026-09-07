import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { requireActorContext } from '../../lib/auth-context.js';
import { requireTenantContext } from '../../lib/tenant-context.js';

import { closeBillingPool } from './internal/database.js';
import {
  confirmMockPayment,
  paymentConfirmation,
  publishConsultPrice,
  quoteConsult,
  receiveProviderWebhook,
} from './internal/service.js';
import { BillingError, type BillingActor } from './internal/types.js';

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
// Program pricing needs an actual active Program entity. The first complete
// journey is general care; opaque program strings are deliberately unavailable.
const selection = z
  .object({ consult_type: z.literal('general'), program_id: z.null().optional() })
  .strict();
const priceBody = selection
  .extend({
    version: z.number().int().min(1),
    amount_minor: z.number().int().min(1).max(99999999),
    turnaround_minutes: z.number().int().min(1).max(10080),
    quote_ttl_seconds: z.number().int().min(60).max(900),
  })
  .strict();
export function billingActor(req: FastifyRequest): BillingActor {
  const actor = requireActorContext(req);
  const context = requireTenantContext(req);
  if (
    !req.actorNonce ||
    actor.delegateId !== null ||
    !['patient', 'tenant_admin'].includes(actor.role) ||
    actor.tenantId !== context.tenantId
  )
    throw new BillingError('billing.actor_unavailable', 403);
  return {
    context,
    accountId: actor.accountId,
    nonce: req.actorNonce,
    role: actor.role as 'patient' | 'tenant_admin',
  };
}
export function billingFailure(error: unknown, reply: FastifyReply, requestId: string): boolean {
  if (error instanceof BillingError) {
    void reply.code(error.statusCode).send({
      error: {
        code: error.code,
        message: 'The billing operation could not be completed. Check its status before retrying.',
        request_id: requestId,
      },
    });
    return true;
  }
  return false;
}
function key(req: FastifyRequest): string {
  const parsed = id.safeParse(req.headers['idempotency-key']);
  if (!parsed.success) throw new BillingError('billing.idempotency_key_invalid', 400);
  return parsed.data;
}
export async function registerBillingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onClose', closeBillingPool);
  app.setErrorHandler((error, req, reply) => {
    if (!billingFailure(error, reply, req.id)) void reply.send(error);
  });
  app.post('/consult-prices', { config: { billingBoundary: 'patient' } }, async (req, reply) => {
    void reply.header('Cache-Control', 'no-store');
    key(req);
    const parsed = priceBody.safeParse(req.body);
    if (!parsed.success) throw new BillingError('billing.request_invalid', 400);
    const p = await publishConsultPrice(billingActor(req), { ...parsed.data, program_id: null });
    return reply.code(201).send({
      price_id: p.id,
      pricing_version: p.version,
      amount_minor: p.amount_minor,
      currency: p.currency,
      provider: p.provider,
      mode: p.provider_mode,
    });
  });
  app.post('/consult-quotes', { config: { billingBoundary: 'patient' } }, async (req, reply) => {
    void reply.header('Cache-Control', 'no-store');
    const parsed = selection.safeParse(req.body);
    if (!parsed.success) throw new BillingError('billing.request_invalid', 400);
    return reply
      .code(201)
      .send(await quoteConsult(billingActor(req), { ...parsed.data, program_id: null }, key(req)));
  });
  app.get<{ Params: { id: string } }>('/payment-intents/:id/confirmation', async (req, reply) => {
    void reply.header('Cache-Control', 'no-store');
    if (!id.safeParse(req.params.id).success)
      throw new BillingError('billing.request_invalid', 400);
    return paymentConfirmation(billingActor(req), req.params.id);
  });
  app.post<{ Params: { id: string } }>(
    '/payment-intents/:id/mock-confirm',
    { config: { billingBoundary: 'patient' } },
    async (req, reply) => {
      void reply.header('Cache-Control', 'no-store');
      key(req);
      if (
        !id.safeParse(req.params.id).success ||
        (req.body !== undefined &&
          req.body !== null &&
          (typeof req.body !== 'object' || Object.keys(req.body).length !== 0))
      )
        throw new BillingError('billing.request_invalid', 400);
      await confirmMockPayment(billingActor(req), req.params.id);
      return reply.code(200).send({ status: 'paid', mode: 'mock_local_dev' });
    },
  );
  await app.register(async (webhook) => {
    webhook.removeContentTypeParser('application/json');
    webhook.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 65536 },
      (_req, body, done) => done(null, body),
    );
    webhook.post<{ Params: { provider: string } }>(
      '/webhooks/:provider',
      { config: { billingBoundary: 'webhook' }, bodyLimit: 65536 },
      async (req, reply) => {
        if (!Buffer.isBuffer(req.body)) throw new BillingError('billing.webhook_invalid', 400);
        await receiveProviderWebhook(
          requireTenantContext(req).tenantId,
          req.params.provider,
          req.body,
          req.headers,
        );
        return reply.code(200).send({ received: true });
      },
    );
  });
}
declare module 'fastify' {
  interface FastifyContextConfig {
    billingBoundary?: 'patient' | 'webhook';
  }
}
