// DB-free regression for the Pilot 1 env-purge package:
//   - scripts/lib/purge-plan.mjs (classification validation, deterministic plan)
//   - scripts/lib/incident-manifest.mjs (read-only manifest / lock verification)
//   - scripts/pilot-1-env-purge.sh control flow with a stubbed psql, a stubbed
//     compose command and a scratch incident directory (byte-for-byte untouched)
// The real-Postgres proof lives in tests/integration/pilot-1-env-purge.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGE_HEADER, routineResetBlockers, verifyForPurge } from './lib/incident-manifest.mjs';
import {
  loadClassification,
  planDigest,
  renderPlan,
  tablesOfClass,
  validateClassification,
} from './lib/purge-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'pilot-1-env-purge.sh');
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];

// ---------------------------------------------------------------------------
// purge-plan
// ---------------------------------------------------------------------------

test('classification: loads, every table classified, accounts is scoped-delete, evidence tables preserved, snapshots go with submissions', () => {
  const map = loadClassification();
  assert.ok(Object.keys(map.tables).length >= 80);
  assert.equal(map.tables.accounts.class, 'scoped-delete');
  for (const t of [
    'audit_records',
    'audit_dedupe_markers',
    'domain_events_outbox',
    'tenants',
    'schema_migrations',
  ]) {
    assert.equal(map.tables[t].class, 'preserved', t);
  }
  assert.equal(map.tables.forms_snapshot.class, 'allowlist');
  assert.equal(map.tables.account_pin_credentials.class, 'scoped-delete');
  assert.equal(map.tables.auth_devices.class, 'scoped-delete');
  assert.equal(map.tables.consult_care_binding.disableUserTriggersForTruncate, true);
  assert.equal(map.tables.consult_care_submission.disableUserTriggersForTruncate, true);
  assert.ok(tablesOfClass(map, 'allowlist').length > 30);
});

test('classification: structural violations are build-time failures', () => {
  const map = loadClassification();
  const clone = () => JSON.parse(JSON.stringify(map));
  let m = clone();
  m.tables.accounts = { class: 'allowlist', why: 'x' };
  assert.throws(() => validateClassification(m), /accounts MUST be scoped-delete/);
  m = clone();
  m.tables.accounts.predicate = "cohort_classification = 'participant'; DROP TABLE tenants";
  assert.throws(() => validateClassification(m), /may not contain/);
  m = clone();
  m.tables.audit_records = { class: 'allowlist', why: 'x' };
  assert.throws(() => validateClassification(m), /audit_records MUST be preserved/);
  m = clone();
  m.tables.sessions = { class: 'allowlist', predicate: 'x', why: 'x' };
  assert.throws(() => validateClassification(m), /must not carry a predicate/);
  m = clone();
  m.tables['bad name'] = { class: 'preserved', why: 'x' };
  assert.throws(() => validateClassification(m), /invalid table name/);
  m = clone();
  m.tables.sessions = { class: 'maybe', why: 'x' };
  assert.throws(() => validateClassification(m), /no valid class/);
  m = clone();
  m.tables.tenants.disableUserTriggersForTruncate = true;
  assert.throws(() => validateClassification(m), /only valid as true on an allowlist table/);
});

