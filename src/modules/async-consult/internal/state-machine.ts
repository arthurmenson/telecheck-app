/**
 * state-machine.ts — Async Consult state machine transition logic.
 *
 * Sprint 9 / TLC-021c. Implements 7 of 23 transitions from State Machines
 * v1.1 §3 (`Telecheck_State_Machines_v1_1.md:194-218`):
 *
 *   1. INITIATED       → start_intake     → INTAKE
 *   2. INTAKE          → submit           → SUBMITTED
 *   3. INTAKE          → abandon          → ABANDONED
 *   4. ABANDONED       → resume           → INTAKE
 *   5. ABANDONED       → expire           → EXPIRED
 *   6. SUBMITTED       → process          → PROCESSING
 *   16. AWAITING_DATA  → patient_responds → UNDER_REVIEW
 *
 * The remaining 16 transitions (clinician decision branches: 7-15;
 * AWAITING_DATA timeout: 17; terminal/follow-up: 18-23) land in
 * Sprint 10. This module explicitly throws `UnsupportedTransitionError`
 * for any deferred transition — silent acceptance would defeat the
 * type safety and let pre-Sprint-10 code paths advance consults
 * through unimplemented transitions.
 *
 * This module is the authoritative source of transition validity.
 * Service layer (Sprint 9 TLC-021d) calls `validateTransition()`
 * before issuing the repo's `updateConsultState()` UPDATE — so the
 * state machine catches invalid transitions BEFORE the optimistic-
 * concurrency UPDATE attempts to match a from_state.
 *
 * Spec references:
 *   - State Machines v1.1 §3 (canonical 17-state inventory; 23-transition
 *     table at L196-218)
 *   - Async Consult Slice PRD v1.0 §12 (PRD's slice-side view; State
 *     Machines wins on conflict per CLAUDE.md hard rule)
 *   - SI-005 (Consult schema gap; placeholder posture for v0.1)
 */

import type { ConsultState } from './types.js';

// ---------------------------------------------------------------------------
// Event vocabulary (canonical from State Machines v1.1 §3 transition table)
// ---------------------------------------------------------------------------

/**
 * The 7 events Sprint 9 implements. Each maps 1-to-1 with a transition
 * from State Machines §3. Sprint 10 adds the remaining events
 * (claim, prescribe, advise, request_data, order_labs, escalate_sync,
 * decline, refer, timeout, enter_follow_up, follow_up_complete,
 * sync_booked).
 */
export const SUPPORTED_TRANSITION_EVENTS = [
  'start_intake', // INITIATED → INTAKE
  'submit', // INTAKE → SUBMITTED
  'abandon', // INTAKE → ABANDONED
  'resume', // ABANDONED → INTAKE
  'expire', // ABANDONED → EXPIRED
  'process', // SUBMITTED → PROCESSING
  'patient_responds', // AWAITING_DATA → UNDER_REVIEW
] as const;

export type SupportedTransitionEvent = (typeof SUPPORTED_TRANSITION_EVENTS)[number];

/**
 * Events deferred to Sprint 10. Listed explicitly so the type system
 * can distinguish "Sprint 9 deferred" from "not a valid event at all".
 *
 * `validateTransition()` throws `UnsupportedTransitionError` (not
 * `InvalidTransitionError`) for these — the distinction lets callers
 * surface an operator-actionable error message ("this feature is in
 * Sprint 10; please retry after release") rather than treat it as a
 * data-integrity violation.
 */
export const SPRINT_10_DEFERRED_EVENTS = [
  'claim', // QUEUED → UNDER_REVIEW (transition 8)
  'prescribe', // UNDER_REVIEW → PRESCRIBED (transition 9)
  'advise', // UNDER_REVIEW → ADVISED (transition 10)
  'request_data', // UNDER_REVIEW → AWAITING_DATA (transition 11)
  'order_labs', // UNDER_REVIEW → ADVISED (transition 12)
  'escalate_sync', // UNDER_REVIEW → ESCALATED_TO_SYNC (transition 13)
  'decline', // UNDER_REVIEW → DECLINED (transition 14)
  'refer', // UNDER_REVIEW → REFERRED (transition 15)
  'timeout', // AWAITING_DATA → CLOSED (transition 17)
  'enter_follow_up', // PRESCRIBED → FOLLOW_UP / ADVISED → FOLLOW_UP (transitions 18-19)
  'follow_up_complete', // FOLLOW_UP → COMPLETED (transition 20)
  'sync_booked', // ESCALATED_TO_SYNC → ... (transition 23)
  // ai_complete (transition 7, PROCESSING → QUEUED) is also deferred —
  // it's emitted by the AI service which doesn't exist yet.
  'ai_complete',
] as const;

export type Sprint10DeferredEvent = (typeof SPRINT_10_DEFERRED_EVENTS)[number];

export type ConsultTransitionEvent = SupportedTransitionEvent | Sprint10DeferredEvent;

