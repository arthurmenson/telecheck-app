// DB-free regression for the Pilot 1 incident-lifecycle package (phase B part 3a):
//   - scripts/lib/incident-writers.mjs (consume / remove-lock / gc / close-wipe)
//   - scripts/incident-clear.sh, scripts/incident-log-gc.sh, scripts/pilot-1-close-wipe.sh
//     control flow with a stubbed psql and flock and a scratch incident directory
// The real-Postgres proof for incident-clear lives in tests/integration/incident-clear.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AGE_HEADER, lockState, routineResetBlockers } from './lib/incident-manifest.mjs';
import {
  closeWipe,
  closeWipeBlockers,
  consume,
  gcExecute,
  gcPlan,
  readManifest,
  removeLock,
} from './lib/incident-writers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];
const ID = '2026-09-08T15-45Z-cat1-01';
const DAY = 24 * 60 * 60 * 1000;

function mkIncidentDir({
  id = ID,
  consumed = false,
  lock = true,
  lockId = id,
  ageDays = 0,
  disposition,
  artifacts = 1,
  status = 'SUCCESS',
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const capturedAt = new Date(Date.now() - ageDays * DAY).toISOString();
  const list = [];
  for (let i = 0; i < artifacts; i++) {
    const p = path.join(dir, `${id}-art${i}.age`);
    fs.writeFileSync(p, Buffer.concat([Buffer.from(AGE_HEADER, 'latin1'), Buffer.alloc(40, 7)]));
    list.push({ path: p, plaintextBytes: 10, ciphertextBytes: AGE_HEADER.length + 40 });
  }
  const manifest = { incidentId: id, status, capturedAt, artifacts: list, consumed };
  if (disposition) manifest.disposition = disposition;
  const mf = path.join(dir, `${id}.manifest.json`);
  fs.writeFileSync(mf, JSON.stringify(manifest));
  if (ageDays) {
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(mf, t, t);
    for (const a of list) fs.utimesSync(a.path, t, t);
  }
  if (lock)
    fs.writeFileSync(
      path.join(dir, '.incident.lock'),
      JSON.stringify({ incidentId: lockId, openedAt: capturedAt, openedBy: 'test' }),
    );
  return dir;
}

function snapshot(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    const st = fs.lstatSync(p);
    out[f] = st.isFile()
      ? { size: st.size, sha: createHash('sha256').update(fs.readFileSync(p)).digest('hex') }
      : { type: 'other' };
  }
  return out;
}

const manifestOf = (dir, id = ID) =>
  JSON.parse(fs.readFileSync(path.join(dir, `${id}.manifest.json`), 'utf8'));

// ---------------------------------------------------------------------------
// incident-writers library
// ---------------------------------------------------------------------------