test('plan: deterministic; user triggers disabled only around the TRUNCATE on the guarded tables and post-checked; one TRUNCATE ... RESTRICT; scoped DELETEs before accounts; never CASCADE', () => {
  const map = loadClassification();
  const sql = renderPlan(map);
  assert.equal(sql, renderPlan(map));
  assert.equal(planDigest(sql), planDigest(renderPlan(map)));
  const truncates = sql.match(/^TRUNCATE TABLE .* RESTRICT;$/gm);
  assert.equal(truncates.length, 1);
  for (const t of tablesOfClass(map, 'allowlist'))
    assert.ok(truncates[0].includes(`public.${t}`), t);
  assert.ok(
    truncates[0].includes('public.forms_snapshot') &&
      truncates[0].includes('public.forms_submission'),
  );
  for (const t of tablesOfClass(map, 'preserved')) {
    assert.ok(
      !truncates[0].includes(`public.${t},`) && !truncates[0].includes(`public.${t} `),
      `${t} must not be truncated`,
    );
    assert.ok(
      !new RegExp(`DELETE FROM public\\.${t}\\b`).test(sql),
      `${t} must not be deleted from`,
    );
  }
  assert.ok(!/CASCADE/i.test(sql));
  const disable = sql.indexOf('ALTER TABLE public.consult_care_binding DISABLE TRIGGER USER;');
  const enable = sql.indexOf('ALTER TABLE public.consult_care_binding ENABLE TRIGGER USER;');
  const trunc = sql.indexOf('TRUNCATE TABLE');
  assert.ok(
    disable >= 0 && enable >= 0 && disable < trunc && trunc < enable,
    'triggers must be disabled only around the TRUNCATE',
  );
  assert.ok(!/DISABLE TRIGGER ALL/.test(sql), 'internal (FK) triggers must never be disabled');
  assert.match(sql, /user trigger\(s\) on consult_care_binding still disabled/);
  const pin = sql.indexOf(
    "DELETE FROM public.account_pin_credentials WHERE account_id IN (SELECT account_id FROM public.accounts WHERE cohort_classification = 'participant');",
  );
  const dev = sql.indexOf('DELETE FROM public.auth_devices WHERE');
  const acc = sql.indexOf(
    "DELETE FROM public.accounts WHERE cohort_classification = 'participant';",
  );
  assert.ok(
    pin >= 0 && dev >= 0 && acc >= 0 && pin < acc && dev < acc,
    'credential / device deletes must precede the accounts delete',
  );
  assert.ok(enable < pin, 'scoped deletes come after the TRUNCATE block');
  assert.ok(
    !/INSERT INTO audit_records/.test(sql),
    'the attestation belongs to the caller, not the plan',
  );
  assert.match(sql, /rows survived TRUNCATE of sessions/);
  assert.match(sql, /accounts rows still match the scoped predicate/);
});

test('plan: the test-only failure hook is placed exactly where asked and refused otherwise', () => {
  const map = loadClassification();
  const afterAudit = renderPlan(map, { failAfter: 'audit' });
  assert.ok(afterAudit.indexOf('injected after audit') < afterAudit.indexOf('TRUNCATE TABLE'));
  const afterTruncate = renderPlan(map, { failAfter: 'truncate' });
  assert.ok(
    afterTruncate.indexOf('TRUNCATE TABLE') < afterTruncate.indexOf('injected after truncate'),
  );
  assert.ok(
    afterTruncate.indexOf('injected after truncate') <
      afterTruncate.indexOf('DELETE FROM public.accounts'),
  );
  const afterDelete = renderPlan(map, { failAfter: 'delete' });
  assert.ok(
    afterDelete.indexOf('DELETE FROM public.accounts') <
      afterDelete.indexOf('injected after delete'),
  );
  assert.throws(() => renderPlan(map, { failAfter: 'commit' }), /unknown fail point/);
  assert.ok(!/injected/.test(renderPlan(map)));
});

// ---------------------------------------------------------------------------
// incident-manifest
// ---------------------------------------------------------------------------

