/**
 * pharmacy/internal/state-machine.ts — MedicationRequest state machine
 * transition logic per State Machines v1.1 §19 DRAFT (SI-001 closure
 * artifact).
 *
 * DRAFT pre-SI-001-ratification. Mirrors the structure of
 * src/modules/async-consult/internal/state-machine.ts exactly: typed
 * transition table + validateTransition() + per-event guard contexts.
 *
 * Transition inventory (§19 DRAFT):
 *
 *   draft                       --[submit_for_review]----------> pending_interaction_check
 *   pending_interaction_check   --[engine_clean]---------------> pending_clinician_review
 *   pending_interaction_check   --[engine_safety_hold]---------> pending_clinician_review
 *                                                                  (sets interaction_signals_status='safety_hold')
 *   pending_clinician_review    --[clinician_approve]----------> active  [I-012-gated]
 *   pending_clinician_review    --[clinician_decline]----------> rejected (terminal)
 *   pending_clinician_review    --[clinician_modify]-----------> pending_interaction_check
 *   pending_interaction_check   --[protocol_authorized_prescribing]--> active  [I-012-gated]
 *                                                                  (Mode 2 protocol agent path)
 *   active                      --[clinician_discontinue]------> discontinued
 *   active                      --[patient_request_discontinue]-> discontinued
 *   active                      --[adverse_event_discontinue]--> discontinued
 *   active                      --[expire_at_window_end]-------> expired (terminal)
 *   active                      --[supersede_by_new_prescription]--> superseded (terminal)
 *
 * Terminal states: discontinued, superseded, expired, rejected.
 *
 * I-012 reject-unless three-clause rule applies to the two transitions
 * marked [I-012-gated] above. The guard context for those events MUST
 * carry the envelope (autonomy_level == action_with_confirm, explicit
 * clinician confirmation, RBAC-authorized confirming actor). Bare
 * suppression on rejection is forbidden per I-003; the service layer
 * MUST emit `medication_request.execution_rejected` on rejection.
 *
 * Defense layers (mirror of async-consult per I-023/I-027 discipline):
 *   Layer 1: validateTransition() — guard context shape + transition validity
 *   Layer 2: optimistic-concurrency WHERE status = $expected_from in the repo
 *   Layer 3: DB CHECK constraint on `status` column (migration 023)
 *
 * Spec references:
 *   - State Machines v1.1 §19 DRAFT (per SI-001 DRAFT)
 *   - I-012 (prescribing reject-unless three-clause)
 *   - WORKLOAD_TAXONOMY v5.2 + AUTONOMY_LEVELS v5.2 (envelope fields)
 *   - src/lib/i012-gate.ts (the canonical I-012 gate enforcement helper
 *     when wired by the service layer)
 */

import type { MedicationRequestStatus } from './types.js';

// ---------------------------------------------------------------------------
// Event vocabulary — all §19 DRAFT transitions
// ---------------------------------------------------------------------------

export const SUPPORTED_TRANSITION_EVENTS = [
  'submit_for_review',
  'engine_clean',
  'engine_safety_hold',
  'clinician_approve',
  'clinician_decline',
  'clinician_modify',
  'protocol_authorized_prescribing',
  'clinician_discontinue',
  'patient_request_discontinue',
  'adverse_event_discontinue',
  'expire_at_window_end',
  'supersede_by_new_prescription',
] as const;

export type SupportedTransitionEvent = (typeof SUPPORTED_TRANSITION_EVENTS)[number];

// ---------------------------------------------------------------------------
// Guard context — typed per event
// ---------------------------------------------------------------------------

/**
 * Empty guard context — transitions without runtime guards.
 */
export type EmptyGuardContext = Record<string, never>;

/**
 * I-012 three-clause envelope guard. Required for the prescribing-decision
 * transitions (`clinician_approve` and `protocol_authorized_prescribing`).
 *
 * The service layer constructs this context AFTER it has proven the
 * three clauses via the canonical i012-gate helper. The state machine
 * validates structural completeness; the gate helper validates semantic
 * truth.
 */
export interface I012EnvelopeGuardContext {
  /** Must equal `'action_with_confirm'` per I-012 closure rule (string equality). */
  autonomy_level: 'action_with_confirm';
  /** Confirming actor's account_id (RBAC-authorized; verified upstream). */
  confirming_actor_id: string;
  /** Must be true; the service layer toggles it true only after RBAC check passes. */
  confirming_actor_rbac_authorized: true;
  /** Confirmation timestamp; appears in the audit chain. */
  confirmation_timestamp: string;
}

