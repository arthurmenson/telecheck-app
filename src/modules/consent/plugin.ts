/**
 * consent/plugin.ts — Fastify plugin entry point for the Consent &
 * Delegated Access module.
 *
 * Per ADR-001: this plugin is the only entry point that registers
 * the module's routes. Cross-module callers consume the Consent
 * module ONLY through the public interface in index.ts.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - Consent Slice PRD v1.0
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerConsentRoutes } from './routes.js';

const consentPluginImpl: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(registerConsentRoutes, { prefix: '/v0/consent' });
};

export const consentPlugin = fp(consentPluginImpl, {
  name: 'consent',
  fastify: '5.x',
});