// ---------------------------------------------------------------------------
// Transition table (Sprint 9 supported subset)
// ---------------------------------------------------------------------------

interface TransitionDef {
  from: ConsultState;
  event: SupportedTransitionEvent;
  to: ConsultState;
}

/**
 * The 7 transition rows Sprint 9 supports. Order matches State Machines
 * §3 transition table at L196-218.
 *
 * NOT exported — `validateTransition()` is the public API. The table
 * itself is opaque so future column additions (guards, actions) don't
 * leak through the public interface.
 */
const SUPPORTED_TRANSITIONS: readonly TransitionDef[] = [
  { from: 'INITIATED', event: 'start_intake', to: 'INTAKE' }, // §3 row 1
  { from: 'INTAKE', event: 'submit', to: 'SUBMITTED' }, // §3 row 2
  { from: 'INTAKE', event: 'abandon', to: 'ABANDONED' }, // §3 row 3
  { from: 'ABANDONED', event: 'resume', to: 'INTAKE' }, // §3 row 4
  { from: 'ABANDONED', event: 'expire', to: 'EXPIRED' }, // §3 row 5
  { from: 'SUBMITTED', event: 'process', to: 'PROCESSING' }, // §3 row 6
  { from: 'AWAITING_DATA', event: 'patient_responds', to: 'UNDER_REVIEW' }, // §3 row 16
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a transition is not valid for the consult's current state.
 * E.g., trying to `submit` from PROCESSING (only valid from INTAKE) is
 * an InvalidTransitionError — this is a data-integrity violation that
 * should surface to the caller as a 409 Conflict / 400 Bad Request.
 */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ConsultState,
    public readonly event: SupportedTransitionEvent,
  ) {
    super(`Invalid transition: cannot ${event} from state ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Thrown when the requested transition is recognized but deferred to
 * Sprint 10. Distinct from InvalidTransitionError so the handler layer
 * can surface a different error message ("feature pending Sprint 10
 * release") rather than a generic state-mismatch error.
 *
 * Sprint 10 will implement these transitions and remove them from the
 * SPRINT_10_DEFERRED_EVENTS list — at which point callers attempting
 * these events get the real transition logic (or InvalidTransitionError
 * if the from-state doesn't match).
 */
export class UnsupportedTransitionError extends Error {
  constructor(public readonly event: Sprint10DeferredEvent) {
    super(`Transition event '${event}' is deferred to Sprint 10`);
    this.name = 'UnsupportedTransitionError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Type guard for the supported event set. Useful when an event arrives
 * as a generic string from a queue / external caller.
 */
export function isSupportedEvent(event: string): event is SupportedTransitionEvent {
  return (SUPPORTED_TRANSITION_EVENTS as readonly string[]).includes(event);
}

/**
 * Type guard for the Sprint 10 deferred event set.
 */
export function isSprint10DeferredEvent(event: string): event is Sprint10DeferredEvent {
  return (SPRINT_10_DEFERRED_EVENTS as readonly string[]).includes(event);
}

/**
 * Validate a transition request. Returns the destination state on
 * success; throws on failure.
 *
 * Throws:
 *   - `InvalidTransitionError` if the event is supported but the
 *     from-state doesn't permit it (e.g., `submit` from PROCESSING).
 *   - `UnsupportedTransitionError` if the event is recognized but
 *     deferred to Sprint 10.
 *   - `Error` (generic) if the event is not recognized at all.
 *
 * The service layer (TLC-021d) calls this BEFORE issuing the repo's
 * `updateConsultState()` UPDATE. The repo's optimistic-concurrency
 * `WHERE state = $expected_from` is a separate defense layer that
 * catches concurrent transitions; this function catches "wrong event
 * for this state" before it reaches the DB at all.
 */
export function validateTransition(
  from: ConsultState,
  event: ConsultTransitionEvent,
): ConsultState {
  // Reject deferred events first — distinct error class
  if (isSprint10DeferredEvent(event)) {
    throw new UnsupportedTransitionError(event);
  }

  if (!isSupportedEvent(event)) {
    // Belt-and-suspenders: TypeScript should prevent this at compile
    // time via the ConsultTransitionEvent union, but a runtime caller
    // (queue consumer, external API) might supply an unrecognized
    // string. Don't silently accept.
    throw new Error(`Unrecognized transition event: '${event as string}'`);
  }

  // Look up the transition in the supported table
  const transition = SUPPORTED_TRANSITIONS.find(
    (t) => t.from === from && t.event === event,
  );
  if (transition === undefined) {
    throw new InvalidTransitionError(from, event);
  }

  return transition.to;
}

/**
 * List the events permitted from a given state (for UI / API hint
 * surfaces — "what can the operator do from here?"). Returns only
 * SUPPORTED events; deferred events do NOT appear in the list at v0.1
 * because they cannot be invoked.
 */
export function permittedEventsFrom(from: ConsultState): SupportedTransitionEvent[] {
  return SUPPORTED_TRANSITIONS.filter((t) => t.from === from).map((t) => t.event);
}
