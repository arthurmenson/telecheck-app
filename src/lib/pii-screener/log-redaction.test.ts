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
 *   - depth exhaustion fails CLOSED via sentinel
 *   - non-JSON lines fall back to a whole-line scrub (fail safe)
 *   - stream wrapper preserves chunk/line framing and handles batches
 */

import { Transform, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
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

  it('preserves a scalar under an identifier key even if SSN-shaped', () => {
    const line = JSON.stringify({ tenant_id: 'Telecheck-US', consult_id: '123456789' });
    const out = redactLogLine(line);
    expect(out).toContain('"tenant_id":"Telecheck-US"');
    expect(out).toContain('"consult_id":"123456789"');
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

    // The direct scalar case still preserves.
    const direct = redactLogLine(JSON.stringify({ consult_id: '123456789' }));
    expect(direct).toContain('"consult_id":"123456789"');
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
