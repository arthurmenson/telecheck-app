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
 * percentile-missing case + malformed values).
 *
 * Codex perf-bench-r5 MEDIUM closure (Sprint 13 fix-forward 2026-05-05):
 * the gate logic after JSON parsing is extracted as a pure function
 * `runGate(tasks): GateResult` so `main()` AND `selfTest()` exercise the
 * SAME gate semantics. Earlier Sprint 13 implementation (`4380a73`)
 * had selfTest() calling `verifyManifestCoverage()` and
 * `p95OrConservativeFallback()` directly, which Codex correctly flagged
 * as the same closure-path-overclaim class as r2/r3/r4: enforceable-
 * looking CI coverage that doesn't actually guard the advertised
 * failure mode (manifest-before-threshold ordering + threshold-loop
 * fail-on-no-data behavior). Fix-forward: §A/§B/§C/§D fixtures now
 * drive synthetic bench output through runGate() and assert the
 * GateResult shape, including §B's "manifestFailed=true AND
 * thresholdResults.length==0" assertion that proves missing scenarios
 * short-circuit BEFORE the threshold loop runs.
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
    taskNameMatch: 'detect on ~5 KB narrative with crisis at end returns crisis-detected',
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
    taskNameMatch: 'validateTransition SUBMITTED + start_intake throws InvalidTransitionError',
    p95MaxMicros: 20,
    label: '§6 validateTransition: InvalidTransitionError',
  },
  {
    taskNameMatch: 'validateTransition INTAKE + abandon (30h) throws GuardNotSatisfiedError',
    p95MaxMicros: 20,
    label: '§7 validateTransition: GuardNotSatisfiedError',
  },
  {
    taskNameMatch: 'validateTransition QUEUED + claim throws UnsupportedTransitionError',
    p95MaxMicros: 20,
    label: '§8 validateTransition: UnsupportedTransitionError',
  },
  // §9 emit-audit DB-backed bench is REMOVED from THRESHOLDS at Sprint
  // 17 / TLC-027 fix-forward (Codex r11 closure path). Reason: §9 lives
  // in tests/perf/audit/emit-audit.db.bench.ts which is excluded from
  // the default vitest.bench.config.ts glob (only pure-function
  // *.bench.ts files run by perf.yml; DB-backed *.db.bench.ts files
  // require BENCH_DATABASE_URL + Postgres service container).
  //
  // Sprint 18+ adds §9 back when:
  //   1. NEW perf-db.yml workflow exists with Postgres service +
  //      BENCH_DATABASE_URL set
  //   2. NEW vitest.bench.db.config.ts wires the .db.bench.ts glob
  //   3. NEW check-thresholds-db.ts (or flag-gated check-thresholds.ts)
  //      enforces §9 separately from the pure-function gate
  //
  // Until then, the canonical perf.yml gate covers 8 pure-function
  // scenarios; manifest-check helper + self-test continue to verify
  // those 8.
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
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
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
// Gate function (pure; drives both main() and selfTest())
// ---------------------------------------------------------------------------

/**
 * Per-threshold result shape. Captures every branch in the gate's
 * decision so selfTest() can assert against them without re-implementing
 * gate semantics.
 */
type ThresholdStatus = 'ok' | 'breach' | 'no-data' | 'no-task';

interface ThresholdResult {
  threshold: ScenarioThreshold;
  status: ThresholdStatus;
  /** Set when status is 'ok' or 'breach' (we successfully measured a value). */
  valueMicros?: number;
  /** Set when status is 'ok' or 'breach'. */
  source?: 'p95' | 'p99-fallback';
}

/**
 * Gate verdict. Returned by runGate() so main() can format it for CI
 * stdout/stderr AND selfTest() can assert against it.
 *
 * Critical invariant for Codex perf-bench-r5 closure:
 *   manifestFailed === true  =>  thresholdResults.length === 0
 * (i.e., when manifest coverage fails, the per-threshold loop is
 * SHORT-CIRCUITED. selfTest §B asserts this — proves the
 * manifest-before-threshold ordering claim is enforced, not just
 * documented.)
 */
interface GateResult {
  coverage: ManifestCoverageResult;
  manifestFailed: boolean;
  thresholdResults: readonly ThresholdResult[];
  breached: number;
  matched: number;
  exitCode: 0 | 1;
}

