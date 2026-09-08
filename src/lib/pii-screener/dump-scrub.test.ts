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

describe('Codex R2 in-scope closures', () => {
  it('a quoted identifier with an apostrophe does not open a literal, and the following COPY block is scrubbed', () => {
    const dump =
      'CREATE TABLE public."o\'neil" (id integer, body text);\n' +
      'COPY public."o\'neil" (id, body) FROM stdin;\n' +
      '1\treach me at test.user@example.com\n' +
      '\\.\n';
    const out = scrubText(dump);
    expect(out).not.toContain('test.user@example.com');
    expect(out.startsWith('CREATE TABLE public."o\'neil" (id integer, body text);\n')).toBe(true);
  });
  it('a doubled quote inside an E-literal does not end escape handling', () => {
    const sql = "INSERT INTO public.t VALUES (E'it''s (415)\\t555-0123');\n";
    const out = scrubText(sql);
    expect(out).not.toContain('555-0123');
    // The re-encoder may write the escaped quote as \' (valid in an E-string)
    // or keep ''; both are a single quote inside the literal.
    expect(out).toMatch(/^INSERT INTO public\.t VALUES \(E'it(''|\\')s /);
    expect(out.endsWith("');\n")).toBe(true);
  });
  it('JSON scalar strings are decoded, scrubbed and re-encoded (fully and partly escaped)', () => {
    const full = JSON.stringify('test.user@example.com').replace(
      /[a-z]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
    );
    const out1 = scrubValue(full);
    expect(JSON.parse(out1)).not.toContain('test.user@example.com');
    const out2 = scrubValue('"te\\u0073t.user@example.com"');
    expect(JSON.parse(out2)).not.toContain('test.user@example.com');
  });
  it('backup JSON does not inherit Layer 3 numeric exemptions', () => {
    const out = JSON.parse(
      scrubValue('{"time":1700000000004,"n":1700000000004,"responseTime":0.3125551212}'),
    ) as Record<string, number>;
    expect(out['time']).toBe(out['n']);
    expect(out['responseTime']).toBe(0);
  });
  it('an unterminated literal at end of input fails closed', () => {
    const s = createDumpScrubber();
    s.push("INSERT INTO t VALUES ('open\n");
    expect(() => s.end()).toThrow(/unterminated literal/);
  });
});

describe('Codex R3 in-scope closures', () => {
  it('a COPY header whose quoted identifier spans lines still activates COPY mode', () => {
    const dump =
      'COPY public."o\n\'neil" (id, body) FROM stdin;\n' +
      '1\treach me at test.user@example.com\n' +
      '\\.\n';
    const out = scrubText(dump);
    expect(out).not.toContain('test.user@example.com');
    expect(out.startsWith('COPY public."o\n\'neil" (id, body) FROM stdin;\n')).toBe(true);
    expect(out.endsWith('\\.\n')).toBe(true);
  });
  it('a COPY header whose quoted identifier contains doubled quotes across lines is handled too', () => {
    const dump = 'COPY public."a""b\nc" (id, body) FROM stdin;\n1\tmy SSN is 123-45-6789\n\\.\n';
    expect(scrubText(dump)).not.toContain('123-45-6789');
  });
  it("mixed E-literal escapes (\\' next to '', \\u escapes) decode in one pass and the JSON inside is scrubbed", () => {
    const sql = "SELECT E'\"a\\''' \\u0062@\\u0063.\\u0063\\u006f\"'::json;\n";
    const out = scrubText(sql);
    expect(out).not.toContain('b@c.co');
    expect(out).not.toMatch(/u0062@/);
    expect(out.startsWith("SELECT E'")).toBe(true);
    expect(out.endsWith("'::json;\n")).toBe(true);
  });
  it('decodes \\U escapes and leaves a lone backslash-u without hex as text', () => {
    expect(scrubText("SELECT E'\\U0001F600 ok \\uZZ';\n")).toBe(
      "SELECT E'\\U0001F600 ok \\uZZ';\n",
    );
  });
});

