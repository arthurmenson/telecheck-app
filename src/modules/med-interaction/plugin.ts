/**
 * med-interaction/plugin.ts — Fastify plugin entry point (Sprint 1 / PR 1).
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point
 * that registers the module's routes. Cross-module callers consume
 * the Med Interaction module ONLY through `index.ts`.
 *
 * Status: spec layer COMPLETE + RATIFIED (SI-019 v2.0 P-033 +
 * CDM v1.6 → v1.7 P-034 RATIFIED 2026-05-21). DB layer at PR 1 of ~6:
 * plugin registers the module's `/health` (200) + `/ready` (503) probes
 * so app-level wiring works as subsequent PRs land. Full handler
 * implementation (8 endpoints per SI-019 §5 + CDM §6 OpenAPI v0.3:
 * signal-check + override-record + lifecycle actions) lands at PR 6+
 * after entities (PR 2) → views (PR 3) → raw writer (PR 4) → 6
 * reason-specific wrappers (PR 5).
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - Master PRD v1.10 §7 (interaction engine as platform-floor)
 *   - Telecheck_Medication_Interaction_Engine_Slice_PRD_v2_0.md (P-033)
 *   - Telecheck_CDM_v1_6_to_v1_7_Amendment.md (P-034)
 *   - Pharmacy + Refill Slice PRD v2.1 §6 (downstream consumer per I-002)
 *   - src/modules/med-interaction/README.md
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerMedInteractionRoutes } from './routes.js';

const medInteractionPluginImpl: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  await app.register(registerMedInteractionRoutes, { prefix: '/v0/med-interaction' });
};

export const medInteractionPlugin = fp(medInteractionPluginImpl, {
  name: 'med-interaction',
  fastify: '5.x',
});
