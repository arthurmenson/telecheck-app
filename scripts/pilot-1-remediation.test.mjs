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
const asParticipant = ['--account-id', ULID, '--classify-as', 'participant', '--reason', 'pilot'];

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

test('remediation: the DSN is passed as --dbname and a leading-option DSN never reaches psql', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const stub = mkStub(dir, { state: 't|t|Telecheck-US|patient|US|unclassified|active\n' });
  const injected = run(dir, stub, good, {
    PILOT_1_DATABASE_URL: "--command=UPDATE accounts SET cohort_classification='baseline'",
  });
  assert.equal(injected.status, 2, injected.stderr);
  assert.match(injected.stderr, /must not begin with '-'/);
  assert.ok(
    !fs.existsSync(path.join(dir, 'calls.log')),
    'psql was invoked with an option-shaped DSN',
  );
  const ok = run(dir, stub, good);
  assert.equal(ok.status, 0, ok.stderr);
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  assert.equal(calls.length, 2);
  for (const c of calls) assert.match(c, /(^| )--dbname=postgres:\/\/synthetic( |$)/);
});

test('remediation: the state lookup goes through stdin with psql variables, never -c', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const stub = mkStub(dir, { state: 't|t|Telecheck-US|patient|US|unclassified|active\n' });
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

test('remediation: unknown actor tenant exits 2; unknown / already-classified / staff-as-participant are refused (exit 1) with no transaction', () => {
  const badTenant = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const rt = run(
    badTenant,
    mkStub(badTenant, { state: 'f|t|Telecheck-US|patient|US|unclassified|active\n' }),
    good,
  );
  assert.equal(rt.status, 2, rt.stderr);
  assert.match(rt.stderr, /actor tenant 'Telecheck-US' does not exist/);
  assert.ok(!fs.existsSync(path.join(badTenant, 'tx.sql')));
  for (const [state, args, expect] of [
    ['t|t|\n', good, /not found/],
    ['t|t|Telecheck-US|patient|US|baseline|active\n', good, /already classified as 'baseline'/],
    [
      't|t|Telecheck-US|patient|US|participant|active\n',
      good,
      /already classified as 'participant'/,
    ],
    [
      't|t|Telecheck-US|clinician|US|unclassified|active\n',
      asParticipant,
      /only patient\/delegate accounts can be classified as 'participant'/,
    ],
    [
      't|t|Telecheck-US|tenant_admin|US|unclassified|active\n',
      asParticipant,
      /only patient\/delegate/,
    ],
    [
      't|t|Telecheck-US|platform_admin|US|unclassified|active\n',
      asParticipant,
      /only patient\/delegate/,
    ],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
    const stub = mkStub(dir, { state });
    const r = run(dir, stub, args);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, expect);
    assert.ok(
      !fs.existsSync(path.join(dir, 'tx.sql')),
      'a transaction was started for a refused account',
    );
  }
  // Staff CAN be classified baseline; a delegate CAN be a participant.
  for (const [state, args] of [
    ['t|t|Telecheck-US|clinician|US|unclassified|active\n', good],
    ['t|t|Telecheck-Ghana|delegate|GH|unclassified|active\n', asParticipant],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
    const r = run(dir, mkStub(dir, { state }), args);
    assert.equal(r.status, 0, r.stderr);
  }
});

test('remediation: success path binds the TARGET tenant, records the ACTOR tenant, classifies once, attests in the same transaction, prints only JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const stub = mkStub(dir, { state: 't|t|Telecheck-Ghana|delegate|GH|unclassified|active\n' });
  const r = run(dir, stub, [...good, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'stdout must be exactly one JSON line');
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out, {
    accountId: ULID,
    tenantId: 'Telecheck-Ghana',
    tenantStatus: 'active',
    accountType: 'delegate',
    classifiedAs: 'baseline',
    actor: 'evans@test-host',
    actorTenantId: 'Telecheck-US',
    status: 'classified',
    auditAction: 'pilot_1.cohort_classification',
  });
  const sql = fs.readFileSync(path.join(dir, 'tx.sql'), 'utf8');
  const calls = fs.readFileSync(path.join(dir, 'calls.log'), 'utf8');
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /set_tenant_context\(:'tenant'\)/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /cohort_classification = 'unclassified'/);
  assert.match(sql, /NOT IN \('patient', 'delegate'\)/);
  assert.match(sql, /'pilot_1\.cohort_classification'/);
  assert.match(sql, /INSERT INTO audit_records/);
  assert.match(sql, /v_actor_tenant/);
  assert.match(sql, /CASE WHEN :'bind_context' = 't' THEN set_tenant_context\(:'tenant'\) END/);
  assert.match(calls, /-v bind_context=t/);
  assert.match(calls, /-v tenant_status=active/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.ok(sql.indexOf('UPDATE accounts') < sql.indexOf('INSERT INTO audit_records'));
  assert.match(calls, /-v tenant=Telecheck-Ghana/);
  assert.match(calls, /-v actor_tenant=Telecheck-US/);
  assert.match(calls, /-v cls=baseline/);
  assert.match(calls, /-v actor=evans@test-host/);
});

test('remediation: an inactive tenant is remediated without binding context when the role bypasses RLS, and refused otherwise', () => {
  for (const status of ['suspended', 'archived']) {
    const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
    const r = run(
      ok,
      mkStub(ok, { state: `t|t|Telecheck-Ghana|patient|GH|unclassified|${status}\n` }),
      [...good, '--json'],
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).tenantStatus, status);
    const calls = fs.readFileSync(path.join(ok, 'calls.log'), 'utf8');
    assert.match(calls, /-v bind_context=f/);
    assert.match(calls, new RegExp(`-v tenant_status=${status}`));
    const noBypass = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
    const refused = run(
      noBypass,
      mkStub(noBypass, { state: `t|f|Telecheck-Ghana|patient|GH|unclassified|${status}\n` }),
      good,
    );
    assert.equal(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /BYPASSRLS/);
    assert.ok(
      !fs.existsSync(path.join(noBypass, 'tx.sql')),
      'a transaction was started without RLS bypass',
    );
  }
});

