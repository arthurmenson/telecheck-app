/**
 * pharmacy/plugin.ts — Fastify plugin entry point (skeleton).
 *
 * Per ADR-001 modular monolith: this plugin is the ONLY entry point
 * that registers the module's routes. Cross-module callers consume
 * the Pharmacy module ONLY through `index.ts`.
 *
 * Status at v0.1: BLOCKED on SI-001. Plugin registers the module's
 * `/health` probe so app-level wiring works; full implementation
 * (POST /prescriptions, POST /refills, pharmacy-adapter integration,
 * etc.) lands when SI-001 closes and the CDM §4 schema is canonical.
 *
 * Spec references:
 *   - ADR-001 (modular monolith)
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md
 *   - Pharmacy + Refill Slice PRD v2.1
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { registerPharmacyRoutes } from './routes.js';

const pharmacyPluginImpl: FastifyPluginAsync = async (app: FastifyInstance): Promise<void> => {
  await app.register(registerPharmacyRoutes, { prefix: '/v0/pharmacy' });
};

export const pharmacyPlugin = fp(pharmacyPluginImpl, {
  name: 'pharmacy',
  fastify: '5.x',
});
