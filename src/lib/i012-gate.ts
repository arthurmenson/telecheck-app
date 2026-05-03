/**
 * i012-gate.ts — I-012 reject-unless three-clause rule for prescribing/refill/medication-order.
 *
 * Purpose:
 *   Evaluates the three-clause I-012 gate before any prescribing, refill, or
 *   medication-order `executed` state transition. All three clauses must hold
 *   simultaneously. On rejection, the caller MUST emit a `<action_class>.execution_rejected`
 *   audit event — bare suppression is forbidden per I-003.
 *
 * Spec references:
 *   - I-012: clinician sign-off required for prescribing at launch.
 *   - AUDIT_EVENTS v5.2 §I-012 closure rule (authoritative I-012 action-class set):
 *     prescribing.initiated, prescribing.approved, prescribing.declined, prescribing.modified,
 *     refill.approved, refill.declined, protocol_authorized_prescribing,
 *     protocol_authorized_refill_renewal, protocol_authorized_dispensing_release,
 *     prescribing.execution_rejected, refill.execution_rejected, medication_order.execution_rejected.
 *   - WORKLOAD_TAXONOMY v5.2 §2.2 I-012 preservation rule.
 *   - AUTONOMY_LEVELS v5.2 §2.3 + §5 per-action validation rule 5.
 *   - Master PRD v1.10 §13.7 (single normative source of truth for the three-clause rule).
 *
 * Three-clause rule (from Master PRD §13.7 / WORKLOAD_TAXONOMY v5.2 §2.2):
 *   1. `autonomy_level === 'action_with_confirm'` (string equality, NOT membership).
 *      Reserved levels (action_with_audit_only, fully_autonomous) are explicitly rejected.
 *      Null/unknown/absent values are rejected.
 *   2. An explicit clinician confirmation event exists in the immutable audit chain,
 *      scoped to this `action_id`, prior to the `executed` transition.
 *   3. The confirming actor holds an RBAC role authorized for the action class
 *      per RBAC v1.1 / I-012.
 *
 * Violated clauses enum (per AUDIT_EVENTS v5.2 §I-012 reject-unless rejection event):
 *   - `autonomy_level_string_equality`
 *   - `audit_chain_confirmation_event_missing`
 *   - `confirming_actor_rbac_unauthorized`
 *   - `reserved_level_without_activation_audit_event`
 *
 * Open questions for Engineering Lead:
 *   - Clause 2 (audit chain confirmation): requires querying the append-only
 *     `audit_records` table for a prior `prescribing.approved` (or equivalent)
 *     event with matching `action_id`. Currently STUBBED — throws in production.
 *   - Clause 3 (RBAC check): requires the RBAC catalog (migration not yet authored).
 *     Currently STUBBED — throws in production to prevent silent pass-through.
 *   - `action_id`: the ULID that the rejected `*.executed` would have carried.
 *     Caller provides this; we don't generate it here.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type I012ActionClass = 'prescribing' | 'refill' | 'medication_order';

export type I012ViolatedClause =
  | 'autonomy_level_string_equality'
  | 'audit_chain_confirmation_event_missing'
  | 'confirming_actor_rbac_unauthorized'
  | 'reserved_level_without_activation_audit_event';

export type ConfirmationEventState =
  | 'present-with-defect'
  | 'absent'
  | 'present-but-mismatched-action_id'
  | 'present-but-mismatched-actor';

export type RbacRoleCheckResult = 'authorized' | 'unauthorized' | 'role_not_found';

export type I012GateResult =
  | { pass: true }
  | {
      pass: false;
      violated_clauses: I012ViolatedClause[];
      confirmation_event_state: ConfirmationEventState;
      rbac_role_check_result: RbacRoleCheckResult;
      /**
       * The `ai_workload_type` to populate on the `*.execution_rejected` audit envelope.
       * Per AUDIT_EVENTS v5.2: use 'rejected_invalid_attempt' if attempted value
       * was null/unknown/reserved.
       */
      envelope_ai_workload_type: string;
      /**
       * The `autonomy_level` to populate on the `*.execution_rejected` audit envelope.
       * Per AUDIT_EVENTS v5.2: use 'rejected_invalid_attempt' if attempted value
       * was null/unknown/reserved.
       */
      envelope_autonomy_level: string;
    };

