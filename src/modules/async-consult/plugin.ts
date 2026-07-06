/**
 * async-consult/plugin.ts — Fastify plugin entry point.
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point
 * that registers the module's routes. Cross-module callers consume
 * the Async Consult module ONLY through `index.ts`.
 *
 * TWO route surfaces are mounted (Sprint 10 PR 6):
 *
 *   1. `/v0/async-consult` (routes.ts) — the Sprint-9 legacy surface
 *      against the migration 020 `consults` + `consult_events` tables
 *      (initiate / submit / abandon / resume / patient-responds /
 *      events). Unchanged; preserved for its existing callers +
 *      integration tests.
 *   2. `/v1/async-consults` (routes-v1.ts) — the Sprint-10 P-038
 *      canonical-entity surface (migrations 055-060): initiate /
 *      intake / queue / get / claim / decision through the migration
 *      059 SECDEF wrappers + migration 057 caller-class views, with
 *      async_consult.* audit emission per AUDIT_EVENTS v5.11.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - Async Consult Slice PRD v1.0 §12 (state machine; subset of canonical)
 *   - State Machines v1.1 §3 (canonical state inventory; 17 states)
 *   - P-038 CDM v1.8 → v1.9 amendment (canonical consult entity chain)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerAsyncConsultV1Routes } from './routes-v1.js';
import { registerAsyncConsultRoutes } from './routes.js';

const asyncConsultPluginImpl: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(registerAsyncConsultRoutes, { prefix: '/v0/async-consult' });
  await app.register(registerAsyncConsultV1Routes, { prefix: '/v1/async-consults' });
};

export const asyncConsultPlugin = fp(asyncConsultPluginImpl, {
  name: 'async-consult',
  fastify: '5.x',
});
