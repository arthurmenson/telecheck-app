// DB-free control-flow regression for scripts/pilot-1-marker-remediation.sh
// (psql is stubbed) plus the static seed-classification check the PII spec's
// Sprint 1.3 CI test 4 requires for the SQL seed paths. The real-Postgres
// proof lives in tests/integration/pilot-1-cohort-remediation.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'pilot-1-marker-remediation.sh');
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];
const ULID = '01JZZZ00000000000000000R01';

/**
 * Stub psql: call 1 (the state read, `-c`) prints STATE; call 2 (the
 * transaction, SQL on stdin) is recorded to `tx.sql` and exits TX_EXIT with
 * TX_STDERR. Both invocations append their argv to `calls.log`.
 */
function mkStub(dir, { state = '', txExit = 0, txStderr = '' } = {}) {
  const stub = path.join(dir, 'psql');
  const stateFile = path.join(dir, 'state.txt');
  const stderrFile = path.join(dir, 'tx.stderr');
  fs.writeFileSync(stateFile, state);
  fs.writeFileSync(stderrFile, txStderr);
  const d = dir.replace(/\\/g, '/');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${d}/calls.log"
if printf '%s\\n' "$@" | grep -q -- '^-c$'; then cat "${d}/state.txt"; exit 0; fi
cat > "${d}/tx.sql"
cat "${d}/tx.stderr" >&2
exit ${txExit}
`,
    { mode: 0o755 },
  );
  return stub;
}

function run(dir, stub, args, extraEnv = {}) {
  return spawnSync(bash, [...bashArgs, SCRIPT, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PILOT_1_DATABASE_URL: 'postgres://synthetic',
      PILOT_1_PSQL: stub,
      PILOT_1_ACTOR: 'evans@test-host',
      ...extraEnv,
    },
  });
}

const good = ['--account-id', ULID, '--classify-as', 'baseline', '--reason', 'seed fixture'];

test('remediation: usage errors exit 2 before psql is ever invoked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const stub = mkStub(dir);
  for (const args of [
    [],
    ['--account-id', 'not-a-ulid', '--classify-as', 'baseline', '--reason', 'x'],
    ['--account-id', ULID, '--classify-as', 'operator', '--reason', 'x'],
    ['--account-id', ULID, '--classify-as', 'baseline'],
    ['--account-id', ULID, '--classify-as', 'baseline', '--reason', ''],
    ['--account-id', ULID, '--classify-as', 'baseline', '--reason', 'y'.repeat(501)],
    ['--account-id', ULID, '--classify-as'],
    ['--bogus'],
  ]) {
    const r = run(dir, stub, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  const noDsn = run(dir, stub, good, { PILOT_1_DATABASE_URL: '', DATABASE_URL: '' });
  assert.equal(noDsn.status, 2);
  assert.ok(!fs.existsSync(path.join(dir, 'calls.log')), 'psql was invoked on a usage error');
});

test('remediation: unknown account and already-classified account are refused (exit 1) with no transaction', () => {
  for (const [state, expect] of [
    ['', /not found/],
    ['Telecheck-US|patient|US|baseline|', /already classified as 'baseline'/],
    ['Telecheck-US|patient|US|participant|', /already classified as 'participant'/],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
    const stub = mkStub(dir, { state });
    const r = run(dir, stub, good);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, expect);
    assert.ok(
      !fs.existsSync(path.join(dir, 'tx.sql')),
      'a transaction was started for a refused account',
    );
  }
});

test('remediation: success path binds the tenant, classifies once, and attests in the same transaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const stub = mkStub(dir, { state: 'Telecheck-Ghana|delegate|GH|unclassified\n' });
  const r = run(dir, stub, [...good, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, {
    accountId: ULID,
    tenantId: 'Telecheck-Ghana',
    accountType: 'delegate',
    classifiedAs: 'baseline',
    actor: 'evans@test-host',
    status: 'classified',
    auditAction: 'pilot_1.cohort_classification',
  });
  const sql = fs.readFileSync(path.join(dir, 'tx.sql'), 'utf8');
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /set_tenant_context\(:'tenant'\)/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /cohort_classification = 'unclassified'/);
  assert.match(sql, /'pilot_1\.cohort_classification'/);
  assert.match(sql, /INSERT INTO audit_records/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.ok(sql.indexOf('UPDATE accounts') < sql.indexOf('INSERT INTO audit_records'));
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
  assert.match(calls, /-v tenant=Telecheck-Ghana/);
  assert.match(calls, /-v cls=baseline/);
  assert.match(calls, /-v actor=evans@test-host/);
});

test('remediation: a refusal raised inside the transaction maps to exit 1; any other failure to exit 3', () => {
  const refused = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const r1 = run(
    refused,
    mkStub(refused, {
      state: 'Telecheck-US|patient|US|unclassified\n',
      txExit: 3,
      txStderr: 'ERROR:  REMEDIATION_REFUSED: account X is already classified as participant\n',
    }),
    good,
  );
  assert.equal(r1.status, 1, r1.stderr);
  assert.match(r1.stderr, /rolled back; nothing written/);
  const failed = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const r2 = run(
    failed,
    mkStub(failed, {
      state: 'Telecheck-US|patient|US|unclassified\n',
      txExit: 3,
      txStderr: 'ERROR:  new row for relation "audit_records" violates check constraint\n',
    }),
    good,
  );
  assert.equal(r2.status, 3, r2.stderr);
  assert.match(r2.stderr, /rolled back; nothing written/);
});

test('seeds: every INSERT INTO accounts in a Pilot 1 seed names cohort_classification (PII spec CI test 4, SQL paths)', () => {
  const seeds = ['pilot-1-baseline-seed.sql', 'seed-staging-accounts.sql'];
  for (const file of seeds) {
    // Comments are stripped first so prose about the states cannot mask or
    // trigger a finding — the check is about statements, not commentary.
    const sql = fs.readFileSync(path.join(here, file), 'utf8').replace(/--[^\n]*/g, '');
    const inserts = [...sql.matchAll(/INSERT\s+INTO\s+accounts\s*\(([^)]*)\)/gi)];
    assert.ok(inserts.length >= 1, `${file}: no INSERT INTO accounts found`);
    for (const m of inserts) {
      const columns = m[1].split(',').map((c) => c.trim());
      assert.ok(
        columns.includes('cohort_classification'),
        `${file}: an INSERT INTO accounts omits cohort_classification (columns: ${columns.join(', ')})`,
      );
    }
    assert.ok(!/'unclassified'/.test(sql), `${file}: a seed must never write 'unclassified'`);
  }
});
