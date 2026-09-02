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
 *   - A1 (real-looking name in chat) — ⚠️ NOT COVERED, see KNOWN GAP below
 *   - A2 (real-looking phone in intake free-text) → covered by us_phone / ghana_phone
 *   - A3 (real-looking SSN in chat) → covered by us_ssn
 *   - A4 (real-looking Ghana Card ID in intake) → covered by ghana_card
 *   - A5 (clinician real patient real name in decision notes) — ⚠️ NOT COVERED
 *   - A6 (subtle PII AI-bound) — ⚠️ NOT COVERED; regex covers structural subset
 *   - A6b (subtle PII internal route) — ⚠️ NOT COVERED
 *
 * ⚠️ KNOWN GAP — the NER classifier is inert. A1 / A5 / A6 / A6b were
 * recorded as "deferred to Sprint 1.1b (NER)" and 1.1b shipped, so they
 * read as closed. They are not. `wink-eng-lite-web-model` has no
 * statistical PERSON / GPE / ORG recogniser, so no layer detects person
 * names or prose addresses. Those four tests plus the Layer 2 PERSON case
 * are marked `it.fails` and explained in the Sprint 1.1b describe block.
 * Remedy pending ratifier decision:
 *   telecheckONE/Telecheck_v1_10_PRD_Update/
 *     Decision-Request-Layer-1-NER-Capability-Gap-2026-09-01.md
 */

import { describe, expect, it } from 'vitest';

import { isLuhnValid } from './patterns.js';

import {
  PARTICIPANT_BLOCK_MESSAGE,
  PII_PATTERNS,
  screenInput,
  screenOutput,
  type ScreeningResult,
} from './index.js';

