/**
 * I-012 reject-unless three-clause gate — unit-style integration tests.
 *
 * Covers `src/lib/i012-gate.ts evaluateI012Gate()`, which until this commit
 * had ZERO test coverage despite encoding the platform-floor reject-unless
 * rule for prescribing / refill / medication_order execution.
 *
 * Why this matters:
 *   I-012 is one of the four hardest invariants in the platform — clinician
 *   sign-off MUST be enforced before any prescribing-class action transitions
 *   to `executed`. A regression here is a clinical-safety incident, not a
 *   performance issue. The gate's three clauses are AND-joined; loosening
 *   any one to OR-style or "skip if unknown" is forbidden.
 *
 * Three-clause rule (Master PRD v1.10 §13.7 + WORKLOAD_TAXONOMY v5.2 §2.2):
 *   1. autonomy_level === 'action_with_confirm' (string equality, not membership).
 *   2. An explicit clinician confirmation event exists in the audit chain
 *      (scoped to action_id, prior to executed transition).
 *   3. Confirming actor holds an RBAC role authorized for the action class
 *      per RBAC v1.1.
 *
 * Stub behavior (test-mode only, gated on NODE_ENV='test'):
 *   - Clause 2: uses `confirming_actor` presence + non-empty actor_id as a
 *     proxy for the audit-chain query. The production stub THROWS to prevent
 *     silent pass-through; tests run in NODE_ENV='test' so the stub returns
 *     deterministic state.
 *   - Clause 3: 'clinician' / 'protocol_clinician_lead' authorized for I-012
 *     action classes at v1.0; everything else unauthorized.
 *
 * Coverage in this file:
 *   - Happy path (all three clauses pass)
 *   - Clause 1: every documented failure mode of the autonomy-level check
 *     (null / undefined / empty / unknown / wrong-active / reserved)
 *   - Clause 2: absent confirming_actor + empty actor_id mismatch
 *   - Clause 3: every non-clinician role sample + role_not_found
 *   - Multi-clause failures: violated_clauses array contents are correct
 *     (no missing clauses, no extras)
 *   - Envelope sentinels: envelope_ai_workload_type / envelope_autonomy_level
 *     pinning per AUDIT_EVENTS v5.2 §I-012 reject-unless rejection envelope
 *
 * Spec references:
 *   - I-012 (clinician sign-off required for prescribing at launch)
 *   - I-003 (audit append-only — rejection audit event MUST be emitted by
 *     caller; bare suppression forbidden — tested at the integration
 *     boundary by verifying the gate returns enough envelope context for
 *     the caller to populate the rejection event)
 *   - AUDIT_EVENTS v5.2 §I-012 closure rule
 *   - WORKLOAD_TAXONOMY v5.2 §2.2 I-012 preservation rule
 *   - AUTONOMY_LEVELS v5.2 §2.3 + §5 per-action validation rule 5
 *   - Master PRD v1.10 §13.7 (single normative source of truth)
 */

import { describe, expect, it } from 'vitest';

import {
  evaluateI012Gate,
  type I012ActionClass,
  type I012ActionContext,
  type I012GateResult,
} from '../../src/lib/i012-gate.ts';
import { ulid } from '../../src/lib/ulid.ts';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Build a happy-path action context (all three clauses pass when used as-is). */
function happyCtx(overrides: Partial<I012ActionContext> = {}): I012ActionContext {
  return {
    action_id: ulid(),
    action_class: 'prescribing',
    attempted_autonomy_level: 'action_with_confirm',
    attempted_ai_workload_type: 'protocol_execution',
    attempted_actor_id: 'usr_test_clinician',
    attempted_actor_type: 'clinician',
    confirming_actor: {
      actor_id: 'usr_clinician_signoff',
      actor_role: 'clinician',
    },
    ...overrides,
  };
}

