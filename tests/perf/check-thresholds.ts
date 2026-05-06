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
 *
 * (tsx is a devDependency per package.json:50; .github/workflows/perf.yml
 * invokes via `npx tsx ...` — no separate compile step needed at v0.1.)
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
  {
    taskNameMatch: 'detect on ~35-char clean string returns no-crisis',
    p95MaxMicros: 2,
    label: '§1 short clean text',
  },
  {
    taskNameMatch: 'detect on ~24-char crisis string returns crisis-detected',
    p95MaxMicros: 1.5,
    label: '§2 short crisis text',
  },
  {
    taskNameMatch: 'detect on ~5 KB clean narrative returns no-crisis',
    p95MaxMicros: 200,
    label: '§3 long clean text',
  },
  {
    taskNameMatch:
      'detect on ~5 KB narrative with crisis at end returns crisis-detected',
    p95MaxMicros: 300,
    label: '§4 long text with crisis at end (worst case)',
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
function p95OrConservativeFallback(
  task: BenchTaskResult,
): { value: number; source: 'p95' | 'p99-fallback' } | null {
  if (task.p95 !== undefined) {
    return { value: task.p95, source: 'p95' };
  }
  if (task.p99 !== undefined) {
    // p99 over-strict; over-flagging is safe. Sprint 12+ may revisit
    // if false-positive flake rate becomes problematic.
    return { value: task.p99, source: 'p99-fallback' };
  }
  return null;
}

function main(): number {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: node tests/perf/check-thresholds.js <bench-output.json>');
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

  let breached = 0;
  let matched = 0;
  for (const threshold of THRESHOLDS) {
    const task = tasks.find((t) => t.name.includes(threshold.taskNameMatch));
    if (task === undefined) {
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
  console.log(`\nAll ${THRESHOLDS.length} thresholds passed`);
  return 0;
}

process.exit(main());