describe('Codex R4 in-scope closure', () => {
  it('a table name containing "FROM stdin;" and a terminator line does not activate COPY early', () => {
    const dump =
      'COPY public."a FROM stdin;\n\\.\nb" (id, body) FROM stdin;\n' +
      '1\t"test.user@example.com\n' +
      '\\.\n';
    const out = scrubText(dump);
    expect(out).not.toContain('test.user@example.com');
    expect(out.startsWith('COPY public."a FROM stdin;\n\\.\nb" (id, body) FROM stdin;\n')).toBe(
      true,
    );
    expect(out.endsWith('\\.\n')).toBe(true);
  });
  it('the same trick inside the column list is handled', () => {
    const dump =
      'COPY public.t (id, "x FROM stdin;\n\\.\ny") FROM stdin;\n1\tmy SSN is 123-45-6789\n\\.\n';
    expect(scrubText(dump)).not.toContain('123-45-6789');
  });
  it('an unclosed identifier containing "FROM stdin;" fails closed at end of input', () => {
    const s = createDumpScrubber();
    s.push('COPY public."a FROM stdin;\n');
    s.push('1\treach me at test.user@example.com\n');
    expect(() => s.end()).toThrow(/unterminated (identifier|COPY statement)/);
  });
  it('a plain single-line COPY header still activates COPY', () => {
    const dump = 'COPY public.t (id, body) FROM stdin;\n1\tmy SSN is 123-45-6789\n\\.\n';
    expect(scrubText(dump)).not.toContain('123-45-6789');
  });
});

describe('Codex R5 in-scope closure — statement-head cap fails closed', () => {
  function wideHeader(columns: number): string {
    // Legal PostgreSQL: many multi-line quoted column names.
    const cols = Array.from({ length: columns }, (_, i) => `"c${i}\nx"`).join(', ');
    return `COPY public.t (${cols}) FROM stdin;\n`;
  }
  it('a large but under-cap multi-line header still activates COPY and scrubs rows', () => {
    const header = wideHeader(1_200); // ~10 KiB of header, many line breaks
    const out = scrubText(header + '1\treach me at test.user@example.com\n\\.\n');
    expect(out).not.toContain('test.user@example.com');
  });
  it('a pending statement beyond the cap aborts (exit 4) instead of passing rows through', () => {
    // Fed as physical lines (as the CLI does). The pending COPY statement
    // accumulates from the COPY line until a line ends with ';' in code mode.
    const bigCol = '"' + 'y'.repeat(100_000) + '\nz"';
    const text =
      'COPY public.t (' +
      Array.from({ length: 12 }, () => bigCol).join(',\n') +
      ') FROM stdin;\n1\treach me at test.user@example.com\n\\.\n';
    expect(() => scrubText(text)).toThrow(/exceeds/);
  });
});

describe('Codex R5 follow-through — header assembly across identifier boundaries', () => {
  it('an identifier that closes on one line while the next opens on a later line is still assembled', () => {
    const dump =
      'COPY public."a\nb" (id,\n"c\nd") FROM stdin;\n' +
      '1\treach me at test.user@example.com\n' +
      '\\.\n';
    expect(scrubText(dump)).not.toContain('test.user@example.com');
  });
  it('a COPY statement that never closes fails closed at end of input', () => {
    const s = createDumpScrubber();
    s.push('COPY public.t (id,\n');
    s.push('1\treach me at test.user@example.com\n');
    expect(() => s.end()).toThrow(/unterminated COPY statement/);
  });
  it('a non-COPY multi-line statement does not accumulate and DDL is untouched', () => {
    const ddl = 'CREATE TABLE public."a\nb" (\n    id integer\n);\n';
    expect(scrubText(ddl)).toBe(ddl);
  });
});

