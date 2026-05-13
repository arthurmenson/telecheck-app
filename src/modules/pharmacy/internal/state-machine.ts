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
  MEDICATION_REQUEST_INTERACTION_EVALUATION_COMPLETED:
    'medication_request.interaction_evaluation_completed',
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
 * The guard is a DISCRIMINATED UNION keyed by `event` so the clinician-only
 * route (`clinician_approve`) and the protocol-authorized route
 * (`protocol_authorized_prescribing`) can each enforce the I-012 three-
 * clause rule with route-appropriate envelope semantics — matching the
 * migration 025 medication_requests_i012_envelope_active_check exactly.
 *
 * Three clauses per Master PRD v1.10 §13.7 (single normative source of
 * truth; AUDIT_EVENTS v5.3 + State Machines v1.2 + AUTONOMY_LEVELS v5.2
 * mirror exactly):
 *   1. AI-participating execution attribution: `autonomy_level ==
 *      'action_with_confirm'` (string equality; not membership in a set).
 *      For the clinician-only route (no AI workload), this clause is
 *      satisfied vacuously: the row carries no AI execution attribution
 *      (both ai_workload_type and autonomy_level are null per the DB
 *      CHECK (a) clause — the clinician-only path) and the audit-side
 *      envelope uses the `'n/a'` sentinel per AUDIT_EVENTS v5.3 §I-012
 *      closure rule line 127 clinician-confirmation carve-out.
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
export type I012GuardContext = I012GuardClinicianOnly | I012GuardProtocolAuthorized;

/**
 * Guard for the `clinician_approve` route — clinician is the executing actor;
 * no AI workload attribution on the row.
 *
 * Row envelope (per migration 025 CHECK (a)): ai_workload_type=null AND
 * autonomy_level=null. Audit envelope per AUDIT_EVENTS v5.3 §I-012 closure
 * rule line 127: ai_workload_type='n/a' and autonomy_level='n/a' (the
 * canonical sentinels for the clinician-only carve-out).
 */
export interface I012GuardClinicianOnly {
  route: 'clinician_approve';

  /**
   * Clause 2: identifier of the confirmation event in the audit chain. For
   * the clinician_approve route the confirmation event IS the
   * `prescribing.approved` emission; the caller MUST have planned that
   * emission as part of the transition (or for retry/idempotency cases,
   * located the prior emission scoped to the same action_id).
   */
  confirmation_event_audit_id: string;

  /**
   * Clause 2 (bound-context attestations — added v0.3 per Codex
   * pharmacy-scaffold-rebuild R3 HIGH closure 2026-05-12): the caller MUST
   * attest the audit event referenced by `confirmation_event_audit_id` is
   * bound to these facts. The state machine cross-checks these against the
   * `pending_transition` argument to `validateTransition`; mismatches
   * indicate a service-layer mistake (e.g., a stale retry token, a confused
   * action_id, or a cross-tenant audit-id leak) and reject the transition
   * with `audit_chain_confirmation_event_missing`.
   */
  attested_tenant_id: string;
  attested_action_id: string;
  attested_patient_account_id: string;
  attested_actor_id: string;

  /**
   * Clause 3: the confirming actor's RBAC role. The caller MUST have already
   * verified the role is authorized to sign for prescribing under RBAC v1.1.
   */
  confirming_actor_rbac_authorized: true;
}

/**
 * Guard for the `protocol_authorized_prescribing` route — Mode 2 protocol
 * engine is the executing actor; clinician confirmation is the I-012
 * anchor.
 *
 * Row envelope (per migration 025 CHECK (b)): ai_workload_type=
 * 'protocol_execution' AND autonomy_level='action_with_confirm'. Audit
 * envelope per AUDIT_EVENTS v5.3 §protocol_authorized_prescribing payload:
 * actor_type='ai_workload', ai_workload_type='protocol_execution',
 * autonomy_level='action_with_confirm'.
 */
export interface I012GuardProtocolAuthorized {
  route: 'protocol_authorized_prescribing';

  /**
   * Clause 1: autonomy_level for the transition. MUST equal 'action_with_confirm'.
   * Reserved levels (action_with_audit_only, fully_autonomous) are rejected.
   */
  autonomy_level: AutonomyLevel;

  /**
   * AI workload type — MUST be 'protocol_execution' per WORKLOAD_TAXONOMY
   * v5.2 §2.2 for this route. conversational_assistant at action_with_confirm
   * is impossible by taxonomy (the §2.1 autonomy_level_range cap on
   * conversational_assistant is [advisory] only).
   */
  ai_workload_type: AIWorkloadType;

  /**
   * Clause 2: identifier of the prior `prescribing.protocol_authorization_granted`
   * event in the immutable audit chain. The caller MUST have located this
   * event by `action_id` (scoped to the same action_id as the upcoming
   * `protocol_authorized_prescribing` success emission) and verified its
   * existence + immutability.
   */
  confirmation_event_audit_id: string;