/**
 * Variant of happyCtx() that returns a context WITHOUT the `confirming_actor`
 * key (rather than `confirming_actor: undefined`). The `I012ActionContext`
 * interface marks confirming_actor as optional, and this repo enables
 * `exactOptionalPropertyTypes` in tsconfig — under that mode, an explicit
 * `undefined` value is rejected and the key must be omitted entirely. This
 * helper lets clause-2/clause-3 absent-actor tests express intent cleanly.
 */
function happyCtxNoActor(
  overrides: Omit<Partial<I012ActionContext>, 'confirming_actor'> = {},
): I012ActionContext {
  const base = happyCtx(overrides);
  // Construct without confirming_actor (object rest discards the key).
  const { confirming_actor: _omit, ...rest } = base;
  return rest;
}

/** Type guard so tests can narrow `pass: false` and access violated_clauses. */
function expectFail(r: I012GateResult): asserts r is Extract<I012GateResult, { pass: false }> {
  expect(r.pass).toBe(false);
}

// ---------------------------------------------------------------------------
// 1. Happy path — all three clauses pass
// ---------------------------------------------------------------------------

describe('evaluateI012Gate — happy path (all three clauses pass)', () => {
  it('returns { pass: true } when autonomy=action_with_confirm + clinician confirmation + clinician RBAC', async () => {
    const result = await evaluateI012Gate(happyCtx());
    expect(result).toEqual({ pass: true });
  });

  it('passes for refill action class with same shape', async () => {
    const result = await evaluateI012Gate(happyCtx({ action_class: 'refill' }));
    expect(result).toEqual({ pass: true });
  });

  it('passes for medication_order action class with same shape', async () => {
    const result = await evaluateI012Gate(happyCtx({ action_class: 'medication_order' }));
    expect(result).toEqual({ pass: true });
  });

  it('passes when confirming_actor.actor_role is protocol_clinician_lead (also authorized)', async () => {
    const result = await evaluateI012Gate(
      happyCtx({
        confirming_actor: { actor_id: 'usr_pcl', actor_role: 'protocol_clinician_lead' },
      }),
    );
    expect(result).toEqual({ pass: true });
  });
});

// ---------------------------------------------------------------------------
// 2. Clause 1 — autonomy_level string equality (every documented failure mode)
// ---------------------------------------------------------------------------

