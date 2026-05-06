/**
 * check-thresholds.ts — Sprint 11 / TLC-023a.
 *
 * Reads vitest bench JSON output (produced by `vitest bench
 * --outputJson <file>`) and asserts per-scenario p95 latency
 * thresholds. Exit code 0 on pass; 1 on threshold breach OR
 * malformed input.
 *
 * Usage:
 *   npx tsx tests/perf/check-thresholds.ts bench-output.json
 *   npx tsx tests/perf/check-thresholds.ts --self-test
 *
 * (tsx is a devDependency per package.json:50; .github/workflows/perf.yml
 * invokes via `npx tsx ...` — no separate compile step needed at v0.1.)
 *
 * The `--self-test` flag exercises the manifest-check + threshold logic
 * against synthetic fixtures (good case + missing-scenario case + tail-
 * percentile-missing case). Codex perf-bench-r4 escalation closure
 * (Sprint 13 / TLC-026) — gives the gate-correctness logic explicit
 * test coverage without requiring a full Postgres test setup.
 *
 * Why a separate script (vs vitest assertion):
 *   Vitest's bench() doesn't natively support assertions. The
 *   convention is: run benches with --outputJson, then a separate
 *   threshold-check script verifies the captured measurements.
 *   This separation also lets the same JSON feed both the
 *   threshold check AND the baseline-comparison flow at TLC-023b.
 *
 * Threshold rationale (Sprint 11 PM brief §6 — proposed; SM
 * empirically tunes against CI-runner variance distribution):
 *
 *   Local Sprint 7 measurements (dev laptop):
 *     §1 short clean      ~180ns mean   (5.5M ops/sec)
 *     §2 short crisis     ~110ns mean   (8.9M ops/sec)
 *     §3 long clean 5KB   ~29μs  mean   (34K  ops/sec)
 *     §4 long crisis end  ~18μs  mean   (54K  ops/sec)
 *
 *   CI runners (shared GitHub Actions ubuntu-latest) are typically
 *   2-4× slower + noisier than dev laptops. Apply a 6-17× margin
 *   over local mean as the p95 ceiling per scenario. Margin
 *   asymmetry reflects which scenarios have the most variance:
 *   short clean (early-exit pattern) varies more in absolute
 *   terms than long-string scenarios where the dominant cost is
 *   regex traversal of the input.
 *
 *   Initial thresholds are flagged "tentative" — TLC-023b will
 *   capture 3-5 CI runs to measure actual variance band, and
 *   TLC-023c will tighten thresholds before promoting the workflow
 *   to required-blocking.
 *
 * Spec references:
 *   - ORT v1.5 OR-218 (Tier 1 launch-blocking; verified at
 *     Telecheck_Operational_Readiness_Todo_v1_5.md:129)
 *   - tests/perf/README.md (operating model + Sprint 11 closure path)
 *   - I-019 (crisis detection platform-floor — bench target)
 */

