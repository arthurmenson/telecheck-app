/**
 * tests/contracts/publish-gates-bypass-reference-lockdown.test.ts —
 * Lockdown contract for SI-011 kill-switch references.
 *
 * SI-011 §"Production environment guard (kill-switch)" specifies a
 * four-layer defense for `FORMS_PUBLISH_GATES_BYPASS` and the
 * `FORMS_PUBLISH_GATES_TEST_OVERRIDE_*` family. Layer 3 of the
 * defense is a CI-enforced static check: any reference to these
 * env-var names OUTSIDE the sanctioned files fails CI. This prevents
 * future code from adding a bypass path on a different surface (e.g.,
 * a debug endpoint, a CLI tool, a migration script) without explicit
 * review by the sanctioned-file owners.
 *
 * Sanctioned files (allowed to reference the bypass var names):
 *
 *   - src/modules/forms-intake/internal/services/publish-gates-killswitch.ts
 *       The kill-switch module itself. Defines the constants, the
 *       scanning predicate, and the boot/runtime check functions.
 *
 *   - src/modules/forms-intake/internal/services/template-service.ts
 *       The publishVersion service that throws PUBLISH_GATES_NOT_IMPLEMENTED
 *       when the bypass is not set with the sentinel value (the pre-
 *       existing fail-closed gate; predates the kill-switch).
 *
 *   - src/modules/forms-intake/internal/handlers/templates.ts
 *       The publish HTTP handler that wires layer 2b runtime check
 *       + Cat B audit emission.
 *
 *   - src/modules/forms-intake/audit.ts
 *       Defines the emitFormsPublishBypassAttemptInProduction audit
 *       emitter; its docblock references the env-var names by name
 *       for traceability.
 *
 *   - src/app.ts
 *       The Fastify factory that wires layer 1 (boot-hook) + layer 2a
 *       (early request guard onRequest hook).
 *
 *   - tests/integration/forms-intake-publish.test.ts
 *       Existing integration tests that set the bypass sentinel via
 *       FORMS_PUBLISH_GATES_BYPASS='unsafe-test-only' to opt into
 *       the publish path. Pre-dates the kill-switch.
 *
 *   - tests/integration/forms-intake-publish-gates-killswitch.test.ts
 *       The unit tests for the kill-switch module itself.
 *
 *   - tests/integration/forms-intake-templates-http.test.ts
 *       HTTP-level publish tests that also set the bypass sentinel.
 *
 *   - tests/contracts/publish-gates-bypass-reference-lockdown.test.ts
 *       THIS FILE — the contract test that enforces the lockdown.
 *
 * Documentation references (allowed): any `.md` file may discuss
 * the bypass sentinel for documentation purposes; markdown files
 * are excluded from the lockdown scan.
 *
 * Spec reference: docs/SI-011-Forms-Publish-Governance-Gates.md
 * §"Production environment guard (kill-switch)" layer 3 + Codex
 * R4 high finding closure.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * The exact files allowed to reference the bypass env-var names.
 * Paths are repo-relative with forward slashes (matching git output).
 *
 * Adding to this list requires explicit review — these files
 * collectively own the kill-switch contract.
 */
const SANCTIONED_FILES: ReadonlySet<string> = new Set([
  'src/app.ts',
  'src/modules/forms-intake/audit.ts',
  'src/modules/forms-intake/internal/handlers/templates.ts',
  'src/modules/forms-intake/internal/services/publish-gates-killswitch.ts',
  'src/modules/forms-intake/internal/services/template-service.ts',
  'tests/contracts/publish-gates-bypass-reference-lockdown.test.ts',
  'tests/integration/forms-intake-publish-gates-killswitch.test.ts',
  'tests/integration/forms-intake-publish.test.ts',
  'tests/integration/forms-intake-templates-http.test.ts',
]);

/**
 * The forbidden patterns the lockdown scans for. References in any
 * .ts file outside the sanctioned list trip the contract.
 *
 * The list intentionally includes both the all-gates bypass and the
 * prefix used for per-gate test overrides — the lockdown is about
 * the env-var NAMES, not the values.
 */
const FORBIDDEN_PATTERNS = [
  'FORMS_PUBLISH_GATES_BYPASS',
  'FORMS_PUBLISH_GATES_TEST_OVERRIDE_',
] as const;

/**
 * Runs `git grep` (preferred over a recursive readdir walk because git
 * already knows the tracked-file set and is faster on Windows). Returns
 * the list of repo-relative paths that contain the pattern in tracked
 * .ts files.
 */