test('writers: consume marks the manifest with the disposition atomically; refuses missing / malformed / mismatched / symlinked manifests and a different prior disposition; completes the same one', () => {
  const dir = mkIncidentDir();
  const r = consume(dir, ID, {
    disposition: 'RESOLVED',
    clearedBy: 'evans@host',
    purgeAttested: true,
    clearedAt: '2026-09-08T16:00:00Z',
  });
  assert.equal(r.alreadyConsumed, false);
  const m = manifestOf(dir);
  assert.equal(m.consumed, true);
  assert.equal(m.disposition, 'RESOLVED');
  assert.equal(m.purgeAttested, true);
  assert.equal(m.clearedBy, 'evans@host');
  assert.equal(m.artifacts.length, 1, 'the artifact list is preserved');
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('.tmp-')),
    [],
    'no temp files left',
  );
  assert.equal(
    consume(dir, ID, { disposition: 'RESOLVED', clearedBy: 'x' }).alreadyConsumed,
    true,
    'interrupted clearance',
  );
  assert.throws(
    () => consume(dir, ID, { disposition: 'ABANDONED', clearedBy: 'x', reason: 'r' }),
    /already consumed with disposition "RESOLVED"/,
  );
  assert.throws(
    () => consume(mkIncidentDir(), 'other-id', { disposition: 'RESOLVED', clearedBy: 'x' }),
    /manifest missing/,
  );
  const bad = mkIncidentDir();
  fs.writeFileSync(path.join(bad, `${ID}.manifest.json`), '{nope');
  assert.throws(() => consume(bad, ID, { disposition: 'RESOLVED', clearedBy: 'x' }), /malformed/);
  const mism = mkIncidentDir();
  fs.writeFileSync(
    path.join(mism, `${ID}.manifest.json`),
    JSON.stringify({ ...manifestOf(mism), incidentId: 'other' }),
  );
  assert.throws(
    () => consume(mism, ID, { disposition: 'RESOLVED', clearedBy: 'x' }),
    /does not match/,
  );
  assert.throws(
    () => consume(dir, '../x', { disposition: 'RESOLVED', clearedBy: 'x' }),
    /incident id must match/,
  );
  assert.throws(
    () => consume(dir, ID, { disposition: 'MAYBE', clearedBy: 'x' }),
    /disposition must be/,
  );
  const ab = mkIncidentDir();
  consume(ab, ID, {
    disposition: 'ABANDONED',
    clearedBy: 'x',
    reason: 'RCA: purge not appropriate',
    purgeAttested: false,
  });
  assert.equal(manifestOf(ab).abandonReason, 'RCA: purge not appropriate');
  // symlinked manifest (Windows needs a privilege for file symlinks; CI runs it)
  const link = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const victim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p1out-')), 'victim.json');
  fs.writeFileSync(victim, JSON.stringify({ incidentId: ID, consumed: false }));
  let linked = true;
  try {
    fs.symlinkSync(victim, path.join(link, `${ID}.manifest.json`), 'file');
  } catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') linked = false;
    else throw e;
  }
  if (linked) {
    assert.throws(
      () => consume(link, ID, { disposition: 'RESOLVED', clearedBy: 'x' }),
      /symbolic link/,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(victim, 'utf8')).consumed,
      false,
      'the link target was written',
    );
  }
});

test('writers: removeLock unlinks only a regular lock naming the id; absent is reported; foreign / malformed / uninspectable locks are refused', () => {
  const dir = mkIncidentDir();
  assert.deepEqual(removeLock(dir, ID), { absent: false, removed: true });
  assert.ok(!fs.existsSync(path.join(dir, '.incident.lock')));
  assert.deepEqual(removeLock(dir, ID), { absent: true });
  assert.throws(
    () => removeLock(mkIncidentDir({ lockId: 'someone-else' }), ID),
    /belongs to "someone-else"/,
  );
  const mal = mkIncidentDir({ lock: false });
  fs.writeFileSync(path.join(mal, '.incident.lock'), '{');
  assert.throws(() => removeLock(mal, ID), /malformed/);
  const dirlock = mkIncidentDir({ lock: false });
  fs.mkdirSync(path.join(dirlock, '.incident.lock'));
  assert.throws(() => removeLock(dirlock, ID), /cannot be inspected/);
  assert.ok(
    fs.existsSync(path.join(dirlock, '.incident.lock')),
    'a non-file lock entry is never removed',
  );
});