describe('open identifiers are held, not emitted', () => {
  it('an unterminated identifier at end of input emits nothing of its lines', () => {
    const s = createDumpScrubber();
    const first = s.push('CREATE TABLE public."a\n');
    const second = s.push('1\treach me at test.user@example.com\n');
    expect(first).toBe('CREATE TABLE public.');
    expect(second).toBe('');
    expect(() => s.end()).toThrow(/unterminated/);
  });
  it('a multi-line identifier that closes is emitted verbatim when it closes', () => {
    const s = createDumpScrubber();
    const a = s.push('CREATE TABLE public."a\n');
    const b = s.push('b" (id integer);\n');
    expect(a + b).toBe('CREATE TABLE public."a\nb" (id integer);\n');
  });
});

describe('value-level accounting', () => {
  it('counts redacted values and COPY rows, never held-line reshuffles', () => {
    const s = createDumpScrubber();
    const dump =
      'COPY public."a\n\'neil" (id, body, n) FROM stdin;\n' +
      '1\treach me at test.user@example.com\t42\n' +
      '2\tclean\t3125551212\n' +
      '\\.\n' +
      "INSERT INTO t VALUES ('my SSN is 123-45-6789');\n";
    for (const line of dump.split('\n').filter((l) => l.length > 0)) s.push(line + '\n');
    s.end();
    expect(s.stats.copyRows).toBe(2);
    expect(s.stats.redactedValues).toBe(3);
  });
});

describe('Codex R6 in-scope closure — literal continuation across a newline', () => {
  it('rejects a continued E-literal (PostgreSQL would join the fragments) instead of decoding half of it', () => {
    const sql = "SELECT E'\"'\n'\\u0062@\\u0063.\\u0063\\u006f\"'::json;\n";
    expect(() => scrubText(sql)).toThrow(/continuation/);
  });
  it('rejects a continued plain literal too', () => {
    expect(() => scrubText("INSERT INTO t VALUES ('abc'\n  'def');\n")).toThrow(/continuation/);
  });
  it('a literal followed by code on the same line, then a literal on the next line, is NOT a continuation', () => {
    const sql =
      "INSERT INTO t VALUES ('a', 1);\nINSERT INTO t VALUES ('b my SSN is 123-45-6789', 2);\n";
    const out = scrubText(sql);
    expect(out).not.toContain('123-45-6789');
    expect(out.startsWith("INSERT INTO t VALUES ('a', 1);\n")).toBe(true);
  });
});

describe('Codex R7 in-scope closure — continuation across whitespace and comments', () => {
  const cases: Array<[string, string]> = [
    ['blank line', "SELECT 'test.user@'\n\n'example.com';\n"],
    ['whitespace-only line', "SELECT 'test.user@'\n \t \n'example.com';\n"],
    ['form-feed / vertical-tab line', "SELECT 'test.user@'\n\f\v\n'example.com';\n"],
    ['comment line', "SELECT 'test.user@'\n-- joined by PostgreSQL\n'example.com';\n"],
    ['trailing comment on the closing line', "SELECT 'test.user@' -- note\n'example.com';\n"],
    ['E-literal with a blank line', "SELECT E'\"'\n\n'\\u0062@\\u0063.\\u0063\\u006f\"'::json;\n"],
  ];
  for (const [name, sql] of cases) {
    it(`rejects a continuation separated by a ${name}`, () => {
      expect(() => scrubText(sql)).toThrow(/continuation/);
    });
  }
  it('a real token after the literal clears the continuation question', () => {
    const sql = "SELECT 'a'\n\n;\nINSERT INTO t VALUES ('my SSN is 123-45-6789');\n";
    const out = scrubText(sql);
    expect(out).not.toContain('123-45-6789');
  });
});