function mkIncidentDir({
  id = '2026-09-08T15-45Z-cat1-01',
  status = 'SUCCESS',
  ageMin = 5,
  consumed = false,
  lockId = id,
  artifacts,
  lock = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const capturedAt = new Date(Date.now() - ageMin * 60_000).toISOString();
  const files = artifacts ?? [{ name: `${id}-app.log.age`, plaintextBytes: 10 }];
  const list = [];
  for (const a of files) {
    const p = path.join(dir, a.name);
    if (!a.missing)
      fs.writeFileSync(
        p,
        Buffer.concat([
          Buffer.from(a.header ?? AGE_HEADER, 'latin1'),
          Buffer.alloc(a.size ?? 40, 7),
        ]),
      );
    const entry = { path: p, plaintextBytes: a.plaintextBytes ?? 10 };
    if (a.ciphertextBytes !== undefined) entry.ciphertextBytes = a.ciphertextBytes;
    list.push(entry);
  }
  const manifest = { incidentId: id, status, capturedAt, artifacts: list, consumed };
  fs.writeFileSync(path.join(dir, `${id}.manifest.json`), JSON.stringify(manifest));
  if (lock)
    fs.writeFileSync(
      path.join(dir, '.incident.lock'),
      JSON.stringify({ incidentId: lockId, openedAt: capturedAt, openedBy: 'test' }),
    );
  return dir;
}

test('incident-manifest: a valid capture passes; every precondition failure is named', () => {
  const ok = mkIncidentDir();
  assert.deepEqual(verifyForPurge(ok, '2026-09-08T15-45Z-cat1-01').ok, true);
  const cases = [
    ['missing manifest', mkIncidentDir(), 'nope', /manifest missing/],
    ['bad id', mkIncidentDir(), '../x', /incident id must match/],
    ['FAILED status', mkIncidentDir({ status: 'FAILED' }), undefined, /not SUCCESS/],
    ['stale', mkIncidentDir({ ageMin: 31 }), undefined, /stale/],
    ['future', mkIncidentDir({ ageMin: -5 }), undefined, /future/],
    ['no artifacts', mkIncidentDir({ artifacts: [] }), undefined, /no artifacts/],
    [
      'missing artifact',
      mkIncidentDir({
        artifacts: [{ name: '2026-09-08T15-45Z-cat1-01-db.sql.age', missing: true }],
      }),
      undefined,
      /artifact missing/,
    ],
    [
      'wrong header',
      mkIncidentDir({
        artifacts: [
          { name: '2026-09-08T15-45Z-cat1-01-db.sql.age', header: 'not-age-at-all-xxxxxxxx' },
        ],
      }),
      undefined,
      /lacks the age header/,
    ],
    [
      'smaller than plaintext',
      mkIncidentDir({
        artifacts: [{ name: '2026-09-08T15-45Z-cat1-01-db.sql.age', plaintextBytes: 10_000 }],
      }),
      undefined,
      /smaller than its plaintext/,
    ],
    [
      'ciphertext mismatch',
      mkIncidentDir({
        artifacts: [{ name: '2026-09-08T15-45Z-cat1-01-db.sql.age', ciphertextBytes: 1 }],
      }),
      undefined,
      /ciphertextBytes/,
    ],
    [
      'foreign artifact name',
      mkIncidentDir({ artifacts: [{ name: 'other-db.sql.age' }] }),
      undefined,
      /not <incident-id>-\*\.age/,
    ],
    ['consumed', mkIncidentDir({ consumed: true }), undefined, /already consumed/],
    ['no lock', mkIncidentDir({ lock: false }), undefined, /lock is absent/],
    ['lock mismatch', mkIncidentDir({ lockId: 'other' }), undefined, /lock belongs to/],
  ];
  for (const [name, dir, id, expect] of cases) {
    const r = verifyForPurge(dir, id ?? '2026-09-08T15-45Z-cat1-01');
    assert.equal(r.ok, false, name);
    assert.match(r.reason, expect, name);
  }
  const mism = mkIncidentDir();
  const f = path.join(mism, '2026-09-08T15-45Z-cat1-01.manifest.json');
  fs.writeFileSync(
    f,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), incidentId: 'other' }),
  );
  assert.match(verifyForPurge(mism, '2026-09-08T15-45Z-cat1-01').reason, /does not match/);
  fs.writeFileSync(f, '{not json');
  assert.match(verifyForPurge(mism, '2026-09-08T15-45Z-cat1-01').reason, /malformed/);
  const esc = mkIncidentDir();
  const ef = path.join(esc, '2026-09-08T15-45Z-cat1-01.manifest.json');
  const em = JSON.parse(fs.readFileSync(ef, 'utf8'));
  em.artifacts[0].path = path.join(esc, '..', '2026-09-08T15-45Z-cat1-01-x.age');
  fs.writeFileSync(ef, JSON.stringify(em));
  assert.match(verifyForPurge(esc, '2026-09-08T15-45Z-cat1-01').reason, /escapes/);
});

