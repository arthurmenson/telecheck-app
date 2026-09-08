// DB-free control-flow regression for scripts/pilot-1-marker-remediation.sh
// (psql is stubbed) plus the static seed-classification check the PII spec's
// Sprint 1.3 CI test 4 requires for the SQL seed paths. The real-Postgres
// proof lives in tests/integration/pilot-1-cohort-remediation.test.ts — the
// stub bypasses SQL parsing, so anything about what PostgreSQL does with the
// SQL is proven there, not here (Codex R1).
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
 * Stub psql. Both calls receive SQL on stdin. The state lookup is the
 * unaligned/tuples-only call (`-A -t`): its SQL is recorded to `lookup.sql`
 * and STATE is printed. The transaction call (`-q`) is recorded to `tx.sql`
 * and exits TX_EXIT with TX_STDERR. Every invocation appends its argv to
 * `calls.log`.
 */
function mkStub(dir, { state = '', txExit = 0, txStderr = '' } = {}) {
  const stub = path.join(dir, 'psql');
  fs.writeFileSync(path.join(dir, 'state.txt'), state);
  fs.writeFileSync(path.join(dir, 'tx.stderr'), txStderr);
  const d = dir.replace(/\\/g, '/');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${d}/calls.log"
if printf '%s\\n' "$@" | grep -q -- '^-t$'; then cat > "${d}/lookup.sql"; cat "${d}/state.txt"; exit 0; fi
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
      PILOT_1_ACTOR_TENANT: 'Telecheck-US',
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
    ['--account-id', '01JZZZ00000000000000PILOT1', '--classify-as', 'baseline', '--reason', 'x'],
    ['--account-id', ULID, '--classify-as', 'operator', '--reason', 'x'],
    ['--account-id', ULID, '--classify-as', 'baseline'],
    ['--account-id', ULID, '--classify-as', 'baseline', '--reason', ''],
    ['--account-id', ULID, '--classify-as', 'baseline', '--reason', 'y'.repeat(501)],
    ['--account-id', ULID, '--classify-as'],
    [...good, '--actor', 'bad "quote"'],
    [...good, '--actor', 'back\\slash'],
    [...good, '--actor-tenant', 'Telecheck US'],
    ['--bogus'],
  ]) {
    const r = run(dir, stub, args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  const noDsn = run(dir, stub, good, { PILOT_1_DATABASE_URL: '', DATABASE_URL: '' });
  assert.equal(noDsn.status, 2);
  const noActorTenant = run(dir, stub, good, { PILOT_1_ACTOR_TENANT: '' });
  assert.equal(noActorTenant.status, 2);
  assert.match(noActorTenant.stderr, /home tenant is required/);
  assert.ok(!fs.existsSync(path.join(dir, 'calls.log')), 'psql was invoked on a usage error');
});

test('remediation: the state lookup goes through stdin with psql variables, never -c', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const stub = mkStub(dir, { state: 't|Telecheck-US|patient|US|unclassified\n' });
  const r = run(dir, stub, good);
  assert.equal(r.status, 0, r.stderr);
  const lookup = fs.readFileSync(path.join(dir, 'lookup.sql'), 'utf8');
  assert.match(lookup, /:'aid'/);
  assert.match(lookup, /:'actor_tenant'/);
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n');
  assert.ok(
    !calls.some((c) => /(^| )-c( |$)/.test(c)),
    'a -c command was used (no variable interpolation)',
  );
  assert.match(calls[0], /-v aid=01JZZZ00000000000000000R01/);
});

