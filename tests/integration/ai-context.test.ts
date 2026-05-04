/**
 * AI workload type + autonomy level resolver — unit-style integration tests.
 *
 * Covers `src/lib/ai-context.ts` (`resolveWorkloadType`, `resolveAutonomyLevel`,
 * `resolveAiContext`), which until this commit had ZERO test coverage despite
 * being the runtime gatekeeper for ADR-029 / WORKLOAD_TAXONOMY v5.2 reserved
 * workload types and AUTONOMY_LEVELS v5.2 reserved autonomy levels.
 *
 * Why this matters:
 *   The whole point of the WORKLOAD_TAXONOMY contract's "reserved" tier is
 *   that those identifiers cannot be used at runtime until (a) a successor
 *   ADR is accepted AND (b) an activation audit event lands in the immutable
 *   chain. The resolvers in ai-context.ts are the ONLY runtime point where
 *   that "you can't use this yet" promise is enforced. A regression that
 *   silently lets a reserved value through means an entire taxonomy of
 *   AI-behavior contracts (audit envelope shape, RBAC scoping, kill-switch
 *   semantics) bypasses the platform's documented activation discipline.
 *
 * Coverage in this file:
 *   1. resolveWorkloadType
 *      - Active values pass through (`conversational_assistant`, `protocol_execution`)
 *      - Sentinels throw `SentinelWorkloadTypeError` (`rejected_invalid_attempt`, `n/a`)
 *      - Reserved types throw `ReservedWorkloadTypeError` because their
 *        feature flags are zod-validated to false at v1.0 (`autonomous_agent`,
 *        `multi_agent_supervisor`, `tool_using_agent`)
 *      - Unknown future values throw `ReservedWorkloadTypeError`
 *      - Empty string throws `ReservedWorkloadTypeError`
 *
 *   2. resolveAutonomyLevel
 *      - Active values pass through (`advisory`, `suggestion`, `action_with_confirm`)
 *      - Sentinels throw `SentinelWorkloadTypeError` (note: same error class
 *        as workload sentinels per current implementation; pinning that
 *        choice and flagging as a SPEC ISSUE in the test header)
 *      - Reserved levels throw `ReservedAutonomyLevelError`
 *        (`action_with_audit_only`, `fully_autonomous`)
 *      - Unknown future values throw `ReservedAutonomyLevelError`
 *      - Empty string throws `ReservedAutonomyLevelError`
 *
 *   3. resolveAiContext (pair validator)
 *      - conversational_assistant + advisory → passes (only valid pair per §2.1)
 *      - conversational_assistant + suggestion / action_with_confirm → throws
 *        (the reason "conversational_assistant only supports advisory" appears
 *        in the message)
 *      - protocol_execution + each of advisory / suggestion / action_with_confirm
 *        → all three pass (per §2.2)
 *      - Reserved workload type fails BEFORE the pair check
 *      - Reserved autonomy level fails BEFORE the pair check
 *
 *   4. Error class identity discipline
 *      - Reserved workload values throw an error whose `name` is
 *        `ReservedWorkloadTypeError` (not the generic `Error`) so callers
 *        can `instanceof`-discriminate without parsing message text.
 *      - Reserved autonomy values throw with `name === 'ReservedAutonomyLevelError'`.
 *      - Sentinels throw with `name === 'SentinelWorkloadTypeError'`.
 *
 * SPEC ISSUE — sentinel error class for autonomy level
 *   The current implementation throws a `SentinelWorkloadTypeError` from
 *   `resolveAutonomyLevel` when the input is a sentinel. The error class
 *   name says "workload" even though the field is autonomy_level. This is
 *   either a copy-paste artifact OR a deliberate "sentinels are workload-
 *   shaped" simplification. Tests pin the current behavior so any future
 *   fix that splits this into a `SentinelAutonomyLevelError` triggers a
 *   deliberate conversation rather than a silent class rename.
 *
 * Spec references:
 *   - ADR-029 (AI Workload Taxonomy)
 *   - WORKLOAD_TAXONOMY v5.2 §1 (sentinels) §2 (active+pair rules) §3 (reserved)
 *   - AUTONOMY_LEVELS v5.2 §3 (reserved levels need ADR-030)
 *   - I-012 (prescribing-class actions require action_with_confirm)
 *   - AUDIT_EVENTS v5.2 §1 (every AI audit carries ai_workload_type + autonomy_level)
 */

