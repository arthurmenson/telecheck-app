import { describe, expect, it } from 'vitest';

import { backupRedactionPatternIds, redactForBackup } from './backup-redaction.js';
import { redactString } from './log-redaction.js';
import { PII_PATTERNS } from './patterns.js';

// Mirror of the canonical sample table in index.test.ts (kept in sync by the
// library-completeness assertion below).
const SAMPLES: Array<{ patternId: string; input: string; expectMatch: string }> = [
  { patternId: 'us_ssn', input: 'my SSN is 123-45-6789 for the form', expectMatch: '123-45-6789' },
  {
    patternId: 'date_of_birth',
    input: 'patient dob 12/31/1985 reports pain',
    expectMatch: 'dob 12/31/1985',
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

describe('redactForBackup — Layer 5 runs the WHOLE library', () => {
  it('covers every pattern in the library (a new pattern must add a sample here)', () => {
    const covered = new Set(SAMPLES.map((s) => s.patternId));
    for (const id of backupRedactionPatternIds()) expect(covered.has(id), id).toBe(true);
    expect(backupRedactionPatternIds()).toEqual(PII_PATTERNS.map((p) => p.id));
  });

  for (const { patternId, input, expectMatch } of SAMPLES) {
    it(`scrubs ${patternId} from a dumped row`, () => {
      const row = `42\tTelecheck-US\t${input}\t\\N\n`;
      const out = redactForBackup(row);
      expect(out).not.toContain(expectMatch);
      expect(out).toContain('[REDACTED:');
      // Framing survives: tabs, the SQL NULL marker and the newline.
      expect(out.startsWith('42\tTelecheck-US\t')).toBe(true);
      expect(out.endsWith('\t\\N\n')).toBe(true);
    });
  }

  it('scrubs what Layer 3 deliberately leaves alone (IP addresses) — no operational carve-out on durable storage', () => {
    const line = 'client 10.0.0.42 and 2001:db8:85a3::8a2e:370:7334';
    expect(redactString(line)).toBe(line);
    const out = redactForBackup(line);
    expect(out).not.toContain('10.0.0.42');
    expect(out).not.toContain('2001:db8:85a3::8a2e:370:7334');
  });

  it('keeps the validate hook: a Luhn-invalid digit run is not a card number', () => {
    expect(redactForBackup('ref 4111 1111 1111 1112 kept')).toBe('ref 4111 1111 1111 1112 kept');
  });

  it('is idempotent and leaves clean rows byte-identical', () => {
    const clean = '7\tTelecheck-US\tsynthetic scenario text\t2026-09-08 04:00:00+00\n';
    expect(redactForBackup(clean)).toBe(clean);
    const once = redactForBackup('my SSN is 123-45-6789');
    expect(redactForBackup(once)).toBe(once);
  });
});
