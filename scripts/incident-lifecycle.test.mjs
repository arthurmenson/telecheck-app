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
  assertNoDotDot,
  validateLifecycleManifest,
  writeAll,
} from './lib/incident-writers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];
const ID = '2026-09-08T15-45Z-cat1-01';
const DAY = 24 * 60 * 60 * 1000;

function mkIncidentDir({
  into,
  id = ID,
  consumed = false,
  lock = true,
  lockId = id,
  ageDays = 0,
  disposition,
  artifacts = 1,
  status = 'SUCCESS',
} = {}) {
  const dir = into ?? fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const capturedAt = new Date(Date.now() - ageDays * DAY).toISOString();
  const list = [];
  for (let i = 0; i < artifacts; i++) {
    const p = path.join(dir, `${id}-art${i}.age`);
    fs.writeFileSync(p, Buffer.concat([Buffer.from(AGE_HEADER, 'latin1'), Buffer.alloc(40, 7)]));
    list.push({ path: p, plaintextBytes: 10, ciphertextBytes: AGE_HEADER.length + 40 });
  }
  const manifest = { incidentId: id, status, capturedAt, artifacts: list, consumed };
  if (disposition) manifest.disposition = disposition;
  else if (consumed) manifest.disposition = 'RESOLVED';
  if (consumed) manifest.clearedAt = capturedAt;
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
    mkIncidentDir({ id, lock: false, ...opts, into: dir });
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
  assert.throws(() => gcPlan(dir, { minAgeDays: 29 }), />= 30/);
  assert.throws(() => gcPlan(dir, { minAgeDays: 1 }), />= 30/);
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
  mkIncidentDir({ id: 'aged', lock: false, consumed: true, ageDays: 40, into: blocked });
  fs.mkdirSync(path.join(blocked, '.incident.lock'));
  const p2 = gcPlan(blocked, { minAgeDays: 30 });
  assert.deepEqual(p2.deletions, []);
  assert.match(p2.skipped[0].reason, /cannot be inspected/);
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

test("writers (Codex R1): artifacts come from the validated inventory only — a prefix collision never claims another incident's evidence; unlisted files are left alone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const copy = (id, opts) => {
    mkIncidentDir({ id, lock: false, ...opts, into: dir });
  };
  copy('inc', { consumed: true, ageDays: 40, artifacts: 2 });
  copy('inc-2', { consumed: false, ageDays: 1, artifacts: 1 }); // young, unconsumed, and locked below
  fs.writeFileSync(path.join(dir, 'inc-unlisted.age'), 'x'); // shares the prefix, not inventoried
  fs.writeFileSync(
    path.join(dir, '.incident.lock'),
    JSON.stringify({ incidentId: 'inc-2', openedAt: 'x', openedBy: 't' }),
  );
  const plan = gcPlan(dir, { minAgeDays: 30 });
  assert.deepEqual(
    plan.deletions.map((d) => d.id),
    ['inc'],
  );
  assert.deepEqual(plan.deletions[0].artifacts, ['inc-art0.age', 'inc-art1.age']);
  const deleted = gcExecute(dir, plan);
  assert.deepEqual(deleted.sort(), ['inc-art0.age', 'inc-art1.age', 'inc.manifest.json']);
  assert.ok(fs.existsSync(path.join(dir, 'inc-2-art0.age')), 'inc-2 evidence must survive');
  assert.ok(fs.existsSync(path.join(dir, 'inc-2.manifest.json')));
  assert.ok(fs.existsSync(path.join(dir, 'inc-unlisted.age')), 'unlisted files are never claimed');
  assert.ok(fs.existsSync(path.join(dir, '.incident.lock')));
  // an inventory that lists a file outside the directory or of another name refuses the whole manifest
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  mkIncidentDir({ id: 'aged', lock: false, consumed: true, ageDays: 40, into: bad });
  const mf = path.join(bad, 'aged.manifest.json');
  const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
  man.artifacts.push({
    path: path.join(bad, 'other-victim.age'),
    plaintextBytes: 1,
    ciphertextBytes: 1,
  });
  fs.writeFileSync(mf, JSON.stringify(man));
  const t = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(mf, t, t);
  fs.writeFileSync(path.join(bad, 'other-victim.age'), 'x');
  const p2 = gcPlan(bad, { minAgeDays: 30 });
  assert.deepEqual(p2.deletions, []);
  assert.match(p2.skipped[0].reason, /inventory refused/);
  // gcExecute refuses a tampered plan naming another incident's file
  assert.throws(
    () =>
      gcExecute(bad, {
        deletions: [
          { id: 'aged', manifest: 'aged.manifest.json', artifacts: ['other-victim.age'] },
        ],
      }),
    /not an artifact of aged/,
  );
  assert.ok(fs.existsSync(path.join(bad, 'other-victim.age')));
});