test('incident-manifest: inspection failures are refusals, never a clean state (Codex R1)', () => {
  // the "directory" is a file → enumeration fails
  const notDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-')), 'file');
  fs.writeFileSync(notDir, 'x');
  assert.match(routineResetBlockers(notDir).join(';'), /cannot inspect the incident directory/);
  assert.match(verifyForPurge(notDir, '2026-09-08T15-45Z-cat1-01').reason, /cannot inspect/);
  // the lock is a directory → unreadable, not absent
  const lockDir = mkIncidentDir({ lock: false });
  fs.mkdirSync(path.join(lockDir, '.incident.lock'));
  assert.match(routineResetBlockers(lockDir).join(';'), /incident lock cannot be inspected/);
  assert.match(verifyForPurge(lockDir, '2026-09-08T15-45Z-cat1-01').reason, /lock unreadable/);
  // a manifest that is a directory → unreadable manifest blocks routine reset
  const manDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  fs.mkdirSync(path.join(manDir, 'x.manifest.json'));
  assert.match(routineResetBlockers(manDir).join(';'), /unreadable manifest/);
});

test('incident-manifest: routine-reset blockers — lock, unconsumed or unreadable manifests; a clean directory has none', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  assert.deepEqual(routineResetBlockers(empty), []);
  assert.match(routineResetBlockers(mkIncidentDir()).join(';'), /incident lock present/);
  assert.deepEqual(routineResetBlockers(mkIncidentDir({ consumed: true, lock: false })), []);
  const unconsumedNoLock = mkIncidentDir({ consumed: false, lock: false });
  assert.match(routineResetBlockers(unconsumedNoLock).join(';'), /unconsumed manifest/);
  fs.writeFileSync(path.join(unconsumedNoLock, 'z.manifest.json'), '{');
  assert.match(routineResetBlockers(unconsumedNoLock).join(';'), /unreadable manifest/);
});

// ---------------------------------------------------------------------------
// script control flow (stubbed psql + compose)
// ---------------------------------------------------------------------------

function snapshot(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    out[f] = {
      size: st.size,
      mtime: st.mtimeMs,
      sha: createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
    };
  }
  return out;
}

/**
 * Stub psql: dispatches on the SHAPE of the call (a -f file is the seed or the
 * transaction; -c / stdin are the small lookups, matched by content).
 * PSQL_BYPASS / PSQL_UNCLASSIFIED / PSQL_PRIOR / PSQL_RECONCILE / PSQL_TX_EXIT /
 * PSQL_TX_STDERR / PSQL_SEED_EXIT drive the answers.
 */
function mkStubs(dir) {
  const d = dir.replace(/\\/g, '/');
  const psql = path.join(dir, 'psql');
  fs.writeFileSync(
    psql,
    `#!/usr/bin/env bash
n=$(ls "${d}"/call-*.args 2>/dev/null | wc -l)
printf '%s\\n' "$*" > "${d}/call-$n.args"
file=""; cmd=""
for ((i=1;i<=$#;i++)); do
  if [ "\${!i}" = "-c" ]; then j=$((i+1)); cmd="\${!j}"; fi
  if [ "\${!i}" = "-f" ]; then j=$((i+1)); file="\${!j}"; fi
done
if [ -n "$file" ]; then
  case "$file" in
    *pilot-1-baseline-seed.sql) echo seeded >> "${d}/seed.ran"; exit "\${PSQL_SEED_EXIT:-0}" ;;
    *) cp "$file" "${d}/tx.sql"; [ -n "\${PSQL_TX_STDERR:-}" ] && echo "\${PSQL_TX_STDERR}" >&2; exit "\${PSQL_TX_EXIT:-0}" ;;
  esac
fi
if [ -n "$cmd" ]; then sql="$cmd"; else sql="$(cat)"; fi
printf '%s' "$sql" > "${d}/call-$n.sql"
case "$sql" in
  *rolsuper*) printf '%s|t|1\\n' "\${PSQL_BYPASS:-t}"; exit 0 ;;
  *information_schema.columns*) echo 1; exit 0 ;;
  *json_agg*) echo "[]"; exit 0 ;;
  *"cohort_classification = 'unclassified'"*) echo "\${PSQL_UNCLASSIFIED:-0}"; exit 0 ;;
  *"payload->>'operationId'"*) if [ "\${PSQL_RECONCILE:-0}" = "ERR" ]; then echo "connection refused" >&2; exit 2; fi; echo "\${PSQL_RECONCILE:-0}"; exit 0 ;;
  *"payload->>'incidentId'"*) echo "\${PSQL_PRIOR:-0}"; exit 0 ;;
  *) echo "stub psql: unexpected SQL" >&2; exit 9 ;;
esac
`,
    { mode: 0o755 },
  );
  const compose = path.join(dir, 'compose');
  fs.writeFileSync(
    compose,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${d}/compose.log"\nexit 0\n`,
    { mode: 0o755 },
  );
  return { psql, compose };
}

