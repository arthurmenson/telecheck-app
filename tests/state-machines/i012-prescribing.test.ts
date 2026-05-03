/**
 * I-012 Prescribing reject-unless three-clause rule tests.
 *
 * Invariant under test: I-012 (Clinician sign-off required for prescribing at launch).
 *
 * Spec references:
 *   - I-012 (INVARIANTS v5.2): "At launch, every prescription requires a named
 *     clinician's approval."
 *   - AUDIT_EVENTS v5.2 §I-012 preservation rule — reject-unless three-clause rule:
 *       Clause 1: autonomy_level == 'action_with_confirm' (string equality; not a set).
 *       Clause 2: explicit clinician confirmation event in immutable audit chain.
 *       Clause 3: confirming actor RBAC-authorized for the action class.
 *   - AUDIT_EVENTS v5.2 §Reject-unless rejection audit event (v5.2 patch 2026-05-02):
 *       When transition rejected, MUST emit <action_class>.execution_rejected Category A audit.
 *       Bare suppression is forbidden per I-003.
 *   - AUDIT_EVENTS v5.2 §Exception for *.execution_rejected events:
 *       envelope ai_workload_type + autonomy_level populated from attempted values;
 *       if null/unknown/reserved → sentinel 'rejected_invalid_attempt'.
 *   - violated_clauses[] enum:
 *       autonomy_level_string_equality | audit_chain_confirmation_event_missing |
 *       confirming_actor_rbac_unauthorized | reserved_level_without_activation_audit_event
 *   - STATE_MACHINES v1.1 ProtocolAuthorizedAction §10.4.
 *   - WORKLOAD_TAXONOMY v5.2 (active: advisory | suggestion | action_with_confirm;
 *     reserved: action_with_audit_only | fully_autonomous).
 *   - RBAC v1.1 (clinician role authorizes prescribing / refill / medication_order).
 *
 * Test scenarios (4 total):
 *   Clause 1 fail: autonomy_level != 'action_with_confirm' → violated_clauses includes
 *                  'autonomy_level_string_equality'; execution_rejected audit emitted.
 *   Clause 2 fail: no prior confirmation event in audit chain → violated_clauses includes
 *                  'audit_chain_confirmation_event_missing'; execution_rejected audit emitted.
 *   Clause 3 fail: confirming actor lacks RBAC authorization → violated_clauses includes
 *                  'confirming_actor_rbac_unauthorized'; execution_rejected audit emitted.
 *   All 3 pass:    execution succeeds; no execution_rejected audit emitted.
 *
 * Action classes covered: prescribing, refill, medication_order.
 *
 * DEPENDS ON:
 *   - src/lib/i012-gate.ts (I012Gate, I012GateInput, I012GateResult — appsec-expert agent)
 *   - tests/helpers/audit-assertions.ts (assertAuditRecordExists)
 *   - tests/helpers/invariant-assertions.ts (assertInvariants)
 *   - tests/helpers/tenant-fixtures.ts (TENANT_US, withTenantContext)
 *   - migrations/002_audit_chain.sql (audit_records table)
 *   - RBAC stub from tests/setup.ts (minimal role seed for clause 3 tests)
 */

// DEPENDS ON: src/lib/i012-gate.ts (appsec-expert agent).
// import type { I012GateInput, I012GateResult } from '../../src/lib/i012-gate.ts';
// import { evaluateI012Gate } from '../../src/lib/i012-gate.ts';

import { describe, expect, it } from 'vitest';

import type { I012GateResultStub } from '../helpers/invariant-assertions.ts';
import { assertInvariants } from '../helpers/invariant-assertions.ts';
import { TENANT_US } from '../helpers/tenant-fixtures.ts';

// ---------------------------------------------------------------------------
// Stub I012 gate evaluator
// (placeholder until src/lib/i012-gate.ts lands; faithfully models the three-clause rule)
// ---------------------------------------------------------------------------

type ViolatedClause =
  | 'autonomy_level_string_equality'
  | 'audit_chain_confirmation_event_missing'
  | 'confirming_actor_rbac_unauthorized'
  | 'reserved_level_without_activation_audit_event';

type ActionClass = 'prescribing' | 'refill' | 'medication_order';

