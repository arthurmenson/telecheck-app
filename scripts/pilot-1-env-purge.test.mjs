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

test('classification: loads, every table classified, accounts is scoped-delete, evidence tables preserved', () => {
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
});

test('plan: deterministic, attestation-free, one TRUNCATE ... RESTRICT over every allowlist table, scoped DELETE with the recorded predicate, post-checks, never CASCADE', () => {
  const map = loadClassification();
  const sql = renderPlan(map);
  assert.equal(sql, renderPlan(map));
  assert.equal(planDigest(sql), planDigest(renderPlan(map)));
  const truncates = sql.match(/^TRUNCATE TABLE .* RESTRICT;$/gm);
  assert.equal(truncates.length, 1);
  for (const t of tablesOfClass(map, 'allowlist'))
    assert.ok(truncates[0].includes(`public.${t}`), t);
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
  assert.match(sql, /^DELETE FROM public\.accounts WHERE cohort_classification = 'participant';$/m);
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
  // manifest id mismatch
  const mism = mkIncidentDir();
  const f = path.join(mism, '2026-09-08T15-45Z-cat1-01.manifest.json');
  fs.writeFileSync(
    f,
    JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), incidentId: 'other' }),
  );
  assert.match(verifyForPurge(mism, '2026-09-08T15-45Z-cat1-01').reason, /does not match/);
  // malformed manifest counts as FAILED
  fs.writeFileSync(f, '{not json');
  assert.match(verifyForPurge(mism, '2026-09-08T15-45Z-cat1-01').reason, /malformed/);
  // an artifact path escaping the directory
  const esc = mkIncidentDir();
  const ef = path.join(esc, '2026-09-08T15-45Z-cat1-01.manifest.json');
  const em = JSON.parse(fs.readFileSync(ef, 'utf8'));
  em.artifacts[0].path = path.join(esc, '..', '2026-09-08T15-45Z-cat1-01-x.age');
  fs.writeFileSync(ef, JSON.stringify(em));
  assert.match(verifyForPurge(esc, '2026-09-08T15-45Z-cat1-01').reason, /escapes/);
});

test('incident-manifest: routine-reset blockers — lock, unconsumed or unreadable manifests; a clean directory has none', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  assert.deepEqual(routineResetBlockers(empty), []);
  assert.match(routineResetBlockers(mkIncidentDir()).join(';'), /incident lock present/);
  const consumedNoLock = mkIncidentDir({ consumed: true, lock: false });
  assert.deepEqual(routineResetBlockers(consumedNoLock), []);
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
 * Stub psql answering by SQL content. Records every invocation's argv and the
 * SQL it received (stdin or -f file). PSQL_UNCLASSIFIED / PSQL_PRIOR /
 * PSQL_BYPASS / PSQL_TX_EXIT drive the answers.
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
# Dispatch on the SHAPE of the call first (the transaction file contains every
# marker string, so content-first matching mis-routes it).
if [ -n "$file" ]; then
  case "$file" in
    *pilot-1-baseline-seed.sql) echo seeded > "${d}/seed.ran"; exit "\${PSQL_SEED_EXIT:-0}" ;;
    *) cp "$file" "${d}/tx.sql"; [ -n "\${PSQL_TX_STDERR:-}" ] && echo "\${PSQL_TX_STDERR}" >&2; exit "\${PSQL_TX_EXIT:-0}" ;;
  esac
fi
if [ -n "$cmd" ]; then sql="$cmd"; else sql="$(cat)"; fi
printf '%s' "$sql" > "${d}/call-$n.sql"
case "$sql" in
  *information_schema.columns*rolsuper*|*rolsuper*) printf '%s|t|1\\n' "\${PSQL_BYPASS:-t}"; exit 0 ;;
  *information_schema.columns*) echo 1; exit 0 ;;
  *json_agg*) echo "[]"; exit 0 ;;
  *"cohort_classification = 'unclassified'"*) echo "\${PSQL_UNCLASSIFIED:-0}"; exit 0 ;;
  *"env.purge.executed"*) echo "\${PSQL_PRIOR:-0}"; exit 0 ;;
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

function txOf(dir) {
  return fs.readFileSync(path.join(dir, 'tx.sql'), 'utf8');
}

test('env-purge: usage errors exit 2 before psql runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  for (const [args, env] of [
    [[], {}],
    [['--routine-reset', '--incident-id', 'x'], {}],
    [['--incident-id'], {}],
    [['--incident-id', '../etc'], {}],
    [['--bogus'], {}],
    [['--routine-reset'], { PILOT_1_DATABASE_URL: '--command=TRUNCATE accounts' }],
    [['--routine-reset'], { PILOT_1_ACTOR_TENANT: '' }],
    [['--routine-reset'], { PILOT_1_ACTOR: 'bad "quote"' }],
    [['--routine-reset'], { PILOT_1_TEST_FAIL_AFTER: 'commit' }],
    [['--routine-reset'], { PILOT_1_INCIDENT_LOGS_DIR: path.join(dir, 'missing') }],
  ]) {
    const r = run(dir, stubs, args, env);
    assert.equal(r.status, 2, `${args.join(' ')} ${JSON.stringify(env)}: ${r.stderr}`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'call-0.args')), 'psql ran on a usage error');
});