describe('evaluateI012Gate — clause 1 (autonomy_level string equality)', () => {
  it('rejects when autonomy_level is null', async () => {
    const r = await evaluateI012Gate(happyCtx({ attempted_autonomy_level: null }));
    expectFail(r);
    expect(r.violated_clauses).toContain('autonomy_level_string_equality');
    expect(r.violated_clauses).not.toContain('reserved_level_without_activation_audit_event');
  });

  it('rejects when autonomy_level is undefined', async () => {
    const r = await evaluateI012Gate(happyCtx({ attempted_autonomy_level: undefined }));
    expectFail(r);
    expect(r.violated_clauses).toContain('autonomy_level_string_equality');
  });

  it('rejects when autonomy_level is empty string', async () => {
    const r = await evaluateI012Gate(happyCtx({ attempted_autonomy_level: '' }));
    expectFail(r);
    expect(r.violated_clauses).toContain('autonomy_level_string_equality');
  });

  it('rejects when autonomy_level is "advisory" (active but wrong)', async () => {
    const r = await evaluateI012Gate(happyCtx({ attempted_autonomy_level: 'advisory' }));
    expectFail(r);
    expect(r.violated_clauses).toContain('autonomy_level_string_equality');
    expect(r.violated_clauses).not.toContain('reserved_level_without_activation_audit_event');
  });

  it('rejects when autonomy_level is "suggestion" (active but wrong)', async () => {
    const r = await evaluateI012Gate(happyCtx({ attempted_autonomy_level: 'suggestion' }));
    expectFail(r);
    expect(r.violated_clauses).toContain('autonomy_level_string_equality');
    expect(r.violated_clauses).not.toContain('reserved_level_without_activation_audit_event');
  });

  it('rejects when autonomy_level is "action_with_audit_only" (RESERVED — pins both clauses)', async () => {
    // Reserved levels MUST trip both `reserved_level_without_activation_audit_event`
    // AND `autonomy_level_string_equality` per i012-gate's encoding of the
    // WORKLOAD_TAXONOMY v5.2 reject-unless rule. This double-pin is what
    // distinguishes a "wrong active level" rejection from a "tried to use
    // a reserved level without ADR activation" rejection.
    const r = await evaluateI012Gate(
      happyCtx({ attempted_autonomy_level: 'action_with_audit_only' }),
    );
    expectFail(r);
    expect(r.violated_clauses).toContain('autonomy_level_string_equality');
    expect(r.violated_clauses).toContain('reserved_level_without_activation_audit_event');
  });

  it('rejects when autonomy_level is "fully_autonomous" (RESERVED — pins both clauses)', async () => {
    const r = await evaluateI012Gate(happyCtx({ attempted_autonomy_level: 'fully_autonomous' }));
    expectFail(r);
    expect(r.violated_clauses).toContain('autonomy_level_string_equality');
    expect(r.violated_clauses).toContain('reserved_level_without_activation_audit_event');
  });

  it('rejects when autonomy_level is an unknown future enum value', async () => {
    const r = await evaluateI012Gate(
      happyCtx({ attempted_autonomy_level: 'whatever_new_level_v2030' }),
    );
    expectFail(r);
    expect(r.violated_clauses).toContain('autonomy_level_string_equality');
    // Unknown values are NOT marked as reserved — they're just unknown.
    expect(r.violated_clauses).not.toContain('reserved_level_without_activation_audit_event');
  });

  it('regression guard: NEVER passes for any value other than exact string "action_with_confirm"', async () => {
    // Pin the string-equality (not membership) semantics. Any string-
    // similarity or case-insensitive comparison would be a regression.
    const lookalikes = [
      'Action_With_Confirm',
      'ACTION_WITH_CONFIRM',
      'action_with_confirm ', // trailing space
      ' action_with_confirm',
      'action-with-confirm',
      'actionWithConfirm',
    ];
    for (const v of lookalikes) {
      const r = await evaluateI012Gate(happyCtx({ attempted_autonomy_level: v }));
      expectFail(r);
      expect(r.violated_clauses).toContain('autonomy_level_string_equality');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Clause 2 — audit chain confirmation event
// ---------------------------------------------------------------------------

describe('evaluateI012Gate — clause 2 (audit chain confirmation event)', () => {
  it('rejects when confirming_actor is absent — confirmation_event_state="absent"', async () => {
    const r = await evaluateI012Gate(happyCtxNoActor());
    expectFail(r);
    expect(r.violated_clauses).toContain('audit_chain_confirmation_event_missing');
    expect(r.confirmation_event_state).toBe('absent');
  });

  it('rejects when confirming_actor.actor_id is empty — confirmation_event_state="present-but-mismatched-actor"', async () => {
    const r = await evaluateI012Gate(
      happyCtx({
        confirming_actor: { actor_id: '', actor_role: 'clinician' },
      }),
    );
    expectFail(r);
    expect(r.violated_clauses).toContain('audit_chain_confirmation_event_missing');
    expect(r.confirmation_event_state).toBe('present-but-mismatched-actor');
  });
});

// ---------------------------------------------------------------------------
// 4. Clause 3 — RBAC authorization
// ---------------------------------------------------------------------------

describe('evaluateI012Gate — clause 3 (RBAC authorization)', () => {
  const unauthorizedRoles = [
    'pharmacist',
    'patient',
    'tenant_admin',
    'platform_admin',
    'operator',
    'research_data_steward',
    'marketing_operator',
  ];

  for (const role of unauthorizedRoles) {
    it(`rejects when confirming_actor.actor_role is "${role}" (unauthorized for I-012)`, async () => {
      const r = await evaluateI012Gate(
        happyCtx({
          confirming_actor: { actor_id: `usr_${role}`, actor_role: role },
        }),
      );
      expectFail(r);
      expect(r.violated_clauses).toContain('confirming_actor_rbac_unauthorized');
      expect(r.rbac_role_check_result).toBe('unauthorized');
    });
  }

  it('reports rbac_role_check_result="role_not_found" when confirming_actor is absent', async () => {
    // When confirming_actor is absent, both clause 2 (confirmation event) AND
    // clause 3 (RBAC) fail; clause 3 reports the absent state distinctly as
    // role_not_found (vs unauthorized for a present-but-wrong role).
    const r = await evaluateI012Gate(happyCtxNoActor());
    expectFail(r);
    expect(r.rbac_role_check_result).toBe('role_not_found');
  });
});

// ---------------------------------------------------------------------------
// 5. Multi-clause failures — violated_clauses contents
// ---------------------------------------------------------------------------

describe('evaluateI012Gate — multi-clause failures', () => {
  it('lists ALL three clause-violation codes when nothing is right', async () => {
    // Inline construct without confirming_actor (exactOptionalPropertyTypes
    // forbids `confirming_actor: undefined` so the key is just omitted).
    const r = await evaluateI012Gate({
      action_id: ulid(),
      action_class: 'prescribing',
      attempted_autonomy_level: 'advisory', // wrong active level
      attempted_ai_workload_type: 'protocol_execution',
      attempted_actor_id: 'usr_attempt',
      attempted_actor_type: 'patient',
      // confirming_actor key intentionally omitted → clause 2 + clause 3 fail
    });
    expectFail(r);
    expect(r.violated_clauses).toContain('autonomy_level_string_equality');
    expect(r.violated_clauses).toContain('audit_chain_confirmation_event_missing');
    expect(r.violated_clauses).toContain('confirming_actor_rbac_unauthorized');
  });

  it('reserved level + missing confirmation produces 4 violations (clause 1 reserved double-pin + clause 2 + clause 3)', async () => {
    const r = await evaluateI012Gate(
      happyCtxNoActor({
        attempted_autonomy_level: 'fully_autonomous',
      }),
    );
    expectFail(r);
    expect(r.violated_clauses).toContain('reserved_level_without_activation_audit_event');
    expect(r.violated_clauses).toContain('autonomy_level_string_equality');
    expect(r.violated_clauses).toContain('audit_chain_confirmation_event_missing');
    expect(r.violated_clauses).toContain('confirming_actor_rbac_unauthorized');
    // Sanity: violated_clauses length is exactly 4 — not silently swallowing
    // or duplicating any code.
    expect(r.violated_clauses).toHaveLength(4);
  });

  it('does NOT report autonomy violation when clause 1 passes (clean clause 2/3 only failure)', async () => {
    const r = await evaluateI012Gate(
      happyCtx({
        attempted_autonomy_level: 'action_with_confirm', // clause 1 passes
        confirming_actor: { actor_id: 'usr_pharm', actor_role: 'pharmacist' }, // clauses 2 OK, 3 fails
      }),
    );
    expectFail(r);
    expect(r.violated_clauses).not.toContain('autonomy_level_string_equality');
    expect(r.violated_clauses).not.toContain('reserved_level_without_activation_audit_event');
    expect(r.violated_clauses).not.toContain('audit_chain_confirmation_event_missing');
    expect(r.violated_clauses).toContain('confirming_actor_rbac_unauthorized');
  });
});

// ---------------------------------------------------------------------------
// 6. Envelope sentinels — envelope_ai_workload_type / envelope_autonomy_level
// ---------------------------------------------------------------------------

describe('evaluateI012Gate — envelope sentinels (rejection envelope population)', () => {
  it('uses "rejected_invalid_attempt" sentinel for null ai_workload_type', async () => {
    const r = await evaluateI012Gate(
      happyCtx({
        attempted_autonomy_level: 'advisory', // force rejection
        attempted_ai_workload_type: null,
      }),
    );
    expectFail(r);
    expect(r.envelope_ai_workload_type).toBe('rejected_invalid_attempt');
  });

  it('uses "rejected_invalid_attempt" sentinel for unknown ai_workload_type', async () => {
    const r = await evaluateI012Gate(
      happyCtx({
        attempted_autonomy_level: 'advisory',
        attempted_ai_workload_type: 'autonomous_agent', // RESERVED — not yet active
      }),
    );
    expectFail(r);
    expect(r.envelope_ai_workload_type).toBe('rejected_invalid_attempt');
  });

  it('preserves active ai_workload_type values (conversational_assistant / protocol_execution / n/a)', async () => {
    for (const wl of ['conversational_assistant', 'protocol_execution', 'n/a']) {
      const r = await evaluateI012Gate(
        happyCtx({
          attempted_autonomy_level: 'advisory', // force rejection
          attempted_ai_workload_type: wl,
        }),
      );
      expectFail(r);
      expect(r.envelope_ai_workload_type).toBe(wl);
    }
  });

  it('uses "rejected_invalid_attempt" sentinel for null autonomy_level', async () => {
    const r = await evaluateI012Gate(
      happyCtx({
        attempted_autonomy_level: null,
        attempted_ai_workload_type: 'protocol_execution',
      }),
    );
    expectFail(r);
    expect(r.envelope_autonomy_level).toBe('rejected_invalid_attempt');
  });

  it('uses "rejected_invalid_attempt" sentinel for unknown autonomy_level', async () => {
    const r = await evaluateI012Gate(
      happyCtx({
        attempted_autonomy_level: 'whatever_new_level_v2030',
        attempted_ai_workload_type: 'protocol_execution',
      }),
    );
    expectFail(r);
    expect(r.envelope_autonomy_level).toBe('rejected_invalid_attempt');
  });

  it('preserves known active autonomy_level values on rejection (advisory/suggestion)', async () => {
    for (const lvl of ['advisory', 'suggestion']) {
      const r = await evaluateI012Gate(
        happyCtx({
          attempted_autonomy_level: lvl,
          // confirming_actor present + clinician — only clause 1 fails so we
          // can read the envelope_autonomy_level cleanly.
        }),
      );
      expectFail(r);
      expect(r.envelope_autonomy_level).toBe(lvl);
    }
  });

  it('preserves RESERVED autonomy_level values on rejection (action_with_audit_only / fully_autonomous)', async () => {
    // Reserved levels are KNOWN — the rejection envelope preserves what was
    // attempted so the audit record shows exactly what the offending caller
    // tried. The sentinel "rejected_invalid_attempt" is reserved for null /
    // unknown / future-enum values.
    for (const lvl of ['action_with_audit_only', 'fully_autonomous']) {
      const r = await evaluateI012Gate(happyCtx({ attempted_autonomy_level: lvl }));
      expectFail(r);
      expect(r.envelope_autonomy_level).toBe(lvl);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Action class coverage — confirms all three I-012 action classes route
// ---------------------------------------------------------------------------

describe('evaluateI012Gate — action class coverage', () => {
  const actionClasses: I012ActionClass[] = ['prescribing', 'refill', 'medication_order'];

  for (const cls of actionClasses) {
    it(`evaluates clauses for action_class="${cls}" (passes happy path; fails on bad RBAC)`, async () => {
      // Happy
      const ok = await evaluateI012Gate(happyCtx({ action_class: cls }));
      expect(ok).toEqual({ pass: true });
      // RBAC fail
      const bad = await evaluateI012Gate(
        happyCtx({
          action_class: cls,
          confirming_actor: { actor_id: 'usr_pharm', actor_role: 'pharmacist' },
        }),
      );
      expectFail(bad);
      expect(bad.violated_clauses).toContain('confirming_actor_rbac_unauthorized');
    });
  }
});