describe('Codex R8 in-scope closures — lexer-driven termination and CR handling', () => {
  it('a comment containing ";" inside a COPY header does not discard the header', () => {
    const dump =
      'COPY public.t (id,\n-- ;\nbody) FROM stdin;\n1\treach me at test.user@example.com\n\\.\n';
    const out = scrubText(dump);
    expect(out).not.toContain('test.user@example.com');
    expect(out).toContain('COPY public.t (id,\n');
  });
  it('a comment containing "FROM stdin;" does not activate COPY early', () => {
    const dump =
      "INSERT INTO t VALUES (1); -- FROM stdin;\nINSERT INTO t VALUES ('my SSN is 123-45-6789');\n";
    const out = scrubText(dump);
    expect(out).not.toContain('123-45-6789');
    expect(out.startsWith('INSERT INTO t VALUES (1); -- FROM stdin;\n')).toBe(true);
  });
  it('a trailing comment on the COPY header line is fine', () => {
    const dump =
      'COPY public.t (id, body) FROM stdin; -- data follows\n1\tmy SSN is 123-45-6789\n\\.\n';
    expect(scrubText(dump)).not.toContain('123-45-6789');
  });
  it('a bare CR ending a comment before a continued literal is rejected', () => {
    expect(() => scrubText("SELECT 'test.user@'\n-- c\r'example.com';\n")).toThrow(
      /carriage return|continuation/,
    );
  });
  it('a bare CR directly between fragments is rejected', () => {
    expect(() => scrubText("SELECT 'test.user@'\r'example.com';\n")).toThrow(/carriage return/);
  });
  it('CRLF line endings pass through SQL and COPY rows', () => {
    const dump = 'COPY public.t (id, body) FROM stdin;\r\n1\tmy SSN is 123-45-6789\r\n\\.\r\n';
    const out = scrubText(dump);
    expect(out).not.toContain('123-45-6789');
    expect(out.split('\r\n')).toHaveLength(4);
  });
  it('a bare CR inside a COPY row is rejected', () => {
    expect(() => scrubCopyRow('1\ta\rb\n')).toThrow(/carriage return/);
  });
});

describe('Codex R9 in-scope closures — block comments, semicolon-level boundaries, buffer budget', () => {
  it('a block comment containing ";" inside a COPY header does not discard the header', () => {
    const dump =
      'COPY public.t (\n/* ; */\nbody) FROM stdin;\n1\treach me at test.user@example.com\n\\.\n';
    expect(scrubText(dump)).not.toContain('test.user@example.com');
  });
  it('a nested block comment and a trailing block comment on the header line are whitespace', () => {
    const dump =
      'COPY public.t (id, /* a /* nested ; */ b */ body) FROM stdin; /* data */\n1\tmy SSN is 123-45-6789\n\\.\n';
    expect(scrubText(dump)).not.toContain('123-45-6789');
  });
  it('an unterminated block comment at end of input fails closed', () => {
    const s = createDumpScrubber();
    s.push('SELECT 1; /* open\n');
    s.push('1\treach me at test.user@example.com\n');
    expect(() => s.end()).toThrow(/unterminated blockcomment/);
  });
  it('a COPY header that starts after a semicolon on the same line is kept', () => {
    const dump =
      'SELECT 1; COPY public.t (\nbody) FROM stdin;\nreach me at test.user@example.com\n\\.\n';
    expect(scrubText(dump)).not.toContain('test.user@example.com');
  });
  it('a completed dollar block followed by a COPY header on the same line is kept', () => {
    const dump =
      'CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql; COPY public.t (id, body) FROM stdin;\n1\tmy SSN is 123-45-6789\n\\.\n';
    expect(scrubText(dump)).not.toContain('123-45-6789');
  });
  it('content after a COPY header on the same line is rejected', () => {
    expect(() => scrubText('COPY public.t (id, body) FROM stdin; SELECT 1;\n1\tx\n\\.\n')).toThrow(
      /after a COPY header/,
    );
  });
  it('an open identifier that never closes is budgeted and rejected before EOF', () => {
    const s = createDumpScrubber();
    s.push('COPY public.t ("\n');
    const chunk = 'y'.repeat(200_000) + '\n';
    expect(() => {
      for (let i = 0; i < 8; i++) s.push(chunk);
    }).toThrow(/exceeds/);
  });
  it('an open literal that never closes is budgeted and rejected before EOF', () => {
    const s = createDumpScrubber();
    s.push("INSERT INTO t VALUES ('\n");
    const chunk = 'y'.repeat(200_000) + '\n';
    expect(() => {
      for (let i = 0; i < 8; i++) s.push(chunk);
    }).toThrow(/exceeds/);
  });
});