function run(dir, stubs, args, extraEnv = {}) {
  return spawnSync(bash, [...bashArgs, SCRIPT, ...args], {
    cwd: path.join(here, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PILOT_1_DATABASE_URL: 'postgres://synthetic',
      PILOT_1_PSQL: stubs.psql,
      PILOT_1_ACTOR: 'evans@test-host',
      PILOT_1_ACTOR_TENANT: 'Telecheck-US',
      PILOT_1_INCIDENT_LOGS_DIR:
        extraEnv.PILOT_1_INCIDENT_LOGS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-')),
      PILOT_1_COMPOSE: stubs.compose,
      PILOT_1_SKIP_RUNTIME_STEPS: '1',
      ...extraEnv,
    },
  });
}

const txOf = (dir) => fs.readFileSync(path.join(dir, 'tx.sql'), 'utf8');
const composeLog = (dir) =>
  fs.existsSync(path.join(dir, 'compose.log'))
    ? fs.readFileSync(path.join(dir, 'compose.log'), 'utf8').trim().split('\n')
    : [];

test('env-purge: usage errors exit 2 before psql runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  for (const [args, env] of [
    [[], {}],
    [['--routine-reset', '--incident-id', 'x'], {}],
    [['--routine-reset', '--finish-runtime'], {}],
    [['--incident-id'], {}],
    [['--incident-id', '../etc'], {}],
    [['--bogus'], {}],
    [['--routine-reset'], { PILOT_1_DATABASE_URL: '--command=TRUNCATE accounts' }],
    [['--routine-reset'], { PILOT_1_ACTOR_TENANT: '' }],
    [['--routine-reset'], { PILOT_1_ACTOR: 'bad "quote"' }],
    [['--routine-reset'], { PILOT_1_TEST_FAIL_AFTER: 'commit' }],
  ]) {
    const r = run(dir, stubs, args, env);
    assert.equal(r.status, 2, `${args.join(' ')} ${JSON.stringify(env)}: ${r.stderr}`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'call-0.args')), 'psql ran on a usage error');
});

test('env-purge: routine-reset is refused by a lock, an unconsumed manifest, an uninspectable directory, an unclassified account, or a non-bypass role — no transaction, incident-logs untouched', () => {
  const notDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-')), 'file');
  fs.writeFileSync(notDir, 'x');
  for (const [name, env, expect] of [
    ['incident lock', { PILOT_1_INCIDENT_LOGS_DIR: mkIncidentDir() }, /incident lock present/],
    [
      'unconsumed manifest',
      { PILOT_1_INCIDENT_LOGS_DIR: mkIncidentDir({ lock: false }) },
      /unconsumed manifest/,
    ],
    ['not a directory', { PILOT_1_INCIDENT_LOGS_DIR: notDir }, /not found or not a directory/],
    ['unclassified account', { PSQL_UNCLASSIFIED: '2' }, /integrity gate is not green/],
    ['role without bypass', { PSQL_BYPASS: 'f' }, /cannot bypass RLS/],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
    const stubs = mkStubs(dir);
    const inc = env.PILOT_1_INCIDENT_LOGS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
    const before = fs.statSync(inc).isDirectory() ? snapshot(inc) : null;
    const r = run(dir, stubs, ['--routine-reset'], { ...env, PILOT_1_INCIDENT_LOGS_DIR: inc });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /REFUSED/);
    assert.match(r.stderr, expect, name);
    assert.ok(!fs.existsSync(path.join(dir, 'tx.sql')), `${name}: a purge transaction ran`);
    if (before) assert.deepEqual(snapshot(inc), before, `${name}: incident-logs changed`);
  }
});