test('remediation: a refusal raised inside the transaction maps to exit 1; any other failure to exit 3', () => {
  const refused = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const r1 = run(
    refused,
    mkStub(refused, {
      state: 't|t|Telecheck-US|patient|US|unclassified|active\n',
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
      state: 't|t|Telecheck-US|patient|US|unclassified|active\n',
      txExit: 3,
      txStderr: 'ERROR:  new row for relation "audit_records" violates check constraint\n',
    }),
    good,
  );
  assert.equal(r2.status, 3, r2.stderr);
  assert.match(r2.stderr, /rolled back; nothing written/);
});

// ---------------------------------------------------------------------------
// Static seed check — a small SQL tokenizer (line + nested block comments,
// single-quoted literals with '' escapes, dollar quotes, double-quoted
// identifiers) splits the file into COMPLETE statements before any account
// insert is inspected, so a `;` inside a literal cannot end a statement early
// (Codex R2). Every statement that touches `accounts` must be a recognised
// INSERT of the exact seed shape whose every tuple writes 'baseline';
// anything else (UPDATE, COPY, an unrecognised INSERT) fails the check. The
// real seeds are also executed against PostgreSQL in the integration test,
// which verifies every row they actually create.
// ---------------------------------------------------------------------------

export function splitSqlStatements(sql) {
  // PostgreSQL ends a line comment at CR as well as LF; a CR could therefore
  // hide executable SQL inside what this scanner sees as a comment. Seeds
  // are LF-only, so the character is rejected outright (Codex R8).
  if (sql.includes('\r')) throw new Error('carriage returns are not supported in a seed');
  const statements = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      continue;
    }
    if (ch === '\\' && cur.trim() === '') {
      // psql meta-command: the ONLY one a seed may contain is the exact
      // `\set ON_ERROR_STOP on` line. psql resumes SQL after `\\` on the
      // same line and `\i` includes arbitrary files, so anything else is
      // rejected rather than skipped (Codex R6).
      let j = i;
      while (j < sql.length && sql[j] !== '\n') j++;
      const line = sql.slice(i, j).trim();
      if (line !== '\\set ON_ERROR_STOP on') {
        throw new Error(`unsupported psql meta-command in a seed: ${line.slice(0, 60)}`);
      }
      statements.push(line);
      i = j;
      continue;
    }
    if (ch === '\\') throw new Error('backslash outside a literal is not supported in a seed');
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) throw new Error('unterminated block comment');
      cur += ' ';
      continue;
    }
    if (ch === "'") {
      const prev = sql[i - 1];
      const prevPrev = sql[i - 2];
      if (
        prev === '&' ||
        (prev !== undefined &&
          /[EeBbXxNn]/.test(prev) &&
          (prevPrev === undefined || !/[A-Za-z0-9_]/.test(prevPrev)))
      ) {
        throw new Error('escape-string / unicode / bit-string literals are not supported in seeds');
      }
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error('unterminated string literal');
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const m = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (!m) {
        // Only ASCII-tagged dollar quotes are modelled; anything else
        // (a non-ASCII tag PostgreSQL would accept) fails closed.
        throw new Error('unsupported dollar-quote tag in a seed');
      }
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end < 0) throw new Error('unterminated dollar quote');
        cur += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }
    if (ch === '"') {
      // A quoted identifier can name a callable ("set_config") that the
      // allowlists would never see; seeds have no need for them (Codex R6).
      throw new Error('quoted identifiers are not supported in a seed');
    }
    if (ch === ';') {
      if (cur.trim()) statements.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim()) statements.push(cur.trim());
  return statements;
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

