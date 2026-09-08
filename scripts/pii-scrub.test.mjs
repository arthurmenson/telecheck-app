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
  return [
    '--',
    '-- PostgreSQL database dump',
    '--',
    'COPY public.ai_mode1_conversation_turn_admission (id, tenant_id, user_message, meta, deleted_at) FROM stdin;',
    ...rows,
    '\\.',
    '',
    ...inserts,
    '-- Completed on 2026-09-08',
  ].join('\n') + '\n';
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
  for (const [id, , expectMatch] of SAMPLES) assert.ok(!stdout.includes(expectMatch), `${id} leaked`);
  assert.ok(stdout.includes('[REDACTED:'));
  assert.equal(stdout.split('\n').length, input.split('\n').length, 'line count preserved');
  assert.ok(stdout.startsWith('--\n-- PostgreSQL database dump\n'));
  assert.ok(stdout.includes('\n\\.\n'), 'COPY terminator preserved');
  assert.ok(stdout.endsWith('-- Completed on 2026-09-08\n'));
  assert.match(stderr, /lines=\d+ redactedLines=\d+/);
});

test('values split across chunk boundaries are still caught (1-byte and 7-byte chunks)', async () => {
  const input = fixture();
  for (const chunk of [1, 7]) {
    const { code, stdout } = await run(['--mode', 'backup'], input, { chunk });
    assert.equal(code, 0);
    for (const [id, , expectMatch] of SAMPLES) assert.ok(!stdout.includes(expectMatch), `${id} leaked at chunk=${chunk}`);
  }
});

test('a trailing line without a newline is redacted at end of input, not lost', async () => {
  const { code, stdout } = await run(['--mode', 'backup'], 'tail row 123-45-6789 no newline');
  assert.equal(code, 0);
  assert.ok(!stdout.includes('123-45-6789'));
  assert.ok(stdout.startsWith('tail row '));
});

test('an oversized line FAILS the run (exit 3) — never dropped, its PII never emitted', async () => {
  const huge = 'x'.repeat(2048) + ' my SSN is 123-45-6789 ' + 'y'.repeat(2048);
  const { code, stdout, stderr } = await run(['--mode', 'backup', '--max-line-bytes', '1024'], `ok line\n${huge}\n`);
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
