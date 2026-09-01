/**
 * log-redaction.test.ts — Sprint 1.2a Layer 3 unit tests.
 *
 * Architecture under test: redaction runs at the DESTINATION STREAM, on
 * already-serialized pino NDJSON. See the module header for why
 * `hooks.logMethod` is the wrong seam (it runs before serializers and
 * corrupts Fastify's prototype-getter-backed request object).
 *
 * Coverage:
 *   - pattern selection is by `redactInLogs`, not `confidence`: the
 *     context-bound passport form IS scrubbed; IP addresses are not
 *   - EVERY string value and property name is screened — no carve-out
 *   - real identifiers survive because they match no pattern, not because
 *     they are exempted
 *   - full serialized-record round trip incl. Fastify-shaped req records
 *   - numbers are screened as whole lexemes, never parsed, and preserved
 *     only at the fixed record positions pino/Fastify write
 *   - non-JSON lines fall back to a whole-line scrub (fail safe)
 *   - stream wrapper preserves chunk/line framing and handles batches
 */

import { Transform, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  LOG_OVERSIZED_LINE_SENTINEL,
  createRedactingStream,
  redactLogLine,
  redactString,
} from './log-redaction.js';

describe('redactString — Layer-3-eligible patterns (redactInLogs)', () => {
  it('scrubs an SSN', () => {
    expect(redactString('failed for 123-45-6789')).toBe(
      'failed for [REDACTED:US Social Security Number]',
    );
  });

  it('scrubs an email', () => {
    expect(redactString('contact real.person@example.com')).toContain(
      '[REDACTED:Email address]',
    );
  });

  it('scrubs a Ghana Card id', () => {
    expect(redactString('id GHA-123456789-0 rejected')).toContain(
      '[REDACTED:Ghana National ID (Ghana Card)]',
    );
  });

  it('scrubs a Luhn-valid card number', () => {
    expect(redactString('card 4111111111111111 declined')).toContain(
      '[REDACTED:Credit card number]',
    );
  });

  it('does NOT scrub a Luhn-invalid digit run', () => {
    const s = 'reference 1234567890123456 logged';
    expect(redactString(s)).toBe(s);
  });

  it('does NOT scrub IP addresses — operational signal, not PII', () => {
    for (const s of ['upstream 10.0.0.42 timed out', 'peer 2001:db8::1 reset']) {
      expect(redactString(s), `scrubbed diagnostic value: ${s}`).toBe(s);
    }
  });

  it('DOES scrub a context-bound passport number', () => {
    // Codex finding: Layer 3 selected patterns by `confidence`, which is
    // the wrong axis — it drives the Layer 1 route decision, and two
    // patterns can be low_confidence for unrelated reasons. `ipv4` is
    // genuinely ambiguous in a log; `us_passport` is low-confidence only
    // because it needs context, and the pattern now REQUIRES the literal
    // word "passport" adjacent to the value. Excluding it let
    // `passport no. AB1234567` reach the log destination unredacted.
    //
    // Selection is now by the explicit `redactInLogs` flag.
    for (const s of [
      'passport no. AB1234567 rejected',
      'passport #: ABCDE1234',
      'Passport Number XY9876543',
    ]) {
      expect(redactString(s), `not scrubbed: ${s}`).toContain('[REDACTED:');
    }
  });

  it('scrubs Ghana phone numbers written with separators', () => {
    // The pattern was contiguous-only, so it missed the way these
    // numbers are normally written — while `us_phone` had accepted
    // separators all along. Ghana testers are in Pilot 1 scope, so the
    // gap was live on an AI-bound route.
    for (const s of [
      '+233241234567',
      '+233 24 123 4567',
      '+233-24-123-4567',
      '0241234567',
      '024 123 4567',
      '024.123.4567',
    ]) {
      expect(redactString(s), `not scrubbed: ${s}`).toContain('[REDACTED:Ghana phone number]');
    }
  });

  it('leaves clean operational prose untouched', () => {
    const s = 'mode1_chat: provider unavailable; surfaced fail-soft response';
    expect(redactString(s)).toBe(s);
  });
});