/**
 * A DO block in a seed is a GUARD: it may read and RAISE, nothing else. The
 * dollar-quoted body is stripped of comments, string literals and quoted
 * identifiers, then rejected if it contains any mutation / execution keyword
 * in ANY spelling, or any function call outside a small read-only allowlist
 * (so `PERFORM classify(...)`, `EXECUTE '...'`, `SELECT fn(...)` all fail).
 */
const DO_FORBIDDEN =
  /\b(UPDATE|INSERT|DELETE|TRUNCATE|MERGE|PERFORM|EXECUTE|CALL|CREATE|ALTER|DROP|GRANT|REVOKE|COPY|LOCK|SET|IMPORT|REFRESH|CLUSTER|VACUUM|ANALYZE|REINDEX)\b/;
const DO_ALLOWED_BEFORE_PAREN = new Set([
  // read-only functions used by the guards
  'COUNT',
  'STRING_AGG',
  'ARRAY_AGG',
  'COALESCE',
  'NULLIF',
  'LENGTH',
  'LOWER',
  'UPPER',
  'BTRIM',
  'NOW',
  // keywords that precede a parenthesis
  'IN',
  'NOT',
  'EXISTS',
  'AND',
  'OR',
  'IF',
  'ELSIF',
  'WHEN',
  'WHILE',
  'THEN',
  'WHERE',
  'ON',
  'SELECT',
  'FROM',
  'VALUES',
  'RETURN',
]);