test('writers (Codex R1): a present lock without a valid identity blocks every GC deletion and close-wipe; incomplete lifecycle manifests are never eligible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  mkIncidentDir({ id: 'aged', lock: false, consumed: true, ageDays: 40, into: dir });
  for (const lockBody of [
    '{}',
    '{"incidentId": 12}',
    '{"incidentId": "../x"}',
    '{"incidentId": null}',
  ]) {
    fs.writeFileSync(path.join(dir, '.incident.lock'), lockBody);
    const plan = gcPlan(dir, { minAgeDays: 30 });
    assert.deepEqual(plan.deletions, [], lockBody);
    assert.match(plan.skipped[0].reason, /blocks every deletion/, lockBody);
    assert.match(closeWipeBlockers(dir).join(';'), /incident lock present/, lockBody);
    assert.match(
      routineResetBlockers(dir).join(';'),
      /incident lock present \(malformed\)/,
      lockBody,
    );
  }
  fs.rmSync(path.join(dir, '.incident.lock'));
  assert.equal(
    gcPlan(dir, { minAgeDays: 30 }).deletions.length,
    1,
    'a valid state is eligible again',
  );
  // incomplete manifests: validator + GC + close-wipe agree
  const t = new Date(Date.now() - 40 * DAY);
  const cases = [
    ['{"consumed": true, "capturedAt": "not-a-date"}', /capturedAt|incidentId/],
    [
      JSON.stringify({
        incidentId: 'aged',
        status: 'SUCCESS',
        capturedAt: t.toISOString(),
        artifacts: [],
        consumed: true,
      }),
      /disposition/,
    ],
    [
      JSON.stringify({
        incidentId: 'aged',
        status: 'SUCCESS',
        capturedAt: t.toISOString(),
        artifacts: [],
        consumed: true,
        disposition: 'RESOLVED',
      }),
      /clearedAt/,
    ],
    [
      JSON.stringify({
        incidentId: 'aged',
        status: 'SUCCESS',
        capturedAt: t.toISOString(),
        artifacts: [{}],
        consumed: true,
        disposition: 'RESOLVED',
        clearedAt: t.toISOString(),
      }),
      /artifact entry without a path/,
    ],
    [
      JSON.stringify({
        incidentId: 'other',
        status: 'SUCCESS',
        capturedAt: t.toISOString(),
        artifacts: [],
        consumed: true,
        disposition: 'RESOLVED',
        clearedAt: t.toISOString(),
      }),
      /does not match/,
    ],
    [
      JSON.stringify({
        incidentId: 'aged',
        status: 'SUCCESS',
        capturedAt: t.toISOString(),
        artifacts: [],
        consumed: 'yes',
      }),
      /consumed is not a boolean/,
    ],
  ];
  for (const [body, expect] of cases) {
    const mf = path.join(dir, 'aged.manifest.json');
    fs.writeFileSync(mf, body);
    fs.utimesSync(mf, t, t);
    assert.match(String(validateLifecycleManifest(JSON.parse(body), 'aged')), expect, body);
    const plan = gcPlan(dir, { minAgeDays: 30 });
    assert.deepEqual(plan.deletions, [], body);
    assert.match(plan.skipped[0].reason, /incomplete lifecycle manifest/, body);
    assert.match(closeWipeBlockers(dir).join(';'), /incomplete lifecycle manifest/, body);
  }
});

