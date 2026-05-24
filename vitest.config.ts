/**
 * Vitest 2 configuration for the Telecheck application.
 *
 * Coverage: v8 provider. 80% threshold enforced on `src/lib/` (foundation layer).
 * Lower threshold (60%) on `src/modules/` while slices are being built.
 *
 * Integration tests require a real PostgreSQL instance — set TEST_DATABASE_URL
 * before running. Ephemeral DB lifecycle is managed by tests/setup.ts.
 *
 * Spec references:
 *   - CLAUDE.md §Code conventions (TypeScript strict, ESM)
 *   - tests/README.md §Test database
 *   - INVARIANTS v5.2 (all testable invariants get coverage)
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * Inject Vitest globals (describe, it, expect, beforeEach, afterEach,
     * beforeAll, afterAll, vi) into every test file without explicit imports.
     * Matches tsconfig.json compilerOptions — types are declared via vitest/globals.
     */
    globals: true,

    /**
     * Node environment — the only valid target for Fastify + Postgres integration
     * tests. Do not switch to jsdom.
     */
    environment: 'node',

    /**
     * Global setup runs once per test run: migrations, seed tenants, and
     * teardown of the ephemeral database are handled here.
     *
     * Per-test transaction wrapping (begin / rollback) is done inside
     * tests/setup.ts via beforeEach / afterEach registered globally.
     */
    setupFiles: ['./tests/setup.ts'],

    // Include patterns:
    //   - tests (recursive) .test.ts files: integration + state-machine + contract + invariant
    //   - src   (recursive) .test.ts files: unit tests alongside source per CLAUDE.md convention
    // NOTE: glob literals are kept out of the JSDoc above because esbuild's
    // block-comment scanner treats the `*/` inside `**/*` as a comment terminator,
    // which produces a parse error at config-load time (vitest.config.ts:45 in CI).
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],

    /**
     * Exclude compiled output, node_modules, and the tests/setup.ts itself.
     */
    exclude: ['node_modules', 'dist', 'tests/setup.ts'],

    /**
     * Coverage configuration using v8 (native V8 coverage — zero Babel
     * instrumentation overhead).
     */
    coverage: {
      provider: 'v8',

      /**
       * Include only source files; exclude tests themselves and the setup harness.
       */
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/server.ts', 'node_modules'],

      /**
       * Granular thresholds per directory:
       *
       *  src/lib/ — foundation layer. 80% before any slice lands.
       *             Invariant-critical paths (audit, RLS, i029-gate, i012-gate,
       *             error-envelope) are targeted at 90%+ by the tests in this
       *             commit; the per-directory threshold catches regressions.
       *
       *  src/modules/ — 60% while slices begin (rises per slice as slice
       *                  test suites land). Enforced at 80% by the time
       *                  the first slice PRD is fully implemented.
       *
       *  Global fallback — 60% until the foundation layer is settled.
       *
       * NOTE: Vitest 2 per-directory thresholds use the `thresholds` key with
       * glob-scoped entries. The `100` per-file option is intentionally off —
       * it would block iteration. Enable per slice when slice is feature-complete.
       */
      thresholds: {
        global: {
          statements: 60,
          branches: 60,
          functions: 60,
          lines: 60,
        },
        'src/lib/': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },

      /**
       * Coverage reports: text summary for CI stdout; lcov for tooling integration
       * (SonarQube, Codecov, etc. when wired in CI). Add 'html' locally if needed.
       */
      reporter: ['text', 'lcov'],

      /**
       * Emit coverage even when tests fail — useful during active development
       * to see which paths are not exercised yet.
       */
      reportOnFailure: true,
    },

    /**
     * Reporters: default for local development. CI layer adds --reporter junit
     * via the `test` npm script (or CI override). Not hardcoded here to avoid
     * polluting local developer output with JUnit XML.
     *
     * In Vitest 2 the canonical way to opt into the default reporter was
     * `reporters: ['default']`. In Vitest 4 that exact string is interpreted
     * as a custom-reporter module name and fails to resolve at server-load
     * time (`ERR_LOAD_URL` from `loadCustomReporterModule`). The Vitest 4
     * idiom is to omit the field entirely (the default reporter is implicit),
     * so this line is intentionally absent.
     */

    /**
     * Timeout: 30s for integration tests that exercise real Postgres. The per-test
     * transaction wrap is fast (rollback instead of truncate), but migration-heavy
     * setups may need the headroom on cold starts.
     */
    testTimeout: 30_000,

    /**
     * Hook timeout: 60s for the global setup (migration apply + seed). Migrations
     * 000–005 are expected to run in under 5s on a warm Postgres, but cold-start
     * containers on CI may need up to 15s.
     */
    hookTimeout: 60_000,

    /**
     * Pool: forks for true process isolation between test files. Integration tests
     * share TEST_DATABASE_URL but each transaction is rolled back — no shared state
     * leaks between test files within a single run.
     *
     * TLC-057 diagnostic (2026-05-11): `singleFork: true` forces sequential
     * test-file execution within the forks pool. Eliminates cross-fork
     * pollution of the long-lived outer `BEGIN` in tests/setup.ts:390 that
     * `pg_advisory_xact_lock` operations in migrations/002_audit_chain.sql:506
     * accumulate against (xact-scope locks release at COMMIT, not at
     * SAVEPOINT rollback). See `docs/TLC-057-i003-Flake-Static-Analysis-2026-
     * 05-11.md` §H3 (HIGH confidence root-cause hypothesis).
     *
     * Trade-off: slower CI (sequential vs parallel test files). The 4×
     * recurrence in the 2026-05-11 turn argues the parallelism's
     * fairness-vs-speed trade was wrong; sequential is the right default
     * until Sprint 35 / TLC-057 lands the proper fix (move outer BEGIN
     * from process-scope to per-file scope so locks release between
     * files; then this diagnostic can be reverted).
     *
     * Validation: this commit alone should eliminate the 2 flake-variant
     * recurrences observed in the 2026-05-11 turn. If CI now stays
     * deterministically green across 5+ subsequent PR runs, H3 is
     * empirically validated and TLC-057 can plan the proper fix with
     * confidence.
     */
    pool: 'forks',
    // Vitest 4 migration (per migration guide § pool-rework):
    // `poolOptions.<pool>` was promoted to a top-level `<pool>` option.
    // Before:  poolOptions: { forks: { singleFork: true } }
    // After:   forks: { singleFork: true }
    // Semantics unchanged; only the config-key shape moved one level up.
    forks: {
      singleFork: true,
    },

    /**
     * Print a newline before each test file name for readability in CI logs.
     */
    logHeapUsage: false,

    // Benchmark configuration (Sprint 7 / TLC-018).
    //
    // Vitest bench mode is invoked via `vitest bench` (mapped to
    // `npm run bench`). It is independent from `vitest run` (mapped to
    // `npm test`) — bench files use `bench()` instead of `it()` and
    // are NOT executed by the standard test runner.
    //
    // Bench is SIGNAL, not GATE at v0.1 — CI does not block on bench
    // results. See tests/perf/README.md for the operating model and
    // Sprint 11 promotion path (per ORT v1.5 OR-218).
    //
    // include: only *.bench.ts files under tests/perf/. The standard
    //   test runner's bench-file glob exclusion is implicit because
    //   the standard `include` only matches *.test.ts.
    // exclude: standard exclusions; tests/setup.ts is intentionally
    //   omitted from benches (no DB needed for the v0.1 bench corpus
    //   — pure-function targets only).
    //
    // NOTE: glob literals are kept out of any JSDoc above this block
    // because esbuild's block-comment scanner treats the `*/` inside
    // `**/*` as a comment terminator (same constraint as line 48).
    // Benchmarks are configured in a separate file (vitest.bench.config.ts)
    // because the test runner's setupFiles requires an ephemeral
    // Postgres which isn't appropriate for the v0.1 pure-function
    // bench corpus. Per-mode setupFiles override under a `benchmark:`
    // key inside this config doesn't apply in Vitest 2; using a
    // dedicated config file is the clean separation.
    //
    // Run with: `npm run bench` (which maps to
    // `vitest bench --run -c vitest.bench.config.ts`).
  },
});
