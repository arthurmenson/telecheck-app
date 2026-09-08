import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, 'pii-scrub.mjs');

// Mirror of the canonical samples in src/lib/pii-screener/index.test.ts; the
// unit test backup-redaction.test.ts asserts library completeness.
const SAMPLES = [
  ['us_ssn', 'my SSN is 123-45-6789 for the form', '123-45-6789'],
  ['date_of_birth', 'patient dob 12/31/1985 reports pain', 'dob 12/31/1985'],
  ['ghana_card', 'Ghana Card GHA-123456789-0 issued', 'GHA-123456789-0'],
  ['us_passport', 'passport number AB1234567 issued', 'passport number AB1234567'],
  ['credit_card', 'card 4111 1111 1111 1111 expires', '4111 1111 1111 1111'],
  ['email', 'reach me at test.user@example.com anytime', 'test.user@example.com'],
  ['us_phone', 'call (415) 555-0123 or leave a message', '(415) 555-0123'],
  ['ghana_phone', 'my number +233241234567 works too', '+233241234567'],
  ['ipv4', 'the box at 10.0.0.42 is down', '10.0.0.42'],
  ['ipv6', 'client 2001:db8:85a3::8a2e:370:7334 connected', '2001:db8:85a3::8a2e:370:7334'],
  ['medical_record_number', 'MRN 1234567 in the chart', 'MRN 1234567'],
];

/** An adversarial pg_dump-shaped fixture: COPY rows, INSERT statements, a JSON column, comments. */
function fixture() {
  const rows = SAMPLES.map(
    ([id, input], i) => `${i + 1}\tTelecheck-US\t${input}\t{"note":"${input}","k":${i}}\t\\N`,
  );
  const inserts = SAMPLES.map(
    ([, input], i) => `INSERT INTO public.free_text (id, body) VALUES (${i + 1}, '${input}');`,
  );
  return (
    [
      '--',
      '-- PostgreSQL database dump',
      '--',
      'COPY public.ai_mode1_conversation_turn_admission (id, tenant_id, user_message, meta, deleted_at) FROM stdin;',
      ...rows,
      '\\.',
      '',
      ...inserts,
      '-- Completed on 2026-09-08',
    ].join('\n') + '\n'
  );
}

function run(args, input, { chunk = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: path.join(here, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (chunk > 0) {
      // Feed the input in small pieces so values straddle chunk boundaries.
      let i = 0;
      const tick = () => {
        if (i >= input.length) return child.stdin.end();
        child.stdin.write(input.slice(i, i + chunk));
        i += chunk;
        setImmediate(tick);
      };
      tick();
    } else {
      child.stdin.end(input);
    }
  });
}

test('backup mode: 100% recall against the whole library on an adversarial dump, framing preserved', async () => {
  const input = fixture();
  const { code, stdout, stderr } = await run(['--mode', 'backup'], input);
  assert.equal(code, 0, stderr);
  for (const [id, , expectMatch] of SAMPLES)
    assert.ok(!stdout.includes(expectMatch), `${id} leaked`);
  assert.ok(stdout.includes('[REDACTED:'));
  assert.equal(stdout.split('\n').length, input.split('\n').length, 'line count preserved');
  assert.ok(stdout.startsWith('--\n-- PostgreSQL database dump\n'));
  assert.ok(stdout.includes('\n\\.\n'), 'COPY terminator preserved');
  assert.ok(stdout.endsWith('-- Completed on 2026-09-08\n'));
  assert.match(stderr, /lines=\d+ copyRows=\d+ redactedValues=\d+/);
});

