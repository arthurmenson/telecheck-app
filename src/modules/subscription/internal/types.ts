/**
 * subscription/internal/types.ts — branded ID types only at v0.1.
 *
 * Schema authoring is BLOCKED on SI-001 (`docs/SI-001-MedicationRequest-Schema-Gap.md`)
 * because Subscription depends on MedicationRequest schema for refill
 * cadence + product-catalog binding. Per EHBG §7, engineering does
 * not author canonical schema. Branded IDs land here because they are
 * NOT schema (identifier hygiene); row-shape interfaces wait for
 * SI-001 closure (Promotion Ledger P-011).
 *
 * Subscription is the patient's standing recurring-fulfillment
 * contract: "every 30 days, ship me Drug X at Tier-Y price". The
 * model owns:
 *   - schedule (cadence, next_ship_at)
 *   - pause/resume/cancel/switch state machine
 *   - product binding to ProductCatalog (Pharmacy module)
 *   - payment method binding (Pharmacy + Payment adapter)
 *
 * None of those land at v0.1 — the skeleton ships only the directory
 * boundary so downstream slices (Pharmacy + Refill, Async Consult,
 * Admin Backend Tenant Admin subscription management) can typed-import
 * `SubscriptionId` ahead of full schema ratification.
 *
 * Spec references:
 *   - docs/SI-001-MedicationRequest-Schema-Gap.md
 *   - CDM v1.2 §3.5 (Pharmacy & Fulfillment entity inventory references
 *     Subscription / SubscriptionSchedule / SubscriptionPause)
 *   - EHBG §7 (engineering implements per CDM, does not author)
 *   - Pharmacy + Refill Slice PRD v2.1 §5 (downstream consumer)
 */

// ---------------------------------------------------------------------------
// Branded ID types — PROVISIONAL pending SI-001 closure + slice ratification.
// Names align with anticipated CDM entity inventory; if a future slice PRD
// picks different names, treat as Sprint 5+ rename.
// ---------------------------------------------------------------------------

declare const _subscriptionIdBrand: unique symbol;
export type SubscriptionId = string & {
  readonly [_subscriptionIdBrand]: 'SubscriptionId';
};
export function asSubscriptionId(s: string): SubscriptionId {
  return s as SubscriptionId;
}

declare const _subscriptionScheduleIdBrand: unique symbol;
export type SubscriptionScheduleId = string & {
  readonly [_subscriptionScheduleIdBrand]: 'SubscriptionScheduleId';
};
export function asSubscriptionScheduleId(s: string): SubscriptionScheduleId {
  return s as SubscriptionScheduleId;
}

declare const _subscriptionPauseIdBrand: unique symbol;
export type SubscriptionPauseId = string & {
  readonly [_subscriptionPauseIdBrand]: 'SubscriptionPauseId';
};
export function asSubscriptionPauseId(s: string): SubscriptionPauseId {
  return s as SubscriptionPauseId;
}

// Row-shape interfaces (Subscription, SubscriptionSchedule,
// SubscriptionPause) are intentionally NOT exported here. They land
// when SI-001 closes and the CDM §4 field-level expansion canonicalizes
// MedicationRequest (which Subscription binds to via medication_request_id).