test('writers (Codex R2): a symlinked incident directory is refused even with a trailing separator; no component may be a link', () => {
  const real = mkIncidentDir({ lock: false, consumed: true });
  const alias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p1alias-')), 'alias');
  fs.symlinkSync(real, alias, 'junction');
  for (const d of [alias, alias + path.sep, alias + '/', alias + '//']) {
    assert.throws(() => closeWipe(d), /symbolic link/, JSON.stringify(d));
    assert.throws(() => gcPlan(d, { minAgeDays: 30 }), /symbolic link/, JSON.stringify(d));
    assert.throws(
      () => consume(d, ID, { disposition: 'RESOLVED', clearedBy: 'x' }),
      /symbolic link/,
      JSON.stringify(d),
    );
    assert.match(closeWipeBlockers(d).join(';'), /symbolic link/, JSON.stringify(d));
  }
  assert.equal(fs.readdirSync(real).length, 2, 'nothing behind the alias was touched');
  // a symlinked PARENT component is refused as well
  const nested = path.join(alias, 'sub');
  fs.mkdirSync(path.join(real, 'sub'));
  assert.match(closeWipeBlockers(nested).join(';'), /symbolic link/);
  assert.throws(() => closeWipe(nested), /symbolic link/);
  assert.throws(() => gcPlan(nested, { minAgeDays: 30 }), /symbolic link/);
});

test('writers (Codex R4): an artifact claimed by two manifests is never deleted on the strength of one of them', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  mkIncidentDir({ into: dir, id: 'inc', lock: false, consumed: true, ageDays: 40, artifacts: 1 });
  mkIncidentDir({ into: dir, id: 'inc-2', lock: true, consumed: false, ageDays: 1, artifacts: 1 }); // active, locked
  // the aged manifest ALSO lists inc-2's artifact
  const mf = path.join(dir, 'inc.manifest.json');
  const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
  man.artifacts.push({
    path: path.join(dir, 'inc-2-art0.age'),
    plaintextBytes: 10,
    ciphertextBytes: AGE_HEADER.length + 40,
  });
  fs.writeFileSync(mf, JSON.stringify(man));
  const t = new Date(Date.now() - 40 * DAY);
  fs.utimesSync(mf, t, t);
  const before = snapshot(dir);
  const plan = gcPlan(dir, { minAgeDays: 30 });
  assert.deepEqual(plan.deletions, [], 'nothing may be deleted while the inventory conflicts');
  const reasons = Object.fromEntries(plan.skipped.map((x) => [x.file, x.reason]));
  assert.match(
    reasons['inc.manifest.json'],
    /conflicting inventory: inc-2-art0\.age also claimed by inc-2/,
  );
  assert.match(reasons['inc-2.manifest.json'], /not consumed/);
  assert.deepEqual(gcExecute(dir, plan), []);
  assert.deepEqual(snapshot(dir), before, 'the directory changed');
  assert.ok(
    fs.existsSync(path.join(dir, 'inc-2-art0.age')),
    "the active incident's evidence survived",
  );
  // the same artifact claimed by a consumed-but-young manifest still blocks
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  mkIncidentDir({ into: dir2, id: 'a', lock: false, consumed: true, ageDays: 40, artifacts: 1 });
  mkIncidentDir({ into: dir2, id: 'b', lock: false, consumed: true, ageDays: 1, artifacts: 0 });
  const mb = path.join(dir2, 'b.manifest.json');
  const manB = JSON.parse(fs.readFileSync(mb, 'utf8'));
  manB.artifacts.push({
    path: path.join(dir2, 'a-art0.age'),
    plaintextBytes: 10,
    ciphertextBytes: AGE_HEADER.length + 40,
  });
  fs.writeFileSync(mb, JSON.stringify(manB));
  const plan2 = gcPlan(dir2, { minAgeDays: 30 });
  assert.deepEqual(plan2.deletions, []);
  assert.match(
    Object.fromEntries(plan2.skipped.map((x) => [x.file, x.reason]))['a.manifest.json'],
    /conflicting inventory/,
  );
});