import { describe, expect, it } from 'vitest';

import {
  ReservedAutonomyLevelError,
  ReservedWorkloadTypeError,
  SentinelWorkloadTypeError,
  resolveAiContext,
  resolveAutonomyLevel,
  resolveWorkloadType,
} from '../../src/lib/ai-context.ts';

// ---------------------------------------------------------------------------
// 1. resolveWorkloadType — active / sentinel / reserved / unknown
// ---------------------------------------------------------------------------

describe('resolveWorkloadType', () => {
  it('accepts active value "conversational_assistant"', () => {
    expect(resolveWorkloadType('conversational_assistant')).toBe('conversational_assistant');
  });

  it('accepts active value "protocol_execution"', () => {
    expect(resolveWorkloadType('protocol_execution')).toBe('protocol_execution');
  });

  it('throws SentinelWorkloadTypeError for "rejected_invalid_attempt" sentinel', () => {
    expect(() => resolveWorkloadType('rejected_invalid_attempt')).toThrow(
      SentinelWorkloadTypeError,
    );
  });

  it('throws SentinelWorkloadTypeError for "n/a" sentinel', () => {
    expect(() => resolveWorkloadType('n/a')).toThrow(SentinelWorkloadTypeError);
  });

  it('throws ReservedWorkloadTypeError for "autonomous_agent" (flag false at v1.0)', () => {
    expect(() => resolveWorkloadType('autonomous_agent')).toThrow(ReservedWorkloadTypeError);
  });

  it('throws ReservedWorkloadTypeError for "multi_agent_supervisor" (flag false at v1.0)', () => {
    expect(() => resolveWorkloadType('multi_agent_supervisor')).toThrow(ReservedWorkloadTypeError);
  });

  it('throws ReservedWorkloadTypeError for "tool_using_agent" (flag false at v1.0)', () => {
    expect(() => resolveWorkloadType('tool_using_agent')).toThrow(ReservedWorkloadTypeError);
  });

  it('throws ReservedWorkloadTypeError for unknown future value', () => {
    expect(() => resolveWorkloadType('unknown_future_workload_v2030')).toThrow(
      ReservedWorkloadTypeError,
    );
  });

  it('throws ReservedWorkloadTypeError for empty string', () => {
    expect(() => resolveWorkloadType('')).toThrow(ReservedWorkloadTypeError);
  });

  it('error message for reserved type cites WORKLOAD_TAXONOMY v5.2 §3', () => {
    try {
      resolveWorkloadType('autonomous_agent');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReservedWorkloadTypeError);
      const e = err as ReservedWorkloadTypeError;
      // The message must cite the spec section so operators reading a 500
      // log can find the activation procedure quickly.
      expect(e.message).toMatch(/WORKLOAD_TAXONOMY v5\.2/);
      expect(e.message).toMatch(/autonomous_agent/);
    }
  });

  it('regression guard — string-equality semantics (no case-folding, no trim)', () => {
    const lookalikes = [
      'Conversational_Assistant',
      'CONVERSATIONAL_ASSISTANT',
      ' conversational_assistant',
      'conversational_assistant ',
      'conversational-assistant',
      'conversationalAssistant',
    ];
    for (const v of lookalikes) {
      expect(() => resolveWorkloadType(v)).toThrow(ReservedWorkloadTypeError);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. resolveAutonomyLevel — active / sentinel / reserved / unknown
// ---------------------------------------------------------------------------

describe('resolveAutonomyLevel', () => {
  it('accepts active value "advisory"', () => {
    expect(resolveAutonomyLevel('advisory')).toBe('advisory');
  });

  it('accepts active value "suggestion"', () => {
    expect(resolveAutonomyLevel('suggestion')).toBe('suggestion');
  });

  it('accepts active value "action_with_confirm"', () => {
    expect(resolveAutonomyLevel('action_with_confirm')).toBe('action_with_confirm');
  });

  // SPEC ISSUE: current implementation throws SentinelWorkloadTypeError (not
  // SentinelAutonomyLevelError) from resolveAutonomyLevel when passed a
  // sentinel. The class name says "workload" but the calling context is
  // autonomy. Tests pin current behavior; flagging in the file header.
  it('throws SentinelWorkloadTypeError for "rejected_invalid_attempt" sentinel (current shared-class behavior)', () => {
    expect(() => resolveAutonomyLevel('rejected_invalid_attempt')).toThrow(
      SentinelWorkloadTypeError,
    );
  });

  it('throws SentinelWorkloadTypeError for "n/a" sentinel (current shared-class behavior)', () => {
    expect(() => resolveAutonomyLevel('n/a')).toThrow(SentinelWorkloadTypeError);
  });

  it('throws ReservedAutonomyLevelError for "action_with_audit_only" (flag false at v1.0)', () => {
    expect(() => resolveAutonomyLevel('action_with_audit_only')).toThrow(
      ReservedAutonomyLevelError,
    );
  });

  it('throws ReservedAutonomyLevelError for "fully_autonomous" (flag false at v1.0)', () => {
    expect(() => resolveAutonomyLevel('fully_autonomous')).toThrow(ReservedAutonomyLevelError);
  });

  it('throws ReservedAutonomyLevelError for unknown future value', () => {
    expect(() => resolveAutonomyLevel('unknown_future_level_v2030')).toThrow(
      ReservedAutonomyLevelError,
    );
  });

  it('throws ReservedAutonomyLevelError for empty string', () => {
    expect(() => resolveAutonomyLevel('')).toThrow(ReservedAutonomyLevelError);
  });

  it('error message for reserved level cites AUTONOMY_LEVELS v5.2 + ADR-030', () => {
    try {
      resolveAutonomyLevel('fully_autonomous');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ReservedAutonomyLevelError);
      const e = err as ReservedAutonomyLevelError;
      expect(e.message).toMatch(/AUTONOMY_LEVELS v5\.2/);
      expect(e.message).toMatch(/ADR-030/);
      expect(e.message).toMatch(/fully_autonomous/);
    }
  });

  it('regression guard — string-equality semantics (no case-folding, no trim)', () => {
    const lookalikes = [
      'Advisory',
      'ADVISORY',
      ' advisory',
      'advisory ',
      'Action_With_Confirm',
      'action-with-confirm',
    ];
    for (const v of lookalikes) {
      expect(() => resolveAutonomyLevel(v)).toThrow(ReservedAutonomyLevelError);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. resolveAiContext — pair validation per WORKLOAD_TAXONOMY v5.2 §2
// ---------------------------------------------------------------------------

describe('resolveAiContext (pair validation)', () => {
  it('accepts conversational_assistant + advisory (only valid pair per §2.1)', () => {
    expect(resolveAiContext('conversational_assistant', 'advisory')).toEqual({
      ai_workload_type: 'conversational_assistant',
      autonomy_level: 'advisory',
    });
  });

  it('throws when conversational_assistant is paired with suggestion', () => {
    expect(() => resolveAiContext('conversational_assistant', 'suggestion')).toThrow(
      /conversational_assistant only supports autonomy_level="advisory"/,
    );
  });

  it('throws when conversational_assistant is paired with action_with_confirm', () => {
    expect(() => resolveAiContext('conversational_assistant', 'action_with_confirm')).toThrow(
      /conversational_assistant only supports autonomy_level="advisory"/,
    );
  });

  for (const lvl of ['advisory', 'suggestion', 'action_with_confirm'] as const) {
    it(`accepts protocol_execution + ${lvl} (per §2.2 — all three active levels valid)`, () => {
      expect(resolveAiContext('protocol_execution', lvl)).toEqual({
        ai_workload_type: 'protocol_execution',
        autonomy_level: lvl,
      });
    });
  }

  it('reserved workload fails BEFORE pair check (workload error, not pair error)', () => {
    // The pair check is downstream of workload resolution. If a reserved
    // workload short-circuited at the pair check, callers would get an
    // unhelpful "invalid pair" message instead of the activation-procedure
    // citation. Pin order: workload errors first.
    expect(() => resolveAiContext('autonomous_agent', 'advisory')).toThrow(
      ReservedWorkloadTypeError,
    );
  });

  it('reserved autonomy level fails BEFORE pair check (autonomy error, not pair error)', () => {
    expect(() => resolveAiContext('protocol_execution', 'fully_autonomous')).toThrow(
      ReservedAutonomyLevelError,
    );
  });

  it('sentinel workload fails BEFORE pair check', () => {
    expect(() => resolveAiContext('rejected_invalid_attempt', 'advisory')).toThrow(
      SentinelWorkloadTypeError,
    );
  });

  it('sentinel autonomy fails BEFORE pair check (when paired with valid workload)', () => {
    expect(() => resolveAiContext('protocol_execution', 'rejected_invalid_attempt')).toThrow(
      SentinelWorkloadTypeError,
    );
  });

  it('two reserved values together — first error wins (workload checked first)', () => {
    // Pin the resolution order: workload-type validation runs before
    // autonomy-level validation. If both are reserved, the workload error
    // surfaces. A future change that flipped the order would trip this.
    let caught: unknown;
    try {
      resolveAiContext('autonomous_agent', 'fully_autonomous');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ReservedWorkloadTypeError);
  });
});

// ---------------------------------------------------------------------------
// 4. Error class identity discipline (instanceof + name)
// ---------------------------------------------------------------------------

describe('error class identity discipline', () => {
  it('ReservedWorkloadTypeError has name === "ReservedWorkloadTypeError"', () => {
    try {
      resolveWorkloadType('autonomous_agent');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).name).toBe('ReservedWorkloadTypeError');
      expect(err).toBeInstanceOf(ReservedWorkloadTypeError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('ReservedAutonomyLevelError has name === "ReservedAutonomyLevelError"', () => {
    try {
      resolveAutonomyLevel('fully_autonomous');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).name).toBe('ReservedAutonomyLevelError');
      expect(err).toBeInstanceOf(ReservedAutonomyLevelError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('SentinelWorkloadTypeError has name === "SentinelWorkloadTypeError"', () => {
    try {
      resolveWorkloadType('n/a');
      expect.fail('expected throw');
    } catch (err) {
      expect((err as Error).name).toBe('SentinelWorkloadTypeError');
      expect(err).toBeInstanceOf(SentinelWorkloadTypeError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('error classes are mutually distinct (instanceof discrimination works)', () => {
    // Concrete proof that callers can use instanceof to branch on error type
    // without parsing message strings.
    let workloadErr: unknown;
    let autonomyErr: unknown;
    let sentinelErr: unknown;
    try {
      resolveWorkloadType('autonomous_agent');
    } catch (e) {
      workloadErr = e;
    }
    try {
      resolveAutonomyLevel('fully_autonomous');
    } catch (e) {
      autonomyErr = e;
    }
    try {
      resolveWorkloadType('n/a');
    } catch (e) {
      sentinelErr = e;
    }

    expect(workloadErr).toBeInstanceOf(ReservedWorkloadTypeError);
    expect(workloadErr).not.toBeInstanceOf(ReservedAutonomyLevelError);
    expect(workloadErr).not.toBeInstanceOf(SentinelWorkloadTypeError);

    expect(autonomyErr).toBeInstanceOf(ReservedAutonomyLevelError);
    expect(autonomyErr).not.toBeInstanceOf(ReservedWorkloadTypeError);
    expect(autonomyErr).not.toBeInstanceOf(SentinelWorkloadTypeError);

    expect(sentinelErr).toBeInstanceOf(SentinelWorkloadTypeError);
    expect(sentinelErr).not.toBeInstanceOf(ReservedWorkloadTypeError);
    expect(sentinelErr).not.toBeInstanceOf(ReservedAutonomyLevelError);
  });
});