function gitGrepTypescript(pattern: string): string[] {
  try {
    const stdout = execSync(
      `git grep --files-with-matches --extended-regexp -- "${pattern}" -- "*.ts"`,
      {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.replace(/\\/g, '/'));
  } catch (err) {
    // `git grep` exits non-zero when no matches are found. That's a
    // perfectly valid outcome (= layer 3 contract holds).
    const e = err as { status?: number; stdout?: Buffer | string };
    if (e.status === 1) {
      return [];
    }
    throw err;
  }
}

describe('SI-011 layer 3 — publish-gates-bypass reference lockdown', () => {
  for (const pattern of FORBIDDEN_PATTERNS) {
    it(`references to "${pattern}" in .ts files are restricted to the sanctioned set`, () => {
      const matchingFiles = gitGrepTypescript(pattern);
      const unsanctioned = matchingFiles.filter((path) => !SANCTIONED_FILES.has(path));
      expect(
        unsanctioned,
        `Found references to "${pattern}" in unsanctioned .ts files. ` +
          `SI-011 layer-3 contract: bypass-env-var references are restricted to ` +
          `the kill-switch module, the publish service/handler, the Fastify ` +
          `factory, and a small set of sanctioned tests. To add a new ` +
          `sanctioned file, update SANCTIONED_FILES in ` +
          `tests/contracts/publish-gates-bypass-reference-lockdown.test.ts ` +
          `with reviewer sign-off. Unsanctioned files: ${unsanctioned.join(', ')}`,
      ).toEqual([]);
    });
  }

  it('every sanctioned file in the list still exists and references at least one pattern', () => {
    // Defense against drift the other way: if a sanctioned file is
    // deleted or no longer references the bypass var names, it shouldn't
    // remain in the list (silently growing the allowed surface).
    const allFilesByPattern = FORBIDDEN_PATTERNS.flatMap(gitGrepTypescript);
    const referencingFiles = new Set(allFilesByPattern);
    const stale = [...SANCTIONED_FILES].filter((path) => !referencingFiles.has(path));
    expect(
      stale,
      `Sanctioned files no longer reference any bypass pattern (possibly deleted or refactored). ` +
        `Remove them from SANCTIONED_FILES if intentional. Stale entries: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Layer-coverage canaries (R6 closure: count CALL expressions, not
  // textual mentions, so comments / imports / docblocks don't satisfy
  // the canary).
  // ---------------------------------------------------------------------

  const KILL_SWITCH_TEST_PATH = 'tests/integration/forms-intake-publish-gates-killswitch.test.ts';

  /**
   * Read the kill-switch test file and strip non-code regions so the
   * canaries assert against EXECUTABLE source only. Strips, in order:
   *   1. block comments (slash-star ... star-slash, including JSDoc)
   *   2. line comments (two-slash to end of line)
   *   3. single-quoted string literals
   *   4. double-quoted string literals
   *   5. template literals (backtick ... backtick, including ${} expressions)
   *
   * After stripping, only executable identifiers + punctuation remain.
   * An assertion message like
   *   `... ${KILL_SWITCH_TEST_PATH} no longer references
   *   assertNoPublishGateBypassAtBoot ...`
   * would have been counted as a layer-1 call by the prior regex, but
   * after template-literal stripping it cannot — defending R6/R7's
   * "executable test calls only" guarantee.
   *
   * Note on regex literals: not stripped here because the test file
   * has none that contain the target identifiers. If future tests add
   * regex literals containing the identifiers (highly unusual), extend
   * this function to strip `/.../flags` as well.
   */
  function readTestFileExecutableSource(): string {
    const source = readFileSync(join(REPO_ROOT, KILL_SWITCH_TEST_PATH), 'utf-8');
    return (
      source
        // 1. block comments
        .replace(/\/\*[\s\S]*?\*\//g, '')
        // 2. line comments
        .replace(/\/\/[^\n]*$/gm, '')
        // 3. single-quoted strings (with escape handling)
        .replace(/'(?:\\.|[^'\\])*'/g, "''")
        // 4. double-quoted strings (with escape handling)
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        // 5. template literals (handles ${} interpolation by greedy match
        //    to next unescaped backtick; nested templates are not handled
        //    perfectly but suffice for this codebase's test conventions)
        .replace(/`(?:\\.|[^`\\])*`/g, '``')
    );
  }

  /**
   * Counts call-expression occurrences of `name(` in the source string.
   * Requires the identifier to appear as a callee — matching the open
   * paren ensures we're not counting import statements, type-only refs,
   * or string literals.
   *
   * Minimum threshold for the canaries is 2 — the kill-switch test
   * file should have at least one assertion using each layer function
   * AND typically additional setup/expect calls. A value below 2
   * strongly indicates the layer's tests were deleted.
   */
  function countCallExpressions(source: string, identifier: string): number {
    // Escape regex metachars in the identifier (defensive; current
    // identifiers are bare words but a future test might pass a
    // method-style name).
    const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\s*\\(`, 'g');
    return (source.match(pattern) ?? []).length;
  }

  const MIN_CALLS_PER_LAYER = 2;

  it('the layer-1 boot-hook test remains wired (call-expression canary)', () => {
    const stripped = readTestFileExecutableSource();
    const callCount = countCallExpressions(stripped, 'assertNoPublishGateBypassAtBoot');
    expect(
      callCount >= MIN_CALLS_PER_LAYER,
      `Layer 1 (boot-hook) test coverage missing in ${KILL_SWITCH_TEST_PATH}. ` +
        `Expected at least ${MIN_CALLS_PER_LAYER} call expressions to ` +
        `assertNoPublishGateBypassAtBoot(), found ${callCount}. ` +
        `Comments/imports/docblock references do not count toward this canary — ` +
        `executable test calls only.`,
    ).toBe(true);
  });

  it('the layer-2 runtime-check test remains wired (call-expression canary)', () => {
    const stripped = readTestFileExecutableSource();
    const callCount = countCallExpressions(stripped, 'checkPublishGateBypassAtRuntime');
    expect(
      callCount >= MIN_CALLS_PER_LAYER,
      `Layer 2 (runtime-check) test coverage missing in ${KILL_SWITCH_TEST_PATH}. ` +
        `Expected at least ${MIN_CALLS_PER_LAYER} call expressions to ` +
        `checkPublishGateBypassAtRuntime(), found ${callCount}. ` +
        `Comments/imports/docblock references do not count toward this canary — ` +
        `executable test calls only. Asserted independently from layer 1 so ` +
        `deleting one layer's tests while preserving the other still fails CI.`,
    ).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Regression test for R7 (mutation-style): prove that string-literal
  // mentions of the layer functions do NOT satisfy the canary.
  //
  // Constructs synthetic sources where the identifiers appear ONLY
  // inside string/template literals + comments, and asserts the call-
  // expression counter returns 0. This pins the "executable only"
  // guarantee against future regressions in the strip pipeline.
  // ---------------------------------------------------------------------

  it('countCallExpressions returns 0 when identifier appears only in comments / strings / templates', () => {
    // Inline-construct the fixture so we don't have to keep a separate
    // sample file in sync. Each literal-class is exercised:
    // - block comment
    // - line comment
    // - single-quoted string
    // - double-quoted string
    // - template literal
    // The strip pipeline must remove ALL of these before counting calls.
    const fixture = [
      '/* assertNoPublishGateBypassAtBoot(envFixture) — in block comment */',
      '// assertNoPublishGateBypassAtBoot(envFixture) — in line comment',
      "const a = 'assertNoPublishGateBypassAtBoot(envFixture) — single-quoted';",
      'const b = "assertNoPublishGateBypassAtBoot(envFixture) — double-quoted";',
      'const c = `assertNoPublishGateBypassAtBoot(envFixture) — template`;',
      'const d = `with ${interpolation} but no call here`;',
    ].join('\n');

    const stripped = fixture
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*$/gm, '')
      .replace(/'(?:\\.|[^'\\])*'/g, "''")
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/`(?:\\.|[^`\\])*`/g, '``');

    const callCount = countCallExpressions(stripped, 'assertNoPublishGateBypassAtBoot');
    expect(callCount).toBe(0);
  });

  it('countCallExpressions returns N when identifier appears as N real call expressions', () => {
    const fixture = [
      'assertNoPublishGateBypassAtBoot(envOf({}));',
      'assertNoPublishGateBypassAtBoot ( envOf({}) );', // whitespace before paren
      'const result = checkPublishGateBypassAtRuntime(process.env);',
    ].join('\n');

    expect(countCallExpressions(fixture, 'assertNoPublishGateBypassAtBoot')).toBe(2);
    expect(countCallExpressions(fixture, 'checkPublishGateBypassAtRuntime')).toBe(1);
  });
});
