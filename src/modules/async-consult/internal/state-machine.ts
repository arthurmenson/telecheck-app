/**
 * state-machine.ts — Async Consult state machine transition logic.
 *
 * Sprint 9 / TLC-021c. Implements 7 of 23 transitions from State Machines
 * v1.1 §3 (`Telecheck_State_Machines_v1_1.md:194-218`):
 *
 *   1. INITIATED       → start_intake     → INTAKE
 *      Guard: payment_confirmed
 *   2. INTAKE          → submit           → SUBMITTED
 *      Guard: form_complete + active_consent
 *   3. INTAKE          → abandon          → ABANDONED
 *      Guard: 48h no activity (caller proves via hours_since_activity)
 *   4. ABANDONED       → resume           → INTAKE
 *      Guard: (none — patient action)
 *   5. ABANDONED       → expire           → EXPIRED
 *      Guard: 14d no activity (caller proves via days_since_abandoned)
 *   6. SUBMITTED       → process          → PROCESSING
 *      Guard: (none)
 *   16. AWAITING_DATA  → patient_responds → UNDER_REVIEW
 *      Guard: (none — patient action)
 *
 * The remaining 16 transitions (clinician decision branches: 7-15;
 * AWAITING_DATA timeout: 17; terminal/follow-up: 18-23) land in
 * Sprint 10. This module explicitly throws `UnsupportedTransitionError`
 * for any deferred transition.
 *
 * GUARD ENFORCEMENT (Codex async-consult-r7 HIGH closure 2026-05-05):
 * Transitions with guards REQUIRE typed guard context. validateTransition()
 * cannot return a destination state without the caller proving guard
 * satisfaction via the typed context. The service layer (Sprint 9 TLC-021d)
 * is responsible for actually checking guard conditions (verifying form
 * completeness, fetching active consent, computing time deltas) BEFORE
 * constructing the guard context — the state machine validates the shape,
 * not the satisfaction.
 *
 * Defense layers (per I-023 / I-027 discipline):
 *   Layer 1: validateTransition() — guard context shape + transition
 *            validity (this module)
 *   Layer 2: optimistic-concurrency WHERE state = $expected_from
 *            (consult-repo.ts updateConsultState)
 *   Layer 3: DB CHECK constraint on state column (migration 020 inline)
 *
 * Spec references:
 *   - State Machines v1.1 §3 (canonical 17-state inventory; 23-transition
 *     table with explicit guard column at L196-218)
 *   - Async Consult Slice PRD v1.0 §12 (PRD's slice-side view; State
 *     Machines wins on conflict per CLAUDE.md hard rule)
 *   - SI-005 (Consult schema gap; placeholder posture for v0.1)
 */

import type { ConsultState } from './types.js';

// ---------------------------------------------------------------------------
// Event vocabulary
// ---------------------------------------------------------------------------

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

export const SPRINT_10_DEFERRED_EVENTS = [
  'ai_complete',
  'claim',
  'prescribe',
  'advise',
  'request_data',
  'order_labs',
  'escalate_sync',
  'decline',
  'refer',
  'timeout',
  'enter_follow_up',
  'follow_up_complete',
  'sync_booked',
] as const;

export type Sprint10DeferredEvent = (typeof SPRINT_10_DEFERRED_EVENTS)[number];

export type ConsultTransitionEvent = SupportedTransitionEvent | Sprint10DeferredEvent;

// ---------------------------------------------------------------------------
// Guard context — typed per event (Codex async-consult-r7 HIGH closure)
// ---------------------------------------------------------------------------

/**
 * Per-event guard context. The caller MUST construct the guard context
 * for guarded events; the state machine cannot return a destination
 * without it. This forces the caller to acknowledge each guard
 * requirement at the type level.
 *
 * The state machine validates SHAPE (does the caller supply the
 * required field?) and TRUTH OF BOOLEAN GUARDS (is `payment_confirmed:
 * true` actually true?). The state machine does NOT verify guard
 * SATISFACTION (e.g., it doesn't query the payment service to check
 * the boolean is grounded in reality). That's the service layer's job
 * (TLC-021d) — by the time the service layer constructs the guard
 * context with `payment_confirmed: true`, it has already proven via
 * the payment service that the guard is satisfied.
 */
export interface StartIntakeGuardContext {
  /** Caller proves payment was confirmed before this transition. */
  payment_confirmed: true;
}