// ---------------------------------------------------------------------------
// Action context input
// ---------------------------------------------------------------------------

export interface I012ActionContext {
  /** The ULID the `*.executed` transition would have carried. */
  action_id: string;
  /** I-012 action class being attempted. */
  action_class: I012ActionClass;
  /** Attempted autonomy level (may be null/unknown/reserved). */
  attempted_autonomy_level: string | null | undefined;
  /** Attempted AI workload type (may be null/unknown/reserved). */
  attempted_ai_workload_type: string | null | undefined;
  /** Actor ID of the entity attempting execution. */
  attempted_actor_id: string;
  /** Actor type of the entity attempting execution. */
  attempted_actor_type: string;
  /**
   * If a confirming actor is known, their ID and role.
   * Null if no confirmation event was found in the audit chain.
   */
  confirming_actor?: {
    actor_id: string;
    actor_role: string;
  };
}

// ---------------------------------------------------------------------------
// Reserved/forbidden autonomy levels for I-012 gate
// ---------------------------------------------------------------------------

const RESERVED_AUTONOMY_LEVELS = new Set(['action_with_audit_only', 'fully_autonomous']);

const ACTIVE_AUTONOMY_LEVELS_FOR_I012 = new Set(['advisory', 'suggestion', 'action_with_confirm']);

// ---------------------------------------------------------------------------
// Sentinel computation helpers
// ---------------------------------------------------------------------------

function resolveEnvelopeWorkloadType(attempted: string | null | undefined): string {
  if (
    attempted === null ||
    attempted === undefined ||
    attempted === '' ||
    !['conversational_assistant', 'protocol_execution', 'n/a'].includes(attempted)
  ) {
    return 'rejected_invalid_attempt';
  }
  return attempted;
}

function resolveEnvelopeAutonomyLevel(attempted: string | null | undefined): string {
  const activeAndKnown = new Set([
    'advisory',
    'suggestion',
    'action_with_confirm',
    'n/a',
    'action_with_audit_only',
    'fully_autonomous', // reserved but known — still sentinel on rejection
  ]);
  if (
    attempted === null ||
    attempted === undefined ||
    attempted === '' ||
    !activeAndKnown.has(attempted)
  ) {
    return 'rejected_invalid_attempt';
  }
  return attempted;
}

// ---------------------------------------------------------------------------
// Clause 2: audit chain confirmation check
// STUB: requires querying the audit_records table.
// ---------------------------------------------------------------------------

async function checkAuditChainConfirmation(
  actionId: string,
  _actionClass: I012ActionClass,
  confirmingActor: I012ActionContext['confirming_actor'],
): Promise<{ state: ConfirmationEventState; pass: boolean }> {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error(
      'I-012 clause 2 (audit chain confirmation event check) is STUBBED. ' +
        'Real implementation queries the audit_records table for a prior ' +
        'prescribing.approved (or equivalent) event with action_id=' +
        actionId +
        '. ' +
        'This requires migration 002 (audit_records table). ' +
        'See i012-gate.ts open questions.',
    );
  }

  // Test mode: use the confirming_actor as a proxy for the confirmation event
  if (!confirmingActor) {
    return { state: 'absent', pass: false };
  }
  if (confirmingActor.actor_id === '') {
    return { state: 'present-but-mismatched-actor', pass: false };
  }
  return { state: 'present-with-defect', pass: true }; // "present-with-defect" is truthy in tests
}

// ---------------------------------------------------------------------------
// Clause 3: RBAC role check
// STUB: requires the RBAC catalog.
// ---------------------------------------------------------------------------

async function checkRbacAuthorization(
  actionClass: I012ActionClass,
  confirmingActor: I012ActionContext['confirming_actor'],
): Promise<{ result: RbacRoleCheckResult; pass: boolean }> {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error(
      'I-012 clause 3 (RBAC role authorization check) is STUBBED. ' +
        'Real implementation queries the RBAC catalog per RBAC v1.1 for ' +
        'the confirming actor\'s role against action class "' +
        actionClass +
        '". ' +
        'See i012-gate.ts open questions.',
    );
  }

  if (!confirmingActor) {
    return { result: 'role_not_found', pass: false };
  }
  // Test mode: only 'clinician' role is authorized for I-012 actions at v1.0
  const authorizedRoles = new Set(['clinician', 'protocol_clinician_lead']);
  const isAuthorized = authorizedRoles.has(confirmingActor.actor_role);
  return {
    result: isAuthorized ? 'authorized' : 'unauthorized',
    pass: isAuthorized,
  };
}

