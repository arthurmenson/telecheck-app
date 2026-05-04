/**
 * I-029 6-condition reject-unless gate — unit-style integration tests.
 *
 * Covers `src/lib/i029-gate.ts evaluateI029Gate()`, which until this commit
 * had ZERO test coverage despite encoding the platform-floor reject-unless
 * rule for the `research.export_completed` `ready → delivered` transition.
 *
 * Why this matters:
 *   I-029 is the youngest of the 4 hardest invariants — added 2026-05-01
 *   with the v1.10 cycle and expanded to 6 conditions in v1.10.1 hygiene
 *   round-12 (Codex Scope-3 HIGH-1 added grant-artifact re-validation as
 *   condition 6). It governs research data delivery to WHO/UN partners
 *   under ADR-028 Posture A. A regression that loosens any of the 6
 *   conditions to OR-style or "skip if unknown" is a privacy-incident
 *   waiting to happen.
 *
 * The 6 conditions (per i029-gate.ts JSDoc / I-029 / TYPES v5.2):
 *   1. dsa_status_at_export === 'active'                    → 'dsa_inactive'
 *   2. k_threshold_actual >= k_min_required                  → 'k_anonymity_violation'
 *   3. permitted_data_domains_at_export matches snapshot     → 'permitted_domain_drift'
 *   4. consent_cohort_snapshot_hash_completed === _initiated → 'consent_cohort_change'
 *   5. Every contributing patient has active ResearchConsent → 'consent_revocation_mid_export'
 *   6. Per-export grant artifact unexpired + hash-matched    → 'grant_artifact_invalidated'
 *
 * Conditions are evaluated in order 1→6 with FIRST-FAILURE SHORT-CIRCUIT.
 * The result carries a single canonical `invalidation_reason` enum value —
 * NOT an array of all violations (unlike I-012 which collects all
 * violated_clauses). This asymmetry is deliberate: the I-029 caller emits
 * a SINGLE `research.export_completed(invalidation_reason=…)` so the
 * single-reason result aligns with the audit envelope shape.
 *
 * Stub behavior (test-mode only):
 *   - Condition 5: production stub THROWS. Test mode reads
 *     `_testSetCondition5Override(...)` (default null = pass).
 *   - Condition 6: production stub THROWS. Test mode evaluates the
 *     provided `grant_artifact_validity_to` + hash equality directly.
 *
 * Coverage in this file:
 *   - Happy path (all 6 conditions pass)
 *   - Each condition's failure mode in isolation
 *   - Short-circuit ordering (first failure wins; later failures don't affect
 *     the reason returned)
 *   - Boundary cases per condition (k threshold equality, hash inequality
 *     of differing types, validity-to date semantics, etc.)
 *   - Single-reason discipline (result never carries multiple reasons)
 *
 * Spec references:
 *   - I-029 (6-condition reject-unless gate; expanded to 6 conditions
 *     v1.10.1 round-12 Codex Scope-3 HIGH-1)
 *   - I-031 (research export audits at audit_sensitivity_level=high_pii)
 *   - I-003 (audit append-only — caller MUST emit completion-attempt audit
 *     on failure; bare suppression forbidden)
 *   - AUDIT_EVENTS v5.2 §5 (research.export_completed envelope)
 *   - TYPES v5.2 ResearchDataExport.invalidation_reason canonical 6-value enum
 *   - STATE_MACHINES v1.1 ResearchExportRequest reject-unless rule
 *   - ADR-028 Research Data Partnership Posture A
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _testSetCondition5Override,
  evaluateI029Gate,
  type I029ExportContext,
  type I029GateResult,
  type I029InvalidationReason,
} from '../../src/lib/i029-gate.ts';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Build a happy-path export context — all 6 conditions pass when used as-is.
 *
 * The "pass" baseline:
 *   - DSA active
 *   - k threshold met (50 >= 11; 11 is the platform default per Master PRD §15.3)
 *   - Permitted domains match snapshot
 *   - Consent cohort hash unchanged
 *   - Condition 5 stub returns pass (override not set)
 *   - Grant artifact valid in the future + signer hash unchanged
 */