interface I012GateInput {
  action_id: string;
  action_class: ActionClass;
  autonomy_level: string | null;
  ai_workload_type: string | null;
  /**
   * Whether the audit chain contains an explicit clinician confirmation event
   * (prescribing.approved or equivalent) for this action_id prior to the
   * executed transition.
   */
  audit_chain_has_confirmation: boolean;
  /**
   * Whether the actor who provided the confirmation event is authorized for
   * the action class under RBAC v1.1.
   */
  confirming_actor_rbac_authorized: boolean;
  /**
   * Whether a successor ADR (030+) has superseded I-012 for this action class
   * AND an activation audit event is recorded in the immutable audit chain.
   * Both conditions (ADR + activation) must be true for reserved levels to pass.
   */
  reserved_level_activation_recorded: boolean;
}

// Stub implementation — remove and replace with the import from src/lib/i012-gate.ts.
function evaluateI012GateStub(input: I012GateInput): I012GateResultStub {
  const violated: ViolatedClause[] = [];
  const RESERVED_LEVELS = new Set(['action_with_audit_only', 'fully_autonomous']);

  // Clause 1: autonomy_level MUST equal 'action_with_confirm' (string equality).
  if (input.autonomy_level !== 'action_with_confirm') {
    if (
      input.autonomy_level !== null &&
      RESERVED_LEVELS.has(input.autonomy_level) &&
      !input.reserved_level_activation_recorded
    ) {
      violated.push('reserved_level_without_activation_audit_event');
    } else {
      violated.push('autonomy_level_string_equality');
    }
  }

  // Clause 2: explicit clinician confirmation in audit chain.
  if (!input.audit_chain_has_confirmation) {
    violated.push('audit_chain_confirmation_event_missing');
  }

  // Clause 3: confirming actor RBAC-authorized.
  if (!input.confirming_actor_rbac_authorized) {
    violated.push('confirming_actor_rbac_unauthorized');
  }

  if (violated.length > 0) {
    return { passed: false, violatedClauses: violated };
  }
  return { passed: true, violatedClauses: [] };
}

// ---------------------------------------------------------------------------
// Shared valid base input — all three clauses pass
// ---------------------------------------------------------------------------

const BASE_VALID_INPUT: I012GateInput = {
  action_id: 'act_i012_test_001',
  action_class: 'prescribing',
  autonomy_level: 'action_with_confirm',
  ai_workload_type: 'protocol_execution',
  audit_chain_has_confirmation: true,
  confirming_actor_rbac_authorized: true,
  reserved_level_activation_recorded: false,
};

// ---------------------------------------------------------------------------
// Clause 1: autonomy_level string equality
// ---------------------------------------------------------------------------

describe('I-012 gate — clause 1: autonomy_level must equal "action_with_confirm"', () => {
  it('should reject prescribing when autonomy_level is "advisory" (wrong value)', () => {
    const input: I012GateInput = { ...BASE_VALID_INPUT, autonomy_level: 'advisory' };
    const result = evaluateI012GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.violatedClauses).toContain(
      'autonomy_level_string_equality' satisfies ViolatedClause,
    );

    assertInvariants(['I-012'], {
      tenantId: TENANT_US,
      i012Result: result,
    });
  });

  it('should reject when autonomy_level is null (absent from attempted action)', () => {
    const input: I012GateInput = { ...BASE_VALID_INPUT, autonomy_level: null };
    const result = evaluateI012GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.violatedClauses).toContain('autonomy_level_string_equality');
  });

  it('should reject reserved level "action_with_audit_only" without activation audit event', () => {
    const input: I012GateInput = {
      ...BASE_VALID_INPUT,
      autonomy_level: 'action_with_audit_only',
      reserved_level_activation_recorded: false,
    };
    const result = evaluateI012GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.violatedClauses).toContain(
      'reserved_level_without_activation_audit_event' satisfies ViolatedClause,
    );
  });

  it('should reject reserved level "fully_autonomous" without activation audit event', () => {
    const input: I012GateInput = {
      ...BASE_VALID_INPUT,
      autonomy_level: 'fully_autonomous',
      reserved_level_activation_recorded: false,
    };
    const result = evaluateI012GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.violatedClauses).toContain('reserved_level_without_activation_audit_event');
  });
});

// ---------------------------------------------------------------------------
// Clause 2: audit chain confirmation event
// ---------------------------------------------------------------------------

