/**
 * state-machine.ts — MedicationRequest state machine transition logic.
 *
 * Sprint 35 / TLC-055 (planned). Implements State Machines v1.2 §19
 * MedicationRequest lifecycle as ratified at P-011 / SI-001 closure
 * 2026-05-11 (spec corpus commit 879cd57). 8 active states + 13 transitions
 * + 2 I-012-gated routes into `active`.
 *
 * History: the original 2026-05-11 ratification scaffold (PR #95; commit
 * 06ba329) was reverted via PR #109 after Codex returned a
 * withdraw-ratification verdict with 5 findings. This rewrite incorporates
 * the corrections that landed in SI-001 v0.13 RATIFIED (20 Codex pre-
 * ratification findings closed inline; spec corpus commit 879cd57).
 *
 * CRITICAL CORRECTIONS FROM THE REVERTED PR #95 SCAFFOLD:
 *   1. `protocol_authorized_prescribing` routes from `pending_clinician_review`
 *      → `active` (the conservative I-012 posture — clinician sees engine
 *      output + invokes protocol auto-approval; never bypasses clinician
 *      review). The reverted scaffold had it from `pending_interaction_check`
 *      → `active`, which would have bypassed clinician review entirely.
 *   2. The I-012 rejection emits the canonical action ID
 *      `prescribing.execution_rejected` (NOT
 *      `medication_request.execution_rejected` — there is no such canonical
 *      action ID in AUDIT_EVENTS v5.3). The reverted scaffold used the
 *      non-canonical name, which drove Codex Finding 3 of the
 *      withdraw-ratification verdict.
 *   3. The `protocol_authorized_prescribing` route requires a distinct
 *      clinician confirmation event of the type
 *      `prescribing.protocol_authorization_granted` (added at AUDIT_EVENTS
 *      v5.3 under P-011) scoped to the same `action_id`. Reusing
 *      `prescribing.approved` as the protocol-route prerequisite would
 *      conflict with its role as the clinician-only route's terminal
 *      success audit.
 *   4. The protocol-authorized AI workload emission MUST use the canonical
 *      envelope: `actor_type='ai_workload'`, `actor_id=<protocol engine
 *      service account ULID>`, `ai_workload_type='protocol_execution'`,
 *      `autonomy_level='action_with_confirm'`. The legacy `protocol_engine`
 *      actor_type is permitted ONLY for pre-v1.10 backfill records per
 *      AUDIT_EVENTS v5.3 §I-012 closure rule (carries forward v5.2 line 66).
 *
 * I-012 RUNTIME ENFORCEMENT — failure on any of the three clauses (workload
 * + autonomy canonical AND confirming actor recorded AND RBAC-authorized)
 * at either of the two routes into `active` MUST emit
 * `prescribing.execution_rejected` (Category A audit; canonical I-012
 * rejection action) AND the transition is REJECTED. Bare suppression on
 * rejection is forbidden per I-003.
 *
 * Defense layers (per I-023 / I-027 discipline):
 *   Layer 1: validateTransition() — guard context shape + transition
 *            validity (this module)
 *   Layer 2: optimistic-concurrency WHERE status = $expected_from (the
 *            repository's updateStatus method — Sprint 35 follow-on)
 *   Layer 3: DB CHECK constraint on status column (migration 025 inline)
 *
 * Spec references:
 *   - State Machines v1.2 §19 MedicationRequest lifecycle
 *   - AUDIT_EVENTS v5.3 §I-012 closure rule + §I-012 preservation rule
 *   - WORKLOAD_TAXONOMY v5.2 §2.1/§2.2 (canonical workload values)
 *   - AUTONOMY_LEVELS v5.2 (action_with_confirm canonical I-012 level)
 *   - Promotion Ledger P-011 entry
 *   - ADR-029 (AI workload taxonomy)
 */

import type {
  MedicationRequestStatus,
  MedicationRequestDiscontinuedReason,
  AIWorkloadType,
  AutonomyLevel,
} from './types.js';

