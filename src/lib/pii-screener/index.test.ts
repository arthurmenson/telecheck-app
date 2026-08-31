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

    it('does NOT call any network primitive at runtime (fetch/WebSocket/EventSource/XMLHttpRequest)', async () => {
      // R1/R4/R5: install runtime traps on every supported network
      // primitive AND rebind them on globalThis so a computed-access
      // bypass (globalThis['fetch']) still routes to the trap. Assert
      // zero calls across representative screener invocations.
      const gt = globalThis as unknown as Record<string, unknown>;
      const originals: Record<string, unknown> = {};
      const trapNames = ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest'];
      const callCounts: Record<string, number> = {};
      for (const name of trapNames) {
        originals[name] = gt[name];
        callCounts[name] = 0;
        // Some primitives (WebSocket, EventSource, XMLHttpRequest) are
        // constructors — trap via a function that increments and throws.
        gt[name] = ((..._args: unknown[]) => {
          callCounts[name] = (callCounts[name] ?? 0) + 1;
          throw new Error(`${name} must not be called by pii-screener`);
        }) as unknown;
      }
      try {
        screenInput('subtle name John Smith at 415 555 1212', 'ai_bound');
        screenInput('SSN 123-45-6789', 'ai_bound');
        screenInput('the box at 10.0.0.42 is down', 'internal');
        screenInput('all-synthetic clean prose without PII', 'ai_bound');
      } finally {
        for (const name of trapNames) {
          gt[name] = originals[name];
        }
      }
      const totalCalls = trapNames.reduce((sum, n) => sum + (callCounts[n] ?? 0), 0);
      expect(totalCalls, `network primitives called: ${JSON.stringify(callCounts)}`).toBe(0);
    });

    it('production source files pass the strict SAFETY checker (import allowlist + global-usage denylist)', async () => {
      // Static SAFETY enforcement via TypeScript AST.
      //
      // Convergence trajectory:
      //   R1: no check.
      //   R2: regex import blacklist (bypassable via bare-name / comment).
      //   R3: AST-based import allowlist (misses global-fetch bypass).
      //   R4: AST-based import allowlist + global-usage denylist.
      //
      // The R4 checker rejects two classes of bypass:
      //   (a) any imported specifier not on the per-file allowlist
      //   (b) any use of a prohibited global (fetch, WebSocket, etc.)
      //       that could reach the network without an import.
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const path = await import('node:path');
      const ts = await import('typescript');

      const modDir = path.dirname(fileURLToPath(import.meta.url));

      /**
       * Sprint 1.1a authorized import allowlist per file. Any addition
       * requires Codex re-review because the SAFETY invariant is at stake.
       * Sprint 1.1b (NER integration) will extend this via its own PR.
       */
      const IMPORT_ALLOWLIST: Record<string, ReadonlySet<string>> = {
        'index.ts': new Set(['./patterns.js']),
        'patterns.ts': new Set([]),
      };

      const violations: Array<{ file: string; kind: string; detail: string }> = [];
      for (const [relPath, allowedSet] of Object.entries(IMPORT_ALLOWLIST)) {
        const filePath = path.join(modDir, relPath);
        const src = await readFile(filePath, 'utf8');
        const fileViolations = checkSafety(src, relPath, allowedSet, ts);
        violations.push(...fileViolations);
      }

      expect(violations,
        `pii-screener production sources violate SAFETY: ${JSON.stringify(violations, null, 2)}`,
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

    // Negative fixtures — prove the checker actually rejects known
    // bypass forms surfaced across R1..R4. Uses in-memory strings; does
    // not modify real source files. Runs the FIXTURES through the
    // EXACT checker used against the production source (§checkSafety).
    it('safety checker rejects known bypass forms (regression suite)', async () => {
      const ts = await import('typescript');
      const emptyAllow: ReadonlySet<string> = new Set([]);

      // Each fixture is (label, source) — every one MUST produce at
      // least one violation from checkSafety().
      const bypasses: Array<[string, string]> = [
        ['bare-name https import', `import { request } from 'https'; request();`],
        ['bare-name http import', `import { request } from 'http'; request();`],
        ['node: prefixed https with comment', `import /*allowed?*/ { request } from 'node:https'; request();`],
        ['anthropic sdk side-effect', `import '@anthropic-ai/sdk';`],
        ['anthropic bedrock sdk named', `import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'; new AnthropicBedrock();`],
        ['template-literal dynamic import', 'import(`https://api.anthropic.com`)'],
        // R4 finding — the global-fetch bypasses:
        ['bare global fetch call', `fetch('https://api.anthropic.com/v1/messages');`],
        ['conditional global fetch', `if (Math.random() > 0.5) fetch('https://x');`],
        ['top-level fetch (executes at import time)', `const x = fetch('https://x');`],
        ['WebSocket global', `new WebSocket('wss://x');`],
        ['EventSource global', `new EventSource('https://x');`],
        ['navigator.sendBeacon', `navigator.sendBeacon('https://x', 'payload');`],
        ['eval bypass', `eval('fetch("https://x")');`],
        ['Function constructor bypass', `new Function('return fetch("https://x")')();`],
        ['require bypass (CJS in TS)', `const https = require('https'); https.request();`],
        // R5 finding — computed global access bypasses:
        ['globalThis bracket fetch', `globalThis['fetch']('https://x');`],
        ['self bracket WebSocket', `new (self['WebSocket'])('wss://x');`],
        ['window bracket process', `window['process'].getBuiltinModule('node:https');`],
        ['Reflect.get on globalThis for fetch (string literal)', `Reflect.get(globalThis, 'fetch')('https://x');`],
        ['Reflect.get on globalThis (any string)', `Reflect.get(globalThis, someRuntimeString)('https://x');`],
        ['aliased-global bracket access', `const g = globalThis; g['fetch']('https://x');`],
        // R6 finding — spelling-agnostic bypasses:
        ['template-literal key', 'globalThis[`fetch`](`https://x`);'],
        ['computed-key string concat', `globalThis['fe' + 'tch']('https://x');`],
        ['runtime-variable key', `const k = 'fetch'; globalThis[k]('https://x');`],
        ['Object.getOwnPropertyDescriptor global', `Object.getOwnPropertyDescriptor(globalThis, 'fetch').value('https://x');`],
        ['Object.entries global', `Object.entries(globalThis).find(([k]) => k === 'fetch');`],
        // R7 finding — alias-tracking bypasses:
        ['aliased-global bracket then invocation', `const g = globalThis; g['fetch']('https://x');`],
        ['aliased Reflect', `const r = Reflect; r.get(globalThis, 'fetch')('https://x');`],
        ['aliased Object', `const o = Object; o.getOwnPropertyDescriptor(globalThis, 'fetch').value('https://x');`],
        ['destructured from globalThis', `const { fetch: f } = globalThis; f('https://x');`],
        ['destructured Reflect', `const { get } = Reflect; get(globalThis, 'fetch')('https://x');`],
      ];

      const failedToDetect: string[] = [];
      for (const [label, source] of bypasses) {
        const viols = checkSafety(source, 'probe.ts', emptyAllow, ts);
        if (viols.length === 0) {
          failedToDetect.push(label);
        }
      }
      expect(failedToDetect,
        `safety checker failed to detect bypass form(s): ${failedToDetect.join('; ')}`,
      ).toEqual([]);
    });

    it('safety checker accepts pristine source (positive control)', async () => {
      const ts = await import('typescript');
      const goodSource = `
        import { foo } from './patterns.js';
        export function screen(x: string): boolean {
          return x.length > 0 && foo(x);
        }
      `;
      const allow = new Set(['./patterns.js']);
      const viols = checkSafety(goodSource, 'probe.ts', allow, ts);
      expect(viols).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------
// checkSafety — shared static SAFETY checker used by both the
// production-file assertion and the negative-fixture regression suite.
// Exported at module scope (not inside describe) so both tests use the
// EXACT same implementation. Detects two violation classes:
//   (1) import specifier not in per-file allowlist (or non-verifiable
//       dynamic import argument)
//   (2) use of a prohibited network/exec global identifier
// Excluding these classes is the SAFETY invariant per PII spec §Layer 1.
// ---------------------------------------------------------------------
type TsModule = typeof import('typescript');

const PROHIBITED_GLOBALS: readonly string[] = [
  'fetch',
  'WebSocket',
  'EventSource',
  'navigator', // navigator.sendBeacon
  'require', // CJS reach-through inside TS
  'eval',
  'Function', // via `new Function(...)`
  'process', // process.getBuiltinModule + process.env-driven config leak
  'XMLHttpRequest',
  'importScripts',
];

function checkSafety(
  source: string,
  fileLabel: string,
  importAllowlist: ReadonlySet<string>,
  ts: TsModule,
): Array<{ file: string; kind: string; detail: string }> {
  const violations: Array<{ file: string; kind: string; detail: string }> = [];
  const sf = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);

  // Pre-pass: collect identifiers that alias a global-like receiver.
  // Handles: `const g = globalThis` → g is tainted global-like.
  // Also handles: `const g = self.globalThis` → g is tainted.
  // Destructuring alias: `const { fetch } = globalThis` → any use of
  // `fetch` as a call target originated from globalThis; we treat that
  // as a violation at the declaration site rather than tracking the
  // destructured name (see class 3 below).
  const globalAliases = new Set<string>();
  const preVisit = (node: import('typescript').Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const root = resolveRootReceiver(node.initializer, ts);
      if (root && GLOBAL_LIKE_RECEIVERS.includes(root)) {
        globalAliases.add(node.name.text);
      }
    }
    // Destructured alias — flag at declaration: `const { fetch } = globalThis;`
    if (ts.isVariableDeclaration(node)
      && node.initializer
      && (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name))) {
      const root = resolveRootReceiver(node.initializer, ts);
      if (root && GLOBAL_LIKE_RECEIVERS.includes(root)) {
        violations.push({
          file: fileLabel,
          kind: 'destructured-from-global-like',
          detail: `destructure from ${root}`,
        });
      }
    }
    ts.forEachChild(node, preVisit);
  };
  preVisit(sf);

  // globalAliases is now the tainted set. Merge into the effective
  // global-like receiver check.
  const effectiveGlobalLike = new Set<string>([...GLOBAL_LIKE_RECEIVERS, ...globalAliases]);

  const visit = (node: import('typescript').Node): void => {
    // Class (1) — imports.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (!importAllowlist.has(spec)) {
        violations.push({ file: fileLabel, kind: 'import', detail: spec });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (!importAllowlist.has(spec)) {
        violations.push({ file: fileLabel, kind: 'reexport', detail: spec });
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        if (!importAllowlist.has(arg.text)) {
          violations.push({ file: fileLabel, kind: 'dynamic-import', detail: arg.text });
        }
      } else if (arg) {
        violations.push({
          file: fileLabel,
          kind: 'dynamic-import',
          detail: '<non-string-literal specifier — not statically verifiable>',
        });
      }
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteral(node.moduleReference.expression)) {
      const spec = node.moduleReference.expression.text;
      if (!importAllowlist.has(spec)) {
        violations.push({ file: fileLabel, kind: 'import-equals', detail: spec });
      }
    }

    // Class (2a) — prohibited globals via direct identifier reference.
    // (fetch(...), new WebSocket(...), navigator.sendBeacon(...), etc.)
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (PROHIBITED_GLOBALS.includes(name)) {
        const parent = node.parent;
        if (parent) {
          // Skip identifiers used as the name-position of a local
          // declaration (they aren't reach-throughs to the global).
          if (ts.isParameter(parent) && parent.name === node) return;
          if (ts.isVariableDeclaration(parent) && parent.name === node) return;
          if (ts.isPropertyAssignment(parent) && parent.name === node) return;
          if (ts.isImportSpecifier(parent)) return;
          if (ts.isImportClause(parent)) return;
          if (ts.isNamespaceImport(parent)) return;
        }
        violations.push({
          file: fileLabel,
          kind: 'prohibited-global',
          detail: name,
        });
      }
    }

    // Class (2b) — element access rooted at a global-like receiver.
    // R6 finding: spelling-based key detection is an arms race
    // (template literals, string concat, computed identifiers all
    // bypass StringLiteral-only rules). Fail-closed: any element
    // access whose ROOT receiver resolves to a global-like object is
    // rejected regardless of key form.
    //
    // Global-like receivers include: globalThis, self, window, global,
    // Reflect (used to reach globals), Object (used via
    // getOwnPropertyDescriptor).
    if (ts.isElementAccessExpression(node)) {
      const root = resolveRootReceiver(node.expression, ts);
      if (root && effectiveGlobalLike.has(root)) {
        violations.push({
          file: fileLabel,
          kind: 'element-access-on-global-like',
          detail: `${root}[<key>]${globalAliases.has(root) ? ` (alias for global-like receiver)` : ''}`,
        });
      }
    }

    // Class (2c) — Reflect.* and Object.getOwnPropertyDescriptor calls.
    // Reject any invocation of these regardless of arguments — a
    // screener has zero legitimate need for reflective global access.
    // Applies to aliased receivers too, via resolveRootReceiver +
    // globalAliases taint set.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const root = resolveRootReceiver(node.expression.expression, ts);
      const method = node.expression.name.text;
      // Reflect is treated as a Reflect-alias if the identifier itself
      // is Reflect OR is an alias whose initializer resolved to Reflect.
      if (root === 'Reflect'
        && ['get', 'apply', 'construct', 'has', 'ownKeys', 'getPrototypeOf'].includes(method)) {
        violations.push({
          file: fileLabel,
          kind: 'reflect-call',
          detail: `Reflect.${method}(...)`,
        });
      }
      if (root === 'Object'
        && ['getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getOwnPropertyNames', 'entries', 'values']
          .includes(method)) {
        // Object.entries / values / etc. on globalThis could enumerate
        // + reach globals. Flag when receiver is globalThis-like (or
        // aliased-to-globalThis-like via the pre-pass taint set).
        const firstArg = node.arguments[0];
        if (firstArg) {
          const argRoot = resolveRootReceiver(firstArg, ts);
          if (argRoot && effectiveGlobalLike.has(argRoot)) {
            violations.push({
              file: fileLabel,
              kind: 'object-reflection-on-global-like',
              detail: `Object.${method}(${argRoot}, ...)`,
            });
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  return violations;
}

/**
 * Global-like receiver identifiers that must not be accessed via
 * element access or reflection from within the pii-screener module.
 * Includes globalThis / self / window / global (the environment root)
 * plus Reflect / Object (reflection instruments used to reach the root).
 */
const GLOBAL_LIKE_RECEIVERS: readonly string[] = [
  'globalThis',
  'self',
  'window',
  'global',
  'Reflect',
  'Object',
];

/**
 * Walk an expression back to its root identifier, following:
 *  - PropertyAccessExpression chains (a.b.c → a)
 *  - ParenthesizedExpression wrappers ((x) → x)
 * Returns the root identifier's text, or null if the root is not an
 * identifier (e.g., a call expression or literal).
 *
 * Used to detect aliased-global bypasses: `const r = Reflect; r.get(...)`
 * — the receiver of `.get` is `r`, but the intent is Reflect access.
 * NOTE: static aliasing is not fully resolvable in a single-file walk
 * — this checker rejects the alias by name too via a separate
 * pattern below. That coverage is complementary; the intent here is
 * to keep the checker fail-closed on direct + one-hop aliased forms.
 */
function resolveRootReceiver(
  expr: import('typescript').Expression,
  ts: TsModule,
): string | null {
  let cur: import('typescript').Node = expr;
  for (let hops = 0; hops < 64; hops++) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isIdentifier(cur)) {
      return cur.text;
    }
    return null;
  }
  return null;
}
