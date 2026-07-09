/**
 * Subscription module — public interface (ADR-001).
 *
 * Cross-module callers consume the Subscription module ONLY through this
 * file. SI-001 CLOSED (Promotion Ledger P-011): the module now exports the
 * Fastify plugin (app.ts wiring), branded ID types, row/enum types, and the
 * `createSubscriptionDraft` service function — the stable in-process target
 * for the Payments-module checkout orchestration (POST /subscriptions is
 * ratified under the Payments module, not this slice's HTTP surface).
 *
 * Spec references:
 *   - ADR-001 (modular monolith — public-interface-only cross-module access)
 *   - CDM v1.2 §4.7/§4.8 (Subscription / SubscriptionEvent)
 *   - State Machines v1.1 §15 (Subscription State Machine)
 *   - OpenAPI v0.2 §20 (subscription endpoint contracts)
 *   - Pharmacy + Refill Slice PRD v2.1 §8 (subscription semantics)
 */

// Branded ID types + row/enum shapes for downstream slices (Pharmacy +
// Refill, Payments checkout orchestration) that hold typed references.
export type {
  SubscriptionId,
  SubscriptionEventId,
  SubscriptionScheduleId,
  SubscriptionPauseId,
  SubscriptionRow,
  SubscriptionEventRow,
  SubscriptionStatus,
  SubscriptionCadence,
  SubscriptionEventType,
} from './internal/types.js';

export {
  asSubscriptionId,
  asSubscriptionEventId,
  asSubscriptionScheduleId,
  asSubscriptionPauseId,
  SUBSCRIPTION_STATUSES,
} from './internal/types.js';

// The DRAFT-creation service function — the stable target for the
// Payments-module checkout orchestration (ADR-001 boundary: Payments calls
// this rather than reaching into subscription tables directly).
export {
  createSubscriptionDraft,
  type CreateSubscriptionDraftArgs,
  type CreateSubscriptionOutcome,
} from './internal/service.js';

// Fastify plugin for app.ts wiring (mounts the §20 handler surface).
export { subscriptionPlugin } from './plugin.js';