test('writers: gc plan deletes only consumed, unlocked, aged manifests + their artifacts; never the lock, never unconsumed / malformed / young ones; both ages must pass', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const add = (id, opts) => {
    const src = mkIncidentDir({ id, lock: false, ...opts });
    for (const f of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, f), path.join(dir, f));
      const st = fs.statSync(path.join(src, f));
      fs.utimesSync(path.join(dir, f), st.atime, st.mtime);
    }
  };
  add('old-consumed', { consumed: true, ageDays: 40, artifacts: 2 });
  add('old-open', { consumed: false, ageDays: 40 });
  add('young-consumed', { consumed: true, ageDays: 3 });
  add('locked-consumed', { consumed: true, ageDays: 40 });
  fs.writeFileSync(path.join(dir, 'broken.manifest.json'), '{oops');
  fs.writeFileSync(path.join(dir, 'broken-x.age'), 'x');
  // an aged consumed manifest whose file mtime is old but whose capturedAt is recent stays
  add('mtime-old-captured-young', { consumed: true, ageDays: 40 });
  const my = path.join(dir, 'mtime-old-captured-young.manifest.json');
  fs.writeFileSync(
    my,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(my, 'utf8')),
      capturedAt: new Date().toISOString(),
    }),
  );
  const t = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(my, t, t);
  fs.writeFileSync(
    path.join(dir, '.incident.lock'),
    JSON.stringify({ incidentId: 'locked-consumed', openedAt: 'x', openedBy: 't' }),
  );
  const plan = gcPlan(dir, { minAgeDays: 30 });
  assert.deepEqual(
    plan.deletions.map((d) => d.id),
    ['old-consumed'],
  );
  assert.deepEqual(plan.deletions[0].artifacts, ['old-consumed-art0.age', 'old-consumed-art1.age']);
  const reasons = Object.fromEntries(plan.skipped.map((s) => [s.file, s.reason]));
  assert.match(reasons['old-open.manifest.json'], /not consumed/);
  assert.match(reasons['young-consumed.manifest.json'], /younger than 30 days/);
  assert.match(reasons['locked-consumed.manifest.json'], /lock references this incident/);
  assert.match(reasons['broken.manifest.json'], /malformed/);
  assert.match(reasons['mtime-old-captured-young.manifest.json'], /younger than 30 days/);
  const before = snapshot(dir);
  const deleted = gcExecute(dir, plan);
  assert.deepEqual(deleted.sort(), [
    'old-consumed-art0.age',
    'old-consumed-art1.age',
    'old-consumed.manifest.json',
  ]);
  const after = snapshot(dir);
  for (const f of Object.keys(before)) {
    if (deleted.includes(f)) assert.ok(!(f in after), `${f} should be gone`);
    else assert.deepEqual(after[f], before[f], `${f} changed`);
  }
  assert.ok(fs.existsSync(path.join(dir, '.incident.lock')), 'gc must never touch the lock');
  assert.ok(
    fs.existsSync(path.join(dir, 'broken-x.age')),
    'artifacts of a malformed manifest are never deleted',
  );
  // an uninspectable lock blocks EVERY deletion
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const src = mkIncidentDir({ id: 'aged', lock: false, consumed: true, ageDays: 40 });
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(blocked, f));
    const st = fs.statSync(path.join(src, f));
    fs.utimesSync(path.join(blocked, f), st.atime, st.mtime);
  }
  fs.mkdirSync(path.join(blocked, '.incident.lock'));
  const p2 = gcPlan(blocked, { minAgeDays: 30 });
  assert.deepEqual(p2.deletions, []);
  assert.match(p2.skipped[0].reason, /uninspectable/);
});

test('writers: close-wipe blockers (lock, unconsumed, unreadable, non-regular entries) and the wipe itself', () => {
  assert.match(closeWipeBlockers(mkIncidentDir()).join(';'), /incident lock present/);
  assert.match(closeWipeBlockers(mkIncidentDir({ lock: false })).join(';'), /unconsumed manifest/);
  const dirlock = mkIncidentDir({ lock: false, consumed: true });
  fs.mkdirSync(path.join(dirlock, '.incident.lock'));
  assert.match(closeWipeBlockers(dirlock).join(';'), /cannot be inspected/);
  const sub = mkIncidentDir({ lock: false, consumed: true });
  fs.mkdirSync(path.join(sub, 'subdir'));
  assert.match(closeWipeBlockers(sub).join(';'), /unexpected entry/);
  const bad = mkIncidentDir({ lock: false, consumed: true });
  fs.writeFileSync(path.join(bad, 'x.manifest.json'), '{');
  assert.match(closeWipeBlockers(bad).join(';'), /unreadable manifest/);
  assert.throws(() => closeWipe(mkIncidentDir()), /close-wipe blocked/);
  const ok = mkIncidentDir({ lock: false, consumed: true, artifacts: 3 });
  fs.writeFileSync(path.join(ok, 'stray.txt'), 'x');
  assert.deepEqual(closeWipeBlockers(ok), []);
  const removed = closeWipe(ok);
  assert.equal(removed.length, 5);
  assert.deepEqual(fs.readdirSync(ok), []);
  assert.ok(fs.existsSync(ok), 'the directory itself is kept');
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-')), 'nope');
  assert.match(closeWipeBlockers(missing).join(';'), /not found/);
});