function happyCtx(overrides: Partial<I029ExportContext> = {}): I029ExportContext {
  // Validity 30 days in the future — comfortably ahead of any reasonable
  // test-clock skew. Hash values are arbitrary fixed strings (the test only
  // cares about equality, not real cryptographic provenance).
  const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    dsa_status_at_export: 'active',
    k_threshold_actual: 50,
    k_min_required: 11,
    permitted_data_domains_at_export: ['chronic_disease_longitudinal', 'ncd_surveillance'],
    permitted_data_domains_at_initiation: ['chronic_disease_longitudinal', 'ncd_surveillance'],
    consent_cohort_snapshot_hash_completed: 'sha256:cohort-fixed-hash-001',
    consent_cohort_snapshot_hash_initiated: 'sha256:cohort-fixed-hash-001',
    contributing_patient_ids: ['pat_01', 'pat_02', 'pat_03'],
    grant_artifact_id: 'grant_01HXXY',
    grant_artifact_validity_to: inThirtyDays,
    grant_signer_chain_attestation_hash_at_initiation: 'sha256:signer-fixed-hash-001',
    grant_signer_chain_attestation_hash_at_completion: 'sha256:signer-fixed-hash-001',
    ...overrides,
  };
}

/** Type-narrow a failure result so tests can read .reason cleanly. */
function expectFail(r: I029GateResult): asserts r is Extract<I029GateResult, { pass: false }> {
  expect(r.pass).toBe(false);
}

// Make sure the condition-5 override is reset between tests — it's a
// module-level mutable state that would otherwise leak across cases.
beforeEach(() => {
  _testSetCondition5Override(null);
});
afterEach(() => {
  _testSetCondition5Override(null);
});

// ---------------------------------------------------------------------------
// 1. Happy path — all six conditions pass
// ---------------------------------------------------------------------------

describe('evaluateI029Gate — happy path (all 6 conditions pass)', () => {
  it('returns { pass: true } when every condition is satisfied', async () => {
    const r = await evaluateI029Gate(happyCtx());
    expect(r).toEqual({ pass: true });
  });

  it('passes with k_threshold_actual === k_min_required (boundary equality)', async () => {
    const r = await evaluateI029Gate(happyCtx({ k_threshold_actual: 11, k_min_required: 11 }));
    expect(r).toEqual({ pass: true });
  });

  it('passes when permitted domains match in different orders (set-equality, not list-equality)', async () => {
    const r = await evaluateI029Gate(
      happyCtx({
        permitted_data_domains_at_export: ['ncd_surveillance', 'chronic_disease_longitudinal'],
        permitted_data_domains_at_initiation: ['chronic_disease_longitudinal', 'ncd_surveillance'],
      }),
    );
    expect(r).toEqual({ pass: true });
  });
});

// ---------------------------------------------------------------------------
// 2. Condition 1 — DSA status (`dsa_inactive`)
// ---------------------------------------------------------------------------

describe('evaluateI029Gate — condition 1 (DSA status active)', () => {
  for (const status of ['suspended', 'expired', 'retired'] as const) {
    it(`fails with reason="dsa_inactive" when dsa_status_at_export="${status}"`, async () => {
      const r = await evaluateI029Gate(happyCtx({ dsa_status_at_export: status }));
      expectFail(r);
      expect(r.reason).toBe<I029InvalidationReason>('dsa_inactive');
    });
  }

  it('SHORT-CIRCUIT — DSA inactive + ALL other conditions also failing → reason still "dsa_inactive"', async () => {
    // Sabotage every condition; gate must report ONLY the first violator.
    _testSetCondition5Override({ pass: false, reason: 'consent_revocation_mid_export' });
    const r = await evaluateI029Gate(
      happyCtx({
        dsa_status_at_export: 'expired', // condition 1 fails → wins
        k_threshold_actual: 1,
        k_min_required: 11, // condition 2 would fail
        permitted_data_domains_at_export: ['ncd_surveillance'],
        permitted_data_domains_at_initiation: ['chronic_disease_longitudinal'], // condition 3 would fail
        consent_cohort_snapshot_hash_completed: 'A',
        consent_cohort_snapshot_hash_initiated: 'B', // condition 4 would fail
        // condition 5 override set to fail above
        grant_artifact_validity_to: new Date(0).toISOString(), // condition 6 would fail
      }),
    );
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('dsa_inactive');
  });
});

// ---------------------------------------------------------------------------
// 3. Condition 2 — k-anonymity threshold (`k_anonymity_violation`)
// ---------------------------------------------------------------------------