test('writers (Codex R5): ownership is inferred from every manifest NAME and the active lock — a truncated or FAILED (artifact-less) locked incident still protects its evidence', () => {
  for (const variant of ['truncated', 'failed-no-artifacts', 'lock-only']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
    mkIncidentDir({ into: dir, id: 'inc', lock: false, consumed: true, ageDays: 40, artifacts: 1 });
    // the aged manifest lists inc-2's artifact; inc-2's own manifest cannot vouch for it
    const victim = path.join(dir, 'inc-2-art0.age');
    fs.writeFileSync(
      victim,
      Buffer.concat([Buffer.from(AGE_HEADER, 'latin1'), Buffer.alloc(40, 7)]),
    );
    const mf = path.join(dir, 'inc.manifest.json');
    const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
    man.artifacts.push({
      path: victim,
      plaintextBytes: 10,
      ciphertextBytes: AGE_HEADER.length + 40,
    });
    fs.writeFileSync(mf, JSON.stringify(man));
    const t = new Date(Date.now() - 40 * DAY);
    fs.utimesSync(mf, t, t);
    if (variant === 'truncated')
      fs.writeFileSync(
        path.join(dir, 'inc-2.manifest.json'),
        '{"incidentId": "inc-2", "status": "SUCC',
      );
    if (variant === 'failed-no-artifacts')
      fs.writeFileSync(
        path.join(dir, 'inc-2.manifest.json'),
        JSON.stringify({
          incidentId: 'inc-2',
          status: 'FAILED',
          capturedAt: new Date().toISOString(),
          consumed: false,
        }),
      );
    fs.writeFileSync(
      path.join(dir, '.incident.lock'),
      JSON.stringify({ incidentId: 'inc-2', openedAt: 'x', openedBy: 't' }),
    );
    const before = snapshot(dir);
    const plan = gcPlan(dir, { minAgeDays: 30 });
    assert.deepEqual(plan.deletions, [], variant);
    const reason = Object.fromEntries(plan.skipped.map((x) => [x.file, x.reason]))[
      'inc.manifest.json'
    ];
    assert.match(reason, /ambiguous ownership: inc-2-art0\.age may belong to inc-2/, variant);
    assert.deepEqual(gcExecute(dir, plan), [], variant);
    assert.deepEqual(snapshot(dir), before, `${variant}: the directory changed`);
    assert.ok(fs.existsSync(victim), `${variant}: the active incident's evidence survived`);
  }
  // an unrelated aged manifest whose artifacts share no other id prefix is still collected
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  mkIncidentDir({ into: ok, id: 'solo', lock: false, consumed: true, ageDays: 40, artifacts: 2 });
  fs.writeFileSync(
    path.join(ok, '.incident.lock'),
    JSON.stringify({ incidentId: 'other', openedAt: 'x', openedBy: 't' }),
  );
  assert.deepEqual(
    gcPlan(ok, { minAgeDays: 30 }).deletions.map((d) => d.id),
    ['solo'],
  );
});

