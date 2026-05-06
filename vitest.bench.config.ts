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
 * Sprint 17 / TLC-027 EXECUTE update (2026-05-06):
 *   `setupFiles` is now ALWAYS-ON — set unconditionally to
 *   `tests/perf/db/setup.ts`. Closes Codex perf-bench-r10-A HIGH
 *   2026-05-05: prior Sprint 14 SCAFFOLD attempt made setupFiles
 *   conditional on `BENCH_DATABASE_URL` presence, which fail-opened
 *   when env was unset (DB-backed bench files would silently fall
 *   back to the production app pool / dev DB).
 *
 *   The setup file's `beforeAll` fast-exits with success when
 *   `BENCH_DATABASE_URL` is unset, so pure-function benches still
 *   run without a Postgres dependency. DB-backed bench files
 *   explicitly import + call `requireBenchDb()` from the setup file,
 *   which throws at bench-file load time if the env was unset —
 *   forcing the operator to set BENCH_DATABASE_URL before the
 *   DB-backed bench can run.
 *
 *   This removes the prior config-time conditional and pushes the
 *   env-presence check to bench-file load time, where it produces
 *   a clear actionable error rather than silent fallback.
 *
 * Sprint 17 also lands `tests/perf/audit/emit-audit.bench.ts` — the
 * first DB-backed bench scenario (§9 emit-audit happy-path single-row
 * append). With this scaffold validated, additional DB-backed scenarios
 * (idempotency lookup, withTenantBoundConnection, repo CRUD) land in
 * Sprint 18+.
 *
 * Bench is SIGNAL, not GATE at v0.1 — CI does not block on bench
 * results. See tests/perf/README.md for the operating model and
 * Sprint 11 promotion path (per ORT v1.5 OR-218).
 *
 * Spec references:
 *   - ORT v1.5 OR-218 (Performance and load test plan)
 *   - tests/perf/README.md (operating model)
 *   - tests/perf/db/setup.ts (bench-mode DB setup; Sprint 17 / TLC-027)
 *   - src/lib/db.ts setBenchPool() (NEW Sprint 17 / TLC-027)
 *   - docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md (acceptance criteria)
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // setupFiles: ALWAYS-ON (Codex r10-A closure). The setup file
    // fast-exits when BENCH_DATABASE_URL is unset, so pure-function
    // benches still run without Postgres. DB-backed bench files
    // explicitly call requireBenchDb() to assert the bench DB is
    // initialized.
    setupFiles: ['./tests/perf/db/setup.ts'],

    // Only bench files; never collect *.test.ts files in bench mode.
    include: [],
    exclude: ['node_modules', 'dist'],

    // Benchmark configuration: only collect pure-function bench files
    // (*.bench.ts) under tests/perf/. DB-backed bench files use the
    // *.db.bench.ts suffix and are EXCLUDED from this default config —
    // they require BENCH_DATABASE_URL + a Postgres service container,
    // and run via a separate workflow / config (perf-db.yml planned
    // Sprint 18+).
    //
    // Sprint 17 / TLC-027 fix-forward (r11-CI-module-load closure):
    // earlier attempt put emit-audit.bench.ts under the default glob,
    // which caused vitest to load it (and call requireBenchDb() at
    // module level) in CI's perf.yml that doesn't set
    // BENCH_DATABASE_URL — failing the entire bench session. The
    // .db.bench.ts naming convention separates the two contexts cleanly.
    benchmark: {
      include: ['tests/perf/**/*.bench.ts'],
      exclude: ['node_modules', 'dist', 'tests/perf/**/*.db.bench.ts'],
      reporters: ['default'],
    },

    // Pool: forks for process isolation. Bench runs typically don't
    // need this but it matches the rest of the config for consistency.
    pool: 'forks',
  },
});
