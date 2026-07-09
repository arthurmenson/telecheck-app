/**
 * subscription/internal/state-machine.ts — the Subscription state machine
 * per State Machines v1.1 §15, as a PURE transition table + guard helpers.
 *
 * Every state mutation in this module goes through a transition declared
 * here (no shortcut paths). The service layer (service.ts) executes the
 * durable UPDATE with the from-state re-checked in the WHERE clause +
 * optimistic `version` bump, so a stale in-memory read can never commit an
 * unratified transition.
 *
 * §15 transition inventory (16 transitions across 10 states):
 *
 *   DRAFT      → ACTIVE                (clinician_approval;   clinician)
 *   DRAFT      → DECLINED              (clinician_decline;    clinician)
 *   ACTIVE     → FULFILLING            (period_end;           system)
 *   ACTIVE     → PAUSED                (pause_request;        patient)
 *   ACTIVE     → SWITCHING             (switch_request;       patient)
 *   ACTIVE     → CANCELLATION_PENDING  (cancel_request;       patient)
 *   ACTIVE     → SAFETY_HOLD           (safety_signal_critical; system)
 *   ACTIVE     → PAYMENT_FAILED_TERMINAL (payment_failed_terminal; system)
 *   FULFILLING → ACTIVE                (complete;             system)
 *   PAUSED     → ACTIVE                (resume;               patient or system auto-resume)
 *   PAUSED     → CANCELLED             (pause_expires;        system)
 *   SWITCHING  → ACTIVE                (switch_approve / switch_decline; clinician)
 *   CANCELLATION_PENDING → CANCELLED   (end_period;           system)
 *   SAFETY_HOLD → ACTIVE               (clinician_release;    clinician ONLY — I-001 floor)
 *   SAFETY_HOLD → CANCELLED            (clinician_terminate;  clinician)
 *
 * Terminal states: CANCELLED, DECLINED, PAYMENT_FAILED_TERMINAL.
 *
 * Guard invariants carried from §15:
 *   - SAFETY_HOLD release is clinician-only (no system/patient release).
 *   - Pause maximum is 90 days from paused_at (durable CHECK in 076 §1;
 *     also validated here for a friendly 400 before the DB 23514).
 *   - Cancellation deflection is bounded and NON-BLOCKING — the patient's
 *     choice to cancel is sovereign; deflection metadata is recorded,
 *     never used to reject the transition.
 *   - Switch always requires clinician review (no protocol auto-approval
 *     for switches at launch).
 *
 * Spec references: State Machines v1.1 §15; CDM v1.2 §4.7/§4.8;
 * Pharmacy + Refill Slice PRD v2.1 §8; migrations/076.
 */

import type { SubscriptionActorType, SubscriptionEventType, SubscriptionStatus } from './types.js';

// ---------------------------------------------------------------------------
// Transition vocabulary
// ---------------------------------------------------------------------------

export const SUBSCRIPTION_TRANSITIONS = [
  'clinician_approval',
  'clinician_decline',
  'period_end',
  'pause_request',
  'switch_request',
  'cancel_request',
  'safety_signal_critical',
  'payment_failed_terminal',
  'complete',
  'resume',
  'pause_expires',
  'switch_approve',
  'switch_decline',
  'end_period',
  'clinician_release',
  'clinician_terminate',
] as const;
export type SubscriptionTransition = (typeof SUBSCRIPTION_TRANSITIONS)[number];

export interface TransitionSpec {
  from: SubscriptionStatus;
  to: SubscriptionStatus;
  /** Actor classes permitted to trigger the transition per §15. */
  actorTypes: readonly SubscriptionActorType[];
  /** CDM §4.8 event_type recorded in subscription_events, or null when the
   *  §15 emission has no ratified enum value (SPEC GAP — audit-only trail;
   *  see migration 076 header + module README §Spec issues). */
  eventType: SubscriptionEventType | null;
  /** AUDIT_EVENTS category per §15: "Switch approvals and SAFETY_HOLD events
   *  are Category A (safety-critical clinical); other transitions are
   *  Category C (operational)." */
  auditCategory: 'A' | 'C';
}

/**
 * The §15 transition table. `tenant_operator` is accepted alongside
 * `patient` on the patient-sovereign transitions per OpenAPI v0.2
 * §20.3-20.6 ("subscription owner; or tenant operator").
 */