describe('I-012 gate — clause 2: audit chain must contain explicit clinician confirmation', () => {
  it('should reject prescribing when no clinician confirmation event in audit chain', () => {
    const input: I012GateInput = {
      ...BASE_VALID_INPUT,
      audit_chain_has_confirmation: false,
    };
    const result = evaluateI012GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.violatedClauses).toContain(
      'audit_chain_confirmation_event_missing' satisfies ViolatedClause,
    );

    assertInvariants(['I-012'], {
      tenantId: TENANT_US,
      i012Result: result,
    });
  });

  it('should reject refill when no confirmation event in audit chain', () => {
    const input: I012GateInput = {
      ...BASE_VALID_INPUT,
      action_class: 'refill',
      audit_chain_has_confirmation: false,
    };
    const result = evaluateI012GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.violatedClauses).toContain('audit_chain_confirmation_event_missing');
  });

  it('should reject medication_order when no confirmation event in audit chain', () => {
    const input: I012GateInput = {
      ...BASE_VALID_INPUT,
      action_class: 'medication_order',
      audit_chain_has_confirmation: false,
    };
    const result = evaluateI012GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.violatedClauses).toContain('audit_chain_confirmation_event_missing');
  });
});

// ---------------------------------------------------------------------------
// Clause 3: confirming actor RBAC authorization
// ---------------------------------------------------------------------------

describe('I-012 gate — clause 3: confirming actor must be RBAC-authorized', () => {
  it('should reject prescribing when confirming actor lacks clinician RBAC role', () => {
    const input: I012GateInput = {
      ...BASE_VALID_INPUT,
      confirming_actor_rbac_authorized: false,
    };
    const result = evaluateI012GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.violatedClauses).toContain(
      'confirming_actor_rbac_unauthorized' satisfies ViolatedClause,
    );

    assertInvariants(['I-012'], {
      tenantId: TENANT_US,
      i012Result: result,
    });
  });
});

// ---------------------------------------------------------------------------
// All 3 clauses pass — execution succeeds
// ---------------------------------------------------------------------------

describe('I-012 gate — all clauses pass: execution succeeds', () => {
  it('should pass prescribing when all three clauses are satisfied', () => {
    const result = evaluateI012GateStub(BASE_VALID_INPUT);

    expect(result.passed).toBe(true);
    expect(result.violatedClauses).toHaveLength(0);

    assertInvariants(['I-012'], {
      tenantId: TENANT_US,
      i012Result: result,
    });
  });

  it('should pass refill when all three clauses are satisfied', () => {
    const input: I012GateInput = { ...BASE_VALID_INPUT, action_class: 'refill' };
    const result = evaluateI012GateStub(input);

    expect(result.passed).toBe(true);
  });

  it('should pass medication_order when all three clauses are satisfied', () => {
    const input: I012GateInput = { ...BASE_VALID_INPUT, action_class: 'medication_order' };
    const result = evaluateI012GateStub(input);

    expect(result.passed).toBe(true);
  });

  it.todo(
    'should emit NO execution_rejected audit when all 3 clauses pass ' +
      '(blocked on src/lib/audit.ts + src/lib/i012-gate.ts integration — appsec-expert agent)',
  );
});

// ---------------------------------------------------------------------------
// Audit-side: execution_rejected event must emit on rejection (I-003 bare suppression)
// ---------------------------------------------------------------------------

describe('I-012 + I-003 — execution_rejected audit must emit on rejection', () => {
  it.todo(
    'should emit prescribing.execution_rejected Category A audit with violated_clauses[] ' +
      'when clause 1 fails (blocked on src/lib/audit.ts integration — appsec-expert agent)',
  );

  it.todo(
    'should emit refill.execution_rejected audit with violated_clauses[] ' +
      'when clause 2 fails (blocked on src/lib/audit.ts integration)',
  );

  it.todo(
    'should emit medication_order.execution_rejected audit with violated_clauses[] ' +
      'when clause 3 fails (blocked on src/lib/audit.ts integration)',
  );

  it.todo(
    'should populate envelope ai_workload_type=rejected_invalid_attempt when ' +
      'attempted autonomy_level is null/reserved per AUDIT_EVENTS v5.2 §Exception rule ' +
      '(blocked on src/lib/audit.ts + src/lib/i012-gate.ts)',
  );

  it('should validate that violated_clauses is non-empty on any rejection (structural check)', () => {
    // Structural check runnable without DB integration.
    const result = evaluateI012GateStub({
      ...BASE_VALID_INPUT,
      autonomy_level: 'advisory',
      audit_chain_has_confirmation: false,
    });

    expect(result.passed).toBe(false);
    expect(result.violatedClauses.length).toBeGreaterThanOrEqual(1);

    // violatedClauses must only contain canonical values.
    const validClauses = new Set<ViolatedClause>([
      'autonomy_level_string_equality',
      'audit_chain_confirmation_event_missing',
      'confirming_actor_rbac_unauthorized',
      'reserved_level_without_activation_audit_event',
    ]);
    for (const clause of result.violatedClauses) {
      expect(validClauses.has(clause as ViolatedClause)).toBe(true);
    }
  });
});
