/**
 * I-029 Research Data Export — 6-condition reject-unless gate tests.
 *
 * Invariant under test: I-029 (Research data export 6-condition reject-unless gate).
 *
 * Spec references:
 *   - I-029 (INVARIANTS v5.2): 6 conditions ALL must be met for delivery to succeed.
 *   - AUDIT_EVENTS v5.2 §5 research events:
 *       research.export_completed must emit with status=invalidated + invalidation_reason
 *       when ANY condition fails. Bare suppression forbidden (I-003).
 *       Concurrent signal_enforcement_trigger Category B audit required on invalidation.
 *   - STATE_MACHINES v1.1 ResearchExportRequest reject-unless rule.
 *   - TYPES v5.2 ResearchDataExport.invalidation_reason enum (6 values):
 *       dsa_inactive | k_anonymity_violation | permitted_domain_drift |
 *       consent_cohort_change | consent_revocation_mid_export | grant_artifact_invalidated
 *   - OpenAPI v0.2 /research/exports/{export_id}/complete endpoint.
 *   - I-031: research.export_completed emits at audit_sensitivity_level=high_pii.
 *
 * Test scenarios (7 total):
 *   Condition 1 fail: DSA not active                  → invalidation_reason = dsa_inactive
 *   Condition 2 fail: k-anonymity floor violated      → invalidation_reason = k_anonymity_violation
 *   Condition 3 fail: permitted domain drift          → invalidation_reason = permitted_domain_drift
 *   Condition 4 fail: consent cohort hash changed     → invalidation_reason = consent_cohort_change
 *   Condition 5 fail: per-patient consent revoked     → invalidation_reason = consent_revocation_mid_export
 *   Condition 6 fail: grant artifact invalidated      → invalidation_reason = grant_artifact_invalidated
 *   All 6 pass:       delivery succeeds;
 *                     research_export.delivered domain event emitted;
 *                     research.export_completed(status=completed) audit emitted;
 *                     NO signal_enforcement_trigger emitted.
 *
 * DEPENDS ON:
 *   - src/lib/i029-gate.ts (I029Gate, I029GateInput, I029GateResult — appsec-expert agent)
 *   - tests/helpers/audit-assertions.ts (assertAuditRecordExists, assertHighPiiSensitivity)
 *   - tests/helpers/invariant-assertions.ts (assertInvariants, assertI029ResearchGate)
 *   - tests/helpers/tenant-fixtures.ts (TENANT_US, withTenantContext)
 *   - migrations/002_audit_chain.sql (audit_records table)
 */

// DEPENDS ON: src/lib/i029-gate.ts (written by appsec-expert agent).
// Import the evaluator once it exists. Until then, the tests document the
// expected interface and use stub implementations.
//
// import type { I029GateInput, I029GateResult } from '../../src/lib/i029-gate.ts';
// import { evaluateI029Gate } from '../../src/lib/i029-gate.ts';

import { describe, expect, it } from 'vitest';
import {
  assertAuditRecordExists,
  assertHighPiiSensitivity,
} from '../helpers/audit-assertions.ts';
import type { I029GateResultStub } from '../helpers/invariant-assertions.ts';
import { assertInvariants } from '../helpers/invariant-assertions.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';

// ---------------------------------------------------------------------------
// Stub I029 gate evaluator (placeholder until src/lib/i029-gate.ts lands)
// ---------------------------------------------------------------------------

// DEPENDS ON: src/lib/i029-gate.ts (appsec-expert agent).
// This stub is removed once the real module is imported above.
type InvalidationReason =
  | 'dsa_inactive'
  | 'k_anonymity_violation'
  | 'permitted_domain_drift'
  | 'consent_cohort_change'
  | 'consent_revocation_mid_export'
  | 'grant_artifact_invalidated';

interface I029GateInput {
  dsa_status_at_export: 'active' | 'expired' | 'suspended' | 'retired';
  k_threshold_actual: number;
  k_min_required: number;
  permitted_domains_at_export: string[];
  permitted_domains_at_initiation: string[];
  consent_cohort_hash_initiated: string;
  consent_cohort_hash_completed: string;
  all_patients_have_active_consent: boolean;
  grant_artifact_valid: boolean;
  grant_artifact_unexpired: boolean;
  grant_signer_chain_intact: boolean;
}