  /**
   * Clause 2 (action-ID anchor): the canonical action ID of the confirmation
   * event. MUST equal `prescribing.protocol_authorization_granted` per
   * AUDIT_EVENTS v5.3 §I-012 closure rule authoritative set amendment under
   * P-011. Reusing `prescribing.approved` here is rejected — that action ID
   * is the clinician-only route's terminal success audit.
   */
  confirmation_event_action_id: string;

  /**
   * Clause 2 (bound-context attestations — added v0.3 per Codex
   * pharmacy-scaffold-rebuild R3 HIGH closure 2026-05-12): the caller MUST
   * attest the audit event referenced by `confirmation_event_audit_id` is
   * bound to these facts. The state machine cross-checks these against the
   * `pending_transition` argument to `validateTransition`; mismatches
   * indicate a service-layer mistake (e.g., a stale retry token, a confused
   * action_id, a cross-tenant audit-id leak, or a wrong protocol_id /
   * protocol_version pairing) and reject the transition with
   * `audit_chain_confirmation_event_missing`.
   *
   * Protocol-route attestations include the protocol binding fields
   * (protocol_id + protocol_version) because the upstream
   * prescribing.protocol_authorization_granted event MUST have been scoped
   * to the same protocol context as the row being transitioned. A mismatch
   * means the clinician authorized a different protocol than the engine is
   * about to execute.
   */
  attested_tenant_id: string;
  attested_action_id: string;
  attested_patient_account_id: string;
  attested_actor_id: string;
  attested_protocol_id: string;
  attested_protocol_version: string;

  /**
   * Clause 3: the confirming clinician's RBAC role. The clinician who emitted
   * the `prescribing.protocol_authorization_granted` event MUST have been
   * authorized to sign for prescribing under RBAC v1.1.
   */
  confirming_actor_rbac_authorized: true;
}

/**
 * Pending transition context — the facts about the row being transitioned that
 * the state machine cross-checks against the I-012 guard's bound-context
 * attestations. The caller (service layer) MUST construct this from the actual
 * MedicationRequest row data; the state machine cross-checks the guard's
 * `attested_*` fields against these values and rejects with
 * `audit_chain_confirmation_event_missing` on any mismatch.
 *
 * Added v0.3 per Codex pharmacy-scaffold-rebuild R3 HIGH closure 2026-05-12.
 */
