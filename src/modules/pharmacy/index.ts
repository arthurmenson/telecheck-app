/**
 * Pharmacy module — public interface (skeleton).
 *
 * Per ADR-001: cross-module callers consume the Pharmacy module ONLY
 * through this file. At v0.1 the only exported surface is the Fastify
 * plugin (for app.ts wiring) and branded ID types (for downstream
 * slices that hold typed references to medication_request_id /
 * refill_id / etc. without needing full row shapes).
 *
 * Schema authoring (the real `MedicationRequest`, `Refill`,
 * `Dispensing`, `Shipment`, `ProductCatalog` row interfaces +
 * repos + services + HTTP handlers) is BLOCKED on SI-001
 * (`docs/SI-001-MedicationRequest-Schema-Gap.md`). This skeleton
 * exists so the module directory + plugin wiring + branded ID
 * imports are stable now — when SI-001 closes upstream
 * (Promotion Ledger P-011), only the data + service + handler
 * authoring is left, not directory scaffolding.
 *
 * Spec references:
 *   - ADR-001 (modular monolith — public-interface-only cross-module access)
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md (the blocker)
 *   - CDM v1.2 §3.5 (Pharmacy & Fulfillment entity inventory)
 *   - Pharmacy + Refill Slice PRD v2.1 (the target spec)
 */

// Branded ID types — safe to ship at v0.1 because they are identifier
// hygiene, not schema. Downstream slices (Subscription, Dispensing,
// etc.) that hold typed references to these IDs can compile clean
// before SI-001 closes.
export type {
  MedicationRequestId,
  RefillId,
  DispensingId,
  ShipmentId,
  ProductCatalogId,
} from './internal/types.js';

export {
  asMedicationRequestId,
  asRefillId,
  asDispensingId,
  asShipmentId,
  asProductCatalogId,
} from './internal/types.js';

// Fastify plugin for app.ts wiring. Currently exposes only `/health`.
export { pharmacyPlugin } from './plugin.js';