test('env-purge: incident mode is refused for every manifest precondition and for an already-attested incident; the directory is never written', () => {
  const id = '2026-09-08T15-45Z-cat1-01';
  for (const [name, inc, env] of [
    ['missing manifest', fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-')), {}],
    ['FAILED', mkIncidentDir({ status: 'FAILED' }), {}],
    ['stale', mkIncidentDir({ ageMin: 40 }), {}],
    ['consumed', mkIncidentDir({ consumed: true }), {}],
    ['lock mismatch', mkIncidentDir({ lockId: 'other' }), {}],
    ['already attested', mkIncidentDir(), { PSQL_PRIOR: '1' }],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
    const stubs = mkStubs(dir);
    const before = snapshot(inc);
    const r = run(dir, stubs, ['--incident-id', id], { ...env, PILOT_1_INCIDENT_LOGS_DIR: inc });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /REFUSED/);
    assert.ok(!fs.existsSync(path.join(dir, 'tx.sql')), `${name}: a purge transaction ran`);
    assert.deepEqual(snapshot(inc), before, `${name}: incident-logs changed`);
  }
});

test('env-purge: incident success — advisory lock, per-tenant attestation with the operation id before the plan, digest + incident id + artifacts carried, re-seed runs, incident-logs untouched, no compose call when skipped', () => {
  const id = '2026-09-08T15-45Z-cat1-01';
  const inc = mkIncidentDir({
    artifacts: [{ name: `${id}-app.log.age` }, { name: `${id}-db.sql.age` }],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  const before = snapshot(inc);
  const r = run(dir, stubs, ['--incident-id', id, '--json'], { PILOT_1_INCIDENT_LOGS_DIR: inc });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, 'incident');
  assert.equal(out.incidentId, id);
  assert.equal(out.artifacts, 2);
  assert.equal(out.reconciled, false);
  assert.match(out.operationId, /^[0-9a-f-]{36}$/);
  const map = loadClassification();
  assert.equal(out.planDigest, planDigest(renderPlan(map)));
  const tx = txOf(dir);
  assert.match(tx, /^BEGIN;/m);
  assert.ok(
    tx.indexOf("pg_advisory_xact_lock(hashtext('pilot-1-env-purge'))") <
      tx.indexOf("'env.purge.executed'"),
    'the advisory lock must precede every check',
  );
  assert.ok(
    tx.indexOf("'env.purge.executed'") < tx.indexOf('TRUNCATE TABLE'),
    'attestation must precede the plan',
  );
  assert.match(tx, /FOR v_t IN SELECT id FROM tenants ORDER BY id LOOP/);
  assert.match(tx, /'operationId', v_op/);
  assert.match(tx, /COMMIT;\s*$/);
  assert.ok(!/CASCADE/i.test(tx));
  for (const t of tablesOfClass(map, 'allowlist')) assert.ok(tx.includes(`public.${t}`), t);
  const argsFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.args'))
    .sort();
  const txArgs = argsFiles
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .find((a) => a.includes('-f '));
  assert.match(txArgs, new RegExp(`-v incident_id=${id.replace(/[.]/g, '\\.')}`));
  assert.match(txArgs, new RegExp(`-v operation_id=${out.operationId}`));
  assert.match(txArgs, /-v artifacts=2/);
  assert.match(txArgs, /--dbname=postgres:\/\/synthetic/);
  assert.ok(fs.existsSync(path.join(dir, 'seed.ran')), 're-seed did not run');
  assert.deepEqual(snapshot(inc), before, 'incident-logs changed');
  assert.deepEqual(composeLog(dir), [], 'compose was invoked although runtime steps were skipped');
});

test('env-purge: routine-reset success; the runtime steps run in the right order — stop before the purge, container removed and recreated after (never exec into the stopped app)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  const r = run(dir, stubs, ['--routine-reset', '--json'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_CADDY_LOG_PATHS: '/var/log/access.log',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, 'routine-reset');
  assert.equal(out.incidentId, null);
  assert.equal(out.runtimeStepsSkipped, false);
  assert.deepEqual(composeLog(dir), [
    'exec app pkill -TERM node',
    'stop app',
    'exec redis redis-cli FLUSHALL',
    "exec caddy sh -c [ -e '/var/log/access.log' ] && : > '/var/log/access.log'",
    'rm -sf app',
    'up -d app',
  ]);
  const noCaddy = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const s2 = mkStubs(noCaddy);
  const r2 = run(noCaddy, s2, ['--routine-reset'], { PILOT_1_SKIP_RUNTIME_STEPS: '0' });
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stderr, /no PILOT_1_CADDY_LOG_PATHS configured/);
  assert.ok(!composeLog(noCaddy).some((l) => l.startsWith('exec caddy')));
  assert.ok(
    !composeLog(noCaddy).some((l) => /exec app (sh|rm)/.test(l)),
    'never exec into the stopped app container',
  );
});