export interface PendingTransitionContext {
  /** The MedicationRequest row's tenant_id. */
  tenant_id: string;
  /** The canonical I-012 action_id for this prescribing decision. */
  action_id: string;
  /** The MedicationRequest row's patient_account_id. */
  patient_account_id: string;
  /** The actor performing the transition (clinician for both routes). */
  actor_id: string;
  /** The row's protocol_id — null on the clinician-only route. */
  protocol_id: string | null;
  /** The row's protocol_version — null on the clinician-only route. */
  protocol_version: string | null;
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
    super(
      `I-012 reject-unless three-clause rule failed for ${event}: ${violated_clauses.join(', ')}`,
    );
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
 * the caller MUST supply BOTH a fully-populated `I012GuardContext` AND a
 * `PendingTransitionContext` describing the row being transitioned. The state
 * machine:
 *   1. Verifies the guard route matches the event.
 *   2. Cross-checks the guard's `attested_*` bindings against the
 *      `pending_transition` facts. Mismatches reject with
 *      `audit_chain_confirmation_event_missing` (the bound confirmation
 *      event doesn't match the pending transition's row).
 *   3. Evaluates the I-012 three clauses per the route.
 * Any clause failure throws `I012RejectError`. The caller is responsible for
 * emitting `prescribing.execution_rejected` to the immutable audit chain per
 * I-003.
 *
 * For non-I-012-gated events, both `i012_guard` and `pending_transition` MUST
 * be undefined.
 *
 * Returns the destination state on success.
 */
export function validateTransition(
  from: MedicationRequestStatus,
  event: TransitionEvent,
  i012_guard?: I012GuardContext,
  pending_transition?: PendingTransitionContext,
): MedicationRequestStatus {
  const transition = TRANSITIONS.find((t) => t.from === from && t.event === event);
  if (!transition) {
    throw new InvalidTransitionError(from, event);
  }

  if (transition.i012_gated) {
    if (!i012_guard || !pending_transition) {
      throw new I012RejectError(event as I012GatedEvent, [
        'audit_chain_confirmation_event_missing',
        'confirming_actor_rbac_unauthorized',
      ]);
    }
    // Cross-check 1: guard.route MUST match the event being attempted
    // (catches service-layer mistakes where a clinician_approve guard is
    // paired with a protocol_authorized_prescribing event, or vice versa).
    if (i012_guard.route !== event) {
      throw new I012RejectError(event as I012GatedEvent, [
        'audit_chain_confirmation_event_missing',
      ]);
    }
    // Cross-check 2: the guard's attested bindings MUST match the pending
    // transition's row facts. Mismatch = stale retry token, confused
    // action_id, cross-tenant audit-id leak, or wrong protocol pairing.
    if (
      i012_guard.attested_tenant_id !== pending_transition.tenant_id ||
      i012_guard.attested_action_id !== pending_transition.action_id ||
      i012_guard.attested_patient_account_id !== pending_transition.patient_account_id ||
      i012_guard.attested_actor_id !== pending_transition.actor_id
    ) {
      throw new I012RejectError(event, ['audit_chain_confirmation_event_missing']);
    }
    if (i012_guard.route === 'protocol_authorized_prescribing') {
      if (
        i012_guard.attested_protocol_id !== pending_transition.protocol_id ||
        i012_guard.attested_protocol_version !== pending_transition.protocol_version
      ) {
        throw new I012RejectError(event, ['audit_chain_confirmation_event_missing']);
      }
    } else {
      // Clinician-only route: pending_transition.protocol_id/version MUST be null
      // (matches the row CHECK medication_requests_i012_protocol_binding_check
      // tightened to iff in R2 — protocol metadata cannot exist on the
      // clinician-only branch).
      if (pending_transition.protocol_id !== null || pending_transition.protocol_version !== null) {
        throw new I012RejectError(event, ['audit_chain_confirmation_event_missing']);
      }
    }
    const violations = evaluateI012Clauses(event, i012_guard);
    if (violations.length > 0) {
      throw new I012RejectError(event, violations);
    }
  } else if (i012_guard !== undefined || pending_transition !== undefined) {
    throw new Error(
      `Event '${event}' is not I-012-gated; do not pass an I012GuardContext or PendingTransitionContext`,
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
function evaluateI012Clauses(event: I012GatedEvent, guard: I012GuardContext): I012ViolatedClause[] {
  const violations: I012ViolatedClause[] = [];

  if (event === 'clinician_approve' && guard.route === 'clinician_approve') {
    // Clinician-only route.
    //
    // Clause 1 (AI execution attribution): vacuously satisfied. The row
    // envelope carries no AI execution attribution (DB CHECK (a):
    // ai_workload_type=null AND autonomy_level=null); the AUDIT_EVENTS
    // envelope uses the 'n/a' sentinel for ai_workload_type/autonomy_level
    // per the v5.3 §I-012 closure rule line 127 clinician-confirmation
    // carve-out. The state machine does not re-test clause 1 here because
    // there is no autonomy_level value on the guard to test.
    //
    // Clause 2: confirmation event is the upcoming `prescribing.approved`
    // emission; the caller MUST have planned (or already emitted, for
    // retry/idempotency) that audit record scoped to the same action_id.
    // We require a non-empty confirmation_event_audit_id as the caller's
    // attestation that this slot is reserved.
    if (!guard.confirmation_event_audit_id) {
      violations.push('audit_chain_confirmation_event_missing');
    }
    // Clause 3: confirming actor RBAC-authorized.
    if (guard.confirming_actor_rbac_authorized !== true) {
      violations.push('confirming_actor_rbac_unauthorized');
    }
    return violations;
  }

  if (
    event === 'protocol_authorized_prescribing' &&
    guard.route === 'protocol_authorized_prescribing'
  ) {
    // Protocol-authorized route.
    //
    // Clause 1: autonomy_level string equality. Reserved levels (advisory,
    // suggestion) and any future reserved levels are rejected here. Only
    // action_with_confirm permits I-012 execution per AUTONOMY_LEVELS v5.2.
    if (guard.autonomy_level !== 'action_with_confirm') {
      violations.push('autonomy_level_string_equality');
    }
    // Workload cross-check (defense-in-depth — the DB CHECK
    // medication_requests_i012_envelope_active_check enforces this too).
    // For the protocol-authorized route the workload MUST be
    // 'protocol_execution' per WORKLOAD_TAXONOMY v5.2 §2.2.
    if (guard.ai_workload_type !== 'protocol_execution') {
      violations.push('reserved_level_without_activation_audit_event');
    }
    // Clause 2: the confirmation event MUST be
    // prescribing.protocol_authorization_granted (the NEW Category A action
    // added at AUDIT_EVENTS v5.3 under P-011) scoped to the same action_id.
    if (
      guard.confirmation_event_action_id !==
      AUDIT_ACTIONS.PRESCRIBING_PROTOCOL_AUTHORIZATION_GRANTED
    ) {
      violations.push('audit_chain_confirmation_event_missing');
    }
    if (!guard.confirmation_event_audit_id) {
      violations.push('audit_chain_confirmation_event_missing');
    }
    // Clause 3: confirming clinician RBAC-authorized.
    if (guard.confirming_actor_rbac_authorized !== true) {
      violations.push('confirming_actor_rbac_unauthorized');
    }
    return violations;
  }

  // Guard/event mismatch — the discriminated union failed at runtime
  // somehow. Treat as a confirmation-event-missing violation; the caller
  // shouldn't have reached this branch.
  violations.push('audit_chain_confirmation_event_missing');
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