// ---------------------------------------------------------------------------
// scripts (stub psql + flock)
// ---------------------------------------------------------------------------

function mkStubs(dir) {
  const d = dir.replace(/\\/g, '/');
  const psql = path.join(dir, 'psql');
  fs.writeFileSync(
    psql,
    `#!/usr/bin/env bash
n=$(ls "${d}"/call-*.args 2>/dev/null | wc -l)
printf '%s\\n' "$*" > "${d}/call-$n.args"
sql="$(cat)"
printf '%s' "$sql" > "${d}/call-$n.sql"
case "$sql" in
  *"env.incident.abandoned"*"INSERT INTO audit_records"*) printf '%s' "$sql" > "${d}/tx.sql"; [ -n "\${PSQL_TX_STDERR:-}" ] && echo "\${PSQL_TX_STDERR}" >&2; exit "\${PSQL_TX_EXIT:-0}" ;;
  *"env.purge.executed"*"env.incident.abandoned"*) printf '%s|%s\\n' "\${PSQL_PURGE_ROWS:-0}" "\${PSQL_ABANDON_ROWS:-0}"; exit 0 ;;
  *) echo "stub psql: unexpected SQL" >&2; exit 9 ;;
esac
`,
    { mode: 0o755 },
  );
  const flock = path.join(dir, 'flock');
  fs.writeFileSync(
    flock,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${d}/flock.log"\n[ "\${FLOCK_BUSY:-0}" = "1" ] && exit 1\nexit 0\n`,
    { mode: 0o755 },
  );
  return { psql, flock };
}

function run(script, dir, stubs, args, extraEnv = {}) {
  return spawnSync(bash, [...bashArgs, path.join(here, script), ...args], {
    cwd: path.join(here, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PILOT_1_DATABASE_URL: 'postgres://synthetic',
      PILOT_1_PSQL: stubs.psql,
      PILOT_1_FLOCK: stubs.flock,
      PILOT_1_ACTOR: 'evans@test-host',
      PILOT_1_ACTOR_TENANT: 'Telecheck-US',
      PILOT_1_LOCK_FILE: path.join(dir, 'lifecycle.lock'),
      ...extraEnv,
    },
  });
}
const psqlCalls = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.args')).length;

