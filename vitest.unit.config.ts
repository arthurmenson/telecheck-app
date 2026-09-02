/**
 * vitest.unit.config.ts — pure-function test runner, no Postgres required.
 *
 * ## Why this exists
 *
 * The main config (`vitest.config.ts`) applies `tests/setup.ts` as a GLOBAL
 * setup file. That setup opens a Postgres connection, applies migrations,
 * seeds RBAC and installs a test role — so **every** test file, including
 * ones that touch nothing but pure functions, fails to collect without a
 * live `TEST_DATABASE_URL`.
 *
 * The practical consequence was worse than inconvenience. During Sprint
 * 1.2a, five tests asserting that Layer 1's wink-nlp NER detects person
 * names turned out to have **never executed**, because no local run was
 * possible and the failures had not yet surfaced in CI. They were passing
 * in nobody's world. The same blind spot hid two stale assertions pinning
 * behaviour that had already been replaced, and a real ordering defect in
 * which `us_ssn` consumed the digits of a Ghana Card and mislabelled it.
 *
 * A test suite that cannot be run locally gets written but not exercised.
 * This config closes that gap for the files that genuinely need no
 * database.
 *
 * Run with: `npm run test:unit`
 *
 * ## Why an explicit include list rather than a glob
 *
 * `src/**` contains a mix: `ulid.test.ts` is pure, `db.probe.test.ts` and
 * `with-db-role.test.ts` are not. A broad glob would pull in the
 * DB-dependent ones and fail, which would train everyone to ignore the
 * result — the same failure mode this config exists to fix.
 *
 * So the list is opt-in and grows as files are confirmed DB-free. It is
 * NOT a substitute for `npm test`, which remains the full suite and the
 * CI gate; it is the fast inner loop.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',

    // Explicit opt-in. Add a file here once it is confirmed to need no
    // database, no Redis, and no Fastify app instance.
    include: [
      'tests/unit/check-log-call-sites.test.ts',
      'src/lib/pii-screener/index.test.ts',
      'src/lib/pii-screener/log-redaction.test.ts',
    ],

    // No `setupFiles`. That omission is the entire point of this config.

    testTimeout: 30_000,
  },
});