describe('evaluateI029Gate — condition 2 (k-anonymity threshold)', () => {
  it('fails with reason="k_anonymity_violation" when k_threshold_actual < k_min_required', async () => {
    const r = await evaluateI029Gate(happyCtx({ k_threshold_actual: 10, k_min_required: 11 }));
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('k_anonymity_violation');
  });

  it('passes at strict equality (k=11, k_min=11) — boundary is INCLUSIVE on the lower side', async () => {
    const r = await evaluateI029Gate(happyCtx({ k_threshold_actual: 11, k_min_required: 11 }));
    expect(r).toEqual({ pass: true });
  });

  it('SHORT-CIRCUIT — k below + permitted-domain-drift + consent-cohort change → reason still "k_anonymity_violation"', async () => {
    const r = await evaluateI029Gate(
      happyCtx({
        // condition 1 OK
        k_threshold_actual: 5,
        k_min_required: 11, // condition 2 fails → wins
        permitted_data_domains_at_export: ['ncd_surveillance'],
        permitted_data_domains_at_initiation: ['chronic_disease_longitudinal'], // condition 3 would fail
        consent_cohort_snapshot_hash_completed: 'A',
        consent_cohort_snapshot_hash_initiated: 'B', // condition 4 would fail
      }),
    );
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('k_anonymity_violation');
  });
});

// ---------------------------------------------------------------------------
// 4. Condition 3 — permitted data domain match (`permitted_domain_drift`)
// ---------------------------------------------------------------------------

describe('evaluateI029Gate — condition 3 (permitted data domain match)', () => {
  it('fails with reason="permitted_domain_drift" when export adds a domain not in snapshot', async () => {
    const r = await evaluateI029Gate(
      happyCtx({
        permitted_data_domains_at_export: [
          'chronic_disease_longitudinal',
          'pharmacovigilance_signal',
        ],
        permitted_data_domains_at_initiation: ['chronic_disease_longitudinal'],
      }),
    );
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('permitted_domain_drift');
  });

  it('fails with reason="permitted_domain_drift" when export drops a domain from snapshot', async () => {
    const r = await evaluateI029Gate(
      happyCtx({
        permitted_data_domains_at_export: ['chronic_disease_longitudinal'],
        permitted_data_domains_at_initiation: ['chronic_disease_longitudinal', 'ncd_surveillance'],
      }),
    );
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('permitted_domain_drift');
  });

  it('fails with reason="permitted_domain_drift" when export swaps one domain for another', async () => {
    const r = await evaluateI029Gate(
      happyCtx({
        permitted_data_domains_at_export: ['ncd_surveillance'],
        permitted_data_domains_at_initiation: ['chronic_disease_longitudinal'],
      }),
    );
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('permitted_domain_drift');
  });

  it('passes when both sides are empty (no domains permitted, none exported — degenerate but valid)', async () => {
    // The gate evaluates set-equality. Two empty sets are equal. The CCR-side
    // protection that "no permitted domains means no export at all" is a
    // separate concern — this gate only checks drift between the two snapshots.
    const r = await evaluateI029Gate(
      happyCtx({
        permitted_data_domains_at_export: [],
        permitted_data_domains_at_initiation: [],
      }),
    );
    expect(r).toEqual({ pass: true });
  });

  it('passes when sets are equal but list contains duplicates (set-coercion is correct)', async () => {
    const r = await evaluateI029Gate(
      happyCtx({
        // Same logical set; defensive against a future caller passing duplicates.
        permitted_data_domains_at_export: [
          'chronic_disease_longitudinal',
          'chronic_disease_longitudinal',
          'ncd_surveillance',
        ],
        permitted_data_domains_at_initiation: ['chronic_disease_longitudinal', 'ncd_surveillance'],
      }),
    );
    expect(r).toEqual({ pass: true });
  });
});

// ---------------------------------------------------------------------------
// 5. Condition 4 — consent cohort snapshot hash (`consent_cohort_change`)
// ---------------------------------------------------------------------------

