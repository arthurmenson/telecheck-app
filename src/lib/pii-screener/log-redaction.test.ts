/**
 * log-redaction.test.ts — Sprint 1.2a Layer 3 unit tests.
 *
 * Architecture under test: redaction runs at the DESTINATION STREAM, on
 * already-serialized pino NDJSON. See the module header for why
 * `hooks.logMethod` is the wrong seam (it runs before serializers and
 * corrupts Fastify's prototype-getter-backed request object).
 *
 * Coverage:
 *   - high-confidence patterns scrubbed; low-confidence deliberately not
 *   - server-generated identifier keys preserved; client-influenced keys
 *     (notably `url` with its query string) ARE scrubbed
 *   - full serialized-record round trip incl. Fastify-shaped req records
 *   - identifier preservation requires BOTH key name and UUID/ULID value shape
 *   - non-JSON lines fall back to a whole-line scrub (fail safe)
 *   - stream wrapper preserves chunk/line framing and handles batches
 */

import { Transform, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  LOG_OVERSIZED_LINE_SENTINEL,
  createRedactingStream,
  isIdentifierKey,
  redactLogLine,
  redactString,
} from './log-redaction.js';

describe('redactString — high-confidence patterns only', () => {
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

  it('does NOT scrub low-confidence patterns (IPv4 stays for diagnostics)', () => {
    const s = 'upstream 10.0.0.42 timed out';
    expect(redactString(s)).toBe(s);
  });

  it('leaves clean operational prose untouched', () => {
    const s = 'mode1_chat: provider unavailable; surfaced fail-soft response';
    expect(redactString(s)).toBe(s);
  });
});

describe('isIdentifierKey — carve-out surface', () => {
  it('accepts *_id and *Id', () => {
    expect(isIdentifierKey('consult_id')).toBe(true);
    expect(isIdentifierKey('turnId')).toBe(true);
    expect(isIdentifierKey('ai_chat_session_id')).toBe(true);
  });

  it('accepts explicitly-listed server-generated keys', () => {
    expect(isIdentifierKey('tenant_id')).toBe(true);
    expect(isIdentifierKey('pg_sqlstate')).toBe(true);
    expect(isIdentifierKey('route')).toBe(true);
  });

  it('REJECTS client-influenced keys — url is not carved out', () => {
    // Codex R1 finding: `url` was in the first draft's carve-out, which
    // let `/?email=real.person@example.com` through unredacted. Query
    // strings are caller-controlled; the value must be scrubbed.
    expect(isIdentifierKey('url')).toBe(false);
    expect(isIdentifierKey('path')).toBe(false);
    expect(isIdentifierKey('query')).toBe(false);
    expect(isIdentifierKey('headers')).toBe(false);
    expect(isIdentifierKey('host')).toBe(false);
  });

  it('REJECTS hostname — ambiguous between pino base binding and Host header', () => {
    // pino's base bindings use `hostname` for the OS hostname
    // (server-generated), but Fastify's req serializer uses the SAME key
    // for the client-supplied Host header. A name-based carve-out cannot
    // tell them apart, so the key must not be carved out.
    expect(isIdentifierKey('hostname')).toBe(false);
  });

  it('rejects free-text keys', () => {
    expect(isIdentifierKey('note')).toBe(false);
    expect(isIdentifierKey('message')).toBe(false);
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

  it('preserves a UUID/ULID under an identifier key', () => {
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
    // Codex finding: key-name-only exemption was a deterministic
    // bypass. Preservation now requires the VALUE to be a UUID or ULID.
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

  it('still scrubs inside a nested object under an identifier key', () => {
    // The carve-out is about ID VALUES, not exempting whole subtrees.
    const out = redactLogLine(JSON.stringify({ request_id: { note: 'ssn 123-45-6789' } }));
    expect(out).toContain('[REDACTED:');
    expect(out).not.toContain('123-45-6789');
  });

  it('the carve-out does NOT propagate into arrays under an identifier key', () => {
    // Codex finding: an earlier version pushed the enclosing key onto
    // array frames, so nested arrays kept re-inheriting it and
    // `{"request_id":[["person@example.com"]]}` preserved the email —
    // recreating the nested-subtree bypass the carve-out is meant to
    // exclude. The carve-out now applies ONLY to a string that is the
    // direct value of an object property.
    const one = redactLogLine(JSON.stringify({ request_id: ['person@example.com'] }));
    expect(one).not.toContain('person@example.com');

    const nested = redactLogLine(JSON.stringify({ request_id: [['person@example.com']] }));
    expect(nested).not.toContain('person@example.com');

    const deep = redactLogLine(JSON.stringify({ trace_id: [[['a@b.com']]] }));
    expect(deep).not.toContain('a@b.com');

    // The direct scalar case still preserves when the value is a ULID.
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