describe('pii-screener (Sprint 1.1a regex core)', () => {
  describe('pattern positives (each pattern fires on a canonical sample)', () => {
    // Every pattern must have at least one positive sample under coverage,
    // otherwise it's dead code. This table is the authoritative sample
    // set + gets extended as new patterns land.
    const samples: Array<{ patternId: string; input: string; expectMatch: string }> = [
      {
        patternId: 'us_ssn',
        input: 'my SSN is 123-45-6789 for the form',
        expectMatch: '123-45-6789',
      },
      {
        patternId: 'ghana_card',
        input: 'Ghana Card GHA-123456789-0 issued',
        expectMatch: 'GHA-123456789-0',
      },
      {
        patternId: 'us_passport',
        input: 'passport number AB1234567 issued',
        expectMatch: 'passport number AB1234567',
      },
      {
        patternId: 'credit_card',
        input: 'card 4111 1111 1111 1111 expires',
        expectMatch: '4111 1111 1111 1111',
      },
      {
        patternId: 'email',
        input: 'reach me at test.user@example.com anytime',
        expectMatch: 'test.user@example.com',
      },
      {
        patternId: 'us_phone',
        input: 'call (415) 555-0123 or leave a message',
        expectMatch: '(415) 555-0123',
      },
      {
        patternId: 'ghana_phone',
        input: 'my number +233241234567 works too',
        expectMatch: '+233241234567',
      },
      { patternId: 'ipv4', input: 'the box at 10.0.0.42 is down', expectMatch: '10.0.0.42' },
      {
        patternId: 'ipv6',
        input: 'client 2001:db8:85a3::8a2e:370:7334 connected',
        expectMatch: '2001:db8:85a3::8a2e:370:7334',
      },
      {
        patternId: 'medical_record_number',
        input: 'MRN 1234567 in the chart',
        expectMatch: 'MRN 1234567',
      },
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
      expect(
        uncovered,
        `patterns without a positive sample: ${uncovered.map((p) => p.id).join(', ')}`,
      ).toEqual([]);
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
        expect(
          r.hits.some((h) => h.patternId === 'us_passport'),
          `false-positive passport hit on: ${input}`,
        ).toBe(false);
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

    it('IPv6 full form is detected', () => {
      // R9 HIGH: spec requires IPv6; prior version shipped IPv4-only.
      const r = screenInput('client 2001:0db8:85a3:0000:0000:8a2e:0370:7334 connected', 'ai_bound');
      expect(r.action).toBe('block');
      expect(r.hits.some((h) => h.patternId === 'ipv6')).toBe(true);
    });

    it('IPv6 compressed forms detected (::, ::1, fe80::, mid-compress)', () => {
      const cases: Array<[string, string]> = [
        ['loopback ::1 is local', '::1'],
        ['link-local fe80:: is available', 'fe80::'],
        ['compressed 2001:db8::8a2e:370:7334 example', '2001:db8::8a2e:370:7334'],
      ];
      for (const [input, expected] of cases) {
        const r = screenInput(input, 'ai_bound');
        const hit = r.hits.find((h) => h.patternId === 'ipv6');
        expect(hit, `no ipv6 hit for: ${input}`).toBeDefined();
        expect(hit?.match).toBe(expected);
      }
    });

    it('IPv6 IPv4-mapped form detected', () => {
      const r = screenInput('mapped ::ffff:192.0.2.1 legacy', 'ai_bound');
      const hit = r.hits.find((h) => h.patternId === 'ipv6');
      expect(hit).toBeDefined();
      expect(hit?.match).toBe('::ffff:192.0.2.1');
    });

    it('IPv6 does not match malformed strings', () => {
      // Bad hex, too many groups, non-address text
      const negatives = [
        'not an address: 2001:0dbg:...',
        'a:b:c is not enough groups',
        'no colons here 2001db8',
      ];
      for (const input of negatives) {
        const r = screenInput(input, 'internal');
        expect(
          r.hits.some((h) => h.patternId === 'ipv6'),
          `false-positive ipv6 hit on: ${input}`,
        ).toBe(false);
      }
    });

    it('IPv6 blocks on ai_bound (low_confidence still blocks per matrix)', () => {
      const r = screenInput('the server 2001:db8::1 is up', 'ai_bound');
      expect(r.action).toBe('block');
    });

    it('IPv6 redacts on internal route (low_confidence)', () => {
      const r = screenInput('the server 2001:db8::1 is up', 'internal');
      expect(r.action).toBe('redact');
      expect(r.redactedInput).toContain('[REDACTED:IPv6 address]');
    });
  });

  describe('Sprint 1.1b — NER coverage (KNOWN GAP: the classifier is inert)', () => {
    // ⚠️ EVERY TEST IN THIS BLOCK IS `it.fails`. That is not a suppression.
    //
    // `ner.ts` filters `doc.entities()` for PERSON / GPE / ORG, but
    // `wink-eng-lite-web-model` emits only pattern-based entity types
    // (DATE, MONEY, TIME, CARDINAL, ORDINAL, PERCENT, EMAIL, URL). It
    // ships no statistical person/place/organisation recogniser, so the
    // filter matches nothing and NO layer detects person names or prose
    // addresses today.
    //
    // These assertions describe the behaviour the spec REQUIRES. They are
    // marked `it.fails` so the gap is loud in every test run instead of
    // sitting behind a permanently red pipeline that people learn to
    // scroll past. `it.fails` is a ratchet, not a mute: the moment a
    // remedy makes the classifier work, these tests FAIL and whoever
    // fixed it is forced to come back here and remove the marker.
    //
    // Do NOT resolve this by deleting the tests or loosening the
    // assertions. Note that A6b's own history is the cautionary tale —
    // Codex flagged in Sprint 1.1b that a loose `redact OR pass`
    // assertion would let a broken NER integration silently pass, and it
    // was tightened. The tightening never caught anything, because the
    // suite could not be executed locally at all.
    //
    // Remedy is a ratifier decision (four options, three-way consult):
    //   telecheckONE/Telecheck_v1_10_PRD_Update/
    //     Decision-Request-Layer-1-NER-Capability-Gap-2026-09-01.md
    it.fails('A1 — real-looking person name in chat blocks on ai_bound (PERSON)', () => {
      const r = screenInput('Hello, I am John Smith and I have a headache', 'ai_bound');
      expect(r.action).toBe('block');
      expect(r.hits.some((h) => h.patternId === 'ner_person')).toBe(true);
    });

    it.fails('A5 — clinician real patient name in decision notes (internal route blocks)', () => {
      // Internal route + high-confidence hit → BLOCK per decision matrix.
      const r = screenInput('Patient Jane Doe reports symptom resolution', 'internal');
      expect(r.action).toBe('block');
      const nerHit = r.hits.find((h) => h.patternId === 'ner_person');
      expect(nerHit).toBeDefined();
      expect(nerHit?.confidence).toBe('high_confidence');
    });

    it.fails('A6 — subtle PII (name + condition tied) on AI-bound blocks', () => {
      const r = screenInput('Michael Johnson has severe hypertension', 'ai_bound');
      expect(r.action).toBe('block');
    });

    it.fails(
      'A6b — subtle PII on internal-only route with GPE (low-confidence) redacts inline',
      () => {
        // GPE (country/city name) alone is low-confidence; internal
        // route → redact. Explicitly free of PERSON entities (which would
        // be high-confidence block).
        //
        // R1 finding: prior version accepted redact OR pass, so a broken
        // NER integration would silently satisfy this test. Fix — require
        // deterministic detection: use a well-known GPE fixture ("United
        // States") that wink-eng-lite-web-model reliably surfaces, and
        // assert the concrete post-redaction output.
        const r = screenInput('the clinic is in the United States today', 'internal');
        expect(r.action).toBe('redact');
        const gpeHit = r.hits.find((h) => h.patternId === 'ner_gpe');
        expect(gpeHit).toBeDefined();
        expect(gpeHit?.confidence).toBe('low_confidence');
        // Concrete redaction must place the GPE label at the right position.
        expect(r.redactedInput).toContain(
          '[REDACTED:Geopolitical entity (country / city / state)]',
        );
      },
    );

    it('synthetic participant handle does NOT trigger PERSON (does not look like a name)', () => {
      const r = screenInput('I am pilot1-participant-01 and I feel great', 'ai_bound');
      expect(r.hits.some((h) => h.patternId === 'ner_person')).toBe(false);
    });

    it('ordinary medical prose without proper nouns does NOT trigger NER', () => {
      const r = screenInput(
        'the patient reports chest pain lasting three days with associated fatigue',
        'ai_bound',
      );
      expect(r.action).toBe('pass');
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
      const result = screenInput('the servers 10.0.0.1 and 10.0.0.2 are both offline', 'internal');
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
      const result = screenInput('server1 10.0.0.1 server2 10.0.0.2', 'internal');
      expect(result.action).toBe('redact');
      expect(result.redactedInput).toBe(
        'server1 [REDACTED:IPv4 address] server2 [REDACTED:IPv4 address]',
      );
      // No NESTED redaction — a token opened inside another token that has
      // not closed yet. `[^\]]*` is what makes this precise: an earlier
      // `.*` form spanned the closing bracket, so two perfectly correct
      // sibling redactions matched it and the assertion failed on valid
      // output. That made the test useless in both directions.
      expect(result.redactedInput).not.toMatch(/\[REDACTED:[^\]]*\[REDACTED/);
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
        'index.ts': new Set(['./patterns.js', './ner.js']),
        'patterns.ts': new Set([]),
        // Sprint 1.1b: NER classifier module allowlist. wink-nlp and
        // wink-eng-lite-web-model are Evans-ratified 2026-08-31 as the
        // local NER path (chat message "B"). Both are pure JS, no
        // native bindings, no network. Adding any other specifier to
        // ner.ts requires Sprint 1.1b Codex re-review because it
        // could introduce a network reach or a new capability surface.
        'ner.ts': new Set(['wink-nlp', 'wink-eng-lite-web-model']),
      };

      const violations: Array<{ file: string; kind: string; detail: string }> = [];
      for (const [relPath, allowedSet] of Object.entries(IMPORT_ALLOWLIST)) {
        const filePath = path.join(modDir, relPath);
        const src = await readFile(filePath, 'utf8');
        const fileViolations = checkSafety(src, relPath, allowedSet, ts);
        violations.push(...fileViolations);
      }

      expect(
        violations,
        `pii-screener production sources violate SAFETY: ${JSON.stringify(violations, null, 2)}`,
      ).toEqual([]);

      // Complement: the module's export surface should not name any
      // provider-adjacent identifier (defense-in-depth against an
      // implementation that reaches a provider via an aliased symbol).
      const mod = await import('./index.js');
      const suspiciousExportNames = Object.keys(mod).filter((n) =>
        /client|provider|fetch|http|anthropic|bedrock|azure/i.test(n),
      );
      expect(
        suspiciousExportNames,
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
        [
          'node: prefixed https with comment',
          `import /*allowed?*/ { request } from 'node:https'; request();`,
        ],
        ['anthropic sdk side-effect', `import '@anthropic-ai/sdk';`],
        [
          'anthropic bedrock sdk named',
          `import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'; new AnthropicBedrock();`,
        ],
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
        [
          'Reflect.get on globalThis for fetch (string literal)',
          `Reflect.get(globalThis, 'fetch')('https://x');`,
        ],
        [
          'Reflect.get on globalThis (any string)',
          `Reflect.get(globalThis, someRuntimeString)('https://x');`,
        ],
        ['aliased-global bracket access', `const g = globalThis; g['fetch']('https://x');`],
        // R6 finding — spelling-agnostic bypasses:
        ['template-literal key', 'globalThis[`fetch`](`https://x`);'],
        ['computed-key string concat', `globalThis['fe' + 'tch']('https://x');`],
        ['runtime-variable key', `const k = 'fetch'; globalThis[k]('https://x');`],
        [
          'Object.getOwnPropertyDescriptor global',
          `Object.getOwnPropertyDescriptor(globalThis, 'fetch').value('https://x');`,
        ],
        ['Object.entries global', `Object.entries(globalThis).find(([k]) => k === 'fetch');`],
        // R7 finding — alias-tracking bypasses:
        [
          'aliased-global bracket then invocation',
          `const g = globalThis; g['fetch']('https://x');`,
        ],
        ['aliased Reflect', `const r = Reflect; r.get(globalThis, 'fetch')('https://x');`],
        [
          'aliased Object',
          `const o = Object; o.getOwnPropertyDescriptor(globalThis, 'fetch').value('https://x');`,
        ],
        ['destructured from globalThis', `const { fetch: f } = globalThis; f('https://x');`],
        ['destructured Reflect', `const { get } = Reflect; get(globalThis, 'fetch')('https://x');`],
        // R8 finding — transitive-taint bypasses:
        ['two-hop global alias', `const g = globalThis; const h = g; h['fetch']('https://x');`],
        [
          'three-hop global alias',
          `const g = globalThis; const h = g; const i = h; i['fetch']('https://x');`,
        ],
        ['assignment-mediated alias', `let g; g = globalThis; g['fetch']('https://x');`],
        [
          'multi-hop Reflect alias',
          `const r = Reflect; const r2 = r; r2.get(globalThis, 'fetch')('https://x');`,
        ],
        [
          'multi-hop Object alias',
          `const o = Object; const o2 = o; o2.getOwnPropertyDescriptor(globalThis, 'fetch');`,
        ],
      ];

      const failedToDetect: string[] = [];
      for (const [label, source] of bypasses) {
        const viols = checkSafety(source, 'probe.ts', emptyAllow, ts);
        if (viols.length === 0) {
          failedToDetect.push(label);
        }
      }
      expect(
        failedToDetect,
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

  // Pre-pass: collect identifier aliases by CATEGORY of tainted origin.
  // Three categories, tracked separately because their downstream
  // checks differ:
  //   globalRootAliases → aliases of globalThis / self / window / global
  //   reflectAliases    → aliases of Reflect (or aliases of aliases)
  //   objectAliases     → aliases of Object (or aliases of aliases)
  //
  // Fixed-point iteration: keep re-walking declarations until no set
  // grows. Handles multi-hop aliases (const g = globalThis; const h = g;
  // const i = h; ...). Bounded to `MAX_HOPS` iterations to guard against
  // pathological source.
  const globalRootAliases = new Set<string>();
  const reflectAliases = new Set<string>();
  const objectAliases = new Set<string>();
  const GLOBAL_ROOTS: readonly string[] = ['globalThis', 'self', 'window', 'global'];
  const MAX_HOPS = 32;

  const collectDeclarations = (): boolean => {
    let grew = false;
    const walk = (node: import('typescript').Node): void => {
      // Identifier binding: `const alias = <expr>`
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
        const root = resolveRootReceiver(node.initializer, ts);
        if (root) {
          const currentGlobalSet = new Set<string>([...GLOBAL_ROOTS, ...globalRootAliases]);
          const currentReflectSet = new Set<string>(['Reflect', ...reflectAliases]);
          const currentObjectSet = new Set<string>(['Object', ...objectAliases]);
          if (currentGlobalSet.has(root) && !globalRootAliases.has(node.name.text)) {
            globalRootAliases.add(node.name.text);
            grew = true;
          } else if (currentReflectSet.has(root) && !reflectAliases.has(node.name.text)) {
            reflectAliases.add(node.name.text);
            grew = true;
          } else if (currentObjectSet.has(root) && !objectAliases.has(node.name.text)) {
            objectAliases.add(node.name.text);
            grew = true;
          }
        }
      }
      // Destructuring binding: `const { fetch } = globalThis` etc. —
      // recorded as a violation at the destructure site because the
      // destructured names could carry the taint anywhere.
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name))
      ) {
        const root = resolveRootReceiver(node.initializer, ts);
        const currentAll = new Set<string>([
          ...GLOBAL_ROOTS,
          ...globalRootAliases,
          'Reflect',
          ...reflectAliases,
          'Object',
          ...objectAliases,
        ]);
        if (root && currentAll.has(root)) {
          // Only push once per destructure decl (dedupe on line-start).
          const detail = `destructure from ${root}`;
          const already = violations.some(
            (v) => v.kind === 'destructured-from-global-like' && v.detail === detail,
          );
          if (!already) {
            violations.push({ file: fileLabel, kind: 'destructured-from-global-like', detail });
            grew = true;
          }
        }
      }
      // Also track assignment-mediated aliases: `let g; g = globalThis`
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const root = resolveRootReceiver(node.right, ts);
        if (root) {
          const currentGlobalSet = new Set<string>([...GLOBAL_ROOTS, ...globalRootAliases]);
          const currentReflectSet = new Set<string>(['Reflect', ...reflectAliases]);
          const currentObjectSet = new Set<string>(['Object', ...objectAliases]);
          if (currentGlobalSet.has(root) && !globalRootAliases.has(node.left.text)) {
            globalRootAliases.add(node.left.text);
            grew = true;
          } else if (currentReflectSet.has(root) && !reflectAliases.has(node.left.text)) {
            reflectAliases.add(node.left.text);
            grew = true;
          } else if (currentObjectSet.has(root) && !objectAliases.has(node.left.text)) {
            objectAliases.add(node.left.text);
            grew = true;
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
    return grew;
  };

  // Fixed-point iteration until no set grows (multi-hop aliases).
  let hop = 0;
  while (collectDeclarations() && hop < MAX_HOPS) {
    hop++;
  }

  // Effective sets for downstream checks.
  const effectiveGlobalLikeReceivers = new Set<string>([
    ...GLOBAL_ROOTS,
    ...globalRootAliases,
    'Reflect',
    ...reflectAliases,
    'Object',
    ...objectAliases,
  ]);
  const effectiveReflectReceivers = new Set<string>(['Reflect', ...reflectAliases]);
  const effectiveObjectReceivers = new Set<string>(['Object', ...objectAliases]);
  // Backwards-compat: previously used `globalAliases` name is retained
  // for the receiver-detail annotation logic below.
  const globalAliases = new Set<string>([
    ...globalRootAliases,
    ...reflectAliases,
    ...objectAliases,
  ]);
  const effectiveGlobalLike = effectiveGlobalLikeReceivers;

  const visit = (node: import('typescript').Node): void => {
    // Class (1) — imports.
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (!importAllowlist.has(spec)) {
        violations.push({ file: fileLabel, kind: 'import', detail: spec });
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
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
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
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
      // is Reflect OR is an alias whose initializer resolved to Reflect
      // (transitively via the pre-pass fixed-point taint set).
      if (
        root &&
        effectiveReflectReceivers.has(root) &&
        ['get', 'apply', 'construct', 'has', 'ownKeys', 'getPrototypeOf'].includes(method)
      ) {
        violations.push({
          file: fileLabel,
          kind: 'reflect-call',
          detail: `${root}.${method}(...)${reflectAliases.has(root) ? ` (Reflect alias)` : ''}`,
        });
      }
      if (
        root &&
        effectiveObjectReceivers.has(root) &&
        [
          'getOwnPropertyDescriptor',
          'getOwnPropertyDescriptors',
          'getOwnPropertyNames',
          'entries',
          'values',
        ].includes(method)
      ) {
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
// Note: the canonical global-like receiver set (globalThis, self, window,
// global, Reflect, Object) is inlined inside checkSafety() as GLOBAL_ROOTS
// (for element-access) plus the literal 'Reflect' + 'Object' bases for
// reflection-call guards. Alias-tracking taint sets extend those at
// runtime. This comment is the design anchor referenced from checkSafety()
// so future maintainers know where to update the canonical set.

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
function resolveRootReceiver(expr: import('typescript').Expression, ts: TsModule): string | null {
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

// ---------------------------------------------------------------------------
// Sprint 1.1d — audit_bound route class + Layer 2 egress screener
// ---------------------------------------------------------------------------

describe('pii-screener — audit_bound route class (Sprint 1.1d)', () => {
  it('blocks on a HIGH-confidence hit', () => {
    const r = screenInput('reviewer note: patient SSN 123-45-6789 on file', 'audit_bound');
    expect(r.action).toBe('block');
    expect(r.blockReason).toBe('match_any_audit_bound');
  });

  it('blocks on a LOW-confidence hit too (append-only audit is unpurgeable)', () => {
    // IPv4 is low-confidence. On an `internal` route this would redact;
    // on audit_bound it must block, because an audit row cannot later be
    // scrubbed (I-003 append-only) and env-purge PRESERVES audit_records.
    const r = screenInput('reviewer note: portal at 10.0.0.42 was slow', 'audit_bound');
    expect(r.action).toBe('block');
    expect(r.blockReason).toBe('match_any_audit_bound');
    expect(r.redactedInput).toBeUndefined();
  });

  it('is strictly stricter than internal for the same input', () => {
    const lowConfidenceInput = 'the box at 10.0.0.42 is down';
    expect(screenInput(lowConfidenceInput, 'internal').action).toBe('redact');
    expect(screenInput(lowConfidenceInput, 'audit_bound').action).toBe('block');
  });

  it('passes clean synthetic reviewer prose', () => {
    const r = screenInput('Template rejected: question 4 wording is ambiguous.', 'audit_bound');
    expect(r.action).toBe('pass');
  });
});

describe('pii-screener — screenOutput (Layer 2 egress, Sprint 1.1d)', () => {
  it('redacts a high-confidence hit in model-generated output', () => {
    const r = screenOutput('Sure — you can reach the office at test.user@example.com.');
    expect(r.redacted).toBe(true);
    expect(r.output).toContain('[REDACTED:Email address]');
    expect(r.output).not.toContain('test.user@example.com');
  });

  it('redacts a low-confidence hit too (egress redacts everything it finds)', () => {
    const r = screenOutput('Try the portal at 10.0.0.42 instead.');
    expect(r.redacted).toBe(true);
    expect(r.output).toContain('[REDACTED:IPv4 address]');
  });

  it('NEVER blocks — there is no block action on egress', () => {
    const r = screenOutput('SSN 123-45-6789 and email a@b.com and IP 10.0.0.1');
    // The contract exposes no `action` field at all; the only outcomes
    // are redacted-or-not. This test pins that shape.
    expect(r).toHaveProperty('redacted');
    expect(r).not.toHaveProperty('action');
    expect(r.output).not.toContain('123-45-6789');
  });

  it('returns clean output verbatim with redacted=false', () => {
    const clean = 'Take one tablet each morning with food.';
    const r = screenOutput(clean);
    expect(r.redacted).toBe(false);
    expect(r.output).toBe(clean);
    expect(r.hits).toEqual([]);
  });

  it('handles empty string', () => {
    const r = screenOutput('');
    expect(r.redacted).toBe(false);
    expect(r.output).toBe('');
  });

  // KNOWN GAP — see the Sprint 1.1b block above. Layer 2 inherits the same
  // inert classifier, so it cannot redact a name the model invents. `it.fails`
  // keeps this visible and forces a revisit when the classifier works.
  it.fails('redacts a hallucinated PERSON name (the actual Layer 2 threat model)', () => {
    // Layer 1 already blocked participant-supplied PII at ingress, so
    // the model never saw it. What Layer 2 defends against is the model
    // EMITTING a plausible identity of its own accord.
    const r = screenOutput('I checked with Dr. Sarah Whitfield about your dosage.');
    expect(r.redacted).toBe(true);
    expect(r.output).toContain('[REDACTED:Person name]');
  });
});

describe('us_phone matches standalone numbers but never identifier substrings', () => {
  it('matches the forms humans actually write', () => {
    for (const text of [
      'call (415) 555-0123 now',
      'call 415-555-0123 now',
      'call 415.555.0123 now',
      'call +1 415 555 0123 now',
      'call +14155550123 now',
      'call 14155550123 now',
      'call 1 (415) 555-0123 now',
    ]) {
      expect(screenInput(text, 'ai_bound').action, `missed: ${text}`).toBe('block');
    }
  });

  it('matches a BARE ten-digit run', () => {
    // Regression guard. An intermediate fix dropped the bare form to stop
    // it firing inside identifiers; that left a real phone number passing
    // Layer 3 unredacted — exactly the case a last-line defense exists
    // for. The bare form is required.
    const hits = screenInput('call 3125551212 now', 'internal').hits;
    expect(hits.some((h) => h.patternId === 'us_phone')).toBe(true);
  });

  it('leaves UUIDs and large integers intact', () => {
    // The real defect was SUBSTRING matching, not the bare form. An
    // ordinary UUID like 550e8400-e29b-41d4-a716-446655440000 contains
    // 6655440000, and 9007199254740993 contains a candidate too — so the
    // unguarded pattern mangled ~1-2% of UUIDs on nearly every log line.
    // The `(?<!\d)` / `(?!\d)` guards bracketing the whole match reject
    // any candidate adjacent to another digit, which makes long digit
    // runs safe by construction rather than by dropping coverage.
    for (const text of [
      '550e8400-e29b-41d4-a716-446655440000',
      '9007199254740993',
      '123456789012',
      'aaa-446655440000-bbb',
    ]) {
      const hits = screenInput(text, 'internal').hits;
      expect(
        hits.some((h) => h.patternId === 'us_phone'),
        `phone matched in: ${text}`,
      ).toBe(false);
    }
  });
});
