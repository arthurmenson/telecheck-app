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

test('remediation: unknown actor tenant exits 2; unknown / already-classified / staff-as-participant are refused (exit 1) with no transaction', () => {
  const badTenant = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
  const rt = run(
    badTenant,
    mkStub(badTenant, { state: 'f|Telecheck-US|patient|US|unclassified\n' }),
    good,
  );
  assert.equal(rt.status, 2, rt.stderr);
  assert.match(rt.stderr, /actor tenant 'Telecheck-US' does not exist/);
  assert.ok(!fs.existsSync(path.join(badTenant, 'tx.sql')));
  for (const [state, args, expect] of [
    ['t|\n', good, /not found/],
    ['t|Telecheck-US|patient|US|baseline\n', good, /already classified as 'baseline'/],
    ['t|Telecheck-US|patient|US|participant\n', good, /already classified as 'participant'/],
    [
      't|Telecheck-US|clinician|US|unclassified\n',
      asParticipant,
      /only patient\/delegate accounts can be classified as 'participant'/,
    ],
    ['t|Telecheck-US|tenant_admin|US|unclassified\n', asParticipant, /only patient\/delegate/],
    ['t|Telecheck-US|platform_admin|US|unclassified\n', asParticipant, /only patient\/delegate/],
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
    ['t|Telecheck-US|clinician|US|unclassified\n', good],
    ['t|Telecheck-Ghana|delegate|GH|unclassified\n', asParticipant],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1r-'));
    const r = run(dir, mkStub(dir, { state }), args);
    assert.equal(r.status, 0, r.stderr);
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
  assert.match(sql, /NOT IN \('patient', 'delegate'\)/);
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
  const statements = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '\\' && cur.trim() === '') {
      // psql meta-command (`\set`, `\.`): a whole line, terminated by the
      // newline rather than a `;`.
      let j = i;
      while (j < sql.length && sql[j] !== '\n') j++;
      statements.push(sql.slice(i, j).trim());
      i = j;
      continue;
    }
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
      const j = sql.indexOf('"', i + 1);
      if (j < 0) throw new Error('unterminated identifier');
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
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

function parseTuples(body) {
  const tuples = [];
  let depth = 0;
  let start = -1;
  let quote = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "'") {
        if (body[i + 1] === "'") i++;
        else quote = false;
      }
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
  if (depth !== 0) throw new Error('unbalanced VALUES tuple');
  return tuples;
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
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '-' && text[i + 1] === '-') {
      while (i < text.length && text[i] !== '\n') i++;
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
    if (ch === '"') {
      const j = text.indexOf('"', i + 1);
      if (j < 0) throw new Error('unterminated identifier in DO body');
      out += ' ';
      i = j + 1;
      continue;
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

const ACCOUNTS_INSERT =
  /^INSERT\s+INTO\s+(?:public\.)?accounts\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*?)(?:\s+ON\s+CONFLICT\s*\(\s*account_id\s*\)\s*DO\s+NOTHING)?$/i;

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
    if (!/\baccounts\b/i.test(stmt)) continue; // other tables (forms_template, ...)
    const m = stmt.match(ACCOUNTS_INSERT);
    if (!m) throw new Error(`unrecognised statement touching accounts: ${stmt.slice(0, 80)}`);
    const columns = m[1].split(',').map((c) => c.trim().toLowerCase());
    const tuples = parseTuples(m[2]);
    if (tuples.length === 0) throw new Error('accounts INSERT without VALUES tuples');
    found.push({ columns, tuples });
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
  // The real guards are accepted as read-only.
  for (const file of ['pilot-1-baseline-seed.sql', 'seed-staging-accounts.sql']) {
    const sql = fs.readFileSync(path.join(here, file), 'utf8');
    for (const stmt of splitSqlStatements(sql)) if (/^DO\b/i.test(stmt)) assertReadOnlyDoBody(stmt);
  }
  const literalSemicolon =
    "SELECT 'a;b'; INSERT INTO accounts (account_id, cohort_classification) VALUES ('x', 'baseline');";
  assert.equal(splitSqlStatements(literalSemicolon).length, 2);
});