test('incident-clear: usage errors exit 2 before anything runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1c-'));
  const stubs = mkStubs(dir);
  const inc = mkIncidentDir();
  const before = snapshot(inc);
  for (const args of [
    [],
    ['--incident-id', ID],
    ['--incident-id', '../x', '--disposition', 'RESOLVED'],
    ['--incident-id', ID, '--disposition', 'MAYBE'],
    ['--incident-id', ID, '--disposition', 'ABANDONED'],
    ['--incident-id', ID, '--disposition', 'RESOLVED', '--force-abandoned', 'r'],
    ['--incident-id', ID, '--disposition', 'ABANDONED', '--force-abandoned', 'x'.repeat(501)],
    ['--incident-id', ID, '--disposition', 'ABANDONED', '--force-abandoned', 'two\nlines'],
    ['--bogus'],
  ]) {
    const r = run('incident-clear.sh', dir, stubs, args, { PILOT_1_INCIDENT_LOGS_DIR: inc });
    assert.equal(r.status, 2, `${JSON.stringify(args)}: ${r.stderr}`);
  }
  let r = run(
    'incident-clear.sh',
    dir,
    stubs,
    ['--incident-id', ID, '--disposition', 'ABANDONED', '--force-abandoned', 'r'],
    { PILOT_1_INCIDENT_LOGS_DIR: inc, PILOT_1_ACTOR_TENANT: '' },
  );
  assert.equal(r.status, 2, r.stderr);
  r = run('incident-clear.sh', dir, stubs, ['--incident-id', ID, '--disposition', 'RESOLVED'], {
    PILOT_1_INCIDENT_LOGS_DIR: inc,
    PILOT_1_DATABASE_URL: '--command=x',
  });
  assert.equal(r.status, 2, r.stderr);
  r = run('incident-clear.sh', dir, stubs, ['--incident-id', ID, '--disposition', 'RESOLVED'], {
    PILOT_1_INCIDENT_LOGS_DIR: inc,
    PILOT_1_LOCK_FILE: path.join(inc, 'lifecycle.lock'),
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /must not be inside the incident directory/);
  assert.equal(psqlCalls(dir), 0);
  assert.deepEqual(snapshot(inc), before);
});

test('incident-clear: refusals — lifecycle busy, no lock, foreign lock, missing / malformed manifest, RESOLVED without a purge attestation, different prior disposition — nothing changes', () => {
  const cases = [
    [
      'lifecycle busy',
      mkIncidentDir(),
      ['--disposition', 'RESOLVED'],
      { FLOCK_BUSY: '1' },
      /another Pilot 1 lifecycle/,
    ],
    [
      'no lock',
      mkIncidentDir({ lock: false }),
      ['--disposition', 'RESOLVED'],
      {},
      /no incident lock is present/,
    ],
    [
      'foreign lock',
      mkIncidentDir({ lockId: 'someone-else' }),
      ['--disposition', 'RESOLVED'],
      {},
      /belongs to 'someone-else'/,
    ],
    [
      'missing manifest',
      (() => {
        const d = mkIncidentDir();
        fs.rmSync(path.join(d, `${ID}.manifest.json`));
        return d;
      })(),
      ['--disposition', 'RESOLVED'],
      {},
      /manifest missing/,
    ],
    [
      'malformed manifest',
      (() => {
        const d = mkIncidentDir();
        fs.writeFileSync(path.join(d, `${ID}.manifest.json`), '{');
        return d;
      })(),
      ['--disposition', 'RESOLVED'],
      {},
      /malformed/,
    ],
    [
      'RESOLVED without purge',
      mkIncidentDir(),
      ['--disposition', 'RESOLVED'],
      { PSQL_PURGE_ROWS: '0' },
      /requires a committed env\.purge\.executed attestation/,
    ],
    [
      'other disposition',
      mkIncidentDir({ consumed: true, disposition: 'RESOLVED' }),
      ['--disposition', 'ABANDONED', '--force-abandoned', 'r'],
      {},
      /already consumed with disposition 'RESOLVED'/,
    ],
    [
      'consumed not boolean',
      (() => {
        const d = mkIncidentDir();
        const f = path.join(d, `${ID}.manifest.json`);
        fs.writeFileSync(
          f,
          JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), consumed: 'yes' }),
        );
        return d;
      })(),
      ['--disposition', 'ABANDONED', '--force-abandoned', 'r'],
      {},
      /counts as FAILED/,
    ],
  ];
  for (const [name, inc, extra, env, expect] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1c-'));
    const stubs = mkStubs(dir);
    const before = snapshot(inc);
    const r = run('incident-clear.sh', dir, stubs, ['--incident-id', ID, ...extra], {
      ...env,
      PILOT_1_INCIDENT_LOGS_DIR: inc,
    });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /REFUSED/, name);
    assert.match(r.stderr, expect, name);
    assert.ok(!fs.existsSync(path.join(dir, 'tx.sql')), `${name}: an audit transaction ran`);
    assert.deepEqual(snapshot(inc), before, `${name}: incident-logs changed`);
  }
});

