import { describe, expect, it } from 'vitest';

import {
  createDumpScrubber,
  decodeCopyField,
  encodeCopyField,
  scrubCopyRow,
  scrubValue,
} from './dump-scrub.js';

function scrubText(text: string): string {
  const s = createDumpScrubber();
  const parts = text.split('\n');
  let out = '';
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (last && part === '') return;
    out += s.push(last ? part : part + '\n');
  });
  return out + s.end();
}

describe('COPY field codec', () => {
  it('round-trips PostgreSQL text-format escapes', () => {
    const raw = 'a\\tb\\nc\\\\d\\r\\x41\\101';
    const decoded = decodeCopyField(raw);
    expect(decoded).toBe('a\tb\nc\\d\rAA');
    expect(encodeCopyField(decoded)).toBe('a\\tb\\nc\\\\d\\rAA');
  });
});

describe('scrubValue — typed, value-level', () => {
  it('scrubs prose with the whole library', () => {
    expect(scrubValue('reach me at test.user@example.com')).not.toContain('test.user@example.com');
  });
  it('replaces a matching bare number by 0 so an integer column stays an integer', () => {
    expect(scrubValue('3125551212')).toBe('0');
    expect(scrubValue('42')).toBe('42');
    expect(scrubValue('-7.5')).toBe('-7.5');
  });
  it('keeps JSON valid: strings and keys scrubbed, non-matching numbers verbatim, matching numbers become 0 as numbers', () => {
    const json =
      '{"email":"test.user@example.com","n":3125551212,"k":7,"nested":{"ssn":"123-45-6789"}}';
    const out = scrubValue(json);
    const parsed = JSON.parse(out) as {
      email: string;
      n: number;
      k: number;
      nested: { ssn: string };
    };
    expect(parsed.n).toBe(0);
    expect(typeof parsed.n).toBe('number');
    expect(parsed.k).toBe(7);
    expect(parsed.email).not.toContain('test.user@example.com');
    expect(parsed.nested.ssn).not.toContain('123-45-6789');
  });
  it('sees through JSON unicode escapes', () => {
    const json = '{"email":"te\\u0073t.user@example.com"}';
    const out = JSON.parse(scrubValue(json)) as { email: string };
    expect(out.email).not.toContain('test.user@example.com');
  });
});

describe('COPY rows — decoded values, preserved framing', () => {
  it('catches PII hidden behind COPY escapes (embedded newline / tab)', () => {
    const row = '7\tTelecheck-US\tMRN\\n1234567\t(415)\\t555-0123\t\\N\n';
    const out = scrubCopyRow(row);
    const fields = out.trimEnd().split('\t');
    expect(fields).toHaveLength(5);
    expect(fields[0]).toBe('7');
    expect(fields[4]).toBe('\\N');
    expect(decodeCopyField(fields[2]!)).not.toContain('1234567');
    expect(decodeCopyField(fields[3]!)).not.toContain('555-0123');
    expect(out.endsWith('\n')).toBe(true);
  });
  it('never merges tab-separated numeric fields; a matching number becomes 0 in place', () => {
    const out = scrubCopyRow('1\t3125551212\t2\n');
    expect(out).toBe('1\t0\t2\n');
  });
  it('scrubs inside a JSON column and keeps it parseable', () => {
    const out = scrubCopyRow('1\t{"note":"my SSN is 123-45-6789","k":1}\n');
    const json = out.trimEnd().split('\t')[1]!;
    const parsed = JSON.parse(decodeCopyField(json)) as { note: string; k: number };
    expect(parsed.k).toBe(1);
    expect(parsed.note).not.toContain('123-45-6789');
  });
  it('scrubs printable bytea and leaves binary/ciphertext untouched', () => {
    const hex = Buffer.from('reach me at test.user@example.com', 'utf8').toString('hex');
    const out = scrubCopyRow(`1\t\\\\x${hex}\n`);
    const field = decodeCopyField(out.trimEnd().split('\t')[1]!);
    expect(field.startsWith('\\x')).toBe(true);
    expect(Buffer.from(field.slice(2), 'hex').toString('utf8')).not.toContain(
      'test.user@example.com',
    );
    const bin = '\\\\x00ff10c0deadbeef';
    expect(scrubCopyRow(`1\t${bin}\n`)).toBe(`1\t${bin}\n`);
  });
});

describe('SQL text — only literal contents are scrubbed', () => {
  it('leaves DDL untouched, including the ::jsonb cast that looks like IPv6', () => {
    const ddl =
      "CREATE TABLE public.t (\n    id integer NOT NULL,\n    meta jsonb DEFAULT '{}'::jsonb NOT NULL\n);\n";
    expect(scrubText(ddl)).toBe(ddl);
  });
  it('scrubs INSERT string literals and keeps quoting valid', () => {
    const sql = "INSERT INTO public.t (id, body) VALUES (1, 'it''s test.user@example.com');\n";
    const out = scrubText(sql);
    expect(out).not.toContain('test.user@example.com');
    expect(out).toMatch(
      /^INSERT INTO public\.t \(id, body\) VALUES \(1, 'it''s \[REDACTED:[^\]]+\]'\);\n$/,
    );
  });
  it('handles E-literals with backslash escapes', () => {
    const sql = "INSERT INTO public.t VALUES (E'line\\nMRN 1234567\\tend');\n";
    const out = scrubText(sql);
    expect(out).not.toContain('1234567');
    expect(out.startsWith("INSERT INTO public.t VALUES (E'line\\n")).toBe(true);
  });
  it('handles a literal spanning lines and preserves the newline inside it', () => {
    const sql = "INSERT INTO public.t VALUES ('first line\nsecond my SSN is 123-45-6789');\n";
    const out = scrubText(sql);
    expect(out).not.toContain('123-45-6789');
    expect(out.split('\n')).toHaveLength(3);
  });
  it('leaves dollar-quoted function bodies and comments untouched', () => {
    const fn =
      '-- contact test.user@example.com in a comment is code, not data\n' +
      'CREATE FUNCTION f() RETURNS text LANGUAGE plpgsql AS $$ BEGIN RETURN a::text; END $$;\n';
    expect(scrubText(fn)).toBe(fn);
  });
  it('passes through numbers, identifiers and casts in a full dump excerpt', () => {
    const dump =
      "SET client_encoding = 'UTF8';\n" +
      'COPY public.t (id, phone, meta) FROM stdin;\n' +
      '1\t3125551212\t{"a":1}\n' +
      '\\.\n' +
      'ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);\n';
    const out = scrubText(dump);
    expect(out).toBe(dump.replace('1\t3125551212\t', '1\t0\t'));
  });
});