// ---------------------------------------------------------------------------
// Event vocabulary — mirrors State Machines v1.2 §19 transition triggers
// ---------------------------------------------------------------------------

/**
 * The canonical transition events for MedicationRequest per State Machines
 * v1.2 §19. There are 13 transitions in the §19 lifecycle.
 *
 * Two events terminate at `active` — the two I-012-gated prescribing-
 * execution routes:
 *   - `clinician_approve` (clinician-only path)
 *   - `protocol_authorized_prescribing` (Mode 2 protocol-engine path)
 * Both require I-012 three-clause-rule satisfaction; both emit
 * `medication_request.approved.v1` domain event with discriminating
 * `approval_pathway` field per DOMAIN_EVENTS v5.2 (amended in-place at
 * P-011 — reuses the existing canonical event for BOTH routes).
 */
export const TRANSITION_EVENTS = [
  // From draft
  'submit_for_review', // draft → pending_interaction_check

  // From pending_interaction_check (engine output)
  'engine_clean', // pending_interaction_check → pending_clinician_review
  'engine_safety_hold', // pending_interaction_check → pending_clinician_review (with safety_hold flag)

  // From pending_clinician_review (the two I-012-gated routes into active + decline + modify)
  'clinician_approve', // pending_clinician_review → active (clinician-only path; emits prescribing.approved)
  'protocol_authorized_prescribing', // pending_clinician_review → active (Mode 2 path; requires prior prescribing.protocol_authorization_granted; emits protocol_authorized_prescribing)
  'clinician_decline', // pending_clinician_review → rejected (terminal; emits prescribing.declined — NOT an I-012 rejection)
  'clinician_modify', // pending_clinician_review → pending_interaction_check (re-route, not refusal)

  // From active (discontinuation + supersession + expiry)
  'clinician_discontinue', // active → discontinued (with discontinued_reason)
  'patient_request_discontinue', // active → discontinued (discontinued_reason='patient_request')
  'adverse_event_discontinue', // active → discontinued (discontinued_reason='adverse_event')
  'expire_at_window_end', // active → expired (terminal; scheduled job)
  'supersede_by_new_prescription', // active → superseded (paired with new row in draft→active flow)
] as const;

export type TransitionEvent = (typeof TRANSITION_EVENTS)[number];

/**
 * The two prescribing-execution-route events that enter `active` and are
 * gated by the I-012 reject-unless three-clause rule per AUDIT_EVENTS v5.3
 * §I-012 preservation rule.
 */
export const I012_GATED_EVENTS = ['clinician_approve', 'protocol_authorized_prescribing'] as const;

export type I012GatedEvent = (typeof I012_GATED_EVENTS)[number];

export function isI012GatedEvent(event: TransitionEvent): event is I012GatedEvent {
  return (I012_GATED_EVENTS as readonly string[]).includes(event);
}

// ---------------------------------------------------------------------------
// Canonical AUDIT_EVENTS v5.3 action IDs (this module emits / references)
// ---------------------------------------------------------------------------

/**
 * Canonical AUDIT_EVENTS v5.3 Category A action IDs that this state machine
 * emits or references. Live emissions MUST resolve against AUDIT_EVENTS v5.3
 * or later per P-011 amendment (the `prescribing.protocol_authorization_granted`
 * action is added to the authoritative I-012 action-class set at v5.3).
 */