test(
  'writers (Codex R5): a manifest entry that is a FIFO or a symlink is never opened for reading — GC and close-wipe report it and the lifecycle cannot hang',
  { skip: process.platform === 'win32' },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
    mkIncidentDir({ into: dir, id: 'aged', lock: false, consumed: true, ageDays: 40 });
    const fifo = spawnSync('mkfifo', [path.join(dir, 'pipe.manifest.json')], { encoding: 'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p1out-')), 'x.json');
    fs.writeFileSync(
      outside,
      JSON.stringify({
        incidentId: 'linked',
        status: 'SUCCESS',
        capturedAt: new Date().toISOString(),
        artifacts: [],
        consumed: true,
        disposition: 'RESOLVED',
        clearedAt: new Date().toISOString(),
      }),
    );
    fs.symlinkSync(outside, path.join(dir, 'linked.manifest.json'));
    const started = Date.now();
    const plan = gcPlan(dir, { minAgeDays: 30 });
    assert.ok(Date.now() - started < 5000, 'the plan must not block on the FIFO');
    const reasons = Object.fromEntries(plan.skipped.map((x) => [x.file, x.reason]));
    assert.match(reasons['pipe.manifest.json'], /not a regular file/);
    assert.match(reasons['linked.manifest.json'], /symbolic link/);
    assert.deepEqual(
      plan.deletions.map((d) => d.id),
      ['aged'],
      'the regular aged manifest is still eligible',
    );
    const blockers = closeWipeBlockers(dir);
    assert.match(
      blockers.join(';'),
      /unexpected entry \(not a regular file\): pipe\.manifest\.json/,
    );
    assert.match(
      blockers.join(';'),
      /unexpected entry \(not a regular file\): linked\.manifest\.json/,
    );
  },
);

test('writers (Codex R3): a literal `symlink/..` path is refused before any normalization — the lexical and physical destinations may differ', () => {
  // /safe/alias -> /real/sub ; configured "/safe/alias/../incident-logs" names
  // /real/incident-logs physically but /safe/incident-logs lexically
  const safe = fs.mkdtempSync(path.join(os.tmpdir(), 'p1safe-'));
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'p1real-'));
  fs.mkdirSync(path.join(real, 'sub'));
  fs.symlinkSync(path.join(real, 'sub'), path.join(safe, 'alias'), 'junction');
  const lexical = path.join(safe, 'incident-logs');
  const physical = path.join(real, 'incident-logs');
  fs.mkdirSync(lexical);
  fs.mkdirSync(physical);
  mkIncidentDir({ into: lexical, lock: false, consumed: true }); // no blockers lexically
  mkIncidentDir({ into: physical, id: 'live', lock: true }); // an ACTIVE incident physically
  const configured = `${safe}${path.sep}alias${path.sep}..${path.sep}incident-logs`;
  const beforeL = snapshot(lexical);
  const beforeP = snapshot(physical);
  assert.throws(() => assertNoDotDot(configured, 'x'), /'\.\.' segments/);
  assert.throws(() => closeWipe(configured), /'\.\.' segments/);
  assert.match(closeWipeBlockers(configured).join(';'), /'\.\.' segments/);
  assert.throws(() => gcPlan(configured, { minAgeDays: 30 }), /'\.\.' segments/);
  assert.throws(
    () => consume(configured, 'live', { disposition: 'RESOLVED', clearedBy: 'x' }),
    /'\.\.' segments/,
  );
  assert.throws(() => removeLock(configured, 'live'), /'\.\.' segments/);
  assert.deepEqual(snapshot(lexical), beforeL, 'lexical destination changed');
  assert.deepEqual(snapshot(physical), beforeP, 'physical destination changed');
  assert.ok(
    fs.existsSync(path.join(physical, '.incident.lock')),
    'the active incident lock survived',
  );
  // a `..` anywhere, including a trailing one and a Windows-style separator, is refused
  for (const bad of ['..', `${lexical}${path.sep}..`, `..${path.sep}x`, 'a/../b', 'a\\..\\b']) {
    assert.throws(() => assertNoDotDot(bad, 'p'), /'\.\.' segments/, bad);
  }
  assertNoDotDot(lexical, 'p'); // plain paths pass
  assertNoDotDot(path.join(lexical, 'x..y', '..z', 'z..'), 'p'); // dots inside names are not segments
});

