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

import { describe, expect, it } from 'vitest';

import {
  DEPTH_LIMIT_SENTINEL,
  LOG_REDACTION_MAX_DEPTH,
  createRedactingStream,
  isIdentifierKey,
  redactLogLine,
  redactParsedRecord,
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

  it('rejects free-text keys', () => {
    expect(isIdentifierKey('note')).toBe(false);
    expect(isIdentifierKey('message')).toBe(false);
  });
});

describe('redactParsedRecord — key-aware traversal', () => {
  it('preserves a scalar under an identifier key even if SSN-shaped', () => {
    const out = redactParsedRecord({ consult_id: '123456789' }) as Record<string, unknown>;
    expect(out['consult_id']).toBe('123456789');
  });

  it('scrubs the same value under a non-identifier key', () => {
    const out = redactParsedRecord({ note: 'ssn 123-45-6789' }) as Record<string, unknown>;
    expect(String(out['note'])).toContain('[REDACTED:US Social Security Number]');
  });

  it('still walks a nested object under an identifier key', () => {
    // The carve-out is about ID VALUES, not exempting whole subtrees —
    // otherwise `{ req_id: { note: '<pii>' } }` would slip through.
    const out = redactParsedRecord({
      request_id: { note: 'ssn 123-45-6789' },
    }) as Record<string, Record<string, unknown>>;
    expect(String(out['request_id']!['note'])).toContain('[REDACTED:');
  });

  it('traverses arrays', () => {
    const out = redactParsedRecord({ notes: ['clean', 'ssn 123-45-6789'] }) as Record<
      string,
      string[]
    >;
    expect(out['notes']![0]).toBe('clean');
    expect(out['notes']![1]).toContain('[REDACTED:');
  });

  it('leaves non-string scalars untouched', () => {
    const out = redactParsedRecord({ n: 42, b: true, z: null }) as Record<string, unknown>;
    expect(out['n']).toBe(42);
    expect(out['b']).toBe(true);
    expect(out['z']).toBeNull();
  });

  it('FAILS CLOSED past the depth bound via sentinel', () => {
    // First implementation returned the raw subtree here, which let 33
    // nested containers followed by an email deterministically bypass
    // Layer 3. Substituting a sentinel keeps the logger alive AND
    // refuses to emit unscreened content.
    let deep: unknown = 'real.person@example.com';
    for (let i = 0; i < LOG_REDACTION_MAX_DEPTH + 6; i++) deep = { next: deep };
    const serialized = JSON.stringify(redactParsedRecord(deep));
    expect(serialized).not.toContain('real.person@example.com');
    expect(serialized).toContain(DEPTH_LIMIT_SENTINEL);
  });
});

describe('redactLogLine — serialized-record pass', () => {
  it('scrubs PII in a pino NDJSON record', () => {
    const line = JSON.stringify({ level: 30, msg: 'failed for 123-45-6789' });
    expect(redactLogLine(line)).toContain('[REDACTED:US Social Security Number]');
  });

  it('scrubs query-string PII in a Fastify-shaped req record (Codex R1 vector)', () => {
    const line = JSON.stringify({
      level: 30,
      msg: 'incoming request',
      req: {
        method: 'GET',
        url: '/v0/ai/chat?email=real.person@example.com',
        hostname: 'localhost',
      },
    });
    const out = redactLogLine(line);
    expect(out).not.toContain('real.person@example.com');
    expect(out).toContain('[REDACTED:Email address]');
    // The route/method survive so the record is still diagnostic.
    expect(out).toContain('"method":"GET"');
  });

  it('scrubs a serialized Error message', () => {
    const line = JSON.stringify({
      level: 50,
      err: {
        type: 'Error',
        message: 'duplicate key value: (email)=(real.person@example.com)',
        stack: 'Error: dup\n  at handler',
      },
    });
    const out = redactLogLine(line);
    expect(out).not.toContain('real.person@example.com');
  });

  it('preserves identifier values through the round trip', () => {
    const line = JSON.stringify({ tenant_id: 'Telecheck-US', consult_id: '123456789' });
    const out = redactLogLine(line);
    expect(out).toContain('"tenant_id":"Telecheck-US"');
    expect(out).toContain('"consult_id":"123456789"');
  });

  it('falls back to a whole-line scrub for non-JSON input (fail safe)', () => {
    const line = 'plain text log with ssn 123-45-6789';
    expect(redactLogLine(line)).toContain('[REDACTED:US Social Security Number]');
  });

  it('falls back for malformed JSON rather than throwing', () => {
    const line = '{"broken": "ssn 123-45-6789"';
    expect(() => redactLogLine(line)).not.toThrow();
    expect(redactLogLine(line)).toContain('[REDACTED:');
  });

  it('preserves a trailing newline', () => {
    const line = JSON.stringify({ msg: 'ok' }) + '\n';
    expect(redactLogLine(line).endsWith('\n')).toBe(true);
  });

  it('returns empty input unchanged', () => {
    expect(redactLogLine('')).toBe('');
  });
});

describe('createRedactingStream — destination wrapper', () => {
  function capture(): { dest: { write(c: string): void }; written: string[] } {
    const written: string[] = [];
    return { dest: { write: (c: string) => void written.push(c) }, written };
  }

  it('scrubs a single record', () => {
    const { dest, written } = capture();
    createRedactingStream(dest).write(
      JSON.stringify({ msg: 'ssn 123-45-6789' }) + '\n',
    );
    expect(written[0]).toContain('[REDACTED:');
    expect(written[0]).not.toContain('123-45-6789');
  });

  it('scrubs every record in a batched multi-line chunk', () => {
    const { dest, written } = capture();
    const chunk =
      JSON.stringify({ msg: 'a real.person@example.com' }) +
      '\n' +
      JSON.stringify({ msg: 'b 123-45-6789' }) +
      '\n';
    createRedactingStream(dest).write(chunk);
    expect(written[0]).not.toContain('real.person@example.com');
    expect(written[0]).not.toContain('123-45-6789');
  });

  it('preserves line framing (trailing newline count)', () => {
    const { dest, written } = capture();
    const chunk = JSON.stringify({ msg: 'x' }) + '\n' + JSON.stringify({ msg: 'y' }) + '\n';
    createRedactingStream(dest).write(chunk);
    expect(written[0]!.split('\n')).toHaveLength(chunk.split('\n').length);
    expect(written[0]!.endsWith('\n')).toBe(true);
  });

  it('passes a non-string chunk straight through', () => {
    const { dest, written } = capture();
    // Defensive: pino should only ever hand us strings, but a transport
    // could differ. Do not throw.
    createRedactingStream(dest).write('' as string);
    expect(written).toHaveLength(1);
  });
});