export const AUDIT_ACTIONS = {
  // I-012-gated success audits (one per route into `active`)
  PRESCRIBING_APPROVED: 'prescribing.approved', // clinician_approve route success
  PROTOCOL_AUTHORIZED_PRESCRIBING: 'protocol_authorized_prescribing', // protocol_authorized_prescribing route success

  // I-012 confirmation prerequisite for the protocol_authorized_prescribing route
  // (added at AUDIT_EVENTS v5.3 under P-011 — must be present in the immutable
  // audit chain scoped to the same `action_id` prior to the success event)
  PRESCRIBING_PROTOCOL_AUTHORIZATION_GRANTED: 'prescribing.protocol_authorization_granted',

  // I-012 rejection action — the CANONICAL action ID for prescribing
  // execution-rejection per AUDIT_EVENTS v5.3 §I-012 reject-unless rejection-
  // audit-event rule. Bare suppression of this audit is forbidden per I-003.
  // (NOT `medication_request.execution_rejected` — that is NOT a canonical
  // action ID; the reverted PR #95 scaffold's use of that name drove Codex
  // Finding 3 of the withdraw-ratification verdict.)
  PRESCRIBING_EXECUTION_REJECTED: 'prescribing.execution_rejected',

  // Other clinician decision events (not I-012-gated)
  PRESCRIBING_DECLINED: 'prescribing.declined', // clinician_decline (deliberate refusal, not an I-012 rejection)
  PRESCRIBING_MODIFIED: 'prescribing.modified', // clinician_modify (re-route, not refusal)

  // MedicationRequest lifecycle events (added at AUDIT_EVENTS v5.3 under P-011)
  MEDICATION_REQUEST_DRAFTED: 'medication_request.drafted',
  MEDICATION_REQUEST_SUBMITTED_FOR_REVIEW: 'medication_request.submitted_for_review',
  MEDICATION_REQUEST_INTERACTION_EVALUATION_COMPLETED: 'medication_request.interaction_evaluation_completed',
  MEDICATION_REQUEST_DISCONTINUED: 'medication_request.discontinued',
  MEDICATION_REQUEST_SUPERSEDED: 'medication_request.superseded',
  MEDICATION_REQUEST_EXPIRED: 'medication_request.expired',
} as const;

// ---------------------------------------------------------------------------
// Transition table — mirrors State Machines v1.2 §19 exactly
// ---------------------------------------------------------------------------

interface TransitionDef {
  from: MedicationRequestStatus;
  event: TransitionEvent;
  to: MedicationRequestStatus;
  /** Canonical AUDIT_EVENTS v5.3 action ID emitted on success */
  success_audit_action: string;
  /** True iff the transition is in the I-012 authoritative action-class set */
  i012_gated: boolean;
}

const TRANSITIONS: readonly TransitionDef[] = [
  // From draft
  {
    from: 'draft',
    event: 'submit_for_review',
    to: 'pending_interaction_check',
    success_audit_action: AUDIT_ACTIONS.MEDICATION_REQUEST_SUBMITTED_FOR_REVIEW,
    i012_gated: false,
  },

  // From pending_interaction_check (engine writeback)
  {
    from: 'pending_interaction_check',
    event: 'engine_clean',
    to: 'pending_clinician_review',
    success_audit_action: AUDIT_ACTIONS.MEDICATION_REQUEST_INTERACTION_EVALUATION_COMPLETED,
    i012_gated: false,
  },
  {
    from: 'pending_interaction_check',
    event: 'engine_safety_hold',
    to: 'pending_clinician_review',
    success_audit_action: AUDIT_ACTIONS.MEDICATION_REQUEST_INTERACTION_EVALUATION_COMPLETED,
    i012_gated: false,
  },

  // From pending_clinician_review — the two I-012-gated routes into `active`
  // PLUS clinician_decline and clinician_modify
  {
    from: 'pending_clinician_review',
    event: 'clinician_approve',
    to: 'active',
    success_audit_action: AUDIT_ACTIONS.PRESCRIBING_APPROVED,
    i012_gated: true,
  },
  {
    from: 'pending_clinician_review',
    event: 'protocol_authorized_prescribing',
    to: 'active',
    success_audit_action: AUDIT_ACTIONS.PROTOCOL_AUTHORIZED_PRESCRIBING,
    i012_gated: true,
  },
  {
    from: 'pending_clinician_review',
    event: 'clinician_decline',
    to: 'rejected',
    success_audit_action: AUDIT_ACTIONS.PRESCRIBING_DECLINED,
    i012_gated: false,
  },
  {
    from: 'pending_clinician_review',
    event: 'clinician_modify',
    to: 'pending_interaction_check',
    success_audit_action: AUDIT_ACTIONS.PRESCRIBING_MODIFIED,
    i012_gated: false,
  },

  // From active — discontinuation, expiry, supersession
  {
    from: 'active',
    event: 'clinician_discontinue',
    to: 'discontinued',
    success_audit_action: AUDIT_ACTIONS.MEDICATION_REQUEST_DISCONTINUED,
    i012_gated: false,
  },
  {
    from: 'active',
    event: 'patient_request_discontinue',
    to: 'discontinued',
    success_audit_action: AUDIT_ACTIONS.MEDICATION_REQUEST_DISCONTINUED,
    i012_gated: false,
  },
  {
    from: 'active',
    event: 'adverse_event_discontinue',
    to: 'discontinued',
    success_audit_action: AUDIT_ACTIONS.MEDICATION_REQUEST_DISCONTINUED,
    i012_gated: false,
  },
  {
    from: 'active',
    event: 'expire_at_window_end',
    to: 'expired',
    success_audit_action: AUDIT_ACTIONS.MEDICATION_REQUEST_EXPIRED,
    i012_gated: false,
  },
  {
    from: 'active',
    event: 'supersede_by_new_prescription',
    to: 'superseded',
    success_audit_action: AUDIT_ACTIONS.MEDICATION_REQUEST_SUPERSEDED,
    i012_gated: false,
  },
];