test('writers (Codex R2): a FAILED capture (no artifact list) can be ABANDONED, collected by GC and does not block close-wipe; residual files are reported, never deleted by GC', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const t = new Date(Date.now() - 40 * DAY);
  // runbook step 5: FAILED manifest without `artifacts`; a partial artifact lingers
  fs.writeFileSync(
    path.join(dir, `${ID}.manifest.json`),
    JSON.stringify({
      incidentId: ID,
      status: 'FAILED',
      capturedAt: t.toISOString(),
      consumed: false,
    }),
  );
  fs.writeFileSync(path.join(dir, `${ID}-partial.age`), 'x');
  fs.writeFileSync(
    path.join(dir, '.incident.lock'),
    JSON.stringify({ incidentId: ID, openedAt: t.toISOString(), openedBy: 't' }),
  );
  assert.equal(
    validateLifecycleManifest(
      JSON.parse(fs.readFileSync(path.join(dir, `${ID}.manifest.json`), 'utf8')),
      ID,
    ),
    null,
    'the documented FAILED shape validates',
  );
  const r = consume(dir, ID, {
    disposition: 'ABANDONED',
    clearedBy: 'x',
    reason: 'capture failed',
    clearedAt: t.toISOString(),
  });
  assert.equal(r.alreadyConsumed, false);
  assert.deepEqual(manifestOf(dir).artifacts, [], 'an explicit empty inventory is recorded');
  assert.equal(manifestOf(dir).status, 'FAILED', 'the failure information is preserved');
  removeLock(dir, ID);
  fs.utimesSync(path.join(dir, `${ID}.manifest.json`), t, t);
  const plan = gcPlan(dir, { minAgeDays: 30 });
  assert.deepEqual(
    plan.deletions.map((d) => d.id),
    [ID],
  );
  assert.deepEqual(plan.deletions[0].artifacts, []);
  assert.deepEqual(plan.deletions[0].residual, [`${ID}-partial.age`]);
  const deleted = gcExecute(dir, plan);
  assert.deepEqual(deleted, [`${ID}.manifest.json`]);
  assert.ok(
    fs.existsSync(path.join(dir, `${ID}-partial.age`)),
    'GC never deletes an uninventoried file',
  );
  // with the manifest gone the residual file is an ordinary regular file: close-wipe removes it
  assert.deepEqual(closeWipeBlockers(dir), []);
  assert.deepEqual(closeWipe(dir), [`${ID}-partial.age`]);
  // and before GC, a consumed FAILED manifest is no close-wipe blocker either
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  fs.writeFileSync(
    path.join(dir2, `${ID}.manifest.json`),
    JSON.stringify({
      incidentId: ID,
      status: 'FAILED',
      capturedAt: t.toISOString(),
      consumed: false,
    }),
  );
  consume(dir2, ID, { disposition: 'ABANDONED', clearedBy: 'x', reason: 'r' });
  assert.deepEqual(closeWipeBlockers(dir2), []);
});

