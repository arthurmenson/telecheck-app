/**
 * validateTransition — latency benchmark.
 *
 * Sprint 12 / TLC-024. Second pure-function bench target after
 * Sprint 7 TLC-018's `crisisDetector.detect`. Measures the hot-path
 * latency of the Async Consult state machine validator (Sprint 9
 * TLC-021c).
 *
 * Why this bench (vs. DB-backed alternatives):
 *   - Pure function — no DB connection needed; bench harness can run
 *     without ephemeral Postgres (which the v0.1 bench infra doesn't
 *     yet provide; Sprint 13+ may add it for emitAudit / repo benches)
 *   - Hot path on Async Consult slice (every transition request runs
 *     through validateTransition before reaching the repo)
 *   - 4 distinct execution paths exercise different code branches
 *   - Reject paths (§2/§3/§4) include V8 stack-capture overhead from
 *     thrown errors — this is the ACTUAL production cost (handlers
 *     map service-error throws to HTTP envelopes), so benching the
 *     throw-cost is realistic, not a measurement artifact
 *
 * Scenarios benched:
 *   §1 happy path — INITIATED + start_intake + valid GuardContext
 *      → INTAKE (no throw; tightest scenario)
 *   §2 InvalidTransitionError — wrong from-state for event
 *      (e.g., SUBMITTED + start_intake; expecting INITIATED)
 *   §3 GuardNotSatisfiedError — runtime guard violation
 *      (e.g., abandon + hours_since_activity: 30 < 48-h threshold)
 *   §4 UnsupportedTransitionError — Sprint-10-deferred event
 *      (e.g., claim — listed in SPRINT_10_DEFERRED_EVENTS)
 *
 * Bench is SIGNAL, not GATE at v0.1. Per `tests/perf/README.md:24-30`,
 * the perf workflow lands at Sprint 11 with warn-only-via-branch-
 * protection-not-required posture. Sprint 12 TLC-023c documents the
 * promote-to-blocking path.
 *
 * Threshold rationale (per `tests/perf/check-thresholds.ts:THRESHOLDS`):
 *   §1 happy path        p99 < 2μs   (pure logic; tight)
 *   §2 InvalidTransition  p99 < 10μs  (loose; throw-cost dominates)
 *   §3 GuardNotSatisfied  p99 < 10μs  (same)
 *   §4 UnsupportedEvent   p99 < 10μs  (same)
 *
 * Spec references:
 *   - State Machines v1.1 §3 (canonical transition table)
 *   - Async Consult Slice PRD v1.0 §12
 *   - Sprint 9 / TLC-021c (state-machine.ts implementation)
 *   - Sprint 12 / TLC-024 (this bench)
 *   - ORT v1.5 OR-218 (Tier-1 launch-blocking; partly closed at
 *     Sprint 11 TLC-023a/b; this bench extends coverage)
 */

import { bench, describe } from 'vitest';

import {
  type GuardContext,
  GuardNotSatisfiedError,
  InvalidTransitionError,
  UnsupportedTransitionError,
  validateTransition,
} from '../../../src/modules/async-consult/internal/state-machine.ts';

// ---------------------------------------------------------------------------
// §1 happy path — INITIATED + start_intake → INTAKE
// ---------------------------------------------------------------------------

describe('validateTransition — §1 happy path (INITIATED + start_intake → INTAKE)', () => {
  const happyCtx: GuardContext = {
    event: 'start_intake',
    guard: { payment_confirmed: true },
  };

  bench(
    'validateTransition INITIATED + start_intake returns INTAKE',
    () => {
      validateTransition('INITIATED', 'start_intake', happyCtx);
    },
    { time: 500 },
  );
});

// ---------------------------------------------------------------------------
// §2 InvalidTransitionError — wrong from-state for event
// ---------------------------------------------------------------------------

describe('validateTransition — §2 InvalidTransitionError (SUBMITTED + start_intake)', () => {
  const ctx: GuardContext = {
    event: 'start_intake',
    guard: { payment_confirmed: true },
  };

  bench(
    'validateTransition SUBMITTED + start_intake throws InvalidTransitionError',
    () => {
      // Per Codex perf-bench-r1 MEDIUM closure 2026-05-05: catch ONLY
      // the expected error class; rethrow others. Without this, a
      // regression that returns normally OR throws a cheaper error
      // would silently complete the bench and let check-thresholds.ts
      // report OK while no longer measuring production-realistic
      // reject-path cost.
      try {
        validateTransition('SUBMITTED', 'start_intake', ctx);
        // Reaching here = expected throw didn't happen. Surface as
        // bench failure (rethrow propagates to vitest).
        throw new Error(
          'Bench fidelity violation: validateTransition returned normally; ' +
            'expected InvalidTransitionError',
        );
      } catch (err) {
        if (!(err instanceof InvalidTransitionError)) {
          // Wrong error class (or the fidelity-violation Error from
          // the missing-throw branch above). Rethrow to fail the bench.
          throw err;
        }
        // Expected throw — V8 stack-capture cost is the measurement.
      }
    },
    { time: 500 },
  );
});

// ---------------------------------------------------------------------------
// §3 GuardNotSatisfiedError — runtime guard violation
// ---------------------------------------------------------------------------

describe('validateTransition — §3 GuardNotSatisfiedError (abandon + 30h < 48h threshold)', () => {
  const ctx: GuardContext = {
    event: 'abandon',
    // hours_since_activity below the 48h threshold — runtime guard fails
    guard: { hours_since_activity: 30 },
  };

  bench(
    'validateTransition INTAKE + abandon (30h) throws GuardNotSatisfiedError',
    () => {
      try {
        validateTransition('INTAKE', 'abandon', ctx);
        throw new Error(
          'Bench fidelity violation: validateTransition returned normally; ' +
            'expected GuardNotSatisfiedError',
        );
      } catch (err) {
        if (!(err instanceof GuardNotSatisfiedError)) {
          throw err;
        }
      }
    },
    { time: 500 },
  );
});

// ---------------------------------------------------------------------------
// §4 UnsupportedTransitionError — Sprint-10-deferred event
// ---------------------------------------------------------------------------

describe('validateTransition — §4 UnsupportedTransitionError (claim — Sprint 10 deferred)', () => {
  // The discriminated-union GuardContext type doesn't include 'claim'
  // (Sprint-10-deferred events are NOT in the discriminated union),
  // so we construct the context via cast for the bench. This mirrors
  // the production-runtime path where an external caller (queue
  // consumer / decoded JSON) supplies the deferred event by string.
  const ctx = {
    event: 'claim',
    guard: {},
  } as unknown as GuardContext;

  bench(
    'validateTransition QUEUED + claim throws UnsupportedTransitionError',
    () => {
      try {
        // 'claim' is a Sprint-10-deferred event listed in
        // SPRINT_10_DEFERRED_EVENTS. validateTransition throws
        // UnsupportedTransitionError BEFORE transition lookup +
        // event/context match check (Codex async-consult-r8 closure).
        validateTransition(
          'QUEUED',
          'claim' as Parameters<typeof validateTransition>[1],
          ctx,
        );
        throw new Error(
          'Bench fidelity violation: validateTransition returned normally; ' +
            'expected UnsupportedTransitionError',
        );
      } catch (err) {
        if (!(err instanceof UnsupportedTransitionError)) {
          throw err;
        }
      }
    },
    { time: 500 },
  );
});