test('backup mode: PII hidden behind COPY / JSON / bytea encodings is caught after DECODING, and DDL is untouched', async () => {
  const hexEmail = Buffer.from('reach me at test.user@example.com', 'utf8').toString('hex');
  const input = [
    "SET client_encoding = 'UTF8';",
    'CREATE TABLE public.t (',
    '    id integer NOT NULL,',
    "    meta jsonb DEFAULT '{}'::jsonb NOT NULL",
    ');',
    'COPY public.t (id, note, phone, meta, blob) FROM stdin;',
    '1\tMRN\\n1234567\t(415)\\t555-0123\t{"email":"te\\\\u0073t.user@example.com","n":3125551212}\t\\\\x' +
      hexEmail,
    '2\t3125551212\t\\N\t{"k":2}\t\\N',
    '\\.',
    "INSERT INTO public.free_text (id, body) VALUES (1, E'line\\nmy SSN is 123-45-6789');",
    'ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);',
    '',
  ].join('\n');
  const { code, stdout, stderr } = await run(['--mode', 'backup'], input);
  assert.equal(code, 0, stderr);
  const lines = stdout.split('\n');
  // DDL byte-identical (the ::jsonb cast is not an IPv6 address).
  assert.equal(lines[1], 'CREATE TABLE public.t (');
  assert.equal(lines[3], "    meta jsonb DEFAULT '{}'::jsonb NOT NULL");
  assert.equal(lines[10], 'ALTER TABLE ONLY public.t ADD CONSTRAINT t_pkey PRIMARY KEY (id);');
  // COPY row 1: decode every field and check recall + framing.
  const row1 = lines[6].split('\t');
  assert.equal(row1.length, 5, 'field count preserved');
  const dec = (f) => f.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
  assert.ok(!dec(row1[1]).includes('1234567'), 'COPY-escaped MRN leaked');
  assert.ok(!dec(row1[2]).includes('555-0123'), 'COPY-escaped phone leaked');
  const meta = JSON.parse(dec(row1[3]));
  assert.equal(meta.n, 0, 'matching JSON number becomes 0, still a number');
  assert.equal(typeof meta.n, 'number');
  assert.ok(!meta.email.includes('test.user@example.com'), 'JSON-escaped email leaked');
  const blob = dec(row1[4]);
  assert.ok(blob.startsWith('\\x'));
  assert.ok(
    !Buffer.from(blob.slice(2), 'hex').toString('utf8').includes('test.user@example.com'),
    'bytea email leaked',
  );
  // COPY row 2: matching numeric field becomes 0 in place, \N kept, field count kept.
  assert.equal(lines[7], '2\t0\t\\N\t{"k":2}\t\\N');
  // INSERT E-literal: decoded SSN gone, statement still well-formed.
  assert.ok(!lines[9].includes('123-45-6789'));
  assert.match(
    lines[9],
    /^INSERT INTO public\.free_text \(id, body\) VALUES \(1, E'line\\n[^']*'\);$/,
  );
});

test('values split across chunk boundaries are still caught (1-byte and 7-byte chunks)', async () => {
  const input = fixture();
  for (const chunk of [1, 7]) {
    const { code, stdout } = await run(['--mode', 'backup'], input, { chunk });
    assert.equal(code, 0);
    for (const [id, , expectMatch] of SAMPLES)
      assert.ok(!stdout.includes(expectMatch), `${id} leaked at chunk=${chunk}`);
  }
});

test('a trailing COPY row without a newline is redacted at end of input, not lost', async () => {
  // Prose OUTSIDE a COPY block or a literal is code and passes through by
  // design; the value under test is a COPY field, terminated by end of input.
  const input = 'COPY public.t (id, body) FROM stdin;\n1\tmy SSN is 123-45-6789 no newline';
  const { code, stdout } = await run(['--mode', 'backup'], input);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('123-45-6789'));
  assert.ok(stdout.startsWith('COPY public.t (id, body) FROM stdin;\n1\t'));
  assert.ok(!stdout.endsWith('\n'), 'no newline is invented');
});

test('an oversized line FAILS the run (exit 3) — never dropped, its PII never emitted', async () => {
  const huge = 'x'.repeat(2048) + ' my SSN is 123-45-6789 ' + 'y'.repeat(2048);
  const { code, stdout, stderr } = await run(
    ['--mode', 'backup', '--max-line-bytes', '1024'],
    `ok line\n${huge}\n`,
  );
  assert.equal(code, 3);
  assert.match(stderr, /exceeds --max-line-bytes/);
  assert.ok(!stdout.includes('123-45-6789'));
  assert.ok(!stdout.includes('xxxx'), 'no partial oversized line emitted');
});

test('empty input yields empty output and exit 0', async () => {
  const { code, stdout } = await run(['--mode', 'backup'], '');
  assert.equal(code, 0);
  assert.equal(stdout, '');
});

test('usage errors exit 2', async () => {
  const { code } = await run(['--mode', 'nope'], 'x\n');
  assert.equal(code, 2);
});