/**
 * Discontinuation reason guard — `discontinued_reason` MUST be set on
 * any transition that lands on `status='discontinued'` (CHECK constraint
 * enforces parity).
 */
export interface DiscontinueGuardContext {
  discontinued_reason:
    | 'clinical_decision'
    | 'adverse_event'
    | 'patient_request'
    | 'replaced_by_new_prescription'
    | 'safety_hold';
}

/**
 * Discriminated union of guard contexts keyed by event.
 */
export type GuardContext =
  | { event: 'submit_for_review'; guard: EmptyGuardContext }
  | { event: 'engine_clean'; guard: EmptyGuardContext }
  | { event: 'engine_safety_hold'; guard: EmptyGuardContext }
  | { event: 'clinician_approve'; guard: I012EnvelopeGuardContext }
  | { event: 'clinician_decline'; guard: EmptyGuardContext }
  | { event: 'clinician_modify'; guard: EmptyGuardContext }
  | { event: 'protocol_authorized_prescribing'; guard: I012EnvelopeGuardContext }
  | { event: 'clinician_discontinue'; guard: DiscontinueGuardContext }
  | { event: 'patient_request_discontinue'; guard: DiscontinueGuardContext }
  | { event: 'adverse_event_discontinue'; guard: DiscontinueGuardContext }
  | { event: 'expire_at_window_end'; guard: EmptyGuardContext }
  | { event: 'supersede_by_new_prescription'; guard: EmptyGuardContext };

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

interface TransitionDef {
  from: MedicationRequestStatus;
  event: SupportedTransitionEvent;
  to: MedicationRequestStatus;
}

const SUPPORTED_TRANSITIONS: readonly TransitionDef[] = [
  { from: 'draft', event: 'submit_for_review', to: 'pending_interaction_check' },
  { from: 'pending_interaction_check', event: 'engine_clean', to: 'pending_clinician_review' },
  {
    from: 'pending_interaction_check',
    event: 'engine_safety_hold',
    to: 'pending_clinician_review',
  },
  // Mode 2 protocol agent: skips clinician_review when authorized; I-012-gated
  { from: 'pending_interaction_check', event: 'protocol_authorized_prescribing', to: 'active' },
  // Clinician decision branches from pending_clinician_review
  { from: 'pending_clinician_review', event: 'clinician_approve', to: 'active' }, // I-012-gated
  { from: 'pending_clinician_review', event: 'clinician_decline', to: 'rejected' },
  { from: 'pending_clinician_review', event: 'clinician_modify', to: 'pending_interaction_check' },
  // Lifecycle exits from active
  { from: 'active', event: 'clinician_discontinue', to: 'discontinued' },
  { from: 'active', event: 'patient_request_discontinue', to: 'discontinued' },
  { from: 'active', event: 'adverse_event_discontinue', to: 'discontinued' },
  { from: 'active', event: 'expire_at_window_end', to: 'expired' },
  { from: 'active', event: 'supersede_by_new_prescription', to: 'superseded' },
];

/**
 * Events that require the I-012 three-clause envelope guard. Service
 * layer uses this set to decide which transitions require the
 * canonical i012-gate helper.
 */