// ---------------------------------------------------------------------------
// I-012 reject-unless three-clause rule — applied to BOTH transitions into
// `active` per AUDIT_EVENTS v5.3 §I-012 preservation rule (carries forward
// v5.2 line 78 prose plus P-011 amendment)
// ---------------------------------------------------------------------------

/**
 * I-012 three-clause rule context. The caller MUST prove all three clauses
 * before the state machine permits a transition into `active`. Failure on
 * ANY clause MUST emit `prescribing.execution_rejected` (per
 * AUDIT_ACTIONS.PRESCRIBING_EXECUTION_REJECTED) and reject the transition;
 * bare suppression is forbidden per I-003.
 *
 * Three clauses per Master PRD v1.10 §13.7 (single normative source of
 * truth; AUDIT_EVENTS v5.3 + State Machines v1.2 + AUTONOMY_LEVELS v5.2
 * mirror exactly):
 *   1. `autonomy_level == 'action_with_confirm'` (string equality; not
 *      membership in a set).
 *   2. An explicit clinician confirmation event exists in the immutable
 *      audit chain scoped to this `action_id` prior to the transition.
 *      For the `clinician_approve` route, the confirmation event IS the
 *      `prescribing.approved` emission itself (the clinician is the
 *      executing actor). For the `protocol_authorized_prescribing` route,
 *      the confirmation event is `prescribing.protocol_authorization_granted`
 *      (NEW Category A action at AUDIT_EVENTS v5.3 — clinician adopts the
 *      protocol-engine route by explicitly authorizing it for this consult
 *      / patient / protocol_id+version).
 *   3. The confirming actor's `actor_id` resolves to a role authorized to
 *      sign for the action class under RBAC v1.1 / I-012.
 */
export interface I012GuardContext {
  /**
   * Clause 1: autonomy_level for the transition. MUST equal 'action_with_confirm'.
   * Reserved levels (action_with_audit_only, fully_autonomous) are rejected.
   */
  autonomy_level: AutonomyLevel;

  /**
   * The AI workload type for this prescribing decision, if AI-participating.
   * Clinician-only path: pass `null` here AND null for autonomy_level (the
   * `clinician_approve` route permits this).
   *
   * Protocol-authorized path: MUST be 'protocol_execution' per WORKLOAD_TAXONOMY
   * v5.2 §2.2. The DB CHECK enforces this; the state machine cross-checks at
   * the application layer for defense-in-depth.
   */
  ai_workload_type: AIWorkloadType | null;

