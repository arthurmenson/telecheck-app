/**
 * pharmacy/routes.ts — Fastify route registration (skeleton).
 *
 * Status at v0.1: BLOCKED on SI-001. Only `/health` is mounted; every
 * other path under `/v0/pharmacy` returns the canonical 501-equivalent
 * tenant-blind error envelope when SI-001 closure adds real handlers.
 *
 * Spec references:
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md
 *   - I-023 (tenant scoping via foundation tenantContext plugin)
 *   - I-025 (tenant-blind error envelopes)
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export const registerPharmacyRoutes: FastifyPluginAsync = async (
  app: FastifyInstance,
): Promise<void> => {
  // Health probe — allowlisted in tenantContextPlugin so it works
  // without tenant binding. Returns the BLOCKED state explicitly so
  // operator monitoring distinguishes "module up" (200) from "module
  // ready for production" (which it is NOT until SI-001 closes).
  app.get('/health', async () => ({
    status: 'ok',
    module: 'pharmacy',
    blocked: 'SI-001',
    blocked_message:
      'MedicationRequest schema not yet ratified in CDM v1.2 §4. ' +
      'See docs/SI-001-MedicationRequest-Schema-Gap.md.',
  }));

  // Real routes (POST /prescriptions, POST /refills, etc.) land when
  // SI-001 closes and the schema migrations are authored. The handler
  // surface is intentionally absent here so that any premature wiring
  // breaks at typecheck time rather than reaching production half-built.
};