export const I012_GATED_EVENTS: ReadonlySet<SupportedTransitionEvent> = new Set([
  'clinician_approve',
  'protocol_authorized_prescribing',
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: MedicationRequestStatus,
    public readonly event: SupportedTransitionEvent,
  ) {
    super(`Invalid transition: cannot ${event} from status ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

export class GuardNotSatisfiedError extends Error {
  constructor(
    public readonly event: SupportedTransitionEvent,
    public readonly reason: string,
  ) {
    super(`Guard not satisfied for event '${event}': ${reason}`);
    this.name = 'GuardNotSatisfiedError';
  }
}

export class GuardContextEventMismatchError extends Error {
  constructor(
    public readonly requestedEvent: SupportedTransitionEvent,
    public readonly contextEvent: string,
  ) {
    super(
      `Guard context event mismatch: requested transition '${requestedEvent}' but ` +
        `context describes '${contextEvent}'. The state machine refuses to advance.`,
    );
    this.name = 'GuardContextEventMismatchError';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isSupportedEvent(event: string): event is SupportedTransitionEvent {
  return (SUPPORTED_TRANSITION_EVENTS as readonly string[]).includes(event);
}

export function isI012GatedEvent(event: SupportedTransitionEvent): boolean {
  return I012_GATED_EVENTS.has(event);
}

/**
 * Validate the runtime values of a guard context. Type system enforces
 * the shape; this function enforces boolean/string truth where needed
 * (e.g., autonomy_level === 'action_with_confirm', rbac_authorized true).
 */
function validateGuard(ctx: GuardContext): void {
  switch (ctx.event) {
    case 'clinician_approve':
    case 'protocol_authorized_prescribing': {
      // Layer-1 envelope-shape enforcement. The actual I-012 gate (audit
      // chain + RBAC + autonomy equality) is enforced by the service
      // layer via lib/i012-gate.ts; this layer is the state-machine
      // structural floor.
      const g = ctx.guard;
      if (g.autonomy_level !== 'action_with_confirm') {
        // TypeScript narrowing renders `g.autonomy_level` `never` after the
        // equality check above; cast for the template-literal error message.
        const observed = g.autonomy_level as unknown as string;
        throw new GuardNotSatisfiedError(
          ctx.event,
          `autonomy_level must equal 'action_with_confirm' per I-012 closure rule; got '${observed}'`,
        );
      }
      if (g.confirming_actor_rbac_authorized !== true) {
        throw new GuardNotSatisfiedError(
          ctx.event,
          'confirming_actor_rbac_authorized must be true (set by service layer after RBAC check)',
        );
      }
      if (typeof g.confirming_actor_id !== 'string' || g.confirming_actor_id.length === 0) {
        throw new GuardNotSatisfiedError(
          ctx.event,
          'confirming_actor_id must be a non-empty string',
        );
      }
      if (typeof g.confirmation_timestamp !== 'string' || g.confirmation_timestamp.length === 0) {
        throw new GuardNotSatisfiedError(
          ctx.event,
          'confirmation_timestamp must be a non-empty ISO-8601 string',
        );
      }
      return;
    }
    case 'clinician_discontinue':
    case 'patient_request_discontinue':
    case 'adverse_event_discontinue': {
      // Discontinued reason parity per migration 023 CHECK constraint
      const allowed = new Set([
        'clinical_decision',
        'adverse_event',
        'patient_request',
        'replaced_by_new_prescription',
        'safety_hold',
      ]);
      if (!allowed.has(ctx.guard.discontinued_reason)) {
        throw new GuardNotSatisfiedError(
          ctx.event,
          `discontinued_reason '${ctx.guard.discontinued_reason}' is not in the permitted set`,
        );
      }
      return;
    }
    default:
      // Empty guard context — nothing to validate
      return;
  }
}

/**
 * Validate a transition request with guard context. Returns the
 * destination status on success; throws on failure.
 *
 * The `event` parameter is REQUIRED and must equal `ctx.event`.
 * Without the separate `event` param, a runtime caller could supply a
 * context for the wrong event (bypassing guards).
 *
 * Throws:
 *   - `Error` if the requested event is not recognized at all
 *   - `GuardContextEventMismatchError` if `event !== ctx.event`
 *   - `InvalidTransitionError` if the from-status doesn't permit the event
 *   - `GuardNotSatisfiedError` if the guard context's runtime values
 *     don't satisfy the §19 DRAFT guard
 */
export function validateTransition(
  from: MedicationRequestStatus,
  event: SupportedTransitionEvent,
  ctx: GuardContext,
): MedicationRequestStatus {
  if (!isSupportedEvent(event)) {
    throw new Error(`Unrecognized transition event: '${String(event)}'`);
  }
  if (event !== ctx.event) {
    throw new GuardContextEventMismatchError(event, ctx.event);
  }
  const transition = SUPPORTED_TRANSITIONS.find((t) => t.from === from && t.event === event);
  if (transition === undefined) {
    throw new InvalidTransitionError(from, event);
  }
  validateGuard(ctx);
  return transition.to;
}

/**
 * List the events permitted from a given status — for API hint surfaces.
 */
export function permittedEventsFrom(from: MedicationRequestStatus): SupportedTransitionEvent[] {
  return SUPPORTED_TRANSITIONS.filter((t) => t.from === from).map((t) => t.event);
}
