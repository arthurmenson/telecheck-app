/**
 * log-redaction.test.ts — Sprint 1.2a Layer 3 unit tests.
 *
 * Coverage:
 *   - high-confidence patterns are scrubbed from strings
 *   - low-confidence patterns are deliberately NOT scrubbed (they
 *     collide with legitimate operational values)
 *   - identifier-keyed values are preserved verbatim (debuggability)
 *   - Error.message / .stack are scrubbed (the primary residual vector)
 *   - Errors are not mutated in place
 *   - nested objects / arrays / Map / Set are traversed
 *   - depth bound fails OPEN (documented asymmetry vs. audit_bound)
 *   - the pino logMethod hook scrubs both merge object and message
 */

import { describe, expect, it } from 'vitest';

import {
  piiRedactingLogMethod,
  redactLogPayload,
  redactString,
} from './log-redaction.js';

describe('redactString — high-confidence patterns only (Sprint 1.2a)', () => {
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
    // An IP in a log line is usually infrastructure, not PII. Scrubbing
    // it would remove genuinely useful diagnostic signal.
    const s = 'upstream 10.0.0.42 timed out';
    expect(redactString(s)).toBe(s);
  });

  it('leaves clean operational prose untouched', () => {
    const s = 'mode1_chat: provider unavailable; surfaced fail-soft response';
    expect(redactString(s)).toBe(s);
  });
});

describe('redactLogPayload — identifier-key preservation', () => {
  it('preserves *_id values verbatim even when they look like an SSN', () => {
    // A bare 9-digit run matches us_ssn. Under an identifier key it must
    // survive, or the operator loses correlation during an incident.
    const out = redactLogPayload({ consult_id: '123456789' }) as Record<string, unknown>;
    expect(out['consult_id']).toBe('123456789');
  });

  it('preserves camelCase *Id values', () => {
    const out = redactLogPayload({ turnId: '123456789' }) as Record<string, unknown>;
    expect(out['turnId']).toBe('123456789');
  });

  it('preserves explicitly-listed identifier keys', () => {
    const out = redactLogPayload({ tenant_id: 'Telecheck-US', route: '/v0/ai/chat' }) as Record<
      string,
      unknown
    >;
    expect(out['tenant_id']).toBe('Telecheck-US');
    expect(out['route']).toBe('/v0/ai/chat');
  });

  it('DOES scrub the same value under a non-identifier key', () => {
    const out = redactLogPayload({ note: 'ssn 123-45-6789' }) as Record<string, unknown>;
    expect(out['note']).toContain('[REDACTED:US Social Security Number]');
  });
});

describe('redactLogPayload — Error handling (the primary residual vector)', () => {
  it('scrubs Error.message', () => {
    const err = new Error('duplicate key value: (email)=(real.person@example.com)');
    const out = redactLogPayload(err) as Record<string, unknown>;
    expect(String(out['message'])).toContain('[REDACTED:Email address]');
    expect(String(out['message'])).not.toContain('real.person@example.com');
  });

  it('scrubs Error.stack', () => {
    const err = new Error('boom');
    err.stack = 'Error: boom\n  at handler (ssn 123-45-6789)';
    const out = redactLogPayload(err) as Record<string, unknown>;
    expect(String(out['stack'])).toContain('[REDACTED:US Social Security Number]');
  });

  it('does NOT mutate the original Error (shared object safety)', () => {
    const original = 'contact real.person@example.com';
    const err = new Error(original);
    redactLogPayload(err);
    expect(err.message).toBe(original);
  });

  it('preserves pg-style identifier props while scrubbing free-text props', () => {
    const err = Object.assign(new Error('constraint violated'), {
      code: '23505',
      detail: 'Key (email)=(real.person@example.com) already exists.',
    });
    const out = redactLogPayload(err) as Record<string, unknown>;
    expect(out['code']).toBe('23505');
    expect(String(out['detail'])).toContain('[REDACTED:Email address]');
  });

  it('preserves name', () => {
    const out = redactLogPayload(new TypeError('bad')) as Record<string, unknown>;
    expect(out['name']).toBe('TypeError');
  });
});

describe('redactLogPayload — structural traversal', () => {
  it('traverses nested objects', () => {
    const out = redactLogPayload({ a: { b: { note: 'ssn 123-45-6789' } } }) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    expect(String(out['a']!['b']!['note'])).toContain('[REDACTED:');
  });

  it('traverses arrays', () => {
    const out = redactLogPayload({ notes: ['clean', 'ssn 123-45-6789'] }) as Record<
      string,
      string[]
    >;
    expect(out['notes']![0]).toBe('clean');
    expect(out['notes']![1]).toContain('[REDACTED:');
  });

  it('traverses Map values', () => {
    const out = redactLogPayload(new Map([['k', 'ssn 123-45-6789']])) as Map<string, string>;
    expect(out.get('k')).toContain('[REDACTED:');
  });

  it('traverses Set members', () => {
    const out = redactLogPayload(new Set(['ssn 123-45-6789'])) as Set<string>;
    expect([...out][0]).toContain('[REDACTED:');
  });

  it('leaves non-string scalars untouched', () => {
    const out = redactLogPayload({ n: 42, b: true, z: null }) as Record<string, unknown>;
    expect(out['n']).toBe(42);
    expect(out['b']).toBe(true);
    expect(out['z']).toBeNull();
  });

  it('FAILS OPEN past the depth bound (documented asymmetry vs audit_bound)', () => {
    // Throwing from inside a logger would break logging itself — losing
    // the operational record during an incident is worse than a
    // pathologically-nested payload going unscrubbed. Logs are also
    // purgeable; audit rows are not. See module header.
    let deep: unknown = 'ssn 123-45-6789';
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(() => redactLogPayload(deep)).not.toThrow();
  });
});

describe('piiRedactingLogMethod — pino hook', () => {
  it('scrubs both the merge object and the message string', () => {
    const captured: unknown[][] = [];
    const method = function (this: unknown, ...args: unknown[]): void {
      captured.push(args);
    };
    piiRedactingLogMethod.call(
      {},
      [{ note: 'ssn 123-45-6789' }, 'failed for real.person@example.com'],
      method,
    );
    expect(captured).toHaveLength(1);
    const [mergeObj, msg] = captured[0]!;
    expect(String((mergeObj as Record<string, unknown>)['note'])).toContain('[REDACTED:');
    expect(String(msg)).toContain('[REDACTED:Email address]');
  });

  it('passes non-string non-object args through untouched', () => {
    const captured: unknown[][] = [];
    const method = function (this: unknown, ...args: unknown[]): void {
      captured.push(args);
    };
    piiRedactingLogMethod.call({}, [42, true, null], method);
    expect(captured[0]).toEqual([42, true, null]);
  });
});