describe('redactLogLine — string-token scanner (numeric-lossless)', () => {
  it('scrubs PII in a pino NDJSON record', () => {
    const line = JSON.stringify({ level: 30, msg: 'failed for 123-45-6789' });
    expect(redactLogLine(line)).toContain('[REDACTED:US Social Security Number]');
  });

  it('scrubs query-string PII in a Fastify-shaped req record', () => {
    const line = JSON.stringify({
      level: 30,
      msg: 'incoming request',
      req: { method: 'GET', url: '/v0/ai/chat?email=real.person@example.com' },
    });
    const out = redactLogLine(line);
    expect(out).not.toContain('real.person@example.com');
    expect(out).toContain('[REDACTED:Email address]');
    // Server-defined fields survive so the record stays diagnostic.
    expect(out).toContain('"method":"GET"');
  });

  it('scrubs a serialized Error message', () => {
    const line = JSON.stringify({
      level: 50,
      err: { type: 'Error', message: 'dup key: (email)=(real.person@example.com)' },
    });
    expect(redactLogLine(line)).not.toContain('real.person@example.com');
  });

  it('leaves real identifiers intact — because they match nothing, not by exemption', () => {
    const line = JSON.stringify({
      tenant_id: 'Telecheck-US',
      turn_id: '550e8400-e29b-41d4-a716-446655440000',
      account_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    });
    const out = redactLogLine(line);
    expect(out).toContain('Telecheck-US');
    expect(out).toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(out).toContain('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('does NOT preserve a PII-shaped value merely because the key looks like an id', () => {
    // Codex found a bypass in two successive carve-out designs here:
    // key-name-only, then key name plus a UUID/ULID value shape (a
    // 26-char Crockford string can contain a nine-digit run and still be
    // a valid ULID). The carve-out is now gone entirely — every string
    // is screened — so these cases hold for a structural reason rather
    // than because a rule happens to exclude them.
    const cases: Array<[string, string]> = [
      [JSON.stringify({ request_id: 'person@example.com' }), 'person@example.com'],
      [JSON.stringify({ patient_id: '123-45-6789' }), '123-45-6789'],
      [JSON.stringify({ trace_id: '4111111111111111' }), '4111111111111111'],
      [JSON.stringify({ consult_id: '123456789' }), '123456789'],
    ];
    for (const [line, leaked] of cases) {
      expect(redactLogLine(line), `leaked via: ${line}`).not.toContain(leaked);
    }
  });

  it('scrubs PII appearing in JSON PROPERTY NAMES', () => {
    // Property names are caller-shaped too. An earlier version emitted
    // key tokens raw, so `{"person@example.com":true}` wrote the email
    // verbatim — the same defect class fixed in the audit_bound walker
    // (Sprint 1.1d) and reintroduced here.
    const cases: Array<[string, string]> = [
      ['{"person@example.com":true}', 'person@example.com'],
      ['{"123-45-6789":"x"}', '123-45-6789'],
      ['{"4111111111111111":1}', '4111111111111111'],
      ['{"a":{"b":{"p@q.com":1}}}', 'p@q.com'],
      ['{"xs":[{"p@q.com":1}]}', 'p@q.com'],
    ];
    for (const [line, leaked] of cases) {
      const out = redactLogLine(line);
      expect(out, `leaked key via: ${line}`).not.toContain(leaked);
      expect(() => JSON.parse(out) as unknown).not.toThrow();
    }
  });

  it('scrubs the same value under a non-identifier key', () => {
    const out = redactLogLine(JSON.stringify({ note: 'ssn 123-45-6789' }));
    expect(out).toContain('[REDACTED:US Social Security Number]');
  });

  it('scrubs inside a nested object under an identifier key', () => {
    // An identifier key never exempted a whole subtree, and now exempts
    // nothing at all.
    const out = redactLogLine(JSON.stringify({ request_id: { note: 'ssn 123-45-6789' } }));
    expect(out).toContain('[REDACTED:');
    expect(out).not.toContain('123-45-6789');
  });

  it('scrubs inside arrays under an identifier key, at every nesting depth', () => {
    // Codex finding against an earlier design: array frames inherited
    // the enclosing key, and nested arrays kept re-inheriting it, so
    // `{"request_id":[["person@example.com"]]}` preserved the email.
    // Array frames now carry no key — and with the string carve-out
    // removed there is nothing left for them to inherit.
    const one = redactLogLine(JSON.stringify({ request_id: ['person@example.com'] }));
    expect(one).not.toContain('person@example.com');

    const nested = redactLogLine(JSON.stringify({ request_id: [['person@example.com']] }));
    expect(nested).not.toContain('person@example.com');

    const deep = redactLogLine(JSON.stringify({ trace_id: [[['a@b.com']]] }));
    expect(deep).not.toContain('a@b.com');

    // A real ULID still survives — it matches no high-confidence pattern.
    const direct = redactLogLine(JSON.stringify({ consult_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }));
    expect(direct).toContain('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('rejects JSON-LIKE but invalid lines and falls back to whole-line scrub', () => {
    // Codex finding: the scanner recognises quoted tokens but does not
    // verify grammar, so `{email:real.person@example.com}` — which
    // starts with `{` but is not JSON — was copied through verbatim
    // with the unquoted email never reaching redactString. A JSON.parse
    // validity check (result discarded) now gates the scanner.
    const out = redactLogLine('{email:real.person@example.com}');
    expect(out).not.toContain('real.person@example.com');
    expect(out).toContain('[REDACTED:Email address]');
  });

  it('falls back for unbalanced containers', () => {
    const out = redactLogLine('{"a":"ssn 123-45-6789"');
    expect(out).not.toContain('123-45-6789');
    expect(out).toContain('[REDACTED:');
  });

  it('handles unicode and control-character escapes, staying valid JSON', () => {
    const line = JSON.stringify({ msg: 'é "q" \\ ssn 123-45-6789' });
    const out = redactLogLine(line);
    expect(out).not.toContain('123-45-6789');
    expect(() => JSON.parse(out) as unknown).not.toThrow();
  });

  // --- Codex R-final finding: JSON.parse/stringify round trip was lossy ---

  it('preserves integers beyond Number.MAX_SAFE_INTEGER byte-for-byte', () => {
    // JSON.parse coerces to IEEE-754 double, silently rounding 64-bit
    // ids. Parsing succeeds so no failure sentinel fires — the value is
    // just quietly wrong. The scanner never interprets numeric lexemes.
    const line = '{"id":9007199254740993,"msg":"clean"}';
    expect(redactLogLine(line)).toContain('9007199254740993');
  });

  it('preserves a nanosecond-precision timestamp', () => {
    const line = '{"nano":1725196800123456789,"msg":"clean"}';
    expect(redactLogLine(line)).toContain('1725196800123456789');
  });

  it('preserves float formatting (1.0 does not become 1)', () => {
    const line = '{"f":1.0,"msg":"clean"}';
    expect(redactLogLine(line)).toContain('1.0');
  });

  it('preserves exponent notation verbatim', () => {
    const line = '{"e":1e21,"msg":"clean"}';
    expect(redactLogLine(line)).toContain('1e21');
  });

  it('preserves booleans and null verbatim', () => {
    const line = '{"b":true,"z":null,"msg":"clean"}';
    const out = redactLogLine(line);
    expect(out).toContain('"b":true');
    expect(out).toContain('"z":null');
  });

  it('handles escaped characters inside string values', () => {
    const line = JSON.stringify({ msg: 'line1\nline2 "quoted" ssn 123-45-6789' });
    const out = redactLogLine(line);
    expect(out).toContain('[REDACTED:');
    expect(out).not.toContain('123-45-6789');
    // Still valid JSON after the rewrite.
    expect(() => JSON.parse(out) as unknown).not.toThrow();
  });

  it('output remains parseable JSON', () => {
    const line = JSON.stringify({ a: 1, msg: 'ssn 123-45-6789', nested: { b: ['a@b.com'] } });
    expect(() => JSON.parse(redactLogLine(line)) as unknown).not.toThrow();
  });

  it('falls back to a whole-line scrub for non-JSON input (fail safe)', () => {
    expect(redactLogLine('plain text with ssn 123-45-6789')).toContain('[REDACTED:');
  });

  it('falls back for malformed JSON rather than throwing', () => {
    const line = '{"broken": "ssn 123-45-6789"';
    expect(() => redactLogLine(line)).not.toThrow();
    expect(redactLogLine(line)).toContain('[REDACTED:');
  });

  it('preserves a trailing newline', () => {
    expect(redactLogLine(JSON.stringify({ msg: 'ok' }) + '\n').endsWith('\n')).toBe(true);
  });

  it('returns empty input unchanged', () => {
    expect(redactLogLine('')).toBe('');
  });
});

describe('createRedactingStream — destination wrapper', () => {
  function capture(): { dest: Writable; written: string[] } {
    const written: string[] = [];
    const dest = new Writable({
      write(chunk: unknown, _enc, cb): void {
        written.push(String(chunk));
        cb();
      },
    });
    return { dest, written };
  }

  /** Write through the transform and let it flush to dest. */
  async function pump(stream: Transform, chunk: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      stream.write(chunk, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((r) => setImmediate(r));
  }

  it('scrubs a single record', async () => {
    const { dest, written } = capture();
    const s = createRedactingStream(dest);
    await pump(s, JSON.stringify({ msg: 'ssn 123-45-6789' }) + '\n');
    const all = written.join('');
    expect(all).toContain('[REDACTED:');
    expect(all).not.toContain('123-45-6789');
  });

  it('scrubs every record in a batched multi-line chunk', async () => {
    const { dest, written } = capture();
    const s = createRedactingStream(dest);
    const chunk =
      JSON.stringify({ msg: 'a real.person@example.com' }) +
      '\n' +
      JSON.stringify({ msg: 'b 123-45-6789' }) +
      '\n';
    await pump(s, chunk);
    const all = written.join('');
    expect(all).not.toContain('real.person@example.com');
    expect(all).not.toContain('123-45-6789');
  });

  it('preserves line framing', async () => {
    const { dest, written } = capture();
    const s = createRedactingStream(dest);
    const chunk = JSON.stringify({ msg: 'x' }) + '\n' + JSON.stringify({ msg: 'y' }) + '\n';
    await pump(s, chunk);
    const all = written.join('');
    expect(all.split('\n')).toHaveLength(chunk.split('\n').length);
    expect(all.endsWith('\n')).toBe(true);
  });

  it('is a real stream (composes with a worker-backed pino transport)', () => {
    const { dest } = capture();
    const s = createRedactingStream(dest);
    // A duck-typed { write } object would fail these. pino and the
    // process-exit path rely on real stream plumbing when the
    // destination is a worker-backed transport (pino-pretty).
    expect(typeof s.pipe).toBe('function');
    expect(typeof s.end).toBe('function');
    expect(typeof s.on).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Chunk-boundary safety
//
// Transform streams do NOT guarantee chunks align with newline-delimited
// records. An earlier version treated every chunk as line-complete, so a
// value split across a boundary — `real.person@ex` + `ample.com` —
// matched in NEITHER fragment, both were forwarded, and the destination
// reassembled the original PII.
//
// These tests split a record at EVERY character position and assert the
// value never survives.
// ---------------------------------------------------------------------------

describe('createRedactingStream — chunk-boundary safety', () => {
  function capture(): { dest: Writable; written: string[] } {
    const written: string[] = [];
    const dest = new Writable({
      write(chunk: unknown, _enc, cb): void {
        written.push(String(chunk));
        cb();
      },
    });
    return { dest, written };
  }

  async function feed(chunks: string[]): Promise<string> {
    const { dest, written } = capture();
    const stream = createRedactingStream(dest);
    for (const c of chunks) {
      await new Promise<void>((resolve, reject) => {
        stream.write(c, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve) => stream.end(() => resolve()));
    await new Promise((r) => setImmediate(r));
    return written.join('');
  }

  const SPLIT_CASES: Array<[string, string]> = [
    ['email', 'real.person@example.com'],
    ['SSN', '123-45-6789'],
    ['card', '4111111111111111'],
  ];

  for (const [label, value] of SPLIT_CASES) {
    it(`${label} survives no split point`, async () => {
      const record = JSON.stringify({ msg: `x ${value} y` }) + '\n';
      const leaks: number[] = [];
      for (let i = 1; i < record.length; i++) {
        const out = await feed([record.slice(0, i), record.slice(i)]);
        if (out.includes(value)) leaks.push(i);
      }
      expect(leaks, `${label} leaked at split points: ${leaks.join(', ')}`).toEqual([]);
    });
  }

  it('PII in a property name survives no split point', async () => {
    const record = '{"real.person@example.com":true}\n';
    const leaks: number[] = [];
    for (let i = 1; i < record.length; i++) {
      const out = await feed([record.slice(0, i), record.slice(i)]);
      if (out.includes('real.person@example.com')) leaks.push(i);
    }
    expect(leaks, `key leaked at split points: ${leaks.join(', ')}`).toEqual([]);
  });

  it('flushes an unterminated trailing line, scrubbed', async () => {
    // No newline ever arrives; flush() must still emit it redacted
    // rather than dropping the record or leaking it.
    const out = await feed(['{"msg":"ssn 123-45-6789"}']);
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('123-45-6789');
    expect(out).toContain('[REDACTED:');
  });

  it('holds a partial line until its newline arrives', async () => {
    const out = await feed(['{"msg":"cle', 'an"}\n']);
    expect(out).toContain('clean');
    expect(out.endsWith('\n')).toBe(true);
  });
});

describe('createRedactingStream — overflow boundary', () => {
  const CAP = 1_048_576;

  function capture(): { dest: Writable; written: string[] } {
    const written: string[] = [];
    const dest = new Writable({
      write(chunk: unknown, _enc, cb): void {
        written.push(String(chunk));
        cb();
      },
    });
    return { dest, written };
  }

  async function feed(chunks: string[]): Promise<string> {
    const { dest, written } = capture();
    const stream = createRedactingStream(dest);
    for (const c of chunks) {
      await new Promise<void>((resolve, reject) => {
        stream.write(c, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve) => stream.end(() => resolve()));
    await new Promise((r) => setImmediate(r));
    return written.join('');
  }

  const CASES: Array<[string, string]> = [
    ['email', 'real.person@example.com'],
    ['SSN', '123-45-6789'],
    ['card', '4111111111111111'],
  ];

  for (const [label, value] of CASES) {
    it(`${label} is not reassembled across the overflow boundary`, async () => {
      // An earlier version redacted and EMITTED the oversized carry,
      // then cleared it. If the emitted portion ended mid-token and the
      // next chunk opened with the remainder, neither fragment matched
      // and the destination concatenated them back — making overflow a
      // deliberate way to defeat Layer 3. The record is now dropped.
      const half = Math.floor(value.length / 2);
      const filler = 'x'.repeat(CAP + 10 - half);
      const out = await feed([filler + value.slice(0, half), value.slice(half) + '\n']);
      expect(out).not.toContain(value);
    });
  }

  it('emits a sentinel, drops the record, and resynchronises', async () => {
    const out = await feed([
      'y'.repeat(CAP + 10),
      'tail-of-dropped-record\n',
      JSON.stringify({ msg: 'clean after resync' }) + '\n',
    ]);
    expect(out).toContain(LOG_OVERSIZED_LINE_SENTINEL);
    // No part of the dropped record reaches the destination…
    expect(out).not.toContain('tail-of-dropped-record');
    // …and the stream recovers for the next complete record.
    expect(out).toContain('clean after resync');
  });
});

describe('createRedactingStream — per-record cap enforcement', () => {
  const CAP = 1_048_576;

  function capture(): { dest: Writable; written: string[] } {
    const written: string[] = [];
    const dest = new Writable({
      write(chunk: unknown, _enc, cb): void {
        written.push(String(chunk));
        cb();
      },
    });
    return { dest, written };
  }

  async function feed(chunks: string[]): Promise<string> {
    const { dest, written } = capture();
    const stream = createRedactingStream(dest);
    for (const c of chunks) {
      await new Promise<void>((resolve, reject) => {
        stream.write(c, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve) => stream.end(() => resolve()));
    await new Promise((r) => setImmediate(r));
    return written.join('');
  }

  it('drops an oversized record whose newline arrives in the SAME chunk', async () => {
    // Codex finding: the cap was only checked when a chunk contained no
    // newline at all, so a chunk that both crossed the threshold AND
    // supplied the terminator took the normal path — making the bound
    // depend on how the producer chunked.
    const out = await feed(['z'.repeat(CAP - 10), 'z'.repeat(50) + 'ssn 123-45-6789\n']);
    expect(out).toContain(LOG_OVERSIZED_LINE_SENTINEL);
    expect(out).not.toContain('123-45-6789');
  });

  it('emits a preceding complete line, then drops an oversized tail', async () => {
    const out = await feed([
      JSON.stringify({ msg: 'first clean' }) + '\n',
      'q'.repeat(CAP + 10),
    ]);
    expect(out).toContain('first clean');
    expect(out).toContain(LOG_OVERSIZED_LINE_SENTINEL);
  });

  it('redacts every record in a batched multi-record chunk', async () => {
    const many =
      [1, 2, 3].map((i) => JSON.stringify({ msg: `r${i} a@b.com` })).join('\n') + '\n';
    const out = await feed([many]);
    expect(out).not.toContain('a@b.com');
    expect(out).toContain('r1');
    expect(out).toContain('r3');
  });
});

describe('createRedactingStream — cap is measured in UTF-8 BYTES', () => {
  function capture(): { dest: Writable; written: string[] } {
    const written: string[] = [];
    const dest = new Writable({
      write(chunk: unknown, _enc, cb): void {
        written.push(String(chunk));
        cb();
      },
    });
    return { dest, written };
  }

  async function feed(chunks: string[]): Promise<string> {
    const { dest, written } = capture();
    const stream = createRedactingStream(dest);
    for (const c of chunks) {
      await new Promise<void>((resolve, reject) => {
        stream.write(c, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve) => stream.end(() => resolve()));
    await new Promise((r) => setImmediate(r));
    return written.join('');
  }

  it('drops a multibyte record over the BYTE cap', async () => {
    // Codex finding: both checks used string.length (UTF-16 code
    // units) against a constant named in BYTES. 400k CJK characters is
    // only 400k code units but ~1.2 MiB in UTF-8, so it passed the cap
    // while exceeding the intended bound.
    const cjk = '\u4e2d'.repeat(400_000);
    const out = await feed([cjk + 'ssn 123-45-6789\n']);
    expect(out).toContain(LOG_OVERSIZED_LINE_SENTINEL);
    expect(out).not.toContain('123-45-6789');
  });

  it('a normal ASCII record is unaffected', async () => {
    const out = await feed([JSON.stringify({ msg: 'p'.repeat(1000) + ' a@b.com' }) + '\n']);
    expect(out).not.toContain('a@b.com');
    expect(out).toContain('[REDACTED:');
  });

  it('multibyte records remain split-PII safe at every boundary', async () => {
    const record = JSON.stringify({ msg: '\u4e2d\u6587 real.person@example.com \u4e2d' }) + '\n';
    const leaks: number[] = [];
    for (let i = 1; i < record.length; i++) {
      const out = await feed([record.slice(0, i), record.slice(i)]);
      if (out.includes('real.person@example.com')) leaks.push(i);
    }
    expect(leaks, `leaked at: ${leaks.join(', ')}`).toEqual([]);
  });

  it('resynchronises after a multibyte drop', async () => {
    const cjk = '\u4e2d'.repeat(400_000);
    const out = await feed([cjk + 'x', 'tail\n', JSON.stringify({ msg: 'after' }) + '\n']);
    expect(out).toContain('after');
    expect(out).not.toContain('tail');
  });
});

describe('createRedactingStream — surrogate-split byte accounting', () => {
  function capture(): { dest: Writable; written: string[] } {
    const written: string[] = [];
    const dest = new Writable({
      write(chunk: unknown, _enc, cb): void {
        written.push(String(chunk));
        cb();
      },
    });
    return { dest, written };
  }

  async function feed(chunks: string[]): Promise<string> {
    const { dest, written } = capture();
    const stream = createRedactingStream(dest);
    for (const c of chunks) {
      await new Promise<void>((resolve, reject) => {
        stream.write(c, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve) => stream.end(() => resolve()));
    await new Promise((r) => setImmediate(r));
    return written.join('');
  }

  it('does NOT drop a valid near-cap record whose emoji are split across chunks', async () => {
    // Codex finding: per-chunk Buffer.byteLength OVERCOUNTS when a
    // UTF-16 surrogate pair straddles a chunk boundary — each half
    // measures 3 bytes (6 total) while the combined astral character is
    // 4. Subtracting a record's exact length never reclaims the excess,
    // so the counter drifted upward and would eventually drop a
    // perfectly valid record and emit a false oversized sentinel.
    //
    // 20k split seams inject ~40 KB of phantom bytes into the estimate.
    const emoji = '\u{1F600}';
    const hi = emoji.charAt(0);
    const lo = emoji.charAt(1);
    const chunks: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      chunks.push('a'.repeat(45) + hi);
      chunks.push(lo);
    }
    chunks.push('\n');

    const out = await feed(chunks);
    expect(out).not.toContain(LOG_OVERSIZED_LINE_SENTINEL);
    expect(out.length).toBeGreaterThan(0);
  });

  it('still drops a genuinely oversized record', async () => {
    const out = await feed(['z'.repeat(1_048_576 + 50), '\n']);
    expect(out).toContain(LOG_OVERSIZED_LINE_SENTINEL);
  });
});

describe('createRedactingStream — streaming UTF-8 decode of Buffer input', () => {
  function capture(): { dest: Writable; written: string[] } {
    const written: string[] = [];
    const dest = new Writable({
      write(chunk: unknown, _enc, cb): void {
        written.push(String(chunk));
        cb();
      },
    });
    return { dest, written };
  }

  async function feedBuffers(bufs: Buffer[]): Promise<string> {
    const { dest, written } = capture();
    const stream = createRedactingStream(dest);
    for (const b of bufs) {
      await new Promise<void>((resolve, reject) => {
        stream.write(b, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve) => stream.end(() => resolve()));
    await new Promise((r) => setImmediate(r));
    return written.join('');
  }

  // Codex finding: Buffer.toString('utf8') per chunk turns both halves
  // of a split multibyte character into U+FFFD. A persistent
  // StringDecoder holds the incomplete sequence until it completes.
  const MULTIBYTE: Array<[string, string]> = [
    ['2-byte', '\u00e9'],
    ['3-byte', '\u4e2d'],
    ['4-byte', '\u{1F600}'],
  ];

  for (const [label, char] of MULTIBYTE) {
    it(`${label} character is not corrupted at any byte split`, async () => {
      const line = JSON.stringify({ msg: `a${char}b clean` }) + '\n';
      const buf = Buffer.from(line, 'utf8');
      const bad: number[] = [];
      for (let i = 1; i < buf.length; i++) {
        const out = await feedBuffers([buf.subarray(0, i), buf.subarray(i)]);
        if (out.includes('\uFFFD') || !out.includes(char)) bad.push(i);
      }
      expect(bad, `${label} corrupted at byte splits: ${bad.join(', ')}`).toEqual([]);
    });
  }

  it('PII is still redacted at every Buffer byte split', async () => {
    const line = JSON.stringify({ msg: '\u4e2d real.person@example.com \u4e2d' }) + '\n';
    const buf = Buffer.from(line, 'utf8');
    const leaks: number[] = [];
    for (let i = 1; i < buf.length; i++) {
      const out = await feedBuffers([buf.subarray(0, i), buf.subarray(i)]);
      if (out.includes('real.person@example.com')) leaks.push(i);
    }
    expect(leaks, `leaked at byte splits: ${leaks.join(', ')}`).toEqual([]);
  });
});

describe('redactLogLine — numeric JSON values', () => {
  it('redacts PII that appears as a JSON NUMBER, not a string', () => {
    // Codex finding: the scanner copied every numeric lexeme verbatim
    // on the reasoning that parsing loses precision. True, but
    // over-applied — {"ssn":123456789} reached the destination intact.
    const cases: Array<[string, string]> = [
      ['{"ssn":123456789}', '123456789'],
      ['{"card":4111111111111111}', '4111111111111111'],
      ['{"phone":4155550123}', '4155550123'],
      ['{"vals":[123456789]}', '123456789'],
    ];
    for (const [line, leaked] of cases) {
      const out = redactLogLine(line);
      expect(out, `leaked numeric via: ${line}`).not.toContain(leaked);
      expect(() => JSON.parse(out) as unknown).not.toThrow();
    }
  });

  it('preserves pino\'s own numeric fields on a realistic record', () => {
    // Regression for a would-be self-inflicted outage: a 13-digit ms
    // epoch sits inside the credit-card pattern's 13–19 digit range, so
    // roughly one timestamp in ten is Luhn-valid by chance. Screening
    // numbers with no allowlist at all mangled `time` on ~10% of ALL
    // log lines.
    const line =
      '{"level":30,"time":1725196800123,"pid":12345,"reqId":"r1",' +
      '"responseTime":12.5,"msg":"request completed"}';
    const out = redactLogLine(line);
    expect(out).toContain('"time":1725196800123');
    expect(out).toContain('"level":30');
    expect(out).toContain('"pid":12345');
    expect(out).toContain('"responseTime":12.5');
  });

  it('does NOT preserve a numeric value merely because the key looks like an id', () => {
    // This assertion previously ran the other way, back when numeric
    // preservation reused the generative *_id key rule. That rule was
    // replaced by the closed NUMERIC_PRESERVE_RULES allowlist precisely
    // because it exempted PII: `consult_id` is attacker-influencable in
    // shape, and a nine-digit value under it is indistinguishable from
    // an SSN. See the allowlist block below for the full reasoning.
    expect(redactLogLine('{"consult_id":123456789}')).not.toContain('123456789');
  });

  it('preserves non-matching numeric lexemes byte-for-byte', () => {
    const cases: Array<[string, string]> = [
      ['9007199254740993', 'bigint beyond MAX_SAFE_INTEGER'],
      ['1725196800123456789', 'nanosecond timestamp'],
      ['1.0', 'float formatting'],
      ['1e21', 'exponent notation'],
      ['-42', 'negative'],
    ];
    for (const [value, label] of cases) {
      const out = redactLogLine(`{"v":${value},"m":"x"}`);
      expect(out, `${label} not preserved`).toContain(`"v":${value},`);
    }
  });

  it('matches numeric lexemes WHOLE, never as a substring', () => {
    // The US-phone pattern matches a 10-digit run inside
    // 9007199254740993; substring matching would rewrite a legitimate
    // 64-bit id as `900719[REDACTED:US phone number]` — mangling the
    // value while protecting nothing. A phone number embedded in a
    // longer digit run is not a phone number.
    const out = redactLogLine('{"v":9007199254740993,"m":"x"}');
    expect(out).toContain('9007199254740993');
    expect(out).not.toContain('REDACTED');
  });
});

describe('redactLogLine — numeric preservation is an allowlist, not the *_id rule', () => {
  it('does NOT preserve numeric PII under a generative identifier key', () => {
    // Codex finding: reusing isIdentifierKey for numbers meant any
    // *_id / *Id key exempted its numeric value, so a bare SSN or a
    // Luhn-valid card reached the destination. Unlike the string path
    // there is no value-shape test to compensate — a number has no
    // UUID/ULID form — so the key set carries the whole weight and a
    // generative rule is far too wide.
    const cases: Array<[string, string]> = [
      ['{"patient_id":123456789}', '123456789'],
      ['{"trace_id":4111111111111111}', '4111111111111111'],
      ['{"consult_id":123456789}', '123456789'],
    ];
    for (const [line, leaked] of cases) {
      const out = redactLogLine(line);
      expect(out, `leaked numeric via: ${line}`).not.toContain(leaked);
      expect(() => JSON.parse(out) as unknown).not.toThrow();
    }
  });

  it('preserves exactly the pino-written numeric fields', () => {
    const line =
      '{"level":30,"time":1725196800123,"pid":12345,' +
      '"responseTime":12.5,"statusCode":200,"msg":"done"}';
    const out = redactLogLine(line);
    expect(out).toContain('"time":1725196800123');
    expect(out).toContain('"level":30');
    expect(out).toContain('"pid":12345');
    expect(out).toContain('"responseTime":12.5');
    expect(out).toContain('"statusCode":200');
  });

  it('does NOT preserve an allowlisted key name shadowed inside a nested subtree', () => {
    // Codex finding: the allowlist matched the IMMEDIATE key at any
    // depth, so a caller-shaped subtree could shadow a trusted name.
    // `payload` is application data — its contents are caller-controlled
    // — but its inner key spelled `time` matched, and the phone number
    // was emitted verbatim.
    //
    // Every allowlisted field sits at a FIXED position in the record, so
    // matching the root-relative path instead of the bare key removes
    // the whole shadowing class at no cost.
    const cases: Array<[string, string]> = [
      ['{"payload":{"time":3125551212}}', '3125551212'],
      ['{"body":{"pid":123456789}}', '123456789'],
      ['{"a":{"b":{"level":4111111111111111}}}', '4111111111111111'],
      ['{"req":{"statusCode":123456789}}', '123456789'],
      ['{"payload":[{"time":3125551212}]}', '3125551212'],
      // An array frame has no key, so nothing inside one can resolve to
      // an allowlisted path even directly under a trusted root name.
      ['{"time":[3125551212]}', '3125551212'],
    ];
    for (const [line, leaked] of cases) {
      const out = redactLogLine(line);
      expect(out, `leaked numeric via: ${line}`).not.toContain(leaked);
      expect(() => JSON.parse(out) as unknown).not.toThrow();
    }
  });

  it('does NOT preserve PII placed AT an allowlisted root key', () => {
    // Codex finding: path matching authenticates location, not
    // provenance. The scanner sees serialized bytes and cannot tell
    // whether pino wrote a root field or an application merge object
    // collided with the name — `logger.info({ time: 3125551212 }, 'x')`
    // puts a phone number at root `time`.
    //
    // Closed by requiring the value to sit inside the field's real
    // domain. These fields are machine-written with narrow ranges, and
    // nothing matching us_ssn (9 digits) or us_phone (10 digits) fits
    // any of them.
    const cases: Array<[string, string]> = [
      ['{"time":3125551212}', '3125551212'],
      ['{"time":123456789}', '123456789'],
      ['{"pid":123456789}', '123456789'],
      ['{"pid":3125551212}', '3125551212'],
      ['{"level":123456789}', '123456789'],
      ['{"level":4111111111111111}', '4111111111111111'],
      ['{"responseTime":3125551212}', '3125551212'],
      ['{"statusCode":123456789}', '123456789'],
      ['{"res":{"statusCode":3125551212}}', '3125551212'],
    ];
    for (const [line, leaked] of cases) {
      const out = redactLogLine(line);
      expect(out, `leaked numeric via: ${line}`).not.toContain(leaked);
      expect(() => JSON.parse(out) as unknown).not.toThrow();
    }
  });

  it('matches allowlisted paths case-SENSITIVELY', () => {
    // pino and Fastify write these names in exactly one spelling, so
    // accepting `Time` or `STATUSCODE` would only widen the surface.
    const cases: Array<[string, string]> = [
      ['{"Time":123456789}', '123456789'],
      ['{"TIME":3125551212}', '3125551212'],
      ['{"Pid":123456789}', '123456789'],
      ['{"Level":3125551212}', '3125551212'],
      ['{"ResponseTime":123456789}', '123456789'],
      ['{"statuscode":123456789}', '123456789'],
      ['{"Res":{"statusCode":123456789}}', '123456789'],
      ['{"res":{"StatusCode":123456789}}', '123456789'],
    ];
    for (const [line, leaked] of cases) {
      expect(redactLogLine(line), `leaked via case variant: ${line}`).not.toContain(leaked);
    }
  });

  it('preserves statusCode at both fixed positions Fastify emits it', () => {
    // Root-level under some configurations, under pino's default `res`
    // serializer in others. Both positions are listed explicitly rather
    // than allowing the key at any depth.
    for (const line of ['{"statusCode":200,"msg":"x"}', '{"res":{"statusCode":200},"msg":"x"}']) {
      expect(redactLogLine(line), `mangled: ${line}`).toBe(line);
    }
  });
});
