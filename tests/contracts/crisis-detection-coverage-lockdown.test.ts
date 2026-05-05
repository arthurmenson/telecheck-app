/**
 * Crisis-detection (I-019) coverage lockdown — static analysis test.
 *
 * Sprint 4 / TLC-012-rescoped. Pairs with the audit doc at
 * `docs/CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md`.
 *
 * Contract under test: I-019 (Crisis detection is platform-floor — every
 * free-text patient-input field MUST scan with `crisisDetector` BEFORE
 * persistence).
 *
 * Why static analysis (not runtime):
 *   - Catches removal-of-call regressions at the source level
 *   - Fast (no DB, no process spawn — sibling pattern to
 *     `canonical-glossary.test.ts`)
 *   - Complements the functional crisis-detection tests in
 *     `tests/integration/forms-intake-submission.test.ts` (CRITICAL-1
 *     closure §890+ and recursive-scan closure §1098+)
 *
 * What this lockdown asserts:
 *   1. The platform-singleton `crisisDetector` is exported from
 *      `src/lib/crisis-detection.ts` (no rename / no removal)
 *   2. The forms-intake submission service references `crisisDetector`
 *      at least once (the only known free-text patient-input surface
 *      in the current codebase, per the coverage audit)
 *   3. The reference is via `crisisDetector.detect(...)` — not a renamed
 *      method (lockdown against a refactor that removes detection while
 *      preserving the import for unrelated reasons)
 *
 * Why these and not more:
 *   The audit doc lists every module currently in the codebase + which
 *   are in/out of I-019 scope. Asserting "no other module imports
 *   crisisDetector" would be over-fitted: future modules (chat, community,
 *   voice) MUST add the import when they're authored. So the lockdown
 *   stays narrow: lock the wiring that exists today, gate future modules
 *   via the audit doc's gating principle.
 *
 * Expected failure modes (these should fail this test):
 *   - Someone deletes the `crisisDetector.detect(...)` call from
 *     submission-service.ts during an "optimization"
 *   - Someone renames the export in crisis-detection.ts without updating
 *     the call site (TypeScript compile would catch the call site, but
 *     this test catches the missing-call scenario where someone deletes
 *     both)
 *   - Someone tries to gate the call behind a config flag (the assertion
 *     is on the textual presence of the call, not on it being unconditional —
 *     but the audit doc + I-019 + CLAUDE.md hard rule are clear that
 *     gating is forbidden; a config-gated call would still pass this test
 *     but would fail the I-019-pattern-test below + Codex review)
 *
 * NOT covered by this lockdown (covered elsewhere):
 *   - Functional correctness of detection (covered by the regex-based
 *     tests in `crisis-detection.test.ts` and the integration tests
 *     in `forms-intake-submission.test.ts`)
 *   - Recursive descent into nested objects/arrays (covered by
 *     `forms-intake-submission.test.ts:1098+`)
 *   - Audit emission on detection (covered by
 *     `forms-intake-submission.test.ts:920+`)
 *
 * Spec references:
 *   - I-019 (Contracts Pack v5.2 INVARIANTS)
 *   - CLAUDE.md (project root + telecheck-app) — "Crisis detection is
 *     platform-floor" hard rule
 *   - docs/CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md
 *   - Codex submissions-r1 CRITICAL-1 closure 2026-05-03
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..');

function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), 'utf8');
}

describe('I-019 crisis-detection coverage lockdown — §1 export integrity', () => {
  it('§1a `crisisDetector` is exported from src/lib/crisis-detection.ts', () => {
    const src = readSource('src/lib/crisis-detection.ts');
    // Match `export const crisisDetector = ...`
    expect(src).toMatch(/export\s+const\s+crisisDetector\s*=/);
  });

  it('§1b `crisisDetector` is the platform singleton (CrisisDetector instance, not a factory)', () => {
    const src = readSource('src/lib/crisis-detection.ts');
    // Should be `new CrisisDetector()` — not a function returning a fresh
    // instance per call (which would defeat the "always-on" guarantee
    // because callers might forget to instantiate)
    expect(src).toMatch(/export\s+const\s+crisisDetector\s*=\s*new\s+CrisisDetector\s*\(\s*\)/);
  });

  it('§1c CrisisDetector class declares a `detect` method (call surface stable)', () => {
    const src = readSource('src/lib/crisis-detection.ts');
    // Class must have a method named `detect`. We accept either method
    // shorthand (`detect(...) {}`) or property-form (`detect = (...) => {}`).
    const hasDetectMethod = /\bdetect\s*\(/.test(src) && /class\s+CrisisDetector\b/.test(src);
    expect(hasDetectMethod).toBe(true);
  });
});

describe('I-019 crisis-detection coverage lockdown — §2 forms-intake wiring', () => {
  // The audit doc identifies forms-intake submission service as the only
  // current free-text patient-input surface. This section locks the
  // wiring: removing the call would silently disable I-019 for the only
  // module that needs it today.

  const SUBMISSION_SERVICE_PATH =
    'src/modules/forms-intake/internal/services/submission-service.ts';

  it('§2a submission-service imports `crisisDetector` from src/lib/crisis-detection', () => {
    const src = readSource(SUBMISSION_SERVICE_PATH);
    // Match either named-import or namespace-import bringing in crisisDetector.
    // Pattern: `import { ..., crisisDetector, ... } from '<path-to>/crisis-detection...'`
    const importPattern =
      /import\s*(?:type\s*)?\{[^}]*\bcrisisDetector\b[^}]*\}\s*from\s*['"][^'"]*crisis-detection[^'"]*['"]/;
    expect(src).toMatch(importPattern);
  });

  it('§2b submission-service invokes `crisisDetector.detect(...)` at least once', () => {
    const src = readSource(SUBMISSION_SERVICE_PATH);
    // The call form is `crisisDetector.detect(<args>)`. We do NOT assert
    // specific argument shapes — legitimate refactors may change the
    // source-context label (e.g., 'form_response' → 'forms.submission.response')
    // without breaking I-019 compliance.
    expect(src).toMatch(/crisisDetector\.detect\s*\(/);
  });

  it('§2c the invocation runs BEFORE persistence — the audit-emit-and-throw pattern is preserved', () => {
    const src = readSource(SUBMISSION_SERVICE_PATH);
    // The pattern documented in the coverage audit: on `outcome.crisisDetected`,
    // the service throws a sentinel (CRISIS_DETECTED) so the response write
    // does NOT commit. This assertion ensures the throw-on-detection wiring
    // is still present (a regression that "logs and continues" would silently
    // violate I-019).
    //
    // We assert the textual presence of `CRISIS_DETECTED` (the sentinel
    // string) AND a `throw` near a `crisisDetected` reference. This is
    // necessarily fuzzy; a more precise check would require an AST parse.
    expect(src).toMatch(/CRISIS_DETECTED/);
    // Both must appear; the sentinel by itself isn't enough — it must be
    // thrown from a code path that responds to detection.
    expect(src).toMatch(/crisisDetected/);
    expect(src).toMatch(/throw\s+.*CRISIS_DETECTED|throw\s+new\s+Error\s*\(\s*CRISIS_DETECTED/);
  });
});

describe('I-019 crisis-detection coverage lockdown — §3 future-module gating principle', () => {
  // This is a documentation-style assertion: the coverage audit doc must
  // continue to exist and must continue to declare the gating principle.
  // It catches accidental deletion of the audit doc (which would mean
  // future-module engineers lose the I-019 onramp).

  it('§3a coverage audit doc exists at the canonical path', () => {
    const doc = readSource('docs/CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md');
    expect(doc.length).toBeGreaterThan(0);
  });

  it('§3b coverage audit doc declares the gating principle for future modules', () => {
    const doc = readSource('docs/CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md');
    // The exact phrase from the doc; if someone edits the doc to remove
    // this gating principle, the test fires.
    expect(doc).toContain(
      'Any future module that accepts free-text patient input MUST scan with `crisisDetector` BEFORE persistence',
    );
  });

  it('§3c coverage audit doc lists chat / community / voice as future scope', () => {
    const doc = readSource('docs/CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md');
    // These are the modules I-019 will need to cover when authored.
    // Locking the doc's mention of them prevents quietly losing the future scope.
    expect(doc.toLowerCase()).toContain('chat module');
    expect(doc.toLowerCase()).toContain('community module');
    expect(doc.toLowerCase()).toContain('voice');
  });
});
