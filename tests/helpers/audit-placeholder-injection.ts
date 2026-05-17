/**
 * audit-placeholder-injection.ts — second injector instance for the
 * parallel-injection integration test.
 *
 * Test-only helper that bundles the `aiServiceAuditPlaceholder`
 * injector behind a stable module export so the corresponding test
 * file's `vi.mock` factory can reference it without tripping the
 * Vitest hoisting / TDZ ordering hazard.
 *
 * Why this is a separate module (not declared inline in the test):
 *
 *   `vi.mock` factories are HOISTED to the top of the test module's
 *   load sequence — they run BEFORE any top-level `const`
 *   declarations in the test file. A factory that references a
 *   test-file-local `const` produces a TDZ error when the mocked
 *   module is first imported. Imports, however, ARE hoisted in the
 *   same pass as `vi.mock` factories, so an injector exported from
 *   a separate helper module IS available when the factory runs.
 *
 *   This mirrors the existing PR #163 / #165 pattern at
 *   `tests/helpers/mode-1-chat-audit-injection.ts` where the Mode 1
 *   injector instance lives in a helper module so PR #163's
 *   vi.mock factory can reference the imported binding safely.
 *
 *   Codex R1 H1 closure on PR #170 (2026-05-17) caught this hazard
 *   in an earlier draft that declared the second injector inline in
 *   the test file.
 *
 * Scope: this helper is intentionally narrow — it exists ONLY to
 * support the parallel-injection integration test in
 * `tests/integration/audit-failure-injection-parallel.test.ts`.
 * The underlying `aiServiceAuditPlaceholder` function is a type-cast
 * helper, NOT a production audit emitter, so this injector has no
 * production-handler call site to inject into. New test files
 * exercising real production emitters should follow the Mode 1
 * pattern of bundling per-emitter injectors in dedicated helpers
 * (per PR #165's "Future emitter harnesses" documented pattern).
 */

import {
  type AuditFailureInjector,
  createAuditFailureInjector,
} from './audit-failure-injection.ts';

/**
 * The single injector instance bound to `aiServiceAuditPlaceholder`.
 * Imported by the parallel-injection test file + referenced by that
 * file's `vi.mock` factory. Constructed at module-load time per the
 * PR #165 closure-per-instance contract — independent of any other
 * injector instance the rest of the test suite holds.
 */
export const auditPlaceholderInjector: AuditFailureInjector = createAuditFailureInjector(
  'aiServiceAuditPlaceholder',
);
