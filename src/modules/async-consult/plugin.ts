/**
 * async-consult/plugin.ts — Fastify plugin entry point (skeleton).
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point
 * that registers the module's routes. Cross-module callers consume
 * the Async Consult module ONLY through `index.ts`.
 *
 * Status at v0.1 (Sprint 8): SKELETON — Sprint 1 of 3 for this slice.
 * Plugin registers `/health` (200) + `/ready` (503) so app-level wiring
 * works. Full implementation (POST /v0/async-consult, state-machine
 * transitions, AI Mode 2 prep wiring, clinician decision routing,
 * cross-slice integration with Pharmacy / Med-Interaction / Forms-Intake)
 * lands across Sprints 9-10.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - Async Consult Slice PRD v1.0 §12 (state machine; subset of canonical)
 *   - State Machines v1.1 §3 (canonical state inventory; 17 states)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerAsyncConsultRoutes } from './routes.js';

const asyncConsultPluginImpl: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(registerAsyncConsultRoutes, { prefix: '/v0/async-consult' });
};

export const asyncConsultPlugin = fp(asyncConsultPluginImpl, {
  name: 'async-consult',
  fastify: '5.x',
});
