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
 * When future benches need DB-backed surfaces (e.g., emitAudit hash
 * chain, idempotency lookup), author a separate setup file dedicated
 * to bench-mode that constructs a fresh ephemeral DB without the
 * per-test SAVEPOINT wrapper (which is incompatible with bench's
 * many-iteration model).
 *
 * Bench is SIGNAL, not GATE at v0.1 — CI does not block on bench
 * results. See tests/perf/README.md for the operating model and
 * Sprint 11 promotion path (per ORT v1.5 OR-218).
 *
 * Spec references:
 *   - ORT v1.5 OR-218 (Performance and load test plan)
 *   - tests/perf/README.md (operating model)
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // No setupFiles — bench corpus is pure-function at v0.1.
    setupFiles: [],

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