test('incident-clear RESOLVED: with a purge attestation → manifest consumed (disposition, purgeAttested, clearedBy), lock removed, no audit write; routine-reset then unblocked; re-run refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1c-'));
  const stubs = mkStubs(dir);
  const inc = mkIncidentDir();
  const r = run(
    'incident-clear.sh',
    dir,
    stubs,
    ['--incident-id', ID, '--disposition', 'RESOLVED', '--json'],
    { PILOT_1_INCIDENT_LOGS_DIR: inc, PSQL_PURGE_ROWS: '2' },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'cleared');
  assert.equal(out.disposition, 'RESOLVED');
  assert.equal(out.purgeAttested, true);
  assert.equal(out.abandonedAttestationEmitted, false);
  assert.equal(out.completedInterruptedClearance, false);
  const m = manifestOf(inc);
  assert.equal(m.consumed, true);
  assert.equal(m.disposition, 'RESOLVED');
  assert.equal(m.purgeAttested, true);
  assert.equal(m.clearedBy, 'evans@test-host');
  assert.ok(!fs.existsSync(path.join(inc, '.incident.lock')));
  assert.ok(!fs.existsSync(path.join(dir, 'tx.sql')), 'RESOLVED writes no audit row');
  assert.deepEqual(routineResetBlockers(inc), []);
  assert.deepEqual(lockState(inc), { present: false });
  const again = run(
    'incident-clear.sh',
    dir,
    stubs,
    ['--incident-id', ID, '--disposition', 'RESOLVED'],
    { PILOT_1_INCIDENT_LOGS_DIR: inc, PSQL_PURGE_ROWS: '2' },
  );
  assert.equal(again.status, 1);
  assert.match(again.stderr, /no incident lock is present/);
});