test('log mode delegates to the Layer 3 JSON-aware pass', async () => {
  const line = '{"level":30,"msg":"user test.user@example.com signed in","n":1}\n';
  const { code, stdout } = await run(['--mode', 'log'], line);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('test.user@example.com'));
  assert.doesNotThrow(() => JSON.parse(stdout));
});

test('backup mode: quoted identifier with an apostrophe before a COPY block (Codex R2) is scrubbed', async () => {
  const input =
    'CREATE TABLE public."o\'neil" (id integer, body text);\nCOPY public."o\'neil" (id, body) FROM stdin;\n1\treach me at test.user@example.com\n\\.\n';
  const { code, stdout } = await run(['--mode', 'backup'], input);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('test.user@example.com'));
});

test('backup mode: an unterminated literal at end of input fails closed (exit 4)', async () => {
  const { code, stderr } = await run(['--mode', 'backup'], "INSERT INTO t VALUES ('open\n");
  assert.equal(code, 4);
  assert.match(stderr, /unterminated literal/);
});

test('backup mode: a multi-line quoted identifier in a COPY header (Codex R3) does not hide the rows', async () => {
  const input =
    'COPY public."o\n\'neil" (id, body) FROM stdin;\n1\treach me at test.user@example.com\n\\.\n';
  const { code, stdout } = await run(['--mode', 'backup'], input);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('test.user@example.com'));
});

test('backup mode: mixed E-literal quote escapes around JSON (Codex R3) are decoded and scrubbed', async () => {
  const input = "SELECT E'\"a\\''' \\u0062@\\u0063.\\u0063\\u006f\"'::json;\n";
  const { code, stdout } = await run(['--mode', 'backup'], input);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('b@c.co'));
  assert.ok(!stdout.includes('u0062@'));
  assert.ok(stdout.endsWith("'::json;\n"));
});

test('backup mode: a table name containing "FROM stdin;" and a terminator (Codex R4) cannot end COPY early', async () => {
  const input =
    'COPY public."a FROM stdin;\n\\.\nb" (id, body) FROM stdin;\n1\t"test.user@example.com\n\\.\n';
  const { code, stdout, stderr } = await run(['--mode', 'backup'], input);
  assert.equal(code, 0, stderr);
  assert.ok(!stdout.includes('test.user@example.com'));
  assert.match(stderr, /redactedValues=1/);
});

test('backup mode: an unclosed identifier containing "FROM stdin;" fails closed (exit 4)', async () => {
  const { code, stderr, stdout } = await run(
    ['--mode', 'backup'],
    'COPY public."a FROM stdin;\n1\treach me at test.user@example.com\n',
  );
  assert.equal(code, 4);
  // Whichever guard fires first (the pending COPY statement or the open
  // identifier), the run fails closed and nothing is passed through.
  assert.match(stderr, /unterminated (identifier|COPY statement)/);
  assert.ok(!stdout.includes('test.user@example.com'));
});

test('backup mode: a legal 68 KiB multi-line COPY header (Codex R5) is scrubbed, and an over-cap header fails closed', async () => {
  const cols = Array.from(
    { length: 1_050 },
    (_, i) => `"col_${String(i).padStart(4, '0')}_${'a'.repeat(40)}\nx"`,
  ).join(', ');
  const legal = `COPY public.t (${cols}) FROM stdin;\n1\treach me at test.user@example.com\n\\.\n`;
  const ok = await run(['--mode', 'backup'], legal);
  assert.equal(ok.code, 0, ok.stderr);
  assert.ok(!ok.stdout.includes('test.user@example.com'));
  const huge =
    'COPY public.t ("' +
    'y'.repeat(600_000) +
    '\n' +
    'z'.repeat(600_000) +
    '\nq") FROM stdin;\n1\treach me at test.user@example.com\n\\.\n';
  const bad = await run(['--mode', 'backup', '--max-line-bytes', '2000000'], huge);
  assert.equal(bad.code, 4);
  assert.match(bad.stderr, /exceeds/);
  assert.ok(!bad.stdout.includes('test.user@example.com'));
});

test('backup mode: a header whose identifiers close and open on different lines is assembled (Codex R5 follow-through)', async () => {
  const input =
    'COPY public."a\nb" (id,\n"c\nd") FROM stdin;\n1\treach me at test.user@example.com\n\\.\n';
  const { code, stdout } = await run(['--mode', 'backup'], input);
  assert.equal(code, 0);
  assert.ok(!stdout.includes('test.user@example.com'));
});
