import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerBillingRoutes } from './routes.js';

const plugin: FastifyPluginAsync = async (app) => {
  await app.register(registerBillingRoutes, { prefix: '/v1/billing' });
};
export const billingPlugin = fp(plugin, { name: 'billing', fastify: '5.x' });
export { billingActor, billingFailure } from './routes.js';
export {
  ensureConsultPayment,
  resumeConsultPayment,
  reconcileConsultPayment,
  type ConsultPaymentInput,
} from './internal/service.js';
export { BillingError, type BillingActor } from './internal/types.js';