  /**
   * Clause 2: identifier of the confirmation event in the audit chain. The
   * caller MUST have already located this event by `action_id` and verified
   * its existence + immutability. The state machine cannot fetch the audit
   * chain — that's the service layer's job.
   */
  confirmation_event_audit_id: string;

  /**
   * Clause 2 (route discrimination): the canonical action ID of the
   * confirmation event. For the `clinician_approve` route this is
   * `prescribing.approved` (the success-audit-IS-the-confirmation pattern).
   * For the `protocol_authorized_prescribing` route this is
   * `prescribing.protocol_authorization_granted` (the new Category A
   * confirmation action added at AUDIT_EVENTS v5.3).
   */
  confirmation_event_action_id: string;

  /**
   * Clause 3: the confirming actor's RBAC role. The caller MUST have already
   * verified the role is authorized to sign for this action class under
   * RBAC v1.1 / I-012.
   */
  confirming_actor_rbac_authorized: true;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: MedicationRequestStatus,
    public readonly event: TransitionEvent,
  ) {
    super(`Invalid MedicationRequest transition: cannot ${event} from state ${from}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Thrown when an I-012-gated transition is attempted and one or more of the
 * three clauses fails. The caller MUST emit
 * `AUDIT_ACTIONS.PRESCRIBING_EXECUTION_REJECTED` to the immutable audit chain
 * with the violated clauses in the payload per AUDIT_EVENTS v5.3 §I-012
 * reject-unless rejection-audit-event rule (carries forward v5.2 prose plus
 * P-011 amendment). Bare suppression is forbidden per I-003.
 *
 * The `violated_clauses` array members are the canonical violation-codes
 * from AUDIT_EVENTS v5.3 line 89.
 */
export class I012RejectError extends Error {
  constructor(
    public readonly event: I012GatedEvent,
    public readonly violated_clauses: readonly I012ViolatedClause[],
  ) {
    super(`I-012 reject-unless three-clause rule failed for ${event}: ${violated_clauses.join(', ')}`);
    this.name = 'I012RejectError';
  }
}

/**
 * Canonical I-012 violation clause codes per AUDIT_EVENTS v5.3 line 89
 * (carries forward v5.2 prose unchanged).
 */
export type I012ViolatedClause =
  | 'autonomy_level_string_equality'
  | 'audit_chain_confirmation_event_missing'
  | 'confirming_actor_rbac_unauthorized'
  | 'reserved_level_without_activation_audit_event';

// ---------------------------------------------------------------------------
// validateTransition — pure function, no I/O
// ---------------------------------------------------------------------------

/**
 * Validate a MedicationRequest state transition.
 *
 * For I-012-gated events (`clinician_approve`, `protocol_authorized_prescribing`),
 * the caller MUST supply a fully-populated `I012GuardContext`. The state
 * machine evaluates all three clauses and throws `I012RejectError` if any
 * clause fails. The caller is responsible for emitting
 * `prescribing.execution_rejected` to the immutable audit chain per I-003.
 *
 * For non-I-012-gated events, the `i012_guard` argument MUST be undefined.
 *
 * Returns the destination state on success.
 */
export function validateTransition(
  from: MedicationRequestStatus,
  event: TransitionEvent,
  i012_guard?: I012GuardContext,
): MedicationRequestStatus {
  const transition = TRANSITIONS.find((t) => t.from === from && t.event === event);
  if (!transition) {
    throw new InvalidTransitionError(from, event);
  }

  if (transition.i012_gated) {
    if (!i012_guard) {
      throw new I012RejectError(event as I012GatedEvent, [
        'audit_chain_confirmation_event_missing',
        'confirming_actor_rbac_unauthorized',
        'autonomy_level_string_equality',
      ]);
    }
    const violations = evaluateI012Clauses(event as I012GatedEvent, i012_guard);
    if (violations.length > 0) {
      throw new I012RejectError(event as I012GatedEvent, violations);
    }
  } else if (i012_guard !== undefined) {
    throw new Error(
      `Event '${event}' is not I-012-gated; do not pass an I012GuardContext`,
    );
  }

  return transition.to;
}

/**
 * Evaluate the three I-012 clauses against the supplied guard context.
 * Returns the array of violated clauses (empty array = all clauses
 * satisfied = transition permitted).
 *
 * Per AUDIT_EVENTS v5.3 §I-012 preservation rule (carries forward v5.2
 * line 78 prose plus P-011 amendment).
 */
function evaluateI012Clauses(
  event: I012GatedEvent,
  guard: I012GuardContext,
): I012ViolatedClause[] {
  const violations: I012ViolatedClause[] = [];

  // Clause 1: autonomy_level string equality. Reserved levels rejected here.
  if (guard.autonomy_level !== 'action_with_confirm') {
    // Reserved levels (action_with_audit_only, fully_autonomous) would
    // appear in the AutonomyLevel union only after a successor ADR + an
    // activation audit event. Today the canonical I-012-permitted level is
    // action_with_confirm.
    violations.push('autonomy_level_string_equality');
  }

  // Clause 2: confirmation event present + scoped to same action_id.
  // The state machine verifies the canonical action_id name matches the
  // route; the caller verifies the event's existence in the audit chain.
  const expectedConfirmationActionId =
    event === 'clinician_approve'
      ? AUDIT_ACTIONS.PRESCRIBING_APPROVED
      : AUDIT_ACTIONS.PRESCRIBING_PROTOCOL_AUTHORIZATION_GRANTED;
  if (guard.confirmation_event_action_id !== expectedConfirmationActionId) {
    violations.push('audit_chain_confirmation_event_missing');
  }
  if (!guard.confirmation_event_audit_id) {
    violations.push('audit_chain_confirmation_event_missing');
  }

  // Clause 3: confirming actor RBAC-authorized.
  if (guard.confirming_actor_rbac_authorized !== true) {
    violations.push('confirming_actor_rbac_unauthorized');
  }

  // Workload-route cross-check (defense-in-depth — the DB CHECK enforces
  // this too via medication_requests_i012_envelope_active_check). For the
  // protocol-authorized route the workload MUST be 'protocol_execution';
  // for the clinician-only route the workload MUST be null (clinician acts
  // without AI-execution attribution).
  if (event === 'protocol_authorized_prescribing' && guard.ai_workload_type !== 'protocol_execution') {
    violations.push('reserved_level_without_activation_audit_event');
  }
  if (event === 'clinician_approve' && guard.ai_workload_type !== null) {
    // Mode 1 advisory contribution to a clinician-only prescribing decision
    // is recorded on the AI session / consult transcript, NOT on the
    // MedicationRequest execution envelope. WORKLOAD_TAXONOMY v5.2 §2.1
    // caps conversational_assistant at autonomy_level_range=[advisory], so
    // a 'conversational_assistant' workload at 'action_with_confirm' is
    // taxonomically impossible.
    violations.push('reserved_level_without_activation_audit_event');
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Public predicate: is a state terminal?
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set<MedicationRequestStatus>([
  'discontinued',
  'superseded',
  'expired',
  'rejected',
]);

export function isTerminalState(state: MedicationRequestStatus): boolean {
  return TERMINAL_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Public predicate: does this discontinued_reason match a known event?
// (Used by service-layer mapping when caller chooses among the three
// discontinue events.)
// ---------------------------------------------------------------------------

export function discontinueEventForReason(
  reason: MedicationRequestDiscontinuedReason,
): Extract<
  TransitionEvent,
  'clinician_discontinue' | 'patient_request_discontinue' | 'adverse_event_discontinue'
> {
  switch (reason) {
    case 'patient_request':
      return 'patient_request_discontinue';
    case 'adverse_event':
      return 'adverse_event_discontinue';
    case 'clinical_decision':
    case 'replaced_by_new_prescription':
    case 'expired':
    case 'safety_hold':
    default:
      return 'clinician_discontinue';
  }
}