export const TRANSITION_TABLE: Readonly<Record<SubscriptionTransition, TransitionSpec>> = {
  clinician_approval: {
    from: 'DRAFT',
    to: 'ACTIVE',
    actorTypes: ['clinician'],
    eventType: 'activated',
    auditCategory: 'C',
  },
  clinician_decline: {
    from: 'DRAFT',
    to: 'DECLINED',
    actorTypes: ['clinician'],
    eventType: 'declined',
    auditCategory: 'C',
  },
  period_end: {
    from: 'ACTIVE',
    to: 'FULFILLING',
    actorTypes: ['system'],
    // §15 side effect is `refill.initiated` (Refill machine event); CDM §4.8
    // has no subscription event_type for period_end — audit-only (SPEC GAP).
    eventType: null,
    auditCategory: 'C',
  },
  pause_request: {
    from: 'ACTIVE',
    to: 'PAUSED',
    actorTypes: ['patient', 'tenant_operator'],
    eventType: 'paused',
    auditCategory: 'C',
  },
  switch_request: {
    from: 'ACTIVE',
    to: 'SWITCHING',
    actorTypes: ['patient', 'tenant_operator'],
    eventType: 'switching_initiated',
    auditCategory: 'C',
  },
  cancel_request: {
    from: 'ACTIVE',
    to: 'CANCELLATION_PENDING',
    actorTypes: ['patient', 'tenant_operator'],
    eventType: 'cancellation_pending',
    auditCategory: 'C',
  },
  safety_signal_critical: {
    from: 'ACTIVE',
    to: 'SAFETY_HOLD',
    actorTypes: ['system'],
    eventType: 'safety_hold',
    auditCategory: 'A',
  },
  payment_failed_terminal: {
    from: 'ACTIVE',
    to: 'PAYMENT_FAILED_TERMINAL',
    actorTypes: ['system'],
    eventType: 'terminated_payment_failure',
    auditCategory: 'C',
  },
  complete: {
    from: 'FULFILLING',
    to: 'ACTIVE',
    actorTypes: ['system'],
    // §15 emission `subscription.fulfilled` has no CDM §4.8 enum value —
    // audit-only (SPEC GAP).
    eventType: null,
    auditCategory: 'C',
  },
  resume: {
    from: 'PAUSED',
    to: 'ACTIVE',
    // Patient resumes early OR system auto-resumes at pause_until (§15).
    actorTypes: ['patient', 'tenant_operator', 'system'],
    eventType: 'resumed',
    auditCategory: 'C',
  },
  pause_expires: {
    from: 'PAUSED',
    to: 'CANCELLED',
    actorTypes: ['system'],
    eventType: 'cancelled',
    auditCategory: 'C',
  },
  switch_approve: {
    from: 'SWITCHING',
    to: 'ACTIVE',
    actorTypes: ['clinician'],
    eventType: 'switched',
    auditCategory: 'A', // switch approval is Category A per §15
  },
  switch_decline: {
    from: 'SWITCHING',
    to: 'ACTIVE',
    actorTypes: ['clinician'],
    // §15 emission `subscription.switch_declined` has no CDM §4.8 enum
    // value — audit-only (SPEC GAP).
    eventType: null,
    auditCategory: 'C',
  },
  end_period: {
    from: 'CANCELLATION_PENDING',
    to: 'CANCELLED',
    actorTypes: ['system'],
    eventType: 'cancelled',
    auditCategory: 'C',
  },
  clinician_release: {
    from: 'SAFETY_HOLD',
    to: 'ACTIVE',
    actorTypes: ['clinician'], // clinician-ONLY per §15 I-001 floor
    eventType: 'released_from_safety_hold',
    auditCategory: 'A',
  },
  clinician_terminate: {
    from: 'SAFETY_HOLD',
    to: 'CANCELLED',
    actorTypes: ['clinician'],
    // §15 emission `subscription.terminated_clinical` has no CDM §4.8 enum
    // value — audit-only (SPEC GAP). SAFETY_HOLD family stays Category A.
    eventType: null,
    auditCategory: 'A',
  },
};

/** Terminal states per §15 (no outbound transitions). */
export const TERMINAL_STATUSES: readonly SubscriptionStatus[] = [
  'CANCELLED',
  'DECLINED',
  'PAYMENT_FAILED_TERMINAL',
];

// ---------------------------------------------------------------------------
// Guard helpers
// ---------------------------------------------------------------------------

/** Maximum pause window per CDM §4.7 / §15 (tenant-configurable DOWN only). */
export const MAX_PAUSE_DAYS = 90;

export interface TransitionCheck {
  ok: boolean;
  /** Machine-readable rejection reason when !ok. */
  reason?: 'unknown_transition' | 'invalid_from_state' | 'actor_not_permitted';
  spec?: TransitionSpec;
}

/**
 * Pure guard: is `transition` valid from `currentStatus` for `actorType`?
 * The durable layer re-checks the from-state in the UPDATE's WHERE clause;
 * this helper exists for friendly 409/403 mapping BEFORE touching the row
 * and for exhaustive unit coverage of the §15 table.
 */
export function checkTransition(
  transition: SubscriptionTransition,
  currentStatus: SubscriptionStatus,
  actorType: SubscriptionActorType,
): TransitionCheck {
  const spec = TRANSITION_TABLE[transition] as TransitionSpec | undefined;
  if (spec === undefined) {
    return { ok: false, reason: 'unknown_transition' };
  }
  if (spec.from !== currentStatus) {
    return { ok: false, reason: 'invalid_from_state', spec };
  }
  if (!spec.actorTypes.includes(actorType)) {
    return { ok: false, reason: 'actor_not_permitted', spec };
  }
  return { ok: true, spec };
}

/**
 * Pause-window guard (OpenAPI §20.3: 400 INVALID_PAUSE_DURATION when
 * pause_until is more than 90 days out, in the past, or unparseable).
 */
export function isValidPauseWindow(pausedAt: Date, pauseUntil: Date): boolean {
  if (pauseUntil.getTime() <= pausedAt.getTime()) return false;
  const maxUntil = pausedAt.getTime() + MAX_PAUSE_DAYS * 24 * 60 * 60 * 1000;
  return pauseUntil.getTime() <= maxUntil;
}

/**
 * Renewal scheduling per cadence (§15 "schedule next_renewal_at"; PRD v2.1
 * §8.1 cadence semantics). Expressed as a Postgres interval literal so the
 * durable layer computes NOW() + interval server-side (single time
 * authority).
 */
export function cadenceInterval(cadence: 'monthly' | 'quarterly' | 'biannual'): string {
  switch (cadence) {
    case 'monthly':
      return '1 month';
    case 'quarterly':
      return '3 months';
    case 'biannual':
      return '6 months';
  }
}
