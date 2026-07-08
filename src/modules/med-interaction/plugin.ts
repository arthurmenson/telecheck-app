/**
 * med-interaction/plugin.ts — Fastify plugin entry point (Sprint 1 / PR 6 of 6).
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point
 * that registers the module's routes. Cross-module callers consume
 * the Med Interaction module ONLY through `index.ts`.
 *
 * Status: spec layer COMPLETE + RATIFIED (SI-019 v2.0 P-033 +
 * CDM v1.6 → v1.7 P-034 RATIFIED 2026-05-21). **DB layer COMPLETE
 * through migration 050** (PRs 1-5 merged; 21 Codex rounds total):
 * 12 RBAC roles (046) + 4 entities + RLS + per-table append-only +
 * server-assigned monotonic-ordering triggers (047) + SECURITY BARRIER
 * view + optional MV + SECDEF access function (048) + raw lifecycle
 * writer SECDEF + anti-bypass EXECUTE matrix (049) + 6 reason-specific
 * wrappers (050; 3 operational + 3 fail-closed at ship time — the
 * override wrapper turned OPERATIONAL at migration 070's evidence
 * unlock; resolve + expiry remain fail-closed with narrowed deferrals).
 * PR 6 was the Fastify scaffold update closing the DB-layer series;
 * PRs 7-9 + the evidence-unlock PR mounted all 8 endpoints per SI-019
 * §5 + CDM §6 OpenAPI v0.3 (6 of 8 operational).
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
