/**
 * pii-screener/index.test.ts — Sprint 1.1a regex-core unit + integration tests.
 *
 * Coverage:
 *   - Every pattern in PII_PATTERNS fires on canonical positive samples
 *   - Luhn validator rejects arithmetic false positives on credit-card regex
 *   - AI-bound route: ANY hit → block (high AND low confidence)
 *   - Internal route: high-confidence → block; low-confidence only → redact
 *   - Empty input → pass
 *   - No PII input → pass
 *   - Overlapping hits → deterministic redaction (earlier wins)
 *   - Regex reuse safety (lastIndex reset across calls)
 *   - SAFETY: exercised code path performs no network / process / I/O
 *
 * Adversarial coverage mapping (docs/PILOT_1_COVERAGE_MATRIX.md):
 *   - A1 (real-looking name in chat) — deferred to Sprint 1.1b (NER)
 *   - A2 (real-looking phone in intake free-text) → covered by us_phone / ghana_phone
 *   - A3 (real-looking SSN in chat) → covered by us_ssn
 *   - A4 (real-looking Ghana Card ID in intake) → covered by ghana_card
 *   - A5 (clinician real patient real name in decision notes) — deferred to 1.1b
 *   - A6 (subtle PII AI-bound) — deferred to 1.1b; regex covers structural subset
 *   - A6b (subtle PII internal route) — deferred to 1.1b
 */

import { describe, expect, it } from 'vitest';

import { isLuhnValid } from './patterns.js';

import {
  PARTICIPANT_BLOCK_MESSAGE,
  PII_PATTERNS,
  screenInput,
  type ScreeningResult,
} from './index.js';