// Stub implementation — replace with `import { evaluateI029Gate }` once the real
// module exists. This stub faithfully models the 6-condition waterfall per I-029.
function evaluateI029GateStub(input: I029GateInput): I029GateResultStub {
  if (input.dsa_status_at_export !== 'active') {
    return { passed: false, invalidationReason: 'dsa_inactive', failedCondition: 1 };
  }
  if (input.k_threshold_actual < input.k_min_required) {
    return { passed: false, invalidationReason: 'k_anonymity_violation', failedCondition: 2 };
  }
  if (
    JSON.stringify(input.permitted_domains_at_export.sort()) !==
    JSON.stringify(input.permitted_domains_at_initiation.sort())
  ) {
    return { passed: false, invalidationReason: 'permitted_domain_drift', failedCondition: 3 };
  }
  if (input.consent_cohort_hash_completed !== input.consent_cohort_hash_initiated) {
    return { passed: false, invalidationReason: 'consent_cohort_change', failedCondition: 4 };
  }
  if (!input.all_patients_have_active_consent) {
    return {
      passed: false,
      invalidationReason: 'consent_revocation_mid_export',
      failedCondition: 5,
    };
  }
  if (
    !input.grant_artifact_valid ||
    !input.grant_artifact_unexpired ||
    !input.grant_signer_chain_intact
  ) {
    return { passed: false, invalidationReason: 'grant_artifact_invalidated', failedCondition: 6 };
  }
  return { passed: true, invalidationReason: null, failedCondition: null };
}

// ---------------------------------------------------------------------------
// Base valid input — all 6 conditions pass
// ---------------------------------------------------------------------------

const BASE_VALID_INPUT: I029GateInput = {
  dsa_status_at_export: 'active',
  k_threshold_actual: 15,
  k_min_required: 11,
  permitted_domains_at_export: ['chronic_disease_longitudinal'],
  permitted_domains_at_initiation: ['chronic_disease_longitudinal'],
  consent_cohort_hash_initiated: 'abc123',
  consent_cohort_hash_completed: 'abc123',
  all_patients_have_active_consent: true,
  grant_artifact_valid: true,
  grant_artifact_unexpired: true,
  grant_signer_chain_intact: true,
};

// ---------------------------------------------------------------------------
// Condition 1: DSA not active → dsa_inactive
// ---------------------------------------------------------------------------

describe('I-029 gate — condition 1: DSA must be active', () => {
  it('should reject with invalidation_reason=dsa_inactive when DSA is expired', () => {
    const input: I029GateInput = { ...BASE_VALID_INPUT, dsa_status_at_export: 'expired' };
    const result = evaluateI029GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.invalidationReason).toBe('dsa_inactive' satisfies InvalidationReason);
    expect(result.failedCondition).toBe(1);

    assertInvariants(['I-029'], { i029Result: result });
  });

  it('should reject with dsa_inactive when DSA is suspended', () => {
    const input: I029GateInput = { ...BASE_VALID_INPUT, dsa_status_at_export: 'suspended' };
    const result = evaluateI029GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.invalidationReason).toBe('dsa_inactive');
  });
});

// ---------------------------------------------------------------------------
// Condition 2: k-anonymity floor → k_anonymity_violation
// ---------------------------------------------------------------------------