import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Per-scenario p95 thresholds (in MICROSECONDS — vitest bench reports in ms;
// we convert at comparison time).
// ---------------------------------------------------------------------------

interface ScenarioThreshold {
  /** Substring matched against the bench task name. */
  taskNameMatch: string;
  /** Maximum acceptable p95 latency in MICROSECONDS. */
  p95MaxMicros: number;
  /** Human-readable label for error messages. */
  label: string;
}

const THRESHOLDS: readonly ScenarioThreshold[] = [
  // crisisDetector.detect (Sprint 7 / TLC-018)
  {
    taskNameMatch: 'detect on ~35-char clean string returns no-crisis',
    p95MaxMicros: 2,
    label: '§1 crisis-detect: short clean text',
  },
  {
    taskNameMatch: 'detect on ~24-char crisis string returns crisis-detected',
    p95MaxMicros: 1.5,
    label: '§2 crisis-detect: short crisis text',
  },
  {
    taskNameMatch: 'detect on ~5 KB clean narrative returns no-crisis',
    p95MaxMicros: 200,
    label: '§3 crisis-detect: long clean text',
  },
  {
    taskNameMatch:
      'detect on ~5 KB narrative with crisis at end returns crisis-detected',
    p95MaxMicros: 300,
    label: '§4 crisis-detect: long text with crisis at end (worst case)',
  },
  // validateTransition (Sprint 12 / TLC-024).
  // §5 happy path = pure logic, tight. §6/§7/§8 = reject paths
  // including V8 stack-capture overhead (production-realistic;
  // handler layers map throws to HTTP envelopes).
  {
    taskNameMatch: 'validateTransition INITIATED + start_intake returns INTAKE',
    p95MaxMicros: 2,
    label: '§5 validateTransition: happy path',
  },
  {
    taskNameMatch:
      'validateTransition SUBMITTED + start_intake throws InvalidTransitionError',
    p95MaxMicros: 20,
    label: '§6 validateTransition: InvalidTransitionError',
  },
  {
    taskNameMatch:
      'validateTransition INTAKE + abandon (30h) throws GuardNotSatisfiedError',
    p95MaxMicros: 20,
    label: '§7 validateTransition: GuardNotSatisfiedError',
  },
  {
    taskNameMatch:
      'validateTransition QUEUED + claim throws UnsupportedTransitionError',
    p95MaxMicros: 20,
    label: '§8 validateTransition: UnsupportedTransitionError',
  },
];

// ---------------------------------------------------------------------------
// Vitest bench JSON shape (per `vitest bench --outputJson` output)
// ---------------------------------------------------------------------------

/**
 * Vitest 2.1 outputJson shape: latency percentiles are reported
 * DIRECTLY on the benchmark task object, not nested under `.result`.
 * Fields verified against actual `tests/perf/baseline.json` produced
 * by `vitest bench --outputJson` 2026-05-05.
 */
interface BenchTaskResult {
  name: string;
  /** Mean operations per second (ops/sec). */
  hz?: number;
  /** Latency stats in milliseconds. */
  min?: number;
  max?: number;
  mean?: number;
  p75?: number;
  p99?: number;
  p995?: number;
  p999?: number;
  /** p95 isn't always reported by Vitest 2; fallback to p99 if absent. */
  p95?: number;
}

interface BenchFileResult {
  filepath: string;
  groups?: BenchGroup[];
  /** Some Vitest versions put tasks at the top level. */
  tasks?: BenchTaskResult[];
}

interface BenchGroup {
  fullName: string;
  benchmarks?: BenchTaskResult[];
}

interface BenchOutput {
  files?: BenchFileResult[];
  /** Some shapes have a flat task list at the root. */
  tasks?: BenchTaskResult[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function flattenTasks(output: BenchOutput): BenchTaskResult[] {
  const collected: BenchTaskResult[] = [];
  if (Array.isArray(output.tasks)) {
    collected.push(...output.tasks);
  }
  if (Array.isArray(output.files)) {
    for (const file of output.files) {
      if (Array.isArray(file.tasks)) collected.push(...file.tasks);
      if (Array.isArray(file.groups)) {
        for (const group of file.groups) {
          if (Array.isArray(group.benchmarks)) collected.push(...group.benchmarks);
        }
      }
    }
  }
  return collected;
}

/**
 * Per Codex perf-thresholds-r1 HIGH closure 2026-05-05: the prior
 * implementation interpolated p95 ≈ (p75 + p99) / 2 when p95 was
 * missing. That is mathematically WRONG for tail estimation —
 * since p95 is only guaranteed to be between p75 and p99, the
 * midpoint can be LOWER than the true p95 whenever the latency
 * distribution has a steep tail. A scenario whose true p95
 * exceeds the threshold could pass CI under the midpoint
 * approximation, defeating per-scenario p95 enforcement entirely.
 *
 * Correct fallback: use p99 directly. p99 ≥ true p95 always, so
 * comparing p99 against the p95-threshold over-flags rather than
 * under-flags. Over-flagging is the safe direction (operators see
 * a flaky-perf signal; under-flagging silently ships regressions).
 *
 * Returns null only when neither p95 nor p99 is reported by Vitest;
 * caller fails the gate in that case.
 */
/**
 * Runtime validation per Codex perf-yml-r1 MEDIUM closure 2026-05-05:
 * `!== undefined` is insufficient because `null`, NaN, strings, and
 * negative numbers all pass that check. A malformed bench output
 * with `p99: null` would compute `null * 1000 = 0` and report OK,
 * defeating the gate. Reject anything that isn't a finite non-
 * negative number.
 */
function isValidLatencyNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function p95OrConservativeFallback(
  task: BenchTaskResult,
): { value: number; source: 'p95' | 'p99-fallback' } | null {
  if (isValidLatencyNumber(task.p95)) {
    return { value: task.p95, source: 'p95' };
  }
  if (isValidLatencyNumber(task.p99)) {
    // p99 over-strict; over-flagging is safe. Sprint 12+ may revisit
    // if false-positive flake rate becomes problematic.
    return { value: task.p99, source: 'p99-fallback' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manifest-coverage helper (Sprint 13 / TLC-026 escalation closure)
// ---------------------------------------------------------------------------

/**
 * Per Codex perf-bench-r4 closure (escalated Sprint 12 → 13): expose
 * the EXPECTED_SCENARIOS manifest as a derived view of THRESHOLDS so
 * that "what bench scenarios MUST exist for the gate to pass" is a
 * symbolic, single-source-of-truth declaration. Sprint 14+ baseline
 * regen will use this manifest to verify CI-captured baselines cover
 * every required scenario before commit.
 *
 * The manifest is DERIVED from THRESHOLDS (no duplication): every
 * threshold entry's `taskNameMatch` IS the scenario identifier.
 */
function getExpectedScenarios(): readonly { taskNameMatch: string; label: string }[] {
  return THRESHOLDS.map((t) => ({
    taskNameMatch: t.taskNameMatch,
    label: t.label,
  }));
}

interface ManifestCoverageResult {
  /** Number of expected scenarios found in the bench output. */
  matched: number;
  /** Number of expected scenarios MISSING from the bench output. */
  missing: number;
  /** Detailed list of missing scenario labels (for error messages). */
  missingLabels: readonly string[];
}

/**
 * Verify every expected scenario has a corresponding task in the bench
 * output. Returns { matched, missing, missingLabels }. Caller decides
 * gate-failure semantics (main() fails the gate on missing > 0).
 */
function verifyManifestCoverage(
  tasks: readonly BenchTaskResult[],
  expected: readonly { taskNameMatch: string; label: string }[],
): ManifestCoverageResult {
  let matched = 0;
  const missingLabels: string[] = [];
  for (const scenario of expected) {
    const found = tasks.some((t) => t.name.includes(scenario.taskNameMatch));
    if (found) {
      matched += 1;
    } else {
      missingLabels.push(scenario.label);
    }
  }
  return {
    matched,
    missing: missingLabels.length,
    missingLabels,
  };
}

// ---------------------------------------------------------------------------
// Self-test (--self-test flag)
// ---------------------------------------------------------------------------

/**
 * Lightweight self-test exercising:
 *   §A good case — all expected scenarios present + p99 within limits → pass
 *   §B missing-scenario case — synthetic output missing §3 long clean →
 *      manifest-check fails the gate even before threshold-check loops
 *   §C tail-percentile-missing case — task present but no p95/p99 →
 *      threshold-check fails the gate via "neither p95 nor p99 data"
 *
 * No Postgres / file I/O required. Runs entirely off in-memory fixtures.
 * Codex perf-bench-r4 closure: gives the gate-correctness logic explicit
 * test coverage without expanding the test infra investment.
 */
function selfTest(): number {
  const expected = getExpectedScenarios();

  // §A — good case
  const goodTasks: BenchTaskResult[] = expected.map((s) => ({
    name: `bench harness: ${s.taskNameMatch}`,
    p99: 0.001, // 1μs — well under all thresholds
  }));
  const goodCoverage = verifyManifestCoverage(goodTasks, expected);
  if (goodCoverage.missing !== 0) {
    console.error(
      `SELF-TEST §A FAIL: good case had ${goodCoverage.missing} missing; expected 0`,
    );
    return 1;
  }

  // §B — missing-scenario case (drop §3 long clean from the input)
  const missingTasks = goodTasks.filter(
    (t) => !t.name.includes('detect on ~5 KB clean narrative returns no-crisis'),
  );
  const missingCoverage = verifyManifestCoverage(missingTasks, expected);
  if (missingCoverage.missing !== 1) {
    console.error(
      `SELF-TEST §B FAIL: missing-scenario case had ${missingCoverage.missing} missing; expected 1`,
    );
    return 1;
  }
  if (
    !missingCoverage.missingLabels.some((l) =>
      l.includes('crisis-detect: long clean text'),
    )
  ) {
    console.error(
      `SELF-TEST §B FAIL: missing-scenario label list didn't include the dropped scenario`,
    );
    return 1;
  }

  // §C — tail-percentile-missing case (task present but no p95/p99)
  const tailMissingTask: BenchTaskResult = {
    name: 'bench harness: detect on ~35-char clean string returns no-crisis',
    // No p95, no p99 — should fail per p95OrConservativeFallback contract
  };
  const tailFallback = p95OrConservativeFallback(tailMissingTask);
  if (tailFallback !== null) {
    console.error(
      `SELF-TEST §C FAIL: p95OrConservativeFallback should return null when both p95 + p99 are missing; got ${JSON.stringify(tailFallback)}`,
    );
    return 1;
  }

  // §D — runtime-validation rejection of malformed values (Codex
  // perf-yml-r1 MEDIUM closure — verify isValidLatencyNumber rejects
  // null / NaN / strings / negative numbers)
  const malformedNullTask: BenchTaskResult = {
    name: 'bench harness: detect on ~24-char crisis string returns crisis-detected',
    p99: null as unknown as number,
  };
  if (p95OrConservativeFallback(malformedNullTask) !== null) {
    console.error('SELF-TEST §D FAIL: p99: null should not pass validation');
    return 1;
  }
  const malformedNanTask: BenchTaskResult = {
    name: 'bench harness: detect on ~24-char crisis string returns crisis-detected',
    p99: Number.NaN,
  };
  if (p95OrConservativeFallback(malformedNanTask) !== null) {
    console.error('SELF-TEST §D FAIL: p99: NaN should not pass validation');
    return 1;
  }
  const malformedNegativeTask: BenchTaskResult = {
    name: 'bench harness: detect on ~24-char crisis string returns crisis-detected',
    p99: -1,
  };
  if (p95OrConservativeFallback(malformedNegativeTask) !== null) {
    console.error('SELF-TEST §D FAIL: p99: -1 should not pass validation');
    return 1;
  }

  console.log('SELF-TEST PASS: §A good / §B missing-scenario / §C tail-missing / §D malformed-values all behave correctly');
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  const args = process.argv.slice(2);

  // Self-test mode (Codex perf-bench-r4 closure)
  if (args.length === 1 && args[0] === '--self-test') {
    return selfTest();
  }

  if (args.length !== 1) {
    console.error(
      'Usage: npx tsx tests/perf/check-thresholds.ts <bench-output.json>\n' +
        '       npx tsx tests/perf/check-thresholds.ts --self-test',
    );
    return 1;
  }
  const path = args[0];
  if (path === undefined) {
    console.error('Missing JSON file path');
    return 1;
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`Failed to read ${path}:`, err);
    return 1;
  }

  let parsed: BenchOutput;
  try {
    parsed = JSON.parse(raw) as BenchOutput;
  } catch (err) {
    console.error(`Failed to parse ${path} as JSON:`, err);
    return 1;
  }

  const tasks = flattenTasks(parsed);
  if (tasks.length === 0) {
    console.error('No bench tasks found in output JSON');
    return 1;
  }

  // Manifest-coverage check (Sprint 13 / TLC-026): runs BEFORE the
  // per-threshold loop so missing scenarios fail the gate explicitly,
  // not as a side effect of the threshold-loop's "no matching bench
  // task" path.
  const expected = getExpectedScenarios();
  const coverage = verifyManifestCoverage(tasks, expected);
  if (coverage.missing > 0) {
    console.error(
      `MANIFEST COVERAGE FAILURE: ${coverage.missing}/${expected.length} expected scenarios missing from bench output:`,
    );
    for (const label of coverage.missingLabels) {
      console.error(`  - ${label}`);
    }
    console.error(
      '\nGate fails because the bench harness did not produce output for ' +
        'every required scenario. This typically means a bench file was ' +
        'deleted, renamed, or the bench runner crashed mid-execution.',
    );
    return 1;
  }

  let breached = 0;
  let matched = 0;
  for (const threshold of THRESHOLDS) {
    const task = tasks.find((t) => t.name.includes(threshold.taskNameMatch));
    if (task === undefined) {
      // Should be unreachable due to manifest coverage check above,
      // but defensive in case THRESHOLDS expands without manifest sync.
      console.error(
        `Threshold ${threshold.label}: no matching bench task (looking for "${threshold.taskNameMatch}")`,
      );
      breached += 1;
      continue;
    }
    matched += 1;

    const result = p95OrConservativeFallback(task);
    if (result === null) {
      console.error(
        `Threshold ${threshold.label}: bench task "${task.name}" has neither p95 nor p99 data — failing gate`,
      );
      breached += 1;
      continue;
    }

    const valueMicros = result.value * 1000;
    const sourceLabel = result.source === 'p95' ? 'p95' : 'p99 (over-strict fallback; p95 missing)';
    if (valueMicros > threshold.p95MaxMicros) {
      console.error(
        `THRESHOLD BREACH ${threshold.label}: ${sourceLabel} ${valueMicros.toFixed(2)}μs > limit ${threshold.p95MaxMicros}μs`,
      );
      breached += 1;
    } else {
      console.log(
        `OK ${threshold.label}: ${sourceLabel} ${valueMicros.toFixed(2)}μs <= limit ${threshold.p95MaxMicros}μs`,
      );
    }
  }

  if (matched < THRESHOLDS.length) {
    console.error(
      `Matched ${matched}/${THRESHOLDS.length} thresholds — ` +
        `${THRESHOLDS.length - matched} bench task(s) not found in output`,
    );
  }

  if (breached > 0) {
    console.error(`\n${breached} threshold breach(es) — failing CI gate`);
    return 1;
  }
  console.log(`\nAll ${THRESHOLDS.length} thresholds passed (manifest coverage: ${coverage.matched}/${expected.length} scenarios verified)`);
  return 0;
}

process.exit(main());
