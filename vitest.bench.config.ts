/**
 * Vitest bench-mode configuration (Sprint 7 / TLC-018).
 *
 * Separate from vitest.config.ts because:
 *   1. The test runner's `setupFiles: ['./tests/setup.ts']` requires an
 *      ephemeral Postgres + per-test SAVEPOINT wrapper, neither of
 *      which is appropriate for the v0.1 pure-function bench corpus
 *      (crisisDetector.detect, tenant-context resolution, error
 *      envelope build).
 *   2. Per-mode `setupFiles` override under a `benchmark:` key in
 *      vitest.config.ts does not apply in Vitest 2.
 *
 * Sprint 14 / TLC-025-SCAFFOLD update (2026-05-05):
 *   `setupFiles` now wires `tests/perf/db/setup.ts` — a bench-mode-
 *   specific ephemeral Postgres setup that:
 *     - Does NOT use per-test SAVEPOINT wrapping (incompatible with
 *       bench's many-iteration model)
 *     - DOES use the same setTestPool() BEGIN/COMMIT translation
 *       pattern as integration tests (so bench measures real
 *       production code paths through withTransaction etc.)
 *     - Fails closed when BENCH_DATABASE_URL is not set OR matches
 *       DATABASE_URL / TEST_DATABASE_URL (prevent dev/test DB
 *       pollution by bench iterations)
 *   Sprint 14 lands the SCAFFOLD only — no DB-backed bench scenarios
 *   exist yet. Sprint 15+ adds the first DB-backed bench (candidate:
 *   emitAudit hash chain) once CI validates this scaffold's
 *   migration-apply + seed + role wiring works end-to-end.
 *
 *   Pure-function benches (crisis-detect, validate-transition) do NOT
 *   require BENCH_DATABASE_URL — but the setup file's beforeAll will
 *   throw if BENCH_DATABASE_URL is unset, BLOCKING all benches. To
 *   keep pure-function benches runnable without a Postgres dependency,
 *   we conditionally include the setup file based on env-presence.
 *
 *   Decision: setupFiles is empty by default; operators set
 *   BENCH_DATABASE_URL + run with the override config when they want
 *   DB-backed benches. See tests/perf/README.md §"Running DB-backed
 *   benches" for the invocation pattern.
 *
 * Bench is SIGNAL, not GATE at v0.1 — CI does not block on bench
 * results. See tests/perf/README.md for the operating model and
 * Sprint 11 promotion path (per ORT v1.5 OR-218).
 *
 * Spec references:
 *   - ORT v1.5 OR-218 (Performance and load test plan)
 *   - tests/perf/README.md (operating model)
 *   - tests/perf/db/setup.ts (bench-mode DB setup; Sprint 14 / TLC-025-SCAFFOLD)
 */

import { defineConfig } from 'vitest/config';

// Conditionally include the DB-backed bench setup file. When
// BENCH_DATABASE_URL is set, operators are signaling intent to run
// DB-backed benches; the setup file connects + applies migrations +
// seeds. When unset, pure-function benches run with no setup, same
// as Sprint 7-13 behavior.
const setupFiles = process.env['BENCH_DATABASE_URL']
  ? ['./tests/perf/db/setup.ts']
  : [];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // setupFiles: conditional on BENCH_DATABASE_URL presence (Sprint
    // 14 / TLC-025-SCAFFOLD). Empty when unset → pure-function bench
    // path. Populated when set → DB-backed bench session setup.
    setupFiles,

    // Only bench files; never collect *.test.ts files in bench mode.
    include: [],
    exclude: ['node_modules', 'dist'],

    // Benchmark configuration: only collect *.bench.ts files under
    // tests/perf/. The test runner's `include` glob does NOT match
    // `.bench.ts`, so this is a strict separation.
    benchmark: {
      include: ['tests/perf/**/*.bench.ts'],
      exclude: ['node_modules', 'dist'],
      reporters: ['default'],
    },

    // Pool: forks for process isolation. Bench runs typically don't
    // need this but it matches the rest of the config for consistency.
    pool: 'forks',
  },
});