test('env-purge: a rolled-back transaction exits 3 (verified by reconciliation) and restarts the app; a lost COMMIT ack continues; an unreconcilable outcome exits 5 with the app left stopped', () => {
  const rolled = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  let r = run(rolled, mkStubs(rolled), ['--routine-reset'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PSQL_TX_EXIT: '3',
    PSQL_TX_STDERR: 'ERROR:  violates foreign key constraint',
    PSQL_RECONCILE: '0',
  });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /rolled back \(verified: no attestation/);
  assert.ok(!fs.existsSync(path.join(rolled, 'seed.ran')));
  assert.deepEqual(composeLog(rolled).slice(-1), ['start app']);

  const lost = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  r = run(lost, mkStubs(lost), ['--routine-reset', '--json'], {
    PSQL_TX_EXIT: '2',
    PSQL_TX_STDERR: 'server closed the connection unexpectedly',
    PSQL_RECONCILE: '2',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /COMMIT acknowledgement was lost/);
  assert.equal(JSON.parse(r.stdout).reconciled, true);
  assert.ok(fs.existsSync(path.join(lost, 'seed.ran')));

  const unknown = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  r = run(unknown, mkStubs(unknown), ['--routine-reset'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PSQL_TX_EXIT: '2',
    PSQL_TX_STDERR: 'server closed the connection unexpectedly',
    PSQL_RECONCILE: 'ERR',
  });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /outcome UNKNOWN/);
  assert.match(r.stderr, /left STOPPED/);
  assert.ok(!fs.existsSync(path.join(unknown, 'seed.ran')));
  assert.ok(
    !composeLog(unknown).some((l) => l === 'start app' || l === 'up -d app'),
    'the app must stay stopped when the outcome is unknown',
  );

  const refused = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  r = run(refused, mkStubs(refused), ['--routine-reset'], {
    PSQL_TX_EXIT: '3',
    PSQL_TX_STDERR: 'ERROR:  PURGE_REFUSED: 1 unclassified account(s)',
  });
  assert.equal(r.status, 1, r.stderr);

  const seedFail = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  r = run(seedFail, mkStubs(seedFail), ['--routine-reset'], { PSQL_SEED_EXIT: '3' });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /re-run with --finish-runtime/);
});

test('env-purge: --finish-runtime re-seeds and runs the runtime steps without any purge transaction', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  const r = run(dir, stubs, ['--finish-runtime', '--json'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).mode, 'finish-runtime');
  assert.ok(!fs.existsSync(path.join(dir, 'tx.sql')), 'a purge transaction ran in recovery mode');
  assert.ok(fs.existsSync(path.join(dir, 'seed.ran')));
  assert.deepEqual(composeLog(dir), ['exec redis redis-cli FLUSHALL', 'rm -sf app', 'up -d app']);
});

test('env-purge: the test failure hook is rendered into the transaction only when set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  const r = run(dir, stubs, ['--routine-reset'], { PILOT_1_TEST_FAIL_AFTER: 'truncate' });
  assert.equal(r.status, 0, r.stderr);
  const tx = txOf(dir);
  assert.ok(tx.indexOf('TRUNCATE TABLE') < tx.indexOf('TEST failure injected after truncate'));
  assert.ok(
    tx.indexOf('TEST failure injected after truncate') < tx.indexOf('DELETE FROM public.accounts'),
  );
});