/** Removes comments (nested block + line), string literals and quoted identifiers, in encounter order. */
export function stripSqlNoise(text) {
  if (text.includes('\r')) throw new Error('carriage returns are not supported in a seed');
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      out += ' ';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (text.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      out += ' ';
      continue;
    }
    if (ch === "'") {
      const prev = text[i - 1];
      const prevPrev = text[i - 2];
      if (
        prev === '&' ||
        (prev !== undefined &&
          /[EeBbXxNn]/.test(prev) &&
          (prevPrev === undefined || !/[A-Za-z0-9_]/.test(prevPrev)))
      ) {
        throw new Error('escape-string / unicode / bit-string literals are not supported in seeds');
      }
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new Error('unterminated string literal in DO body');
        if (text[j] === "'") {
          if (text[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += " '' ";
      i = j + 1;
      continue;
    }
    if (ch === '"') throw new Error('quoted identifiers are not supported in a seed');
    if (ch === '$') {
      // A nested dollar-quoted literal — with ANY tag, ASCII or not — would
      // let its apostrophes hide executable SQL from the scanner (Codex R7 /
      // R8); guards never need a dollar sign at all.
      throw new Error('a dollar sign inside a DO body is not supported in a seed');
    }
    out += ch;
    i++;
  }
  return out;
}

export function assertReadOnlyDoBody(stmt) {
  const m = stmt.match(/^DO\s+(\$[A-Za-z_0-9]*\$)([\s\S]*)\1\s*(?:LANGUAGE\s+plpgsql)?$/i);
  if (!m) throw new Error(`unrecognised DO form: ${stmt.slice(0, 80)}`);
  // One pass, in encounter order: a literal containing `--` (the staging
  // guard's remediation hint) must not be mistaken for a comment, and a
  // comment containing a quote must not open a literal.
  const upper = stripSqlNoise(m[2]).toUpperCase();
  const forbidden = upper.match(DO_FORBIDDEN);
  if (forbidden) throw new Error(`DO body is not read-only: ${forbidden[1]}`);
  for (const call of upper.matchAll(/\b([A-Z_][A-Z0-9_]*)\s*\(/g)) {
    if (!DO_ALLOWED_BEFORE_PAREN.has(call[1])) {
      throw new Error(`DO body calls a function outside the read-only allowlist: ${call[1]}`);
    }
  }
}

const SEED_INSERT = /^INSERT\s+INTO\s+(?:public\.)?([a-z_]+)\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/i;
/** Tables a seed may insert into; every other INSERT fails the check. */
const SEED_TABLES = new Set(['accounts', 'forms_template']);
/** A VALUES cell may only be a plain literal, DATE literal, NOW(), number, NULL or boolean — never a call. */
const ALLOWED_VALUE =
  /^(?:'(?:[^']|'')*'|DATE\s+'[^']*'|NOW\(\)|-?\d+(?:\.\d+)?|NULL|TRUE|FALSE)$/i;
const DO_NOTHING_SUFFIX = /^ON\s+CONFLICT\s*\(\s*[a-z_]+\s*\)\s*DO\s+NOTHING$/i;

/**
 * Consumes the complete VALUES expression: `( ... )` tuples separated by
 * commas, then either nothing or exactly the supported DO NOTHING suffix.
 * Any other remainder — `ON CONFLICT ... DO UPDATE`, a named constraint,
 * trailing SQL — is a failure, never absorbed (Codex R5).
 */
function parseValuesStrict(body) {
  const tuples = [];
  let i = 0;
  const skipWs = () => {
    while (i < body.length && /\s/.test(body[i])) i++;
  };
  for (;;) {
    skipWs();
    if (body[i] !== '(') throw new Error(`expected a VALUES tuple at: ${body.slice(i, i + 40)}`);
    let depth = 0;
    let quote = false;
    const start = i + 1;
    let end = -1;
    for (let j = i; j < body.length; j++) {
      const ch = body[j];
      if (quote) {
        if (ch === "'") {
          if (body[j + 1] === "'") j++;
          else quote = false;
        }
        continue;
      }
      if (ch === "'") quote = true;
      else if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end < 0) throw new Error('unbalanced VALUES tuple');
    tuples.push(splitTopLevel(body.slice(start, end)));
    i = end + 1;
    skipWs();
    if (body[i] === ',') {
      i++;
      continue;
    }
    break;
  }
  const remainder = body.slice(i).trim();
  if (remainder !== '' && !DO_NOTHING_SUFFIX.test(remainder)) {
    throw new Error(`unsupported clause after VALUES: ${remainder.slice(0, 60)}`);
  }
  return tuples;
}

/**
 * Returns the parsed account inserts of a seed. Throws on any statement that
 * touches `accounts` without being a recognised seed INSERT.
 */
export function seedAccountInserts(sql) {
  const found = [];
  for (const stmt of splitSqlStatements(sql)) {
    if (stmt.startsWith('\\') || /^(BEGIN|COMMIT)\b/i.test(stmt)) continue;
    if (/^SELECT\b/i.test(stmt)) {
      // Only the two context helpers are recognised; any other SELECT that
      // names accounts (a function call could mutate) fails the check.
      if (/^SELECT\s+(set_tenant_context\('[A-Za-z-]+'\)|clear_tenant_context\(\))$/i.test(stmt))
        continue;
      throw new Error(`unrecognised SELECT touching accounts: ${stmt.slice(0, 80)}`);
    }
    if (/^DO\b/i.test(stmt)) {
      // Fail closed: a DO body may only contain the verified read-only guard
      // forms (Codex R3 / R4 — regex spellings of "UPDATE accounts" are not a
      // gate; comments, ONLY, quoted identifiers, EXECUTE and function calls
      // all evade them).
      assertReadOnlyDoBody(stmt);
      continue;
    }
    if (!/^INSERT\b/i.test(stmt)) {
      throw new Error(`unrecognised statement in a seed: ${stmt.slice(0, 80)}`);
    }
    // Every INSERT — not only the accounts one — must match the strict seed
    // shape: an allowlisted table, a column list, tuples of matching arity,
    // literal-only VALUES cells and at most the exact DO NOTHING suffix
    // (Codex R7: an unchecked forms_template INSERT could carry
    // set_config(...) in a TEXT column).
    const m = stmt.match(SEED_INSERT);
    if (!m) throw new Error(`unrecognised INSERT in a seed: ${stmt.slice(0, 80)}`);
    const table = m[1].toLowerCase();
    if (!SEED_TABLES.has(table)) {
      throw new Error(`INSERT into a table a seed may not touch: ${table}`);
    }
    const columns = m[2].split(',').map((c) => c.trim().toLowerCase());
    const tuples = parseValuesStrict(m[3]);
    if (tuples.length === 0) throw new Error(`${table} INSERT without VALUES tuples`);
    for (const tuple of tuples) {
      if (tuple.length !== columns.length) {
        throw new Error(`${table}: tuple arity ${tuple.length} != ${columns.length} columns`);
      }
      for (const cell of tuple) {
        if (!ALLOWED_VALUE.test(cell)) {
          throw new Error(
            `unsupported VALUES expression in a ${table} INSERT: ${cell.slice(0, 40)}`,
          );
        }
      }
    }
    if (table === 'accounts') found.push({ columns, tuples });
  }
  return found;
}

/** True only if every account insert names the column and every tuple writes 'baseline'. */
export function seedWritesOnlyBaseline(sql) {
  let inserts;
  try {
    inserts = seedAccountInserts(sql);
  } catch {
    return false;
  }
  if (inserts.length < 1) return false;
  for (const { columns, tuples } of inserts) {
    const idx = columns.indexOf('cohort_classification');
    if (idx < 0) return false;
    for (const t of tuples) {
      if (t.length !== columns.length) return false;
      if (t[idx] !== "'baseline'") return false;
    }
  }
  return true;
}

test('seeds: every accounts INSERT in a Pilot 1 seed names cohort_classification and every tuple writes baseline (PII spec CI test 4, SQL paths)', () => {
  for (const file of ['pilot-1-baseline-seed.sql', 'seed-staging-accounts.sql']) {
    const sql = fs.readFileSync(path.join(here, file), 'utf8');
    const inserts = seedAccountInserts(sql);
    assert.ok(inserts.length >= 1, `${file}: no INSERT INTO accounts found`);
    assert.equal(
      seedWritesOnlyBaseline(sql),
      true,
      `${file}: a seed tuple does not write 'baseline'`,
    );
  }
});

test('seeds: the static check rejects DEFAULT, unclassified, missing column, a sixth tuple hidden behind a `;` in a literal, UPDATEs, and commented-out inserts', () => {
  const base = fs.readFileSync(path.join(here, 'seed-staging-accounts.sql'), 'utf8');
  const tuple = /NOW\(\), 'baseline'/;
  assert.equal(seedWritesOnlyBaseline(base), true);
  assert.equal(
    seedWritesOnlyBaseline(base.replace(tuple, 'NOW(), DEFAULT')),
    false,
    'DEFAULT slipped through',
  );
  assert.equal(
    seedWritesOnlyBaseline(base.replace(tuple, "NOW(), 'unclassified'")),
    false,
    "'unclassified' slipped through",
  );
  assert.equal(
    seedWritesOnlyBaseline(
      base.replace(/, cohort_classification\n\) VALUES/, '\n) VALUES').replace(/, 'baseline'/g, ''),
    ),
    false,
    'omitted column slipped through',
  );
  assert.equal(
    seedWritesOnlyBaseline(base.replace(/INSERT INTO accounts/, 'INSERT INTO public.accounts')),
    true,
    'qualified table not recognised',
  );
  // Codex R2 reproduction: a sixth tuple whose first_name contains `;` and
  // whose classification is DEFAULT, appended after the fifth tuple.
  const extra = base.replace(
    /'clinician', 'active', NOW\(\), 'baseline'\n\s*\)\nON CONFLICT/,
    "'clinician', 'active', NOW(), 'baseline'\n    ),\n    ('01JZZZ00000000000000000X06', 'Telecheck-US', '+15550100009', 'x@example.invalid', 'Extra; Fixture', 'Six', DATE '1990-01-01', 'prefer_not_to_say', 'US', 'US', 'en-US', 'patient', 'active', NOW(), DEFAULT)\nON CONFLICT",
  );
  assert.notEqual(extra, base, 'the extra-tuple mutation did not apply');
  assert.equal(
    seedWritesOnlyBaseline(extra),
    false,
    'a tuple hidden behind a ; in a literal slipped through',
  );
  const update =
    base + "\nUPDATE accounts SET cohort_classification = 'baseline' WHERE account_id = 'x';\n";
  assert.equal(seedWritesOnlyBaseline(update), false, 'an UPDATE of accounts slipped through');
  const commented =
    `/* INSERT INTO accounts (account_id, cohort_classification) VALUES ('x', 'baseline'); */\n` +
    base.replace(tuple, 'NOW(), DEFAULT');
  assert.equal(
    seedWritesOnlyBaseline(commented),
    false,
    'a block-commented INSERT masked a real defect',
  );
  // Codex R3 reproduction: an unaudited post-insert classification hidden
  // in a DO block (the checker used to skip every DO statement).
  const doUpdate =
    base +
    "\nDO $$ BEGIN UPDATE accounts SET cohort_classification = 'baseline' WHERE cohort_classification = 'unclassified'; END $$;\n";
  assert.equal(
    seedWritesOnlyBaseline(doUpdate),
    false,
    'an UPDATE inside a DO block slipped through',
  );
  const doDelete =
    base + "\nDO $$ BEGIN DELETE FROM public.accounts WHERE account_type = 'patient'; END $$;\n";
  assert.equal(
    seedWritesOnlyBaseline(doDelete),
    false,
    'a DELETE inside a DO block slipped through',
  );
  const fnSelect = base + "\nSELECT pilot_1_classify_account('x', 'baseline', 'seed');\n";
  assert.equal(seedWritesOnlyBaseline(fnSelect), false, 'an unrecognised SELECT slipped through');
  // Codex R4 reproductions: spellings that evade a keyword regex.
  for (const [name, mutation] of [
    [
      'comment-split UPDATE',
      "DO $$ BEGIN UPDATE /* fixtures */ accounts SET cohort_classification='baseline' WHERE cohort_classification='unclassified'; END $$;",
    ],
    [
      'UPDATE ONLY',
      "DO $$ BEGIN UPDATE ONLY accounts SET cohort_classification='baseline'; END $$;",
    ],
    [
      'quoted identifier',
      'DO $$ BEGIN UPDATE "accounts" SET cohort_classification=\'baseline\'; END $$;',
    ],
    ['TRUNCATE TABLE', 'DO $$ BEGIN TRUNCATE TABLE accounts; END $$;'],
    [
      'PERFORM function',
      "DO $$ BEGIN PERFORM pilot_1_classify_account('x', 'baseline', 'seed'); END $$;",
    ],
    [
      'EXECUTE literal',
      "DO $$ BEGIN EXECUTE 'UPDATE accounts SET cohort_classification = ''baseline'''; END $$;",
    ],
    [
      'SELECT function inside DO',
      'DO $$ DECLARE r INTEGER; BEGIN SELECT classify_all() INTO r; END $$;',
    ],
    [
      'nested comment hiding a keyword',
      "DO $$ BEGIN /* a /* b */ UPDATE accounts SET cohort_classification='baseline'; */ END $$; DO $$ BEGIN UPDATE accounts SET cohort_classification='baseline'; END $$;",
    ],
    ['top-level CALL', 'CALL classify_everything();'],
    ['top-level UPDATE ONLY', "UPDATE ONLY accounts SET cohort_classification = 'baseline';"],
    [
      'INSERT into a quoted table with DEFAULT',
      'INSERT INTO "accounts" (account_id, cohort_classification) VALUES (\'x\', DEFAULT);',
    ],
  ]) {
    assert.equal(
      seedWritesOnlyBaseline(base + '\n' + mutation + '\n'),
      false,
      `${name} slipped through`,
    );
  }
  // Codex R5 reproductions.
  const baseline = fs.readFileSync(path.join(here, 'pilot-1-baseline-seed.sql'), 'utf8');
  assert.equal(seedWritesOnlyBaseline(baseline), true);
  for (const [name, mutated] of [
    [
      'named-constraint DO UPDATE',
      baseline.replace(
        /ON CONFLICT \(account_id\) DO NOTHING;/g,
        "ON CONFLICT ON CONSTRAINT accounts_pkey DO UPDATE SET cohort_classification = 'baseline';",
      ),
    ],
    [
      'DO UPDATE on the column',
      baseline.replace(
        /ON CONFLICT \(account_id\) DO NOTHING;/,
        "ON CONFLICT (account_id) DO UPDATE SET cohort_classification = 'baseline';",
      ),
    ],
    [
      'trailing SQL after DO NOTHING',
      baseline.replace(
        /ON CONFLICT \(account_id\) DO NOTHING;/,
        'ON CONFLICT (account_id) DO NOTHING RETURNING account_id;',
      ),
    ],
    [
      'E-string hiding an UPDATE inside a DO block',
      baseline.replace(
        /\nCOMMIT;/,
        "\nDO $$ BEGIN RAISE NOTICE E'can\\'t'; UPDATE accounts SET cohort_classification='baseline' WHERE cohort_classification='unclassified'; RAISE NOTICE E'can\\'t'; END $$;\nCOMMIT;",
      ),
    ],
    ['top-level E-string', baseline + "\nSELECT E'x';\n"],
    ['unicode-escape string', baseline + "\nSELECT U&'x';\n"],
  ]) {
    assert.notEqual(mutated, baseline, `${name}: mutation did not apply`);
    assert.equal(seedWritesOnlyBaseline(mutated), false, `${name} slipped through`);
  }
  // Codex R6 reproductions.
  for (const [name, mutated] of [
    [
      'quoted set_config then a backslash-escaped UPDATE',
      baseline.replace(
        /\nCOMMIT;/,
        "\nDO $$ DECLARE r TEXT; BEGIN r := \"set_config\"('standard_conforming_strings', 'off', true); END $$;\nDO $$ BEGIN RAISE NOTICE 'can\\'t'; UPDATE accounts SET cohort_classification='baseline' WHERE cohort_classification='unclassified'; RAISE NOTICE 'can\\'t'; END $$;\nCOMMIT;",
      ),
    ],
    [
      'set_config inside VALUES',
      baseline.replace(
        /NOW\(\), 'baseline'\)/,
        "set_config('standard_conforming_strings', 'off', true), 'baseline')",
      ),
    ],
    [
      'any quoted identifier',
      baseline.replace(/INSERT INTO accounts \(/, 'INSERT INTO "accounts" ('),
    ],
    [
      'meta-command with a resumed UPDATE',
      baseline.replace(
        /\nCOMMIT;/,
        "\n\\set ignored 1 \\\\ UPDATE accounts SET cohort_classification='baseline' WHERE cohort_classification='unclassified';\nCOMMIT;",
      ),
    ],
    ['include meta-command', baseline.replace(/\nCOMMIT;/, '\n\\i other.sql\nCOMMIT;')],
    ['echo meta-command', baseline.replace(/\\set ON_ERROR_STOP on/, '\\echo hi')],
    [
      'a function call as a VALUES cell',
      baseline.replace(/'Pilot', 'Clinician US'/, "'Pilot', lower('Clinician US')"),
    ],
  ]) {
    assert.notEqual(mutated, baseline, `${name}: mutation did not apply`);
    assert.equal(seedWritesOnlyBaseline(mutated), false, `${name} slipped through`);
  }
  // Codex R7 reproductions.
  const staging = fs.readFileSync(path.join(here, 'seed-staging-accounts.sql'), 'utf8');
  assert.equal(seedWritesOnlyBaseline(staging), true);
  for (const [name, source, mutated] of [
    [
      'nested dollar quote hiding an UPDATE in a DO body',
      baseline,
      baseline.replace(
        /\nCOMMIT;/,
        "\nDO $$ BEGIN RAISE NOTICE $q$'$q$; UPDATE accounts SET cohort_classification='baseline' WHERE tenant_id='Telecheck-US' AND cohort_classification='unclassified'; RAISE NOTICE $q$'$q$; END $$;\nCOMMIT;",
      ),
    ],
    [
      'set_config in a forms_template TEXT column',
      staging,
      staging.replace(
        /'Staging E2E synthetic intake template',/,
        "set_config('standard_conforming_strings', 'off', true),",
      ),
    ],
    [
      'INSERT into a table a seed may not touch',
      staging,
      staging + "\nINSERT INTO consent_versions (id) VALUES ('x');\n",
    ],
    [
      'forms_template DO UPDATE',
      staging,
      staging.replace(
        /ON CONFLICT \(template_id\) DO NOTHING;/,
        "ON CONFLICT (template_id) DO UPDATE SET name = 'x';",
      ),
    ],
  ]) {
    assert.notEqual(mutated, source, `${name}: mutation did not apply`);
    assert.equal(seedWritesOnlyBaseline(mutated), false, `${name} slipped through`);
  }
  // Codex R8 reproductions.
  for (const [name, mutated] of [
    [
      'non-ASCII dollar tag hiding an UPDATE in a DO body',
      baseline.replace(
        /\nCOMMIT;/,
        "\nDO $$ BEGIN RAISE NOTICE $é$'$é$; UPDATE accounts SET cohort_classification='baseline' WHERE account_type='delegate' AND cohort_classification='unclassified'; RAISE NOTICE $é$'$é$; END $$;\nCOMMIT;",
      ),
    ],
    [
      'CR-terminated comment hiding an UPDATE inside a DO body',
      baseline.replace(
        /\nCOMMIT;/,
        "\nDO $$ BEGIN -- guard\rUPDATE accounts SET cohort_classification='baseline' WHERE account_type='delegate' AND cohort_classification='unclassified';\n END $$;\nCOMMIT;",
      ),
    ],
    [
      'CR-terminated comment hiding a top-level UPDATE',
      baseline.replace(
        /\nCOMMIT;/,
        "\n-- guard\rUPDATE accounts SET cohort_classification='baseline';\nCOMMIT;",
      ),
    ],
    [
      'a bare dollar sign in a DO body',
      baseline.replace(/\nCOMMIT;/, '\nDO $$ BEGIN RAISE NOTICE $x$; END $$;\nCOMMIT;'),
    ],
    ['a non-ASCII top-level dollar quote', baseline + '\nSELECT $é$x$é$;\n'],
  ]) {
    assert.notEqual(mutated, baseline, `${name}: mutation did not apply`);
    assert.equal(seedWritesOnlyBaseline(mutated), false, `${name} slipped through`);
  }
  // The real guards are accepted as read-only.
  for (const file of ['pilot-1-baseline-seed.sql', 'seed-staging-accounts.sql']) {
    const sql = fs.readFileSync(path.join(here, file), 'utf8');
    for (const stmt of splitSqlStatements(sql)) if (/^DO\b/i.test(stmt)) assertReadOnlyDoBody(stmt);
  }
  const literalSemicolon =
    "SELECT 'a;b'; INSERT INTO accounts (account_id, cohort_classification) VALUES ('x', 'baseline');";
  assert.equal(splitSqlStatements(literalSemicolon).length, 2);
});