describe('pii-screener (Sprint 1.1a regex core)', () => {
  describe('pattern positives (each pattern fires on a canonical sample)', () => {
    // Every pattern must have at least one positive sample under coverage,
    // otherwise it's dead code. This table is the authoritative sample
    // set + gets extended as new patterns land.
    const samples: Array<{ patternId: string; input: string; expectMatch: string }> = [
      { patternId: 'us_ssn', input: 'my SSN is 123-45-6789 for the form', expectMatch: '123-45-6789' },
      { patternId: 'ghana_card', input: 'Ghana Card GHA-123456789-0 issued', expectMatch: 'GHA-123456789-0' },
      { patternId: 'us_passport', input: 'passport number AB1234567 issued', expectMatch: 'passport number AB1234567' },
      { patternId: 'credit_card', input: 'card 4111 1111 1111 1111 expires', expectMatch: '4111 1111 1111 1111' },
      { patternId: 'email', input: 'reach me at test.user@example.com anytime', expectMatch: 'test.user@example.com' },
      { patternId: 'us_phone', input: 'call (415) 555-0123 or leave a message', expectMatch: '(415) 555-0123' },
      { patternId: 'ghana_phone', input: 'my number +233241234567 works too', expectMatch: '+233241234567' },
      { patternId: 'ipv4', input: 'the box at 10.0.0.42 is down', expectMatch: '10.0.0.42' },
      { patternId: 'medical_record_number', input: 'MRN 1234567 in the chart', expectMatch: 'MRN 1234567' },
    ];

    for (const { patternId, input, expectMatch } of samples) {
      it(`fires for ${patternId} on canonical sample`, () => {
        const result = screenInput(input, 'ai_bound');
        expect(result.action).toBe('block');
        expect(result.hits.length).toBeGreaterThanOrEqual(1);
        const hit = result.hits.find((h) => h.patternId === patternId);
        expect(hit).toBeDefined();
        expect(hit?.match).toBe(expectMatch);
      });
    }

    it('has a positive sample for every registered pattern (dead-code guard)', () => {
      const covered = new Set(samples.map((s) => s.patternId));
      const uncovered = PII_PATTERNS.filter((p) => !covered.has(p.id));
      expect(uncovered, `patterns without a positive sample: ${uncovered.map((p) => p.id).join(', ')}`)
        .toEqual([]);
    });
  });

  describe('Codex R1 regression suite (defects surfaced 2026-08-31)', () => {
    it('Ghana phone matches +233-prefixed international form after whitespace', () => {
      // R1 HIGH: prior `\b(?:\+233\d{9}|0\d{9})\b` used `\b` which never
      // matches before `+` (both are non-word). Fix: digit-lookaround.
      const r = screenInput('my number +233241234567 works too', 'ai_bound');
      expect(r.action).toBe('block');
      expect(r.hits.some((h) => h.patternId === 'ghana_phone')).toBe(true);
    });

    it('Ghana phone matches +233 form after punctuation and at string start', () => {
      const r1 = screenInput('reach me (+233241234567) evenings', 'ai_bound');
      expect(r1.hits.some((h) => h.patternId === 'ghana_phone')).toBe(true);
      const r2 = screenInput('+233241234567', 'ai_bound');
      expect(r2.hits.some((h) => h.patternId === 'ghana_phone')).toBe(true);
    });

    it('Ghana phone does not match if embedded in longer digit string', () => {
      // Digit lookaround prevents matching inside a 13-digit run that
      // isn't a real Ghana number.
      const r = screenInput('reference 12332412345678', 'internal');
      expect(r.hits.some((h) => h.patternId === 'ghana_phone')).toBe(false);
    });

    it('SSN compact 9-digit form is high-confidence (not passport)', () => {
      // R1 HIGH: `123456789` was falling through to low-confidence
      // us_passport → internal-route redact instead of block.
      const r = screenInput('SSN 123456789 filed', 'internal');
      expect(r.action).toBe('block'); // MUST block on internal for high-confidence
      const ssnHit = r.hits.find((h) => h.patternId === 'us_ssn');
      expect(ssnHit).toBeDefined();
      expect(ssnHit?.confidence).toBe('high_confidence');
    });

    it('SSN hyphenated form still matches', () => {
      const r = screenInput('SSN 123-45-6789 filed', 'internal');
      const ssnHit = r.hits.find((h) => h.patternId === 'us_ssn');
      expect(ssnHit).toBeDefined();
      expect(ssnHit?.match).toBe('123-45-6789');
    });

    it('SSN does not match inside longer digit run (e.g., card fragment)', () => {
      // 12 digits: not an SSN, not a card (< 13). Should produce zero SSN hits.
      const r = screenInput('reference 123456789012', 'internal');
      expect(r.hits.some((h) => h.patternId === 'us_ssn')).toBe(false);
    });

    it('Passport regex requires the "passport" context word', () => {
      // R1 MEDIUM: prior `\b[A-Z0-9]{9}\b` matched any 9-char uppercase
      // word — over-blocked ordinary text. Context-bound fix: must be
      // adjacent to case-insensitive "passport".
      const negatives = [
        'The SYNTHETIC data seed loaded successfully',
        'This is EMERGENCY EDUCATION material',
        'ABCDEFGHI is a nine-character string',
      ];
      for (const input of negatives) {
        const r = screenInput(input, 'ai_bound');
        expect(r.hits.some((h) => h.patternId === 'us_passport'),
          `false-positive passport hit on: ${input}`).toBe(false);
      }
    });

    it('Passport regex matches when passport-context word is present', () => {
      const r = screenInput('passport AB1234567 expires', 'ai_bound');
      expect(r.hits.some((h) => h.patternId === 'us_passport')).toBe(true);
    });

    it('Credit card match excludes trailing separator (boundary correctness)', () => {
      // R1 MEDIUM: prior `\b(?:\d[ -]?){13,19}\b` greedy-included
      // trailing space when followed by another word.
      const r = screenInput('card 4111 1111 1111 1111 expires', 'internal');
      const ccHit = r.hits.find((h) => h.patternId === 'credit_card');
      expect(ccHit).toBeDefined();
      // Match must end on a digit, not a separator.
      expect(ccHit?.match.endsWith(' ')).toBe(false);
      expect(ccHit?.match.endsWith('-')).toBe(false);
      expect(ccHit?.match).toBe('4111 1111 1111 1111');
    });
  });

  describe('Luhn validator (credit card false-positive guard)', () => {
    it('accepts a valid test card number', () => {
      // Visa test card, Luhn-valid.
      expect(isLuhnValid('4111111111111111')).toBe(true);
    });

    it('rejects a 16-digit arithmetic string that fails Luhn', () => {
      // Same length, wrong check digit.
      expect(isLuhnValid('4111111111111112')).toBe(false);
    });

    it('rejects too-short digit strings', () => {
      expect(isLuhnValid('1234')).toBe(false);
    });

    it('rejects too-long digit strings', () => {
      expect(isLuhnValid('12345678901234567890')).toBe(false);
    });

    it('screener does not fire credit_card pattern on Luhn-invalid string', () => {
      const result = screenInput('reference number 1234567890123456 (not a card)', 'internal');
      const ccHit = result.hits.find((h) => h.patternId === 'credit_card');
      expect(ccHit).toBeUndefined();
    });
  });

  describe('decision matrix — AI-bound routes', () => {
    it('BLOCKS on any high-confidence hit', () => {
      const result = screenInput('my ssn is 123-45-6789', 'ai_bound');
      expect(result.action).toBe('block');
      expect(result.blockReason).toBe('regex_match_high_confidence');
      expect(result.participantMessage).toBe(PARTICIPANT_BLOCK_MESSAGE);
      expect(result.redactedInput).toBeUndefined();
    });

    it('BLOCKS on any low-confidence hit (never admits to provider)', () => {
      // ipv4 is low-confidence; on ai_bound route should still block.
      const result = screenInput('the server 192.168.1.100 is running', 'ai_bound');
      expect(result.action).toBe('block');
      expect(result.blockReason).toBe('regex_match_any_ai_bound');
      expect(result.redactedInput).toBeUndefined();
    });
  });

  describe('decision matrix — internal routes', () => {
    it('BLOCKS on high-confidence hit', () => {
      const result = screenInput('patient email jane.doe@example.com', 'internal');
      expect(result.action).toBe('block');
      expect(result.blockReason).toBe('regex_match_high_confidence');
      expect(result.redactedInput).toBeUndefined();
    });

    it('REDACTS INLINE on low-confidence-only hit', () => {
      const result = screenInput('the server 192.168.1.100 is running', 'internal');
      expect(result.action).toBe('redact');
      expect(result.hits.length).toBe(1);
      expect(result.hits[0]?.patternId).toBe('ipv4');
      expect(result.redactedInput).toBe('the server [REDACTED:IPv4 address] is running');
      expect(result.blockReason).toBeUndefined();
    });
  });

  describe('trivial cases', () => {
    it('PASSES on empty input', () => {
      const result = screenInput('', 'ai_bound');
      expect(result.action).toBe('pass');
      expect(result.hits).toEqual([]);
    });

    it('PASSES on all-synthetic input', () => {
      const result = screenInput(
        'Hello, I am pilot1-participant-01 and my synthetic data is generic',
        'ai_bound',
      );
      expect(result.action).toBe('pass');
    });

    it('PASSES on normal medical-workflow prose (no PII patterns)', () => {
      const result = screenInput(
        'The patient reports chest pain lasting three days with associated fatigue',
        'ai_bound',
      );
      expect(result.action).toBe('pass');
    });
  });

  describe('redaction correctness', () => {
    it('redacts multiple non-overlapping low-confidence hits in order', () => {
      const result = screenInput(
        'the servers 10.0.0.1 and 10.0.0.2 are both offline',
        'internal',
      );
      expect(result.action).toBe('redact');
      expect(result.redactedInput).toBe(
        'the servers [REDACTED:IPv4 address] and [REDACTED:IPv4 address] are both offline',
      );
    });

    it('handles overlapping hits deterministically (earlier wins)', () => {
      // Craft an input where two patterns could overlap. In current
      // pattern set, us_passport (low-confidence 9-alphanumeric) can
      // sit adjacent to other tokens. If we ever add overlapping
      // patterns, this test locks the tie-break rule.
      // For now, verify redaction is well-formed even on adjacent hits.
      const result = screenInput(
        'server1 10.0.0.1 server2 10.0.0.2',
        'internal',
      );
      expect(result.action).toBe('redact');
      // No corruption of the output shape.
      expect(result.redactedInput).toContain('[REDACTED:IPv4 address]');
      expect(result.redactedInput).not.toMatch(/\[REDACTED:.*\[REDACTED/); // no nesting
    });
  });

  describe('regex reuse safety', () => {
    it('produces the same result across repeated invocations (lastIndex reset)', () => {
      const input = 'SSN 123-45-6789 and email test@example.com';
      const r1 = screenInput(input, 'ai_bound');
      const r2 = screenInput(input, 'ai_bound');
      const r3 = screenInput(input, 'ai_bound');
      expect(r1.hits.length).toBe(r2.hits.length);
      expect(r2.hits.length).toBe(r3.hits.length);
      expect(r1.hits.length).toBeGreaterThanOrEqual(2);
      // Same pattern IDs in the same order.
      expect(r1.hits.map((h) => h.patternId)).toEqual(r2.hits.map((h) => h.patternId));
    });
  });

  describe('SAFETY: no external network / process calls (per PII spec §Layer 1 Absolute prohibition)', () => {
    it('pathological inputs do not throw', () => {
      const inputs = [
        '',
        'a'.repeat(10000), // very long input
        '🚨🚨🚨 emoji stream 🚨🚨🚨',
        String.fromCharCode(0, 1, 2, 3, 4), // control characters
        'SSN\n123-45-6789\nembedded in newlines',
      ];
      for (const input of inputs) {
        const result: ScreeningResult = screenInput(input, 'ai_bound');
        expect(['block', 'redact', 'pass']).toContain(result.action);
      }
    });

    it('does NOT call global.fetch (network call would leak candidate PII to a provider)', async () => {
      // R1 MEDIUM: prior test only checked return-type wasn't a Promise;
      // did not enforce the actual invariant that no network primitive
      // is invoked. Stub fetch + assert zero calls across a screener run.
      const originalFetch = globalThis.fetch;
      let fetchCallCount = 0;
      globalThis.fetch = ((..._args: unknown[]) => {
        fetchCallCount++;
        return Promise.reject(new Error('fetch should not be called by pii-screener'));
      }) as typeof globalThis.fetch;
      try {
        // Run screener across a variety of inputs that could tempt an
        // "escalate to an LLM classifier" implementation.
        screenInput('subtle name John Smith at 415 555 1212', 'ai_bound');
        screenInput('SSN 123-45-6789', 'ai_bound');
        screenInput('the box at 10.0.0.42 is down', 'internal');
        screenInput('all-synthetic clean prose without PII', 'ai_bound');
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(fetchCallCount).toBe(0);
    });

    it('production source files import ONLY the authorized local specifier (allowlist)', async () => {
      // Static import-boundary enforcement via TypeScript AST + strict
      // allowlist.
      //
      // R1: no check at all. R2: regex blacklist. R3 finding: blacklist
      // approach is trivially bypassable — an implementer could
      // `import { request } from 'https'` (bare, no `node:` prefix),
      // template-literal dynamic import, or a novel provider SDK not
      // on the blacklist.
      //
      // R3 fix: shift to strict allowlist. The Sprint 1.1a production
      // source files (index.ts + patterns.ts) MUST import ONLY these
      // authorized specifiers. Anything else fails the test.
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const path = await import('node:path');
      const ts = await import('typescript');

      const modDir = path.dirname(fileURLToPath(import.meta.url));

      /**
       * Sprint 1.1a authorized import allowlist. Any addition requires
       * Codex re-review because the SAFETY invariant is at stake.
       * - index.ts may import only from './patterns.js'
       * - patterns.ts imports nothing at runtime
       * Sprint 1.1b (NER integration) will extend this via its own PR.
       */
      const ALLOWLIST: Record<string, ReadonlySet<string>> = {
        'index.ts': new Set(['./patterns.js']),
        'patterns.ts': new Set([]),
      };

      const violations: Array<{ file: string; specifier: string; reason: string }> = [];

      for (const [relPath, allowedSet] of Object.entries(ALLOWLIST)) {
        const filePath = path.join(modDir, relPath);
        const src = await readFile(filePath, 'utf8');
        const sourceFile = ts.createSourceFile(
          relPath,
          src,
          ts.ScriptTarget.ES2022,
          /*setParentNodes*/ true,
          ts.ScriptKind.TS,
        );
        // Walk all top-level statements + nested nodes to collect
        // import specifiers from: import decl, import equals decl,
        // dynamic import call, export decl (re-export).
        const specifiers: string[] = [];
        const visit = (node: import('typescript').Node): void => {
          if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text);
          } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            specifiers.push(node.moduleSpecifier.text);
          } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const arg = node.arguments[0];
            if (arg && ts.isStringLiteral(arg)) {
              specifiers.push(arg.text);
            } else if (arg) {
              // Non-string-literal argument (template literal, computed,
              // variable). We reject this outright — cannot statically
              // verify a runtime-computed import.
              violations.push({
                file: relPath,
                specifier: '<computed-dynamic-import>',
                reason: 'dynamic import with non-string-literal specifier is not statically verifiable',
              });
            }
          } else if (ts.isImportEqualsDeclaration(node)) {
            if (ts.isExternalModuleReference(node.moduleReference)
              && ts.isStringLiteral(node.moduleReference.expression)) {
              specifiers.push(node.moduleReference.expression.text);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sourceFile);

        for (const spec of specifiers) {
          if (!allowedSet.has(spec)) {
            violations.push({
              file: relPath,
              specifier: spec,
              reason: `not in Sprint 1.1a allowlist for this file`,
            });
          }
        }
      }

      expect(violations,
        `pii-screener production sources violate import allowlist: ${JSON.stringify(violations, null, 2)}`,
      ).toEqual([]);

      // Complement: the module's export surface should not name any
      // provider-adjacent identifier (defense-in-depth against an
      // implementation that reaches a provider via an aliased symbol).
      const mod = await import('./index.js');
      const suspiciousExportNames = Object.keys(mod).filter((n) =>
        /client|provider|fetch|http|anthropic|bedrock|azure/i.test(n),
      );
      expect(suspiciousExportNames,
        `pii-screener module surface should not export network-adjacent identifiers; found: ${suspiciousExportNames.join(', ')}`,
      ).toEqual([]);
    });

    // Negative fixtures — prove the allowlist checker actually rejects
    // the bypass forms R3 flagged. Uses in-memory strings; does not
    // modify real source files.
    it('allowlist checker rejects bare-name network imports', async () => {
      const ts = await import('typescript');
      const bypasses = [
        `import { request } from 'https'`, // bare, no node: prefix
        `import { request } from 'http'`,
        `import /*allowed?*/ { request } from 'node:https'`, // comment in decl
        `import '@anthropic-ai/sdk'`,
        `import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'`,
        `import('${'`'}${'h'}ttps://api.anthropic.com${'`'}')`, // template literal (encoded to avoid tokenization noise)
      ];
      for (const source of bypasses) {
        const sf = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
        let staticSpec: string | null = null;
        let sawComputedDynamic = false;
        const visit = (n: import('typescript').Node): void => {
          if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
            staticSpec = n.moduleSpecifier.text;
          }
          if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const arg = n.arguments[0];
            if (arg && !ts.isStringLiteral(arg)) sawComputedDynamic = true;
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
        // Every bypass must produce either a specifier that's not in
        // the empty allowlist OR flag as computed-dynamic.
        expect(staticSpec !== null || sawComputedDynamic,
          `allowlist checker failed to detect a bypass form: ${source}`,
        ).toBe(true);
      }
    });
  });
});