describe('I-029 gate — condition 2: k-anonymity floor must be met', () => {
  it('should reject with k_anonymity_violation when k_threshold_actual < k_min_required', () => {
    const input: I029GateInput = {
      ...BASE_VALID_INPUT,
      k_threshold_actual: 8,
      k_min_required: 11,
    };
    const result = evaluateI029GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.invalidationReason).toBe('k_anonymity_violation' satisfies InvalidationReason);
    expect(result.failedCondition).toBe(2);

    assertInvariants(['I-029'], { i029Result: result });
  });

  it('should pass when k_threshold_actual exactly equals k_min_required (boundary)', () => {
    const input: I029GateInput = {
      ...BASE_VALID_INPUT,
      k_threshold_actual: 11,
      k_min_required: 11,
    };
    const result = evaluateI029GateStub(input);

    expect(result.passed).toBe(true);
    expect(result.invalidationReason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Condition 3: Permitted domain drift → permitted_domain_drift
// ---------------------------------------------------------------------------

describe('I-029 gate — condition 3: permitted data domains must match initiation snapshot', () => {
  it('should reject with permitted_domain_drift when domains drift from initiation snapshot', () => {
    const input: I029GateInput = {
      ...BASE_VALID_INPUT,
      permitted_domains_at_export: ['ncd_surveillance'],
      permitted_domains_at_initiation: ['chronic_disease_longitudinal'],
    };
    const result = evaluateI029GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.invalidationReason).toBe('permitted_domain_drift' satisfies InvalidationReason);
    expect(result.failedCondition).toBe(3);

    assertInvariants(['I-029'], { i029Result: result });
  });
});

// ---------------------------------------------------------------------------
// Condition 4: Consent cohort hash change → consent_cohort_change
// ---------------------------------------------------------------------------

describe('I-029 gate — condition 4: consent cohort must not change during export', () => {
  it('should reject with consent_cohort_change when cohort hash changes mid-export', () => {
    const input: I029GateInput = {
      ...BASE_VALID_INPUT,
      consent_cohort_hash_initiated: 'abc123',
      consent_cohort_hash_completed: 'xyz789', // changed mid-export
    };
    const result = evaluateI029GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.invalidationReason).toBe('consent_cohort_change' satisfies InvalidationReason);
    expect(result.failedCondition).toBe(4);

    assertInvariants(['I-029'], { i029Result: result });
  });
});

// ---------------------------------------------------------------------------
// Condition 5: Per-patient active consent → consent_revocation_mid_export
// ---------------------------------------------------------------------------

describe('I-029 gate — condition 5: per-patient active consent required at completion', () => {
  it('should reject with consent_revocation_mid_export when a patient revokes during export', () => {
    const input: I029GateInput = {
      ...BASE_VALID_INPUT,
      all_patients_have_active_consent: false,
    };
    const result = evaluateI029GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.invalidationReason).toBe(
      'consent_revocation_mid_export' satisfies InvalidationReason,
    );
    expect(result.failedCondition).toBe(5);

    assertInvariants(['I-029'], { i029Result: result });
  });
});

// ---------------------------------------------------------------------------
// Condition 6: Grant artifact valid → grant_artifact_invalidated
// (added v5.2 patch 2026-05-02 per Codex Round-12 Scope 3 HIGH-1)
// ---------------------------------------------------------------------------

describe('I-029 gate — condition 6: per-export grant artifact must be valid at completion', () => {
  it('should reject with grant_artifact_invalidated when grant is expired at completion-time', () => {
    const input: I029GateInput = {
      ...BASE_VALID_INPUT,
      grant_artifact_unexpired: false, // grant expired between initiation and completion
    };
    const result = evaluateI029GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.invalidationReason).toBe(
      'grant_artifact_invalidated' satisfies InvalidationReason,
    );
    expect(result.failedCondition).toBe(6);

    assertInvariants(['I-029'], { i029Result: result });
  });

  it('should reject with grant_artifact_invalidated when signer chain is rescinded', () => {
    const input: I029GateInput = {
      ...BASE_VALID_INPUT,
      grant_signer_chain_intact: false, // signer rescinded between initiation and completion
    };
    const result = evaluateI029GateStub(input);

    expect(result.passed).toBe(false);
    expect(result.invalidationReason).toBe('grant_artifact_invalidated');
    expect(result.failedCondition).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// All 6 conditions pass — delivery succeeds
// ---------------------------------------------------------------------------

describe('I-029 gate — all conditions pass: delivery succeeds', () => {
  it('should pass when all 6 conditions are met', () => {
    const result = evaluateI029GateStub(BASE_VALID_INPUT);

    expect(result.passed).toBe(true);
    expect(result.invalidationReason).toBeNull();
    expect(result.failedCondition).toBeNull();

    assertInvariants(['I-029'], { i029Result: result });
  });

  it.todo(
    'should emit research_export.delivered domain event when all 6 conditions pass ' +
      '(blocked on src/lib/domain-events.ts and src/lib/i029-gate.ts — appsec-expert agent)',
  );

  it.todo(
    'should emit research.export_completed(status=completed) audit at audit_sensitivity_level=high_pii ' +
      'when all 6 conditions pass (I-031; blocked on src/lib/audit.ts — appsec-expert agent)',
  );
});

// ---------------------------------------------------------------------------
// Audit-side requirements — invalidation audit MUST emit (bare suppression forbidden)
// ---------------------------------------------------------------------------

describe('I-029 + I-003 — invalidation audit must emit (bare suppression forbidden)', () => {
  it.todo(
    'should emit research.export_completed(status=invalidated, invalidation_reason=dsa_inactive) ' +
      'and concurrent signal_enforcement_trigger Category B audit when condition 1 fails. ' +
      'Blocked on src/lib/audit.ts + src/lib/i029-gate.ts integration (appsec-expert agent).',
  );

  it.todo(
    'should emit research.export_completed at audit_sensitivity_level=high_pii on invalidation (I-031). ' +
      'Blocked on src/lib/audit.ts integration.',
  );

  // This test is runnable now — it exercises the assertion helper with a constructed
  // audit record shape to verify the helper logic itself is correct.
  it('should detect missing audit_sensitivity_level=high_pii on a research.export_completed record', async () => {
    // Construct a stub audit record with the wrong sensitivity level.
    const stubbedRecord = {
      audit_id: 'aud_i029_test_001',
      timestamp: new Date().toISOString(),
      tenant_id: TENANT_US,
      actor_type: 'system' as const,
      actor_id: 'sys_research',
      actor_tenant_id: null,
      target_patient_id: null,
      action: 'research.export_completed',
      category: 'B' as const,
      audit_sensitivity_level: 'standard' as const, // WRONG — should be high_pii per I-031
      resource_type: 'ResearchDataExport',
      resource_id: 'rde_test_001',
      detail: { status: 'invalidated', invalidation_reason: 'dsa_inactive' },
      ai_workload_type: null,
      autonomy_level: null,
      hash_chain: {
        partition: 'rde_test_001',
        sequence_number: 1,
        previous_hash: '0'.repeat(64),
        record_hash: '0'.repeat(64),
      },
    };

    expect(() => assertHighPiiSensitivity(stubbedRecord)).toThrow(/I-031 VIOLATION/);
  });
});