test('writers (Codex R1): manifest rewrites write every byte — a short write never publishes a truncated manifest', () => {
  const dir = mkIncidentDir();
  const before = fs.readFileSync(path.join(dir, `${ID}.manifest.json`), 'utf8');
  const origWrite = fs.writeSync;
  // (a) chunked writes (1 byte per call) still land the complete document
  fs.writeSync = (fd, buf, off, len) => origWrite(fd, buf, off, Math.min(1, len));
  try {
    consume(dir, ID, {
      disposition: 'RESOLVED',
      clearedBy: 'x',
      clearedAt: '2026-09-08T16:00:00Z',
    });
  } finally {
    fs.writeSync = origWrite;
  }
  const m = manifestOf(dir);
  assert.equal(m.consumed, true);
  assert.equal(m.clearedBy, 'x');
  // (b) a zero-length write (disk full) aborts before the rename; the original stays intact
  const dir2 = mkIncidentDir();
  const before2 = fs.readFileSync(path.join(dir2, `${ID}.manifest.json`), 'utf8');
  fs.writeSync = () => 0;
  try {
    assert.throws(
      () => consume(dir2, ID, { disposition: 'RESOLVED', clearedBy: 'x' }),
      /short write/,
    );
  } finally {
    fs.writeSync = origWrite;
  }
  assert.equal(fs.readFileSync(path.join(dir2, `${ID}.manifest.json`), 'utf8'), before2);
  assert.deepEqual(
    fs.readdirSync(dir2).filter((f) => f.includes('.tmp-')),
    [],
    'no temp file left behind',
  );
  assert.notEqual(before, before2 + 'x'); // keep `before` referenced
  // writeAll itself
  const tmpf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p1w-')), 'f');
  const fd = fs.openSync(tmpf, 'w');
  try {
    assert.equal(writeAll(fd, Buffer.from('hello')), 5);
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(fs.readFileSync(tmpf, 'utf8'), 'hello');
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
  *"payload->>'clearedAt'"*"env.incident.abandoned"*) printf '%s\\n' "\${PSQL_COMMITTED_ABANDON:-2026-09-08T15:00:00Z	prior@host	committed reason}"; exit 0 ;;
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
  r = run(
    'incident-clear.sh',
    dir,
    stubs,
    ['--incident-id', ID, '--disposition', 'ABANDONED', '--force-abandoned', 'r'],
    { PILOT_1_INCIDENT_LOGS_DIR: inc, TMPDIR: inc },
  );
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /TMPDIR must not be inside the incident directory/);
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
  assert.equal(out4.abandonmentReplayedFromAudit, true);
  assert.equal(out4.clearedBy, 'prior@host', 'the COMMITTED actor, not the retry');
  assert.equal(out4.clearedAt, '2026-09-08T15:00:00Z');
  assert.match(r4.stderr, /already committed with reason 'committed reason'/);
  // interrupted AFTER commit but BEFORE consume: the manifest gets the committed reason, never the retry's
  const inc5 = mkIncidentDir();
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'p1c-'));
  const r5 = run(
    'incident-clear.sh',
    dir5,
    mkStubs(dir5),
    [
      '--incident-id',
      ID,
      '--disposition',
      'ABANDONED',
      '--force-abandoned',
      'DIFFERENT retry reason',
      '--json',
    ],
    { PILOT_1_INCIDENT_LOGS_DIR: inc5, PSQL_ABANDON_ROWS: '2' },
  );
  assert.equal(r5.status, 0, r5.stderr);
  assert.ok(!fs.existsSync(path.join(dir5, 'tx.sql')), 'no second attestation');
  const m5 = manifestOf(inc5);
  assert.equal(m5.abandonReason, 'committed reason');
  assert.equal(m5.clearedBy, 'prior@host');
  assert.equal(m5.clearedAt, '2026-09-08T15:00:00Z');
  assert.ok(!fs.existsSync(path.join(inc5, '.incident.lock')));
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
    mkIncidentDir({ id, lock: false, ...opts, into: inc });
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
  // the ratified 30-day floor cannot be lowered (Codex R1)
  for (const days of ['0', '1', '29']) {
    const low = run('incident-log-gc.sh', dir, stubs, ['--min-age-days', days, '--dry-run'], {
      PILOT_1_INCIDENT_LOGS_DIR: inc,
    });
    assert.equal(low.status, 2, `--min-age-days ${days}: ${low.stderr}`);
    assert.match(low.stderr, />= 30/);
  }
  assert.ok(fs.existsSync(path.join(inc, 'young.manifest.json')), 'young survives every attempt');
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
  // Codex R3: literal `symlink/..` paths — built by string concatenation, never
  // normalized by the fixture — are usage errors for every configured path
  {
    const safe = fs.mkdtempSync(path.join(os.tmpdir(), 'p1safe-'));
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'p1real-'));
    fs.mkdirSync(path.join(real, 'sub'));
    fs.symlinkSync(path.join(real, 'sub'), path.join(safe, 'alias'), 'junction');
    const viaAlias = `${safe}${path.sep}alias${path.sep}..${path.sep}incident-logs`;
    fs.mkdirSync(path.join(real, 'incident-logs'));
    fs.mkdirSync(path.join(safe, 'incident-logs'));
    const beforeR = snapshot(path.join(real, 'incident-logs'));
    for (const [script, args, env] of [
      ['incident-log-gc.sh', ['--dry-run'], { PILOT_1_INCIDENT_LOGS_DIR: viaAlias }],
      [
        'incident-log-gc.sh',
        ['--dry-run'],
        {
          PILOT_1_INCIDENT_LOGS_DIR: inc,
          PILOT_1_LOCK_FILE: `${viaAlias}${path.sep}lifecycle.lock`,
        },
      ],
      ['pilot-1-close-wipe.sh', ['--confirm'], { PILOT_1_INCIDENT_LOGS_DIR: viaAlias }],
      [
        'pilot-1-close-wipe.sh',
        ['--confirm'],
        {
          PILOT_1_INCIDENT_LOGS_DIR: inc,
          PILOT_1_LOCK_FILE: `${viaAlias}${path.sep}lifecycle.lock`,
        },
      ],
      [
        'incident-clear.sh',
        ['--incident-id', ID, '--disposition', 'RESOLVED'],
        { PILOT_1_INCIDENT_LOGS_DIR: viaAlias },
      ],
      [
        'incident-clear.sh',
        ['--incident-id', ID, '--disposition', 'RESOLVED'],
        {
          PILOT_1_INCIDENT_LOGS_DIR: inc,
          PILOT_1_LOCK_FILE: `${viaAlias}${path.sep}lifecycle.lock`,
        },
      ],
      // MSYS rewrites TMPDIR (and collapses `..`) before bash sees it, so this case is Linux-only
      ...(process.platform === 'win32'
        ? []
        : [
            [
              'incident-clear.sh',
              ['--incident-id', ID, '--disposition', 'RESOLVED'],
              { PILOT_1_INCIDENT_LOGS_DIR: inc, TMPDIR: viaAlias },
            ],
          ]),
    ]) {
      const bad = run(script, dir, stubs, args, env);
      assert.equal(bad.status, 2, `${script} ${JSON.stringify(env)}: ${bad.stderr}`);
      assert.match(bad.stderr, /must not contain '\.\.' segments/, script);
    }
    assert.deepEqual(
      snapshot(path.join(real, 'incident-logs')),
      beforeR,
      'the physical directory changed',
    );
    assert.deepEqual(
      fs.readdirSync(path.join(safe, 'incident-logs')),
      [],
      'the lexical directory changed',
    );
    assert.ok(
      !fs.existsSync(path.join(real, 'incident-logs', 'lifecycle.lock')),
      'a lock file was created through the alias',
    );
  }
  // the lifecycle lock may not live inside the incident directory (Codex R2):
  // neither an inventoried artifact nor an absent .incident.lock may be opened
  for (const lockPath of [
    path.join(inc, 'old-open-art0.age'),
    path.join(inc, '.incident.lock.new'),
    path.join(inc, 'x', '..', 'lifecycle.lock'),
  ]) {
    const beforeLock = snapshot(inc);
    const bad = run('incident-log-gc.sh', dir, stubs, ['--dry-run'], {
      PILOT_1_INCIDENT_LOGS_DIR: inc,
      PILOT_1_LOCK_FILE: lockPath,
    });
    assert.equal(bad.status, 2, `${lockPath}: ${bad.stderr}`);
    assert.match(bad.stderr, /must not be inside the incident directory/);
    assert.deepEqual(snapshot(inc), beforeLock, `${lockPath}: the incident tree changed`);
  }
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