export interface SubmitGuardContext {
  /** Caller proves the intake form is complete (all required fields filled). */
  form_complete: true;
  /** Caller proves the patient has an active consent for the consult-type. */
  active_consent: true;
}

export interface AbandonGuardContext {
  /** Caller proves at least 48 hours have elapsed since last activity. */
  hours_since_activity: number;
}

export interface ExpireGuardContext {
  /** Caller proves at least 14 days have elapsed since the consult entered ABANDONED. */
  days_since_abandoned: number;
}

/** Resume / process / patient_responds have no guards — empty context. */
export type EmptyGuardContext = Record<string, never>;

/**
 * Discriminated union of guard contexts keyed by event. Use the
 * `for-event` helper types below for type-safe construction.
 */
export type GuardContext =
  | { event: 'start_intake'; guard: StartIntakeGuardContext }
  | { event: 'submit'; guard: SubmitGuardContext }
  | { event: 'abandon'; guard: AbandonGuardContext }
  | { event: 'resume'; guard: EmptyGuardContext }
  | { event: 'expire'; guard: ExpireGuardContext }
  | { event: 'process'; guard: EmptyGuardContext }
  | { event: 'patient_responds'; guard: EmptyGuardContext };

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

interface TransitionDef {
  from: ConsultState;
  event: SupportedTransitionEvent;
  to: ConsultState;
}

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

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: ConsultState,
    public readonly event: SupportedTransitionEvent,
  ) {
    super(`Invalid transition: cannot ${event} from state ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

export class UnsupportedTransitionError extends Error {
  constructor(public readonly event: Sprint10DeferredEvent) {
    super(`Transition event '${event}' is deferred to Sprint 10`);
    this.name = 'UnsupportedTransitionError';
  }
}

/**
 * Thrown when the guard context is structurally invalid for the event.
 * E.g., supplying `submit` with `form_complete: false` or supplying
 * `abandon` with `hours_since_activity: 30`.
 *
 * This is a programmer-error class — the service layer should never
 * pass an unsatisfied guard. If thrown, surface as a 500 internal
 * error (the bug is in the service layer, not in client input).
 */
export class GuardNotSatisfiedError extends Error {
  constructor(
    public readonly event: SupportedTransitionEvent,
    public readonly reason: string,
  ) {
    super(`Guard not satisfied for event '${event}': ${reason}`);
    this.name = 'GuardNotSatisfiedError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isSupportedEvent(event: string): event is SupportedTransitionEvent {
  return (SUPPORTED_TRANSITION_EVENTS as readonly string[]).includes(event);
}

export function isSprint10DeferredEvent(event: string): event is Sprint10DeferredEvent {
  return (SPRINT_10_DEFERRED_EVENTS as readonly string[]).includes(event);
}

/**
 * Validate a guard context's runtime values against the documented
 * State Machines §3 guard semantics. Returns void on success; throws
 * GuardNotSatisfiedError on failure. The TYPE system enforces the
 * shape (caller cannot construct an invalid context); this function
 * enforces the BOOLEAN/NUMERIC truth (e.g., `hours_since_activity >= 48`).
 */
function validateGuard(ctx: GuardContext): void {
  switch (ctx.event) {
    case 'start_intake':
      // Type system already enforces payment_confirmed: true
      if (!ctx.guard.payment_confirmed) {
        throw new GuardNotSatisfiedError('start_intake', 'payment_confirmed must be true');
      }
      return;
    case 'submit':
      if (!ctx.guard.form_complete) {
        throw new GuardNotSatisfiedError('submit', 'form_complete must be true');
      }
      if (!ctx.guard.active_consent) {
        throw new GuardNotSatisfiedError('submit', 'active_consent must be true');
      }
      return;
    case 'abandon':
      if (ctx.guard.hours_since_activity < 48) {
        throw new GuardNotSatisfiedError(
          'abandon',
          `hours_since_activity (${ctx.guard.hours_since_activity}) must be >= 48 per State Machines §3 row 3`,
        );
      }
      return;
    case 'expire':
      if (ctx.guard.days_since_abandoned < 14) {
        throw new GuardNotSatisfiedError(
          'expire',
          `days_since_abandoned (${ctx.guard.days_since_abandoned}) must be >= 14 per State Machines §3 row 5`,
        );
      }
      return;
    case 'resume':
    case 'process':
    case 'patient_responds':
      // Empty guard context — nothing to validate at the runtime layer
      return;
  }
}

/**
 * Thrown when the guard context's `event` field does not match the
 * caller's separately-requested event. Codex async-consult-r8 HIGH
 * closure 2026-05-05: prevents a runtime caller (queue consumer,
 * external API path) from supplying a context for the wrong event
 * (e.g., requesting 'submit' but supplying an 'abandon' context to
 * skip submit's form_complete + active_consent guards).
 */
export class GuardContextEventMismatchError extends Error {
  constructor(
    public readonly requestedEvent: SupportedTransitionEvent,
    public readonly contextEvent: string,
  ) {
    super(
      `Guard context event mismatch: requested transition '${requestedEvent}' but ` +
        `context describes '${contextEvent}'. The state machine refuses to advance — ` +
        `caller MUST pass a context whose .event matches the requested event.`,
    );
    this.name = 'GuardContextEventMismatchError';
  }
}

/**
 * Validate a transition request with guard context. Returns the
 * destination state on success; throws on failure.
 *
 * The `event` parameter is REQUIRED and must equal `ctx.event` —
 * Codex async-consult-r8 HIGH closure 2026-05-05. Without the
 * separate `event` param, a runtime caller could supply a context
 * for the wrong event (e.g., requesting 'submit' but supplying an
 * 'abandon' context with hours_since_activity, bypassing 'submit's
 * form_complete + active_consent guards). The dual parameter forces
 * the caller to commit to an event explicitly, and the runtime
 * assertion catches event/context mismatches before transition
 * lookup or guard validation.
 *
 * Throws:
 *   - `Error` if the requested event is not recognized at all
 *     (programmer error / corrupt input)
 *   - `UnsupportedTransitionError` if the event is recognized but
 *     deferred to Sprint 10
 *   - `GuardContextEventMismatchError` if `event !== ctx.event`
 *   - `InvalidTransitionError` if the from-state doesn't permit the event
 *   - `GuardNotSatisfiedError` if the guard context's runtime values
 *     don't satisfy the documented State Machines §3 guard
 *
 * Defense-in-depth posture for guard enforcement (4 layers):
 *   Layer 1: Compile-time TypeScript discriminated union — the caller
 *            cannot construct a context with missing guard fields
 *            for typed call sites
 *   Layer 2: Runtime event/context match assertion (this fix)
 *   Layer 3: Runtime guard value validation (validateGuard())
 *   Layer 4: Optimistic-concurrency UPDATE in repo (consult-repo.ts)
 */
export function validateTransition(
  from: ConsultState,
  event: SupportedTransitionEvent,
  ctx: GuardContext,
): ConsultState {
  // Layer A: validate the requested event is recognized + supported
  if (isSprint10DeferredEvent(event)) {
    throw new UnsupportedTransitionError(event);
  }
  if (!isSupportedEvent(event)) {
    // Compile-time the SupportedTransitionEvent type prevents this;
    // runtime catches downcast / external caller paths.
    throw new Error(`Unrecognized transition event: '${String(event)}'`);
  }

  // Layer B: ENFORCE event/context match (Codex async-consult-r8 HIGH).
  // Compile-time the discriminated union steers callers toward
  // matching event + ctx.event, but a runtime caller (queue consumer,
  // external API decoding untyped JSON) might supply a mismatched pair.
  // Refuse to proceed; surface as a programmer-error class.
  if (event !== ctx.event) {
    throw new GuardContextEventMismatchError(event, ctx.event);
  }

  // Layer C: look up the transition in the supported table
  const transition = SUPPORTED_TRANSITIONS.find(
    (t) => t.from === from && t.event === event,
  );
  if (transition === undefined) {
    throw new InvalidTransitionError(from, event);
  }

  // Layer D: validate the guard's runtime values (boolean/numeric
  // truth checks beyond the type-system shape enforcement)
  validateGuard(ctx);

  return transition.to;
}

/**
 * Reject a deferred (Sprint 10) event with the canonical error class.
 * Service layer can call this when receiving an event that's NOT in
 * SUPPORTED_TRANSITION_EVENTS to surface a clear "Sprint 10 deferred"
 * message rather than a generic state-mismatch error.
 */
export function rejectDeferredEvent(event: Sprint10DeferredEvent): never {
  throw new UnsupportedTransitionError(event);
}

/**
 * List the events permitted from a given state (for UI / API hint
 * surfaces). Returns only SUPPORTED events; deferred events do NOT
 * appear because they cannot be invoked.
 */
export function permittedEventsFrom(from: ConsultState): SupportedTransitionEvent[] {
  return SUPPORTED_TRANSITIONS.filter((t) => t.from === from).map((t) => t.event);
}
