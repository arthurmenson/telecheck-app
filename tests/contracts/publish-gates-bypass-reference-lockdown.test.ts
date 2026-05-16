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
import { resolve } from 'node:path';

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

  it('the layer-1 boot-hook test remains wired (canary)', () => {
    // Layer 1 boot-hook function `assertNoPublishGateBypassAtBoot` MUST
    // be exercised by the kill-switch unit tests file. If that
    // reference disappears (test deletion, refactor, file rename), the
    // contract fails loudly — preserving the kill-switch's safety floor
    // requires both layer test files to remain wired.
    const layer1Files = new Set(gitGrepTypescript('assertNoPublishGateBypassAtBoot'));
    expect(
      layer1Files.has('tests/integration/forms-intake-publish-gates-killswitch.test.ts'),
      'Layer 1 (boot-hook) test wiring missing: ' +
        'tests/integration/forms-intake-publish-gates-killswitch.test.ts no longer ' +
        'references assertNoPublishGateBypassAtBoot. If the file was renamed, ' +
        'update both this canary and SANCTIONED_FILES.',
    ).toBe(true);
  });

  it('the layer-2 runtime-check test remains wired (canary)', () => {
    // Layer 2b runtime function `checkPublishGateBypassAtRuntime` MUST
    // be exercised by the kill-switch unit tests file. Asserted
    // independently from layer 1 so a future commit that deletes ONE
    // layer's tests (but keeps the other) still fails CI — preventing
    // silent coverage loss on the four-layer defense.
    const layer2Files = new Set(gitGrepTypescript('checkPublishGateBypassAtRuntime'));
    expect(
      layer2Files.has('tests/integration/forms-intake-publish-gates-killswitch.test.ts'),
      'Layer 2 (runtime-check) test wiring missing: ' +
        'tests/integration/forms-intake-publish-gates-killswitch.test.ts no longer ' +
        'references checkPublishGateBypassAtRuntime. If the file was renamed, ' +
        'update both this canary and SANCTIONED_FILES.',
    ).toBe(true);
  });
});
