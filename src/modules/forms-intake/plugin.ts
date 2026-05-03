/**
 * forms-intake/plugin.ts — Fastify plugin entry point for the Forms/Intake module.
 *
 * Registered in `src/app.ts` after the foundation middleware (tenantContext,
 * idempotency, errorEnvelope, aiContext). All routes are mounted under the
 * `/v0/forms` prefix so they participate in tenant context resolution and
 * the canonical error envelope per I-023 / I-025.
 *
 * Per ADR-001 modular monolith: this plugin is the only entry point that
 * may register the module's routes. Other modules consume the Forms/Intake
 * module ONLY through the public interface in `index.ts`.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerFormsIntakeRoutes } from './routes.js';

const formsIntakePluginImpl: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(registerFormsIntakeRoutes, { prefix: '/v0/forms' });
};

export const formsIntakePlugin = fp(formsIntakePluginImpl, {
  name: 'forms-intake',
  fastify: '5.x',
});
