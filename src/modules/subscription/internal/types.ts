/**
 * subscription/internal/types.ts — branded IDs + row shapes for the
 * Subscription slice (CDM v1.2 §4.7 Subscription + §4.8 SubscriptionEvent).
 *
 * SI-001 closure: the v0.1 skeleton deferred row shapes on SI-001
 * (MedicationRequest schema gap). SI-001 closed at Promotion Ledger P-011
 * (2026-05-11; migration 025 landed medication_requests); operator (Evans)
 * confirmed 2026-07-08 that P-011 closure authorizes this build. Row shapes
 * now mirror migrations 076 §1/§2 exactly.
 *
 * ID conventions: TYPES contract (v5.1 additions) defines `sub_` (subscription)
 * and `sue_` (subscription event) prefixes; OpenAPI v0.2 §20 shows the
 * `sub_<ULID>` / `sue_<ULID>` wire shapes. Constructors validate the full
 * canonical shape (glossary.ts asMedicationRequestId precedent).
 *
 * Spec references:
 *   - CDM v1.2 §4.7 / §4.8 / §3.12
 *   - State Machines v1.1 §15 (status vocabulary)
 *   - Pharmacy + Refill Slice PRD v2.1 §8
 *   - migrations/076_subscription_entities.sql (durable shapes)
 */

// ---------------------------------------------------------------------------
// Branded ID types
// ---------------------------------------------------------------------------

declare const _subscriptionIdBrand: unique symbol;
export type SubscriptionId = string & {
  readonly [_subscriptionIdBrand]: 'SubscriptionId';
};

