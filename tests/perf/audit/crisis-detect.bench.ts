/**
 * crisisDetector.detect — latency benchmark.
 *
 * Sprint 7 / TLC-018 scaffold example. Measures the hot-path latency
 * of the platform-floor crisis detector (I-019). Every free-text
 * patient input field passes through `crisisDetector.detect` before
 * persistence — this latency adds to every form-response save, every
 * future chat message, every future community post.
 *
 * Why this bench (vs. emitAudit / idempotency lookup):
 *   - Pure function — no DB connection needed; bench harness can run
 *     without ephemeral Postgres (which the v0.1 bench infra doesn't
 *     yet provide)
 *   - Hot path — runs on every patient free-text input
 *   - Already functionally tested at:
 *       tests/integration/crisis-detection.test.ts (regex coverage)
 *       tests/integration/forms-intake-submission.test.ts:890+ (CRITICAL-1
 *         closure — full submission-path integration)
 *   - I-019 platform-floor — performance regression here would cascade
 *     into every patient-input write
 *
 * Scenarios benched (representative load shapes):
 *   §1 short clean text (typical "no crisis" path; first regex test
 *      fast-fails)
 *   §2 short crisis text (typical "crisis detected" path; first
 *      regex test matches)
 *   §3 long clean text (5 KB; typical free-form narrative response)
 *   §4 long text with crisis at the END (worst case for early-exit
 *      regex test loops; all patterns scan full string before match)
 *
 * Bench is SIGNAL, not GATE at v0.1. See tests/perf/README.md for
 * the operating model and Sprint 11 promotion path.
 *
 * Spec references:
 *   - I-019 (Crisis detection platform-floor; never disable, never gate
 *     behind config)
 *   - src/lib/crisis-detection.ts (the singleton being benched)
 *   - ORT v1.5 OR-218 (Performance and load test plan; Tier 1
 *     launch-blocking; verified at
 *     Telecheck_Operational_Readiness_Todo_v1_5.md:129)
 *   - tests/contracts/crisis-detection-coverage-lockdown.test.ts
 *     (Sprint 4 TLC-012-rescoped; structural lockdown)
 */

import { bench, describe } from 'vitest';

import { crisisDetector } from '../../../src/lib/crisis-detection.ts';

const TENANT = 'Telecheck-US';
const SOURCE = 'form_response';

// ---------------------------------------------------------------------------
// Representative input fixtures
// ---------------------------------------------------------------------------

const SHORT_CLEAN = 'I felt better today after my walk.';
// A phrase that matches CRISIS_PATTERNS.suicidal_ideation per
// crisis-detection.ts. Mirrors the canary used in
// forms-intake-submission.test.ts:907.
const SHORT_CRISIS = 'I want to kill myself';

// ~5 KB clean narrative — typical free-form patient response in a
// long-form intake form (e.g., chronic-care symptom narrative).
const LONG_CLEAN = (
  'I have been feeling much better since starting the new medication. ' +
  'My energy is up in the mornings and I have been able to walk to the ' +
  'park most days this week. The previous side effects (mild nausea, ' +
  'occasional dizziness) have largely resolved over the past two weeks. ' +
  'Sleep has improved — I am getting six to seven hours most nights ' +
  'instead of three to four. My family has noticed the difference too. '
).repeat(20);

// ~5 KB clean narrative with crisis text at the very END — worst case
// for the early-exit pattern loop in detect(): all patterns scan the
// full string + the late match means every pattern runs against the
// full input.
const LONG_CRISIS_AT_END = LONG_CLEAN + ' Despite all that, ' + SHORT_CRISIS;

// ---------------------------------------------------------------------------
// §1 — Short clean text (typical "no crisis" path)
// ---------------------------------------------------------------------------

describe('crisisDetector.detect — §1 short clean text', () => {
  bench(
    'detect on ~35-char clean string returns no-crisis',
    () => {
      crisisDetector.detect(SHORT_CLEAN, TENANT, SOURCE);
    },
    { time: 500 },
  );
});

// ---------------------------------------------------------------------------
// §2 — Short crisis text (first-regex-match fast path)
// ---------------------------------------------------------------------------

describe('crisisDetector.detect — §2 short crisis text', () => {
  bench(
    'detect on ~24-char crisis string returns crisis-detected',
    () => {
      crisisDetector.detect(SHORT_CRISIS, TENANT, SOURCE);
    },
    { time: 500 },
  );
});

// ---------------------------------------------------------------------------
// §3 — Long clean text (5 KB representative narrative)
// ---------------------------------------------------------------------------

describe('crisisDetector.detect — §3 long clean text', () => {
  bench(
    'detect on ~5 KB clean narrative returns no-crisis',
    () => {
      crisisDetector.detect(LONG_CLEAN, TENANT, SOURCE);
    },
    { time: 500 },
  );
});

// ---------------------------------------------------------------------------
// §4 — Long text with crisis at end (worst case)
// ---------------------------------------------------------------------------

describe('crisisDetector.detect — §4 long text with crisis at end (worst case)', () => {
  bench(
    'detect on ~5 KB narrative with crisis at end returns crisis-detected',
    () => {
      crisisDetector.detect(LONG_CRISIS_AT_END, TENANT, SOURCE);
    },
    { time: 500 },
  );
});