test('incident-clear ABANDONED: audit rows first (per tenant, under the advisory lock, refusing duplicates), then manifest + lock; refusal inside the transaction changes nothing; an interrupted clearance is completed without a second attestation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1c-'));
  const stubs = mkStubs(dir);
  const inc = mkIncidentDir();
  const r = run(
    'incident-clear.sh',
    dir,
    stubs,
    [
      '--incident-id',
      ID,
      '--disposition',
      'ABANDONED',
      '--force-abandoned',
      'RCA: purge not appropriate',
      '--json',
    ],
    { PILOT_1_INCIDENT_LOGS_DIR: inc, PSQL_PURGE_ROWS: '0' },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.abandonedAttestationEmitted, true);
  assert.equal(out.purgeAttested, false);
  const tx = fs.readFileSync(path.join(dir, 'tx.sql'), 'utf8');
  assert.match(tx, /pg_advisory_xact_lock\(hashtext\('pilot-1-env-purge'\)\)/);
  assert.match(tx, /FOR v_t IN SELECT id FROM tenants ORDER BY id LOOP/);
  assert.match(tx, /'env\.incident\.abandoned'/);
  assert.match(tx, /already recorded as abandoned/);
  const txArgs = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.args'))
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
    .find((a) => a.includes('-v reason='));
  assert.match(txArgs, /-v reason=RCA: purge not appropriate/);
  assert.match(txArgs, /-v actor_tenant=Telecheck-US/);
  assert.match(txArgs, /-v purge_attested=false/);
  const m = manifestOf(inc);
  assert.equal(m.consumed, true);
  assert.equal(m.disposition, 'ABANDONED');
  assert.equal(m.abandonReason, 'RCA: purge not appropriate');
  assert.ok(!fs.existsSync(path.join(inc, '.incident.lock')));

  // refusal inside the transaction (e.g. actor tenant unknown) → nothing changes
  const inc2 = mkIncidentDir();
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'p1c-'));
  const before2 = snapshot(inc2);
  const r2 = run(
    'incident-clear.sh',
    dir2,
    mkStubs(dir2),
    ['--incident-id', ID, '--disposition', 'ABANDONED', '--force-abandoned', 'r'],
    {
      PILOT_1_INCIDENT_LOGS_DIR: inc2,
      PSQL_TX_EXIT: '3',
      PSQL_TX_STDERR: 'ERROR:  CLEAR_REFUSED: actor tenant Telecheck-XX does not exist',
    },
  );
  assert.equal(r2.status, 1, r2.stderr);
  assert.match(r2.stderr, /actor tenant Telecheck-XX does not exist/);
  assert.deepEqual(snapshot(inc2), before2);
  // a DB error inside the transaction → exit 3, nothing changes
  const inc3 = mkIncidentDir();
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'p1c-'));
  const before3 = snapshot(inc3);
  const r3 = run(
    'incident-clear.sh',
    dir3,
    mkStubs(dir3),
    ['--incident-id', ID, '--disposition', 'ABANDONED', '--force-abandoned', 'r'],
    {
      PILOT_1_INCIDENT_LOGS_DIR: inc3,
      PSQL_TX_EXIT: '2',
      PSQL_TX_STDERR: 'server closed the connection unexpectedly',
    },
  );
  assert.equal(r3.status, 3, r3.stderr);
  assert.deepEqual(snapshot(inc3), before3);

  // interrupted clearance: attestation committed + manifest consumed (ABANDONED) but the lock survived
  const inc4 = mkIncidentDir({ consumed: true, disposition: 'ABANDONED' });
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), 'p1c-'));
  const r4 = run(
    'incident-clear.sh',
    dir4,
    mkStubs(dir4),
    ['--incident-id', ID, '--disposition', 'ABANDONED', '--force-abandoned', 'r', '--json'],
    { PILOT_1_INCIDENT_LOGS_DIR: inc4, PSQL_ABANDON_ROWS: '2' },
  );
  assert.equal(r4.status, 0, r4.stderr);
  const out4 = JSON.parse(r4.stdout);
  assert.equal(out4.completedInterruptedClearance, true);
  assert.equal(out4.abandonedAttestationEmitted, false, 'no second attestation');
  assert.ok(!fs.existsSync(path.join(dir4, 'tx.sql')));
  assert.ok(!fs.existsSync(path.join(inc4, '.incident.lock')));
});

