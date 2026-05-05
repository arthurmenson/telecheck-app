/**
 * Subscription module — public interface (skeleton).
 *
 * Per ADR-001: cross-module callers consume the Subscription module
 * ONLY through this file. At v0.1 the only exported surface is the
 * Fastify plugin (for app.ts wiring) and branded ID types (for
 * downstream slices that hold typed references to subscription_id /
 * subscription_schedule_id / subscription_pause_id without needing
 * full row shapes).
 *
 * Schema authoring (the real `Subscription`, `SubscriptionSchedule`,
 * `SubscriptionPause` row interfaces + repos + state machine + HTTP
 * handlers + adapter wiring to Pharmacy + Payment) is BLOCKED on
 * SI-001 closure (Promotion Ledger P-011). This skeleton exists so
 * the module directory + plugin wiring + branded ID imports are
 * stable now — when SI-001 closes upstream, only the data + service
 * + handler authoring is left, not directory scaffolding.
 *
 * Spec references:
 *   - ADR-001 (modular monolith — public-interface-only cross-module access)
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md (the blocker)
 *   - CDM v1.2 §3.5 (Pharmacy & Fulfillment entity inventory)
 *   - Pharmacy + Refill Slice PRD v2.1 §5 (target spec for subscription model)
 */

// Branded ID types — safe to ship at v0.1 because they are identifier
// hygiene, not schema. Downstream slices (Pharmacy + Refill, Async
// Consult, Admin Backend) that hold typed references to these IDs can
// compile clean before SI-001 closes.
export type {
  SubscriptionId,
  SubscriptionScheduleId,
  SubscriptionPauseId,
} from './internal/types.js';

export {
  asSubscriptionId,
  asSubscriptionScheduleId,
  asSubscriptionPauseId,
} from './internal/types.js';

// Fastify plugin for app.ts wiring. Currently exposes only `/health` + `/ready`.
export { subscriptionPlugin } from './plugin.js';