describe('evaluateI029Gate — condition 4 (consent cohort snapshot hash)', () => {
  it('fails with reason="consent_cohort_change" when completion hash differs from initiation hash', async () => {
    const r = await evaluateI029Gate(
      happyCtx({
        consent_cohort_snapshot_hash_initiated: 'sha256:cohort-A',
        consent_cohort_snapshot_hash_completed: 'sha256:cohort-B',
      }),
    );
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('consent_cohort_change');
  });

  it('fails when one hash is empty and the other is not (degenerate-equality)', async () => {
    const r = await evaluateI029Gate(
      happyCtx({
        consent_cohort_snapshot_hash_initiated: '',
        consent_cohort_snapshot_hash_completed: 'sha256:something',
      }),
    );
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('consent_cohort_change');
  });

  it('passes when both hashes are the same empty string (degenerate but equal)', async () => {
    // The gate evaluates string equality; equal degenerate values pass. The
    // upstream caller's responsibility is to ensure non-empty hashes are
    // computed in the first place — this gate only catches DRIFT.
    const r = await evaluateI029Gate(
      happyCtx({
        consent_cohort_snapshot_hash_initiated: '',
        consent_cohort_snapshot_hash_completed: '',
      }),
    );
    expect(r).toEqual({ pass: true });
  });
});

// ---------------------------------------------------------------------------
// 6. Condition 5 — per-patient ResearchConsent (`consent_revocation_mid_export`)
// ---------------------------------------------------------------------------

describe('evaluateI029Gate — condition 5 (per-patient active ResearchConsent)', () => {
  it('fails with reason="consent_revocation_mid_export" when test override returns failure', async () => {
    _testSetCondition5Override({ pass: false, reason: 'consent_revocation_mid_export' });
    const r = await evaluateI029Gate(happyCtx());
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('consent_revocation_mid_export');
  });

  it('passes when override is null (default test stub returns pass)', async () => {
    _testSetCondition5Override(null);
    const r = await evaluateI029Gate(happyCtx());
    expect(r).toEqual({ pass: true });
  });

  it('SHORT-CIRCUIT — condition 5 fails + condition 6 would also fail → reason="consent_revocation_mid_export"', async () => {
    _testSetCondition5Override({ pass: false, reason: 'consent_revocation_mid_export' });
    const r = await evaluateI029Gate(
      happyCtx({
        // Condition 6 fully sabotaged — gate must still return reason from condition 5.
        grant_artifact_validity_to: new Date(0).toISOString(),
        grant_signer_chain_attestation_hash_at_initiation: 'A',
        grant_signer_chain_attestation_hash_at_completion: 'B',
      }),
    );
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('consent_revocation_mid_export');
  });
});

// ---------------------------------------------------------------------------
// 7. Condition 6 — per-export grant artifact (`grant_artifact_invalidated`)
// ---------------------------------------------------------------------------

describe('evaluateI029Gate — condition 6 (grant artifact verification)', () => {
  it('fails with reason="grant_artifact_invalidated" when validity_to is in the past (expired)', async () => {
    const r = await evaluateI029Gate(
      happyCtx({
        grant_artifact_validity_to: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      }),
    );
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('grant_artifact_invalidated');
  });

  it('fails with reason="grant_artifact_invalidated" when signer-chain hash differs across init→completion', async () => {
    const r = await evaluateI029Gate(
      happyCtx({
        grant_signer_chain_attestation_hash_at_initiation: 'sha256:signer-A',
        grant_signer_chain_attestation_hash_at_completion: 'sha256:signer-B',
      }),
    );
    expectFail(r);
    expect(r.reason).toBe<I029InvalidationReason>('grant_artifact_invalidated');
  });

  it('passes when validity_to is in the future AND signer-chain hash unchanged', async () => {
    const r = await evaluateI029Gate(happyCtx());
    expect(r).toEqual({ pass: true });
  });
});

// ---------------------------------------------------------------------------
// 8. Single-reason discipline + condition-ordering audit
// ---------------------------------------------------------------------------

