/**
 * ai-service/plugin.ts — Fastify plugin entry point (scaffold at PR A).
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point
 * that registers the module's routes. Cross-module callers consume
 * the AI Service module ONLY through `index.ts` (the public-interface
 * surface).
 *
 * Status at PR A: scaffold only. Plugin registers `/health` (200) +
 * `/ready` (503). Real handlers land in subsequent PRs (B: Mode 1
 * chat stub; C: Mode 2 case-prep stub; D: Anthropic provider; E:
 * guardrail templates; F: crisis detection).
 *
 * Spec references:
 *   - ADR-001 (modular monolith — public-interface-only cross-module
 *     access)
 *   - AI Clinical Assistant Slice PRD v1.0
 *   - AI_LAYERING v5.2 (two-mode architecture + audit envelope +
 *     tenant scoping + resilience)
 *   - ADR-029 (AI workload taxonomy)
 *   - ADR-020 (LLM provider abstraction)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerAIServiceRoutes } from './routes.js';

const aiServicePluginImpl: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(registerAIServiceRoutes, { prefix: '/v0/ai' });
};

export const aiServicePlugin = fp(aiServicePluginImpl, {
  name: 'ai-service',
  fastify: '5.x',
});