test('env-purge: routine-reset is refused by a lock or an unconsumed manifest, an unclassified account, or a non-bypass role — with no transaction and incident-logs untouched', () => {
  for (const [name, env] of [
    ['incident lock', { PILOT_1_INCIDENT_LOGS_DIR: mkIncidentDir() }],
    ['unconsumed manifest', { PILOT_1_INCIDENT_LOGS_DIR: mkIncidentDir({ lock: false }) }],
    ['unclassified account', { PSQL_UNCLASSIFIED: '2' }],
    ['role without bypass', { PSQL_BYPASS: 'f' }],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
    const stubs = mkStubs(dir);
    const inc = env.PILOT_1_INCIDENT_LOGS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
    const before = snapshot(inc);
    const r = run(dir, stubs, ['--routine-reset'], { ...env, PILOT_1_INCIDENT_LOGS_DIR: inc });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /REFUSED/);
    assert.ok(!fs.existsSync(path.join(dir, 'tx.sql')), `${name}: a purge transaction ran`);
    assert.deepEqual(snapshot(inc), before, `${name}: incident-logs changed`);
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

test('env-purge: incident success — attestation before the plan, plan from the classification, digest + incident id + artifacts carried, re-seed runs, incident-logs byte-for-byte untouched, no compose call when skipped', () => {
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
  assert.equal(out.runtimeStepsSkipped, true);
  assert.match(out.planDigest, /^[0-9a-f]{64}$/);
  const map = loadClassification();
  assert.equal(out.planDigest, planDigest(renderPlan(map)));
  const tx = txOf(dir);
  assert.match(tx, /^BEGIN;/m);
  assert.ok(
    tx.indexOf("'env.purge.executed'") < tx.indexOf('TRUNCATE TABLE'),
    'attestation must precede the plan',
  );
  assert.ok(
    tx.indexOf('TRUNCATE TABLE') <
      tx.indexOf("DELETE FROM public.accounts WHERE cohort_classification = 'participant'"),
  );
  assert.match(tx, /COMMIT;\s*$/);
  assert.ok(!/CASCADE/i.test(tx));
  assert.ok(!/injected/.test(tx));
  for (const t of tablesOfClass(map, 'allowlist')) assert.ok(tx.includes(`public.${t}`), t);
  const args = fs.readFileSync(
    path.join(
      dir,
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.args'))
        .sort()
        .at(-2),
    ),
    'utf8',
  );
  assert.match(args, new RegExp(`-v incident_id=${id.replace(/[.]/g, '\\.')}`));
  assert.match(args, /-v mode=incident/);
  assert.match(args, /-v artifacts=2/);
  assert.match(args, /--dbname=postgres:\/\/synthetic/);
  assert.ok(fs.existsSync(path.join(dir, 'seed.ran')), 're-seed did not run');
  assert.deepEqual(snapshot(inc), before, 'incident-logs changed');
  assert.ok(
    !fs.existsSync(path.join(dir, 'compose.log')),
    'compose was invoked although runtime steps were skipped',
  );
});

test('env-purge: routine-reset success on a clean directory; the runtime steps run in order when not skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  const r = run(dir, stubs, ['--routine-reset', '--json'], { PILOT_1_SKIP_RUNTIME_STEPS: '0' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.mode, 'routine-reset');
  assert.equal(out.incidentId, null);
  assert.equal(out.runtimeStepsSkipped, false);
  const tx = txOf(dir);
  assert.match(tx, /-v mode=routine-reset|routine-reset/);
  const log = fs.readFileSync(path.join(dir, 'compose.log'), 'utf8').trim().split('\n');
  assert.deepEqual(log, [
    'exec app pkill -TERM node',
    'stop app',
    'exec redis redis-cli FLUSHALL',
    'exec caddy sh -c > /var/log/access.log',
    'exec app sh -c rm -f /app/logs/*.log',
    'start app',
  ]);
  assert.ok(log.indexOf('stop app') < 2, 'the app must be stopped before the purge');
});

test('env-purge: a failed purge transaction exits 3 with nothing else run; a PURGE_REFUSED raise maps to exit 1; a failed re-seed after COMMIT exits 4', () => {
  const fail = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  let stubs = mkStubs(fail);
  let r = run(fail, stubs, ['--routine-reset'], {
    PSQL_TX_EXIT: '3',
    PSQL_TX_STDERR: 'ERROR:  update or delete on table "accounts" violates foreign key constraint',
  });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /rolled back/);
  assert.ok(!fs.existsSync(path.join(fail, 'seed.ran')), 're-seed ran after a failed purge');
  const refused = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  stubs = mkStubs(refused);
  r = run(refused, stubs, ['--routine-reset'], {
    PSQL_TX_EXIT: '3',
    PSQL_TX_STDERR: 'ERROR:  PURGE_REFUSED: 1 unclassified account(s)',
  });
  assert.equal(r.status, 1, r.stderr);
  const seedFail = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  stubs = mkStubs(seedFail);
  r = run(seedFail, stubs, ['--routine-reset'], { PSQL_SEED_EXIT: '3' });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /COMMITTED and attested, but re-seed failed/);
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