describe('evaluateI029Gate — single-reason discipline (no multi-reason payloads)', () => {
  it('failure result has shape { pass: false, reason: <single string> } — never an array', async () => {
    const r = await evaluateI029Gate(happyCtx({ dsa_status_at_export: 'expired' }));
    expectFail(r);
    expect(typeof r.reason).toBe('string');
    expect(Array.isArray(r.reason)).toBe(false);
    // I029 caller emits a SINGLE research.export_completed audit with
    // invalidation_reason; multi-reason payloads would break the audit shape.
  });

  it('reason value is always within the canonical 6-value enum (no free-form strings leak through)', async () => {
    const allReasons: I029InvalidationReason[] = [
      'dsa_inactive',
      'k_anonymity_violation',
      'permitted_domain_drift',
      'consent_cohort_change',
      'consent_revocation_mid_export',
      'grant_artifact_invalidated',
    ];

    // Drive each reason in isolation and collect the actual returned values.
    const observed: I029InvalidationReason[] = [];

    // 1. dsa_inactive
    {
      const r = await evaluateI029Gate(happyCtx({ dsa_status_at_export: 'expired' }));
      expectFail(r);
      observed.push(r.reason);
    }
    // 2. k_anonymity_violation
    {
      const r = await evaluateI029Gate(happyCtx({ k_threshold_actual: 1, k_min_required: 11 }));
      expectFail(r);
      observed.push(r.reason);
    }
    // 3. permitted_domain_drift
    {
      const r = await evaluateI029Gate(
        happyCtx({
          permitted_data_domains_at_export: ['ncd_surveillance'],
          permitted_data_domains_at_initiation: ['chronic_disease_longitudinal'],
        }),
      );
      expectFail(r);
      observed.push(r.reason);
    }
    // 4. consent_cohort_change
    {
      const r = await evaluateI029Gate(
        happyCtx({
          consent_cohort_snapshot_hash_initiated: 'X',
          consent_cohort_snapshot_hash_completed: 'Y',
        }),
      );
      expectFail(r);
      observed.push(r.reason);
    }
    // 5. consent_revocation_mid_export
    {
      _testSetCondition5Override({ pass: false, reason: 'consent_revocation_mid_export' });
      const r = await evaluateI029Gate(happyCtx());
      expectFail(r);
      observed.push(r.reason);
      _testSetCondition5Override(null);
    }
    // 6. grant_artifact_invalidated (via expiry)
    {
      const r = await evaluateI029Gate(
        happyCtx({
          grant_artifact_validity_to: new Date(0).toISOString(),
        }),
      );
      expectFail(r);
      observed.push(r.reason);
    }

    // Every observed reason must be in the canonical enum AND the union must
    // exactly equal the enum — no extras, no missing.
    for (const r of observed) {
      expect(allReasons).toContain(r);
    }
    expect(new Set(observed)).toEqual(new Set(allReasons));
  });

  it('CONDITION ORDER PIN — condition 1 wins over condition 2 wins over condition 3 wins over 4 wins over 5 wins over 6', async () => {
    // Compose four pairs. Each pair establishes that the EARLIER condition
    // beats the LATER one when both fail simultaneously. Together they pin
    // the documented evaluation order.

    // 1 beats 2
    {
      const r = await evaluateI029Gate(
        happyCtx({
          dsa_status_at_export: 'expired',
          k_threshold_actual: 1,
          k_min_required: 11,
        }),
      );
      expectFail(r);
      expect(r.reason).toBe<I029InvalidationReason>('dsa_inactive');
    }
    // 2 beats 3
    {
      const r = await evaluateI029Gate(
        happyCtx({
          k_threshold_actual: 1,
          k_min_required: 11,
          permitted_data_domains_at_export: ['ncd_surveillance'],
          permitted_data_domains_at_initiation: ['chronic_disease_longitudinal'],
        }),
      );
      expectFail(r);
      expect(r.reason).toBe<I029InvalidationReason>('k_anonymity_violation');
    }
    // 3 beats 4
    {
      const r = await evaluateI029Gate(
        happyCtx({
          permitted_data_domains_at_export: ['ncd_surveillance'],
          permitted_data_domains_at_initiation: ['chronic_disease_longitudinal'],
          consent_cohort_snapshot_hash_initiated: 'X',
          consent_cohort_snapshot_hash_completed: 'Y',
        }),
      );
      expectFail(r);
      expect(r.reason).toBe<I029InvalidationReason>('permitted_domain_drift');
    }
    // 4 beats 5
    {
      _testSetCondition5Override({ pass: false, reason: 'consent_revocation_mid_export' });
      const r = await evaluateI029Gate(
        happyCtx({
          consent_cohort_snapshot_hash_initiated: 'X',
          consent_cohort_snapshot_hash_completed: 'Y',
        }),
      );
      expectFail(r);
      expect(r.reason).toBe<I029InvalidationReason>('consent_cohort_change');
    }
    // 5 beats 6
    {
      _testSetCondition5Override({ pass: false, reason: 'consent_revocation_mid_export' });
      const r = await evaluateI029Gate(
        happyCtx({
          grant_artifact_validity_to: new Date(0).toISOString(),
        }),
      );
      expectFail(r);
      expect(r.reason).toBe<I029InvalidationReason>('consent_revocation_mid_export');
    }
  });
});