/**
 * Pure gate function. Takes the flattened bench tasks; returns a
 * structured verdict. Does NOT log to stdout/stderr — caller decides
 * formatting.
 *
 * Codex perf-bench-r5 closure (Sprint 13 fix-forward 2026-05-05):
 * extracting this from main() lets selfTest() exercise the SAME gate
 * semantics CI uses, so a future regression that reorders or weakens
 * the gate is caught by --self-test before bench harness runs.
 */
function runGate(tasks: readonly BenchTaskResult[]): GateResult {
  const expected = getExpectedScenarios();
  const coverage = verifyManifestCoverage(tasks, expected);

  // Manifest-before-threshold short-circuit. If any expected scenario
  // is missing, the threshold loop does NOT run.
  if (coverage.missing > 0) {
    return {
      coverage,
      manifestFailed: true,
      thresholdResults: [],
      breached: 0,
      matched: 0,
      exitCode: 1,
    };
  }

  const thresholdResults: ThresholdResult[] = [];
  let breached = 0;
  let matched = 0;

  for (const threshold of THRESHOLDS) {
    const task = tasks.find((t) => t.name.includes(threshold.taskNameMatch));
    if (task === undefined) {
      // Should be unreachable because the manifest check above already
      // guarantees every threshold has a matching task. Defensive in
      // case THRESHOLDS expands without manifest sync.
      thresholdResults.push({ threshold, status: 'no-task' });
      breached += 1;
      continue;
    }
    matched += 1;

    const result = p95OrConservativeFallback(task);
    if (result === null) {
      thresholdResults.push({ threshold, status: 'no-data' });
      breached += 1;
      continue;
    }

    const valueMicros = result.value * 1000;
    if (valueMicros > threshold.p95MaxMicros) {
      thresholdResults.push({
        threshold,
        status: 'breach',
        valueMicros,
        source: result.source,
      });
      breached += 1;
    } else {
      thresholdResults.push({
        threshold,
        status: 'ok',
        valueMicros,
        source: result.source,
      });
    }
  }

  return {
    coverage,
    manifestFailed: false,
    thresholdResults,
    breached,
    matched,
    exitCode: breached > 0 ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Self-test (--self-test flag)
// ---------------------------------------------------------------------------

/**
 * Self-test driving synthetic bench output through runGate() — the
 * same function main() calls. Per Codex perf-bench-r5 MEDIUM closure
 * (Sprint 13 fix-forward 2026-05-05): earlier r4 closure had selfTest
 * calling helper functions in isolation, which is hollow-coverage —
 * a future regression that reorders main()'s gate calls would not
 * be caught. Fix-forward exercises runGate() so the gate semantics
 * CI relies on are the gate semantics --self-test asserts.
 *
 * Sections:
 *   §A good case — all 8 expected scenarios present + p99 within limits
 *      → manifestFailed=false, breached=0, matched=8, exitCode=0
 *   §B missing-scenario case — drop §3 long clean from input
 *      → manifestFailed=true, thresholdResults.length=0, exitCode=1
 *      (CRITICAL: short-circuit means the threshold loop did NOT run)
 *   §C tail-percentile-missing — task present, no p95/p99
 *      → manifestFailed=false, status='no-data' for that scenario,
 *      breached>=1, exitCode=1
 *   §D malformed values — null / NaN / negative p99
 *      → same as §C: status='no-data' (isValidLatencyNumber rejects),
 *      breached>=1, exitCode=1
 *
 * Runs entirely off in-memory fixtures. No Postgres / file I/O.
 */
function selfTest(): number {
  const expected = getExpectedScenarios();

  // §A — good case: all 8 scenarios present, p99=1μs (well under limits)
  const goodTasks: BenchTaskResult[] = expected.map((s) => ({
    name: `bench harness: ${s.taskNameMatch}`,
    p99: 0.001, // 1μs in milliseconds
  }));
  const goodResult = runGate(goodTasks);
  if (goodResult.manifestFailed) {
    console.error(`SELF-TEST §A FAIL: good case had manifestFailed=true; expected false`);
    return 1;
  }
  if (goodResult.breached !== 0) {
    console.error(`SELF-TEST §A FAIL: good case had breached=${goodResult.breached}; expected 0`);
    return 1;
  }
  if (goodResult.matched !== expected.length) {
    console.error(
      `SELF-TEST §A FAIL: good case had matched=${goodResult.matched}; expected ${expected.length}`,
    );
    return 1;
  }
  if (goodResult.thresholdResults.length !== expected.length) {
    console.error(
      `SELF-TEST §A FAIL: good case had thresholdResults.length=${goodResult.thresholdResults.length}; expected ${expected.length}`,
    );
    return 1;
  }
  if (goodResult.exitCode !== 0) {
    console.error(`SELF-TEST §A FAIL: good case exitCode=${goodResult.exitCode}; expected 0`);
    return 1;
  }

  // §B — missing-scenario case: drop §3 long clean. The CRITICAL
  // assertion is that the threshold loop did NOT run (short-circuit).
  // This is what proves manifest-before-threshold ordering, not just
  // that the helper reports a missing label.
  const missingTasks = goodTasks.filter(
    (t) => !t.name.includes('detect on ~5 KB clean narrative returns no-crisis'),
  );
  const missingResult = runGate(missingTasks);
  if (!missingResult.manifestFailed) {
    console.error(
      `SELF-TEST §B FAIL: missing-scenario case had manifestFailed=false; expected true`,
    );
    return 1;
  }
  if (missingResult.thresholdResults.length !== 0) {
    console.error(
      `SELF-TEST §B FAIL: missing-scenario case had thresholdResults.length=${missingResult.thresholdResults.length}; ` +
        `expected 0 (manifest fail must short-circuit before threshold loop)`,
    );
    return 1;
  }
  if (missingResult.coverage.missing !== 1) {
    console.error(
      `SELF-TEST §B FAIL: missing-scenario case had coverage.missing=${missingResult.coverage.missing}; expected 1`,
    );
    return 1;
  }
  if (
    !missingResult.coverage.missingLabels.some((l) => l.includes('crisis-detect: long clean text'))
  ) {
    console.error(`SELF-TEST §B FAIL: missingLabels did not include the dropped scenario`);
    return 1;
  }
  if (missingResult.exitCode !== 1) {
    console.error(
      `SELF-TEST §B FAIL: missing-scenario exitCode=${missingResult.exitCode}; expected 1`,
    );
    return 1;
  }

  // §C — tail-percentile-missing: all scenarios present (manifest OK),
  // but §1's task has no p95 + no p99. Threshold loop runs (manifest
  // didn't short-circuit) and the no-data branch fires for §1.
  const tailMissingTasks: BenchTaskResult[] = expected.map((s, idx) => ({
    name: `bench harness: ${s.taskNameMatch}`,
    // §1 (idx 0) has no p99/p95; rest have p99=1μs
    ...(idx === 0 ? {} : { p99: 0.001 }),
  }));
  const tailResult = runGate(tailMissingTasks);
  if (tailResult.manifestFailed) {
    console.error(
      `SELF-TEST §C FAIL: tail-missing case had manifestFailed=true; expected false (manifest OK; only tail-data missing)`,
    );
    return 1;
  }
  if (tailResult.thresholdResults.length !== expected.length) {
    console.error(
      `SELF-TEST §C FAIL: tail-missing case had thresholdResults.length=${tailResult.thresholdResults.length}; expected ${expected.length} (threshold loop must run)`,
    );
    return 1;
  }
  const noDataResults = tailResult.thresholdResults.filter((r) => r.status === 'no-data');
  if (noDataResults.length !== 1) {
    console.error(
      `SELF-TEST §C FAIL: expected exactly 1 'no-data' threshold result; got ${noDataResults.length}`,
    );
    return 1;
  }
  if (
    noDataResults[0]?.threshold.taskNameMatch !==
    'detect on ~35-char clean string returns no-crisis'
  ) {
    console.error(
      `SELF-TEST §C FAIL: 'no-data' result fired for wrong scenario: ${noDataResults[0]?.threshold.label}`,
    );
    return 1;
  }
  if (tailResult.breached < 1) {
    console.error(
      `SELF-TEST §C FAIL: tail-missing case had breached=${tailResult.breached}; expected >= 1`,
    );
    return 1;
  }
  if (tailResult.exitCode !== 1) {
    console.error(`SELF-TEST §C FAIL: tail-missing exitCode=${tailResult.exitCode}; expected 1`);
    return 1;
  }

  // §D — malformed values: §2's p99 is null/NaN/negative across 3
  // sub-fixtures. isValidLatencyNumber must reject all three;
  // p95OrConservativeFallback returns null; runGate emits 'no-data'.
  for (const malformed of [null as unknown as number, Number.NaN, -1]) {
    const malformedTasks: BenchTaskResult[] = expected.map((s, idx) => ({
      name: `bench harness: ${s.taskNameMatch}`,
      // §2 (idx 1) has the malformed p99
      ...(idx === 1 ? { p99: malformed } : { p99: 0.001 }),
    }));
    const malResult = runGate(malformedTasks);
    if (malResult.manifestFailed) {
      console.error(
        `SELF-TEST §D FAIL: malformed=${String(malformed)} had manifestFailed=true; expected false`,
      );
      return 1;
    }
    const malNoData = malResult.thresholdResults.filter((r) => r.status === 'no-data');
    if (malNoData.length !== 1) {
      console.error(
        `SELF-TEST §D FAIL: malformed=${String(malformed)} expected 1 'no-data'; got ${malNoData.length}`,
      );
      return 1;
    }
    if (
      malNoData[0]?.threshold.taskNameMatch !==
      'detect on ~24-char crisis string returns crisis-detected'
    ) {
      console.error(
        `SELF-TEST §D FAIL: malformed=${String(malformed)} 'no-data' fired for wrong scenario: ${malNoData[0]?.threshold.label}`,
      );
      return 1;
    }
    if (malResult.exitCode !== 1) {
      console.error(
        `SELF-TEST §D FAIL: malformed=${String(malformed)} exitCode=${malResult.exitCode}; expected 1`,
      );
      return 1;
    }
  }

  console.log(
    'SELF-TEST PASS: §A good / §B missing-scenario short-circuits / §C tail-missing / §D malformed-values — all drive runGate() and assert gate semantics',
  );
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

  // Run the gate. Same function selfTest() exercises — see Codex
  // perf-bench-r5 closure rationale at top of file.
  const result = runGate(tasks);
  const expected = getExpectedScenarios();

  // Manifest-coverage failure: short-circuited; threshold loop did
  // NOT run. Format + return.
  if (result.manifestFailed) {
    console.error(
      `MANIFEST COVERAGE FAILURE: ${result.coverage.missing}/${expected.length} expected scenarios missing from bench output:`,
    );
    for (const label of result.coverage.missingLabels) {
      console.error(`  - ${label}`);
    }
    console.error(
      '\nGate fails because the bench harness did not produce output for ' +
        'every required scenario. This typically means a bench file was ' +
        'deleted, renamed, or the bench runner crashed mid-execution.',
    );
    return result.exitCode;
  }

  // Per-threshold formatting.
  for (const tr of result.thresholdResults) {
    if (tr.status === 'no-task') {
      console.error(
        `Threshold ${tr.threshold.label}: no matching bench task (looking for "${tr.threshold.taskNameMatch}")`,
      );
      continue;
    }
    if (tr.status === 'no-data') {
      console.error(
        `Threshold ${tr.threshold.label}: bench task has neither p95 nor p99 data — failing gate`,
      );
      continue;
    }
    const sourceLabel = tr.source === 'p95' ? 'p95' : 'p99 (over-strict fallback; p95 missing)';
    const valueMicros = tr.valueMicros ?? 0;
    if (tr.status === 'breach') {
      console.error(
        `THRESHOLD BREACH ${tr.threshold.label}: ${sourceLabel} ${valueMicros.toFixed(2)}μs > limit ${tr.threshold.p95MaxMicros}μs`,
      );
    } else {
      console.log(
        `OK ${tr.threshold.label}: ${sourceLabel} ${valueMicros.toFixed(2)}μs <= limit ${tr.threshold.p95MaxMicros}μs`,
      );
    }
  }

  if (result.matched < THRESHOLDS.length) {
    console.error(
      `Matched ${result.matched}/${THRESHOLDS.length} thresholds — ` +
        `${THRESHOLDS.length - result.matched} bench task(s) not found in output`,
    );
  }

  if (result.breached > 0) {
    console.error(`\n${result.breached} threshold breach(es) — failing CI gate`);
    return result.exitCode;
  }
  console.log(
    `\nAll ${THRESHOLDS.length} thresholds passed (manifest coverage: ${result.coverage.matched}/${expected.length} scenarios verified)`,
  );
  return result.exitCode;
}

process.exit(main());