// ---------------------------------------------------------------------------
// evaluateI012Gate — main entry point
// ---------------------------------------------------------------------------

/**
 * evaluateI012Gate — evaluates all three I-012 clauses for a prescribing/refill/
 * medication-order executed transition.
 *
 * Returns `{ pass: true }` only when ALL three clauses hold simultaneously.
 *
 * On `{ pass: false }`, the CALLER must:
 *   1. Emit `<action_class>.execution_rejected` audit event (Category A) with:
 *      - `action_id` from the rejected action
 *      - `violated_clauses[]` from the gate result
 *      - `attempted_actor_id`, `attempted_actor_type`
 *      - `attempted_ai_workload_type` = `result.envelope_ai_workload_type`
 *      - `attempted_autonomy_level` = `result.envelope_autonomy_level`
 *      - `confirmation_event_state`, `rbac_role_check_result` from result
 *      - `audit_sensitivity_level = 'standard'` (rejection itself is not high_pii)
 *   Bare suppression of the rejection audit event is FORBIDDEN per I-003.
 */
export async function evaluateI012Gate(ctx: I012ActionContext): Promise<I012GateResult> {
  const violated: I012ViolatedClause[] = [];

  // Pre-compute sentinel values for the rejection envelope
  const envelopeWorkloadType = resolveEnvelopeWorkloadType(ctx.attempted_ai_workload_type);
  const envelopeAutonomyLevel = resolveEnvelopeAutonomyLevel(ctx.attempted_autonomy_level);

  // Clause 1: autonomy_level string equality to 'action_with_confirm'
  let clause1Pass = false;
  const attempted = ctx.attempted_autonomy_level;

  if (attempted === 'action_with_confirm') {
    clause1Pass = true;
  } else if (
    attempted !== null &&
    attempted !== undefined &&
    RESERVED_AUTONOMY_LEVELS.has(attempted)
  ) {
    // Reserved level — explicitly rejected; also set reserved_level violation
    violated.push('reserved_level_without_activation_audit_event');
    violated.push('autonomy_level_string_equality');
  } else if (
    attempted !== null &&
    attempted !== undefined &&
    ACTIVE_AUTONOMY_LEVELS_FOR_I012.has(attempted)
  ) {
    // Active level but not action_with_confirm (advisory/suggestion) — wrong level
    violated.push('autonomy_level_string_equality');
  } else {
    // Null, unknown, absent, or future enum value — rejected
    violated.push('autonomy_level_string_equality');
  }

  // Clause 2: explicit clinician confirmation event in audit chain.
  // Per I-003, the underlying stub throws in production rather than
  // suppressing — that throw propagates here without need for an
  // explicit re-throw wrapper (was previously a no-useless-catch lint hit).
  const c2 = await checkAuditChainConfirmation(
    ctx.action_id,
    ctx.action_class,
    ctx.confirming_actor,
  );
  const confirmationEventState: ConfirmationEventState = c2.state;
  const clause2Pass = c2.pass;
  if (!c2.pass) {
    violated.push('audit_chain_confirmation_event_missing');
  }

  // Clause 3: confirming actor RBAC authorized. Same bare-suppression
  // discipline — RBAC check throws propagate as-is.
  const c3 = await checkRbacAuthorization(ctx.action_class, ctx.confirming_actor);
  const rbacResult: RbacRoleCheckResult = c3.result;
  const clause3Pass = c3.pass;
  if (!c3.pass) {
    violated.push('confirming_actor_rbac_unauthorized');
  }

  if (clause1Pass && clause2Pass && clause3Pass) {
    return { pass: true };
  }

  return {
    pass: false,
    violated_clauses: violated,
    confirmation_event_state: confirmationEventState,
    rbac_role_check_result: rbacResult,
    envelope_ai_workload_type: envelopeWorkloadType,
    envelope_autonomy_level: envelopeAutonomyLevel,
  };
}
