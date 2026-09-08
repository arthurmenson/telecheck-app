import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER = path.join(here, 'backup-redacted.sh');
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];

function mkStubs(dir, { dumpExit = 0 } = {}) {
  const fixture = path.join(dir, 'fixture.sql');
  fs.writeFileSync(
    fixture,
    'COPY public.t (id, body) FROM stdin;\n1\tmy SSN is 123-45-6789\n2\tcall (415) 555-0123\n\\.\n',
  );
  const pgDump = path.join(dir, 'pg_dump');
  fs.writeFileSync(pgDump, `#!/usr/bin/env bash\ncat "${fixture.replace(/\\/g, '/')}"\nexit ${dumpExit}\n`, { mode: 0o755 });
  // Stub age: canonical header + payload, so structural checks are real
  // and the (unencrypted) payload can be inspected for leaks.
  const age = path.join(dir, 'age');
  fs.writeFileSync(age, '#!/usr/bin/env bash\nprintf "age-encryption.org/v1\\n"\ncat\n', { mode: 0o755 });
  const recipients = path.join(dir, 'recipients');
  fs.writeFileSync(recipients, 'age1synthetic\n');
  return { pgDump, age, recipients };
}

function runWrapper(dir, stubs, outDir, extraArgs = [], extraEnv = {}) {
  return spawnSync(bash, [...bashArgs, WRAPPER, outDir, ...extraArgs], {
    cwd: path.join(here, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      BACKUP_DATABASE_URL: 'postgres://synthetic',
      AGE_RECIPIENTS_FILE: stubs.recipients,
      PG_DUMP_BIN: stubs.pgDump,
      AGE_BIN: stubs.age,
      ...extraEnv,
    },
  });
}

test('wrapper: dump -> scrub -> age; artifact has the age header, manifest is written, no PII in the payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-'));
  const stubs = mkStubs(dir);
  const outDir = path.join(dir, 'out');
  const r = runWrapper(dir, stubs, outDir);
  assert.equal(r.status, 0, r.stderr);
  const files = fs.readdirSync(outDir);
  const artifact = files.find((f) => f.endsWith('-db.sql.age'));
  const manifest = files.find((f) => f.endsWith('-db.manifest.json'));
  assert.ok(artifact && manifest, files.join(','));
  const bytes = fs.readFileSync(path.join(outDir, artifact), 'utf8');
  assert.ok(bytes.startsWith('age-encryption.org/v1'));
  assert.ok(!bytes.includes('123-45-6789'));
  assert.ok(!bytes.includes('(415) 555-0123'));
  assert.ok(bytes.includes('[REDACTED:'));
  const m = JSON.parse(fs.readFileSync(path.join(outDir, manifest), 'utf8'));
  assert.equal(m.artifact, artifact);
  assert.ok(m.ciphertextBytes >= m.plaintextBytes && m.plaintextBytes > 0);
  assert.equal(m.redaction, 'layer5-dump-aware-whole-library');
});

test('wrapper: a failing pg_dump stage leaves no artifact and exits non-zero', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-'));
  const stubs = mkStubs(dir, { dumpExit: 1 });
  const outDir = path.join(dir, 'out');
  const r = runWrapper(dir, stubs, outDir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stage 0 failed/);
  assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
});

test('wrapper: refuses without a readable recipients file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-'));
  const stubs = mkStubs(dir);
  stubs.recipients = path.join(dir, 'missing');
  const r = runWrapper(dir, stubs, path.join(dir, 'out'));
  assert.equal(r.status, 2);
});

test('wrapper: pg_dump options that bypass the pipe are refused before execution', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-'));
  const stubs = mkStubs(dir);
  for (const args of [['--file=/tmp/raw.sql'], ['-f', '/tmp/raw.sql'], ['-Fc'], ['--format=custom'], ['-Z', '9'], ['--jobs=4'], ['-E', 'LATIN1']]) {
    const outDir = path.join(dir, 'out-' + args.join('').replace(/[^a-z0-9]/gi, ''));
    const r = runWrapper(dir, stubs, outDir, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /refusing/);
    assert.ok(!fs.existsSync(outDir));
  }
});

test('wrapper: an empty dump is refused and nothing is published', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-'));
  const stubs = mkStubs(dir);
  fs.writeFileSync(path.join(dir, 'fixture.sql'), '');
  const outDir = path.join(dir, 'out');
  const r = runWrapper(dir, stubs, outDir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty dump/);
  assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0);
});

test('wrapper: a failure after the artifact is published removes this run\'s files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-'));
  const stubs = mkStubs(dir);
  const outDir = path.join(dir, 'out');
  const r = runWrapper(dir, stubs, outDir, [], { BACKUP_REDACTED_FAIL_AFTER_PUBLISH: '1' });
  assert.equal(r.status, 7);
  assert.ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, 'published artifact must be withdrawn');
});

test('wrapper: forces plain UTF-8 format on the pg_dump stage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l5-'));
  const stubs = mkStubs(dir);
  const argLog = path.join(dir, 'pg_dump.args');
  fs.writeFileSync(stubs.pgDump, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argLog.replace(/\\/g, '/')}"\ncat "${path.join(dir, 'fixture.sql').replace(/\\/g, '/')}"\n`, { mode: 0o755 });
  const r = runWrapper(dir, stubs, path.join(dir, 'out'));
  assert.equal(r.status, 0, r.stderr);
  const args = fs.readFileSync(argLog, 'utf8').split('\n');
  assert.ok(args.includes('--format=plain'));
  assert.ok(args.includes('--encoding=UTF8'));
});