test('remediation: unknown actor tenant exits 2; unknown / already-classified accounts are refused (exit 1) with no transaction', () => {
  const badTenant = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const rt = run(
    badTenant,
    mkStub(badTenant, { state: 'f|Telecheck-US|patient|US|unclassified\n' }),
    good,
  );
  assert.equal(rt.status, 2, rt.stderr);
  assert.match(rt.stderr, /actor tenant 'Telecheck-US' does not exist/);
  assert.ok(!fs.existsSync(path.join(badTenant, 'tx.sql')));
  for (const [state, expect] of [
    ['t|\n', /not found/],
    ['t|Telecheck-US|patient|US|baseline\n', /already classified as 'baseline'/],
    ['t|Telecheck-US|patient|US|participant\n', /already classified as 'participant'/],
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

test('remediation: success path binds the TARGET tenant, records the ACTOR tenant, classifies once, attests in the same transaction, prints only JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const stub = mkStub(dir, { state: 't|Telecheck-Ghana|delegate|GH|unclassified\n' });
  const r = run(dir, stub, [...good, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'stdout must be exactly one JSON line');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, {
    accountId: ULID,
    tenantId: 'Telecheck-Ghana',
    accountType: 'delegate',
    classifiedAs: 'baseline',
    actor: 'evans@test-host',
    actorTenantId: 'Telecheck-US',
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
  assert.match(sql, /v_actor_tenant/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.ok(sql.indexOf('UPDATE accounts') < sql.indexOf('INSERT INTO audit_records'));
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
  assert.match(calls, /-v tenant=Telecheck-Ghana/);
  assert.match(calls, /-v actor_tenant=Telecheck-US/);
  assert.match(calls, /-v cls=baseline/);
  assert.match(calls, /-v actor=evans@test-host/);
});

test('remediation: a refusal raised inside the transaction maps to exit 1; any other failure to exit 3', () => {
  const refused = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const r1 = run(
    refused,
    mkStub(refused, {
      state: 't|Telecheck-US|patient|US|unclassified\n',
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
      state: 't|Telecheck-US|patient|US|unclassified\n',
      txExit: 3,
      txStderr: 'ERROR:  new row for relation "audit_records" violates check constraint\n',
    }),
    good,
  );
  assert.equal(r2.status, 3, r2.stderr);
  assert.match(r2.stderr, /rolled back; nothing written/);
});

/**
 * Static seed check — SQL-aware enough for the seed files' shape: strips
 * line AND block comments, accepts `INSERT INTO [public.]accounts`, locates
 * the cohort_classification column, and checks the VALUE in every tuple
 * (so `DEFAULT` — which migration 080 resolves to 'unclassified' — is a
 * failure, not a pass). The real seeds are also executed against
 * PostgreSQL in the integration test.
 */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, '');
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quote = false;
  let cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === "'") {
        if (text[i + 1] === "'") {
          cur += "'";
          i++;
        } else quote = false;
      }
      continue;
    }
    if (ch === "'") {
      quote = true;
      cur += ch;
    } else if (ch === '(') {
      depth++;
      cur += ch;
    } else if (ch === ')') {
      depth--;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export function seedAccountInserts(sql) {
  const clean = stripSqlComments(sql);
  const re =
    /INSERT\s+INTO\s+(?:public\.)?accounts\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*?)(?:ON\s+CONFLICT|;)/gi;
  const found = [];
  for (const m of clean.matchAll(re)) {
    const columns = m[1].split(',').map((c) => c.trim().toLowerCase());
    const tuples = [];
    let depth = 0;
    let start = -1;
    let quote = false;
    const body = m[2];
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (quote) {
        if (ch === "'" && body[i + 1] !== "'") quote = false;
        else if (ch === "'") i++;
        continue;
      }
      if (ch === "'") quote = true;
      else if (ch === '(') {
        if (depth === 0) start = i + 1;
        depth++;
      } else if (ch === ')') {
        depth--;
        if (depth === 0 && start >= 0) {
          tuples.push(splitTopLevel(body.slice(start, i)));
          start = -1;
        }
      }
    }
    found.push({ columns, tuples });
  }
  return found;
}

test('seeds: every INSERT INTO accounts in a Pilot 1 seed names cohort_classification and every tuple writes baseline (PII spec CI test 4, SQL paths)', () => {
  for (const file of ['pilot-1-baseline-seed.sql', 'seed-staging-accounts.sql']) {
    const sql = fs.readFileSync(path.join(here, file), 'utf8');
    const inserts = seedAccountInserts(sql);
    assert.ok(inserts.length >= 1, `${file}: no INSERT INTO accounts found`);
    for (const { columns, tuples } of inserts) {
      const idx = columns.indexOf('cohort_classification');
      assert.ok(
        idx >= 0,
        `${file}: an INSERT INTO accounts omits cohort_classification (columns: ${columns.join(', ')})`,
      );
      assert.ok(tuples.length >= 1, `${file}: no VALUES tuples parsed`);
      for (const tuple of tuples) {
        assert.equal(
          tuple.length,
          columns.length,
          `${file}: tuple arity ${tuple.length} != ${columns.length} columns`,
        );
        assert.equal(
          tuple[idx],
          "'baseline'",
          `${file}: a seed tuple writes ${tuple[idx]} for cohort_classification`,
        );
      }
    }
  }
});

test('seeds: the static check rejects DEFAULT, missing column, unclassified, qualified-table and commented-out variants', () => {
  const base = fs.readFileSync(path.join(here, 'seed-staging-accounts.sql'), 'utf8');
  const check = (sql) => {
    const inserts = seedAccountInserts(sql);
    if (inserts.length < 1) return false;
    for (const { columns, tuples } of inserts) {
      const idx = columns.indexOf('cohort_classification');
      if (idx < 0) return false;
      for (const t of tuples) if (t[idx] !== "'baseline'") return false;
    }
    return true;
  };
  assert.equal(check(base), true);
  assert.equal(
    check(base.replace(/NOW\(\), 'baseline'/, 'NOW(), DEFAULT')),
    false,
    'DEFAULT slipped through',
  );
  assert.equal(
    check(base.replace(/NOW\(\), 'baseline'/, "NOW(), 'unclassified'")),
    false,
    "'unclassified' slipped through",
  );
  assert.equal(
    check(
      base.replace(/, cohort_classification\n\) VALUES/, '\n) VALUES').replace(/, 'baseline'/g, ''),
    ),
    false,
    'omitted column slipped through',
  );
  assert.equal(
    check(base.replace(/INSERT INTO accounts/, 'INSERT INTO public.accounts')),
    true,
    'qualified table not recognised',
  );
  assert.equal(
    check(
      base
        .replace(/INSERT INTO accounts/, 'INSERT INTO public.accounts')
        .replace(/NOW\(\), 'baseline'/, 'NOW(), DEFAULT'),
    ),
    false,
  );
  const commented =
    `/* INSERT INTO accounts (account_id, cohort_classification) VALUES ('x', 'baseline'); */\n` +
    base.replace(/NOW\(\), 'baseline'/, 'NOW(), DEFAULT');
  assert.equal(check(commented), false, 'a block-commented INSERT masked a real defect');
});