const SUBSCRIPTION_ID_PATTERN = /^sub_[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/;

/** Type constructor — validates the full sub_<ULID> canonical shape. */
export function asSubscriptionId(s: string): SubscriptionId {
  if (!SUBSCRIPTION_ID_PATTERN.test(s)) {
    throw new TypeError(
      'SubscriptionId must match the canonical sub_<26-char Crockford-base32 ULID> ' +
        `shape (TYPES v5.1 prefix additions; OpenAPI v0.2 §20). Received: "${s}".`,
    );
  }
  return s as SubscriptionId;
}

/** Shape probe (boundary validation; no throw). */
export function isSubscriptionId(s: unknown): s is string {
  return typeof s === 'string' && SUBSCRIPTION_ID_PATTERN.test(s);
}

declare const _subscriptionEventIdBrand: unique symbol;
export type SubscriptionEventId = string & {
  readonly [_subscriptionEventIdBrand]: 'SubscriptionEventId';
};

const SUBSCRIPTION_EVENT_ID_PATTERN = /^sue_[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/;

/** Type constructor — validates the full sue_<ULID> canonical shape. */
export function asSubscriptionEventId(s: string): SubscriptionEventId {
  if (!SUBSCRIPTION_EVENT_ID_PATTERN.test(s)) {
    throw new TypeError(
      'SubscriptionEventId must match the canonical sue_<26-char Crockford-base32 ULID> ' +
        `shape (TYPES v5.1 prefix additions; OpenAPI v0.2 §20.7). Received: "${s}".`,
    );
  }
  return s as SubscriptionEventId;
}

// ---------------------------------------------------------------------------
// DEPRECATED skeleton-era branded IDs (v0.1) — kept exported so any
// downstream typed-import compiled against the skeleton keeps compiling.
// The ratified CDM v1.2 §3.12 inventory has NO SubscriptionSchedule /
// SubscriptionPause entities (cadence + pause state live ON the
// subscriptions row per §4.7); these brands have no durable surface.
// ---------------------------------------------------------------------------

declare const _subscriptionScheduleIdBrand: unique symbol;
/** @deprecated No CDM v1.2 entity — cadence lives on subscriptions (§4.7). */
export type SubscriptionScheduleId = string & {
  readonly [_subscriptionScheduleIdBrand]: 'SubscriptionScheduleId';
};
/** @deprecated See SubscriptionScheduleId. */
export function asSubscriptionScheduleId(s: string): SubscriptionScheduleId {
  return s as SubscriptionScheduleId;
}

declare const _subscriptionPauseIdBrand: unique symbol;
/** @deprecated No CDM v1.2 entity — pause state lives on subscriptions (§4.7). */
export type SubscriptionPauseId = string & {
  readonly [_subscriptionPauseIdBrand]: 'SubscriptionPauseId';
};
/** @deprecated See SubscriptionPauseId. */
export function asSubscriptionPauseId(s: string): SubscriptionPauseId {
  return s as SubscriptionPauseId;
}

// ---------------------------------------------------------------------------
// Enums (mirror migration 076 CHECK constraints)
// ---------------------------------------------------------------------------

/** State Machines v1.1 §15 — the 10 ratified states. */
export const SUBSCRIPTION_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'FULFILLING',
  'PAUSED',
  'SWITCHING',
  'CANCELLATION_PENDING',
  'CANCELLED',
  'DECLINED',
  'PAYMENT_FAILED_TERMINAL',
  'SAFETY_HOLD',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** CDM v1.2 §4.7 cadence enum. */
export const SUBSCRIPTION_CADENCES = ['monthly', 'quarterly', 'biannual'] as const;
export type SubscriptionCadence = (typeof SUBSCRIPTION_CADENCES)[number];

/** CDM v1.2 §4.8 event_type enum — VERBATIM 13 values. See the migration 076
 *  header SPEC GAP note: the State Machines v1.1 §15 emissions `fulfilled`,
 *  `switch_declined`, and `terminated_clinical` (and any period_end marker)
 *  have NO ratified enum value; those transitions are audit-only until the
 *  CDM enum is amended (§12 Spec Issue candidate — module README). */
export const SUBSCRIPTION_EVENT_TYPES = [
  'created',
  'activated',
  'paused',
  'resumed',
  'switching_initiated',
  'switched',
  'cancellation_pending',
  'cancelled',
  'declined',
  'payment_failed',
  'terminated_payment_failure',
  'safety_hold',
  'released_from_safety_hold',
] as const;
export type SubscriptionEventType = (typeof SUBSCRIPTION_EVENT_TYPES)[number];

/** CDM v1.2 §4.8 actor_type enum. */
export const SUBSCRIPTION_ACTOR_TYPES = [
  'patient',
  'clinician',
  'system',
  'tenant_operator',
  'platform_admin',
] as const;
export type SubscriptionActorType = (typeof SUBSCRIPTION_ACTOR_TYPES)[number];

/** OpenAPI v0.2 §20.3 pause reason enum. */
export const PAUSE_REASONS = ['travel', 'financial', 'side_effects', 'break', 'other'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

/** OpenAPI v0.2 §20.5 switch reason enum. */
export const SWITCH_REASONS = [
  'side_effects',
  'preference',
  'clinical_recommendation',
  'other',
] as const;
export type SwitchReason = (typeof SWITCH_REASONS)[number];

/** OpenAPI v0.2 §20.6 cancel reason enum. */
export const CANCEL_REASONS = [
  'side_effects',
  'financial',
  'not_seeing_results',
  'other',
  'no_reason',
] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];

/** OpenAPI v0.2 §20.6 deflection outcome enum. */
export const DEFLECTION_OUTCOMES = [
  'patient_continued_to_cancel',
  'patient_chose_alternative',
  'patient_chose_pause',
] as const;
export type DeflectionOutcome = (typeof DEFLECTION_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// Row shapes (mirror migration 076 §1/§2)
// ---------------------------------------------------------------------------

/** subscriptions row (CDM v1.2 §4.7 / migration 076 §1). The DB column
 *  `prescription_id` is CDM-verbatim; app-layer naming uses the canonical
 *  glossary term (medicationRequestId) — see the migration 076 header
 *  GLOSSARY TENSION note. */
export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  patient_id: string;
  product_id: string;
  prescription_id: string;
  cadence: SubscriptionCadence;
  unit_price: string; // DECIMAL comes back as string from pg
  currency: string;
  status: SubscriptionStatus;
  started_at: Date;
  paused_at: Date | null;
  pause_until: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  next_renewal_at: Date | null;
  last_fulfilled_at: Date | null;
  preauth_window_months: number;
  preauth_renewals_remaining: number;
  payment_method_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

/** subscription_events row (CDM v1.2 §4.8 / migration 076 §2). */
export interface SubscriptionEventRow {
  id: string;
  tenant_id: string;
  subscription_id: string;
  event_type: SubscriptionEventType;
  event_data: Record<string, unknown>;
  actor_type: SubscriptionActorType;
  actor_id: string | null;
  occurred_at: Date;
}