test('incident-log-gc: dry run lists without deleting; execution deletes exactly the eligible set; lifecycle busy / missing directory refuse', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1c-'));
  const stubs = mkStubs(dir);
  const inc = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  for (const [id, opts] of [
    ['old-consumed', { consumed: true, ageDays: 40 }],
    ['old-open', { consumed: false, ageDays: 40 }],
    ['young', { consumed: true, ageDays: 2 }],
  ]) {
    const src = mkIncidentDir({ id, lock: false, ...opts });
    for (const f of fs.readdirSync(src)) {
      fs.copyFileSync(path.join(src, f), path.join(inc, f));
      const st = fs.statSync(path.join(src, f));
      fs.utimesSync(path.join(inc, f), st.atime, st.mtime);
    }
  }
  fs.writeFileSync(
    path.join(inc, '.incident.lock'),
    JSON.stringify({ incidentId: 'young', openedAt: 'x', openedBy: 't' }),
  );
  const before = snapshot(inc);
  let r = run('incident-log-gc.sh', dir, stubs, ['--dry-run', '--json'], {
    PILOT_1_INCIDENT_LOGS_DIR: inc,
  });
  assert.equal(r.status, 0, r.stderr);
  let out = JSON.parse(r.stdout);
  assert.equal(out.dryRun, true);
  assert.deepEqual(
    out.deletions.map((d) => d.id),
    ['old-consumed'],
  );
  assert.deepEqual(out.deleted, []);
  assert.deepEqual(snapshot(inc), before, 'dry run changed the directory');
  r = run('incident-log-gc.sh', dir, stubs, ['--json'], { PILOT_1_INCIDENT_LOGS_DIR: inc });
  assert.equal(r.status, 0, r.stderr);
  out = JSON.parse(r.stdout);
  assert.deepEqual(out.deleted.sort(), ['old-consumed-art0.age', 'old-consumed.manifest.json']);
  assert.ok(fs.existsSync(path.join(inc, '.incident.lock')));
  assert.ok(fs.existsSync(path.join(inc, 'old-open.manifest.json')));
  assert.ok(fs.existsSync(path.join(inc, 'young.manifest.json')));
  r = run('incident-log-gc.sh', dir, stubs, ['--min-age-days', '1', '--dry-run', '--json'], {
    PILOT_1_INCIDENT_LOGS_DIR: inc,
  });
  assert.equal(JSON.parse(r.stdout).deletions.length, 0, 'the lock still protects young');
  assert.equal(
    run('incident-log-gc.sh', dir, stubs, ['--min-age-days', '0'], {
      PILOT_1_INCIDENT_LOGS_DIR: inc,
    }).status,
    2,
  );
  assert.equal(
    run('incident-log-gc.sh', dir, stubs, [], { PILOT_1_INCIDENT_LOGS_DIR: inc, FLOCK_BUSY: '1' })
      .status,
    1,
  );
  assert.equal(
    run('incident-log-gc.sh', dir, stubs, [], { PILOT_1_INCIDENT_LOGS_DIR: path.join(inc, 'nope') })
      .status,
    1,
  );
  const human = run('incident-log-gc.sh', dir, stubs, ['--dry-run'], {
    PILOT_1_INCIDENT_LOGS_DIR: inc,
  });
  assert.match(human.stdout, /DRY RUN: incident-log-gc/);
});

test('pilot-1-close-wipe: --confirm required; refused while a lock or an unconsumed manifest exists (nothing changed); wipes every file otherwise and records the list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1c-'));
  const stubs = mkStubs(dir);
  const locked = mkIncidentDir();
  assert.equal(
    run('pilot-1-close-wipe.sh', dir, stubs, [], { PILOT_1_INCIDENT_LOGS_DIR: locked }).status,
    2,
  );
  const b1 = snapshot(locked);
  let r = run('pilot-1-close-wipe.sh', dir, stubs, ['--confirm'], {
    PILOT_1_INCIDENT_LOGS_DIR: locked,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /incident lock present/);
  assert.deepEqual(snapshot(locked), b1);
  const open = mkIncidentDir({ lock: false });
  const b2 = snapshot(open);
  r = run('pilot-1-close-wipe.sh', dir, stubs, ['--confirm'], { PILOT_1_INCIDENT_LOGS_DIR: open });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /unconsumed manifest/);
  assert.deepEqual(snapshot(open), b2);
  assert.equal(
    run('pilot-1-close-wipe.sh', dir, stubs, ['--confirm'], {
      PILOT_1_INCIDENT_LOGS_DIR: open,
      FLOCK_BUSY: '1',
    }).status,
    1,
  );
  const done = mkIncidentDir({ lock: false, consumed: true, artifacts: 2 });
  r = run('pilot-1-close-wipe.sh', dir, stubs, ['--confirm', '--json'], {
    PILOT_1_INCIDENT_LOGS_DIR: done,
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'wiped');
  assert.equal(out.actor, 'evans@test-host');
  assert.deepEqual(out.removed.sort(), [`${ID}-art0.age`, `${ID}-art1.age`, `${ID}.manifest.json`]);
  assert.deepEqual(fs.readdirSync(done), []);
});
