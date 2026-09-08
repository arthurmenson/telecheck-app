// DB-free regression for the Pilot 1 env-purge package:
//   - scripts/lib/purge-plan.mjs (classification validation, deterministic plan)
//   - scripts/lib/incident-manifest.mjs (read-only manifest / lock verification)
//   - scripts/pilot-1-env-purge.sh control flow with a stubbed psql (which
//     emulates command tags), compose, curl and flock, a scratch lock file
//     and a scratch incident directory (byte-for-byte untouched)
// The real-Postgres proof lives in tests/integration/pilot-1-env-purge.test.ts.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AGE_HEADER,
  lockState,
  routineResetBlockers,
  verifyForPurge,
} from './lib/incident-manifest.mjs';
import {
  loadClassification,
  matviewsOfClass,
  planDigest,
  renderPlan,
  tablesOfClass,
  validateClassification,
} from './lib/purge-plan.mjs';
import { ensureStateDir, writeJournal } from './lib/runtime-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'pilot-1-env-purge.sh');
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];
const UUID = '123e4567-e89b-12d3-a456-426614174000';

// ---------------------------------------------------------------------------
// purge-plan
// ---------------------------------------------------------------------------

test('classification: loads, every table classified, accounts is scoped-delete, evidence tables preserved, snapshots go with submissions, no phantom tables, the materialized view is inventoried', () => {
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
  assert.equal(map.tables.idempotency_keys.class, 'scoped-delete');
  assert.equal(map.tables.identity_idempotency_keys.class, 'scoped-delete');
  assert.equal(map.tables.idempotency_keys.tombstone.column, 'response_body');
  assert.equal(map.tables.identity_idempotency_keys.tombstone.column, 'response_body');
  assert.match(
    map.tables.idempotency_keys.predicate,
    /actor_id NOT IN \(SELECT account_id FROM public\.accounts WHERE cohort_classification <> 'participant'\)/,
  );
  assert.equal(map.tables.consult_care_binding.disableUserTriggersForTruncate, true);
  assert.equal(map.tables.consult_care_submission.disableUserTriggersForTruncate, true);
  assert.equal(map.tables.migration_history, undefined, 'not a table');
  assert.equal(map.tables.rbac_roles, undefined, 'test-bootstrap fixture, not a migration table');
  assert.deepEqual(matviewsOfClass(map, 'allowlist'), ['interaction_signal_current_state_mv']);
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
  m = clone();
  m.materializedViews.interaction_signal_current_state_mv.class = 'scoped-delete';
  assert.throws(() => validateClassification(m), /must be allowlist or preserved/);
  m = clone();
  m.tables.interaction_signal_current_state_mv = { class: 'allowlist', why: 'x' };
  assert.throws(() => validateClassification(m), /both as a table and as a materialized view/);
  m = clone();
  m.tables.sessions.tombstone = { column: 'x', value: 'NULL' };
  assert.throws(
    () => validateClassification(m),
    /tombstone is only valid on a scoped-delete table/,
  );
  m = clone();
  m.tables.idempotency_keys.tombstone = {
    column: 'response_body',
    value: 'NULL; DROP TABLE tenants',
  };
  assert.throws(() => validateClassification(m), /may not contain/);
  m = clone();
  m.tables.idempotency_keys.tombstone = { column: 'bad name', value: 'NULL' };
  assert.throws(() => validateClassification(m), /identifier column/);
});

test('plan: deterministic; guarded truncate; one TRUNCATE ... RESTRICT; scoped DELETEs before accounts; materialized view refreshed after the deletes and post-checked; never CASCADE', () => {
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
  const tomb = sql.indexOf(
    "UPDATE public.idempotency_keys SET response_body = jsonb_build_object('purged', true, 'by', 'scripts/pilot-1-env-purge.sh') WHERE response_body IS DISTINCT FROM (jsonb_build_object('purged', true, 'by', 'scripts/pilot-1-env-purge.sh'));",
  );
  assert.ok(tomb > 0, 'the replay-cache body tombstone must be rendered');
  assert.ok(
    tomb > sql.indexOf('DELETE FROM public.idempotency_keys WHERE'),
    'the tombstone follows the scoped delete',
  );
  assert.match(sql, /idempotency_keys rows still carry a cached response_body/);
  assert.match(sql, /identity_idempotency_keys rows still carry a cached response_body/);
  assert.ok(!/UPDATE public\.accounts/.test(sql), 'accounts is never updated');
  const refresh = sql.indexOf(
    'REFRESH MATERIALIZED VIEW public.interaction_signal_current_state_mv;',
  );
  assert.ok(refresh > acc, 'the projection is refreshed after its sources are purged');
  assert.ok(refresh < sql.indexOf('DO $$'), 'the refresh precedes the post-checks');
  assert.match(sql, /rows survived in materialized view interaction_signal_current_state_mv/);
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
  assert.ok(
    afterDelete.indexOf('injected after delete') < afterDelete.indexOf('REFRESH MATERIALIZED VIEW'),
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
    const realSize = (a.header ?? AGE_HEADER).length + (a.size ?? 40);
    if (a.ciphertextBytes !== null) entry.ciphertextBytes = a.ciphertextBytes ?? realSize;
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
      'missing ciphertextBytes',
      mkIncidentDir({
        artifacts: [{ name: '2026-09-08T15-45Z-cat1-01-db.sql.age', ciphertextBytes: null }],
      }),
      undefined,
      /ciphertextBytes missing/,
    ],
    [
      'truncated ciphertext',
      mkIncidentDir({
        artifacts: [
          {
            name: '2026-09-08T15-45Z-cat1-01-db.sql.age',
            size: 20,
            ciphertextBytes: AGE_HEADER.length + 40,
          },
        ],
      }),
      undefined,
      /!= recorded ciphertextBytes/,
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

test('incident-manifest: a symlink artifact, or one reached through a symlinked directory, cannot authorize a purge — containment is checked on real locations', () => {
  const id = '2026-09-08T15-45Z-cat1-01';
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'p1out-'));
  const external = path.join(outside, `${id}-db.sql.age`);
  fs.writeFileSync(
    external,
    Buffer.concat([Buffer.from(AGE_HEADER, 'latin1'), Buffer.alloc(40, 7)]),
  );
  // (a) symlinked intermediate directory (junction on Windows, dir symlink elsewhere)
  const viaDir = mkIncidentDir({ artifacts: [] });
  fs.symlinkSync(outside, path.join(viaDir, 'sub'), 'junction');
  const mf = path.join(viaDir, `${id}.manifest.json`);
  const man = JSON.parse(fs.readFileSync(mf, 'utf8'));
  man.artifacts = [
    {
      path: path.join(viaDir, 'sub', `${id}-db.sql.age`),
      plaintextBytes: 10,
      ciphertextBytes: AGE_HEADER.length + 40,
    },
  ];
  fs.writeFileSync(mf, JSON.stringify(man));
  assert.match(verifyForPurge(viaDir, id).reason, /resolves outside the incident directory/);
  // (b) file symlink artifact (Windows needs a privilege for file symlinks; CI runs it)
  const viaLink = mkIncidentDir({ artifacts: [] });
  let linked = true;
  try {
    fs.symlinkSync(external, path.join(viaLink, `${id}-db.sql.age`), 'file');
  } catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') linked = false;
    else throw e;
  }
  if (linked) {
    const mf2 = path.join(viaLink, `${id}.manifest.json`);
    const man2 = JSON.parse(fs.readFileSync(mf2, 'utf8'));
    man2.artifacts = [
      {
        path: path.join(viaLink, `${id}-db.sql.age`),
        plaintextBytes: 10,
        ciphertextBytes: AGE_HEADER.length + 40,
      },
    ];
    fs.writeFileSync(mf2, JSON.stringify(man2));
    assert.match(verifyForPurge(viaLink, id).reason, /symbolic link/);
  }
});

test('incident-manifest: inspection failures are refusals, never a clean state; lock-state reports presence / id / unreadability', () => {
  const notDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-')), 'file');
  fs.writeFileSync(notDir, 'x');
  assert.match(routineResetBlockers(notDir).join(';'), /cannot inspect the incident directory/);
  assert.match(verifyForPurge(notDir, '2026-09-08T15-45Z-cat1-01').reason, /cannot inspect/);
  const lockDir = mkIncidentDir({ lock: false });
  fs.mkdirSync(path.join(lockDir, '.incident.lock'));
  assert.match(routineResetBlockers(lockDir).join(';'), /incident lock cannot be inspected/);
  assert.match(verifyForPurge(lockDir, '2026-09-08T15-45Z-cat1-01').reason, /lock unreadable/);
  assert.equal(lockState(lockDir).unreadable, true);
  const manDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  fs.mkdirSync(path.join(manDir, 'x.manifest.json'));
  assert.match(routineResetBlockers(manDir).join(';'), /unreadable manifest/);
  assert.deepEqual(lockState(fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'))), { present: false });
  assert.deepEqual(lockState(mkIncidentDir()), {
    present: true,
    incidentId: '2026-09-08T15-45Z-cat1-01',
  });
  // a dangling incident lock (symlink to nothing) is PRESENT and uninspectable — a blocker, never absent (Codex R7)
  const dangling = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  let linked = true;
  try {
    fs.symlinkSync(path.join(dangling, 'gone.json'), path.join(dangling, '.incident.lock'), 'file');
  } catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') linked = false;
    else throw e;
  }
  if (linked) {
    assert.deepEqual(lockState(dangling), { present: true, unreadable: true, code: 'SYMLINK' });
    assert.match(
      routineResetBlockers(dangling).join(';'),
      /incident lock cannot be inspected \(SYMLINK\)/,
    );
    assert.match(verifyForPurge(dangling, '2026-09-08T15-45Z-cat1-01').reason, /lock unreadable/);
  }
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
// script control flow (stubbed psql + compose + curl + flock)
// ---------------------------------------------------------------------------

function snapshot(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      out[f] = { dir: true, entries: fs.readdirSync(p).sort() };
      continue;
    }
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
 * transaction; -c / stdin are the small lookups, matched by content). Like the
 * real psql it prints command tags (BEGIN / COMMIT / SET) unless -q is given —
 * so a lookup that forgets -q reads a tag instead of its value (Codex R3).
 * PSQL_BYPASS / PSQL_UNCLASSIFIED / PSQL_PRIOR / PSQL_RECONCILE / PSQL_ATTEST /
 * PSQL_TX_EXIT / PSQL_TX_STDERR / PSQL_SEED_EXIT drive the answers.
 */
function mkStubs(dir) {
  const d = dir.replace(/\\/g, '/');
  const psql = path.join(dir, 'psql');
  fs.writeFileSync(
    psql,
    `#!/usr/bin/env bash
n=$(ls "${d}"/call-*.args 2>/dev/null | wc -l)
printf '%s\\n' "$*" > "${d}/call-$n.args"
file=""; cmd=""; quiet=0
for ((i=1;i<=$#;i++)); do
  if [ "\${!i}" = "-c" ]; then j=$((i+1)); cmd="\${!j}"; fi
  if [ "\${!i}" = "-f" ]; then j=$((i+1)); file="\${!j}"; fi
  if [ "\${!i}" = "-q" ]; then quiet=1; fi
done
if [ -n "$file" ]; then
  case "$file" in
    *pilot-1-baseline-seed.sql) echo seeded >> "${d}/seed.ran"; exit "\${PSQL_SEED_EXIT:-0}" ;;
    *) cp "$file" "${d}/tx.sql"; [ -n "\${PSQL_TX_STDERR:-}" ] && echo "\${PSQL_TX_STDERR}" >&2; exit "\${PSQL_TX_EXIT:-0}" ;;
  esac
fi
if [ -n "$cmd" ]; then sql="$cmd"; else sql="$(cat)"; fi
printf '%s' "$sql" > "${d}/call-$n.sql"
tags() { [ "$quiet" = "1" ] || printf '%s\\n' "$@"; }
case "$sql" in
  *rolsuper*) printf '%s|t|1\\n' "\${PSQL_BYPASS:-t}"; exit 0 ;;
  *information_schema.columns*) echo 1; exit 0 ;;
  *json_agg*) echo "[]"; exit 0 ;;
  *"cohort_classification = 'unclassified'"*) echo "\${PSQL_UNCLASSIFIED:-0}"; exit 0 ;;
  *"payload->>'mode'"*) op=$(printf '%s\\n' "$*" | sed -n 's/.*-v op=\\([^ ]*\\).*/\\1/p'); case " \${PSQL_NOATTEST_OPS:-} " in *" $op "*) exit 0 ;; esac; printf '%s\\n' "\${PSQL_ATTEST:-}"; exit 0 ;;
  *"pg_advisory_xact_lock"*"NEWER="*) tags SET BEGIN; printf 'NEWER=%s\\n' "\${PSQL_NEWER_OP:-}"; tags COMMIT; exit 0 ;;
  *"pg_advisory_xact_lock"*"ATTESTED="*) if [ "\${PSQL_RECONCILE:-0}" = "ERR" ]; then echo "lock timeout" >&2; exit 2; fi; echo locked > "${d}/reconcile.locked"; tags SET BEGIN; printf '\\nATTESTED=%s\\n' "\${PSQL_RECONCILE:-0}"; tags COMMIT; exit 0 ;;
  *"payload->>'operationId' = :'op'"*) op=$(printf '%s\\n' "$*" | sed -n 's/.*-v op=\\([^ ]*\\).*/\\1/p'); case " \${PSQL_NOATTEST_OPS:-} " in *" $op "*) echo 0 ;; *) echo 1 ;; esac; exit 0 ;;
  *"payload->>'incidentId'"*) echo "\${PSQL_PRIOR:-0}"; exit 0 ;;
  *) echo "stub psql: unexpected SQL" >&2; exit 9 ;;
esac
`,
    { mode: 0o755 },
  );
  const compose = path.join(dir, 'compose');
  fs.writeFileSync(
    compose,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${d}/compose.log"\ncase "$*" in *redis-cli*) printf '%s\\n' "\${REDIS_REPLY:-OK}" ;; esac\nexit 0\n`,
    { mode: 0o755 },
  );
  const curl = path.join(dir, 'curl');
  fs.writeFileSync(
    curl,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${d}/curl.log"\nprintf '%s' "\${CURL_CODE:-200}"\nexit 0\n`,
    { mode: 0o755 },
  );
  // flock stub: records the call; FLOCK_BUSY=1 emulates a held lock.
  const flock = path.join(dir, 'flock');
  fs.writeFileSync(
    flock,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${d}/flock.log"\n[ "\${FLOCK_BUSY:-0}" = "1" ] && exit 1\nexit 0\n`,
    { mode: 0o755 },
  );
  return { psql, compose, curl, flock };
}

function run(dir, stubs, args, extraEnv = {}) {
  return spawnSync(bash, [...bashArgs, SCRIPT, ...args], {
    cwd: path.join(here, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      PILOT_1_DATABASE_URL: 'postgres://synthetic',
      PILOT_1_PSQL: stubs.psql,
      PILOT_1_CURL: stubs.curl,
      PILOT_1_FLOCK: stubs.flock,
      PILOT_1_ACTOR: 'evans@test-host',
      PILOT_1_ACTOR_TENANT: 'Telecheck-US',
      PILOT_1_INCIDENT_LOGS_DIR:
        extraEnv.PILOT_1_INCIDENT_LOGS_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-')),
      PILOT_1_LOCK_FILE: path.join(dir, 'lifecycle.lock'),
      PILOT_1_RUNTIME_STATE_DIR: path.join(dir, 'state'),
      PILOT_1_COMPOSE: stubs.compose,
      PILOT_1_HEALTH_URLS: 'http://us.test/health http://gh.test/health',
      PILOT_1_SKIP_RUNTIME_STEPS: '1',
      ...extraEnv,
    },
  });
}

const txOf = (dir) => fs.readFileSync(path.join(dir, 'tx.sql'), 'utf8');
const stagesOf = (dir, op) => {
  const d = path.join(dir, 'state', op);
  return fs.existsSync(d)
    ? fs
        .readdirSync(d)
        .filter((f) => f !== 'meta')
        .sort()
    : null;
};
const latestOf = (dir) => {
  const f = path.join(dir, 'state', 'latest');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : null;
};
/** Prepares runtime state for an operation: which stages are done + whether it is the latest. */
function mkState(dir, op, stages, { latest = true, mode = 'incident' } = {}) {
  const d = path.join(dir, 'state', op);
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(d, 'meta'), `${mode}|\n`);
  // the journal marker always exists in reality: it is written before the transaction
  fs.writeFileSync(path.join(d, 'pending'), '');
  for (const st of stages) fs.writeFileSync(path.join(d, st), '');
  if (latest) fs.writeFileSync(path.join(dir, 'state', 'latest'), `${op}\n`);
}
const composeLog = (dir) =>
  fs.existsSync(path.join(dir, 'compose.log'))
    ? fs.readFileSync(path.join(dir, 'compose.log'), 'utf8').trim().split('\n')
    : [];

test('env-purge: usage errors exit 2 before psql runs (incl. missing health URLs with runtime steps enabled, --operation-id outside recovery, a lock file inside the incident tree, a missing flock)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  const inc = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  for (const [args, env] of [
    [[], {}],
    [['--routine-reset', '--incident-id', 'x'], {}],
    [['--routine-reset', '--finish-runtime'], {}],
    [['--incident-id'], {}],
    [['--incident-id', '../etc'], {}],
    [['--finish-runtime'], {}],
    [['--finish-runtime', '--operation-id', 'not-a-uuid'], {}],
    [['--routine-reset', '--operation-id', UUID], {}],
    [['--bogus'], {}],
    [['--routine-reset'], { PILOT_1_DATABASE_URL: '--command=TRUNCATE accounts' }],
    [['--routine-reset'], { PILOT_1_ACTOR_TENANT: '' }],
    [['--routine-reset'], { PILOT_1_ACTOR: 'bad "quote"' }],
    [['--routine-reset'], { PILOT_1_TEST_FAIL_AFTER: 'commit' }],
    [['--routine-reset'], { PILOT_1_SKIP_RUNTIME_STEPS: '0', PILOT_1_HEALTH_URLS: '' }],
    [
      ['--routine-reset'],
      { PILOT_1_INCIDENT_LOGS_DIR: inc, PILOT_1_LOCK_FILE: path.join(inc, 'lifecycle.lock') },
    ],
    [['--routine-reset'], { PILOT_1_INCIDENT_LOGS_DIR: inc, PILOT_1_LOCK_FILE: inc }],
    [['--routine-reset'], { PILOT_1_FLOCK: path.join(dir, 'no-such-flock') }],
  ]) {
    const r = run(dir, stubs, args, env);
    assert.equal(r.status, 2, `${args.join(' ')} ${JSON.stringify(env)}: ${r.stderr}`);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'call-0.args')), 'psql ran on a usage error');
  assert.ok(
    !fs.existsSync(path.join(inc, 'lifecycle.lock')),
    'a lock file was written inside the incident tree',
  );
});

test('env-purge: containment: real filesystem locations — a `..`-prefixed child, a symlinked alias of the incident directory and a TMPDIR inside it are all refused before any write (Codex R4)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  const inc = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const alias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'p1alias-')), 'alias');
  fs.symlinkSync(inc, alias, 'junction');
  const scratch = path.join(inc, 'scratch');
  fs.mkdirSync(scratch);
  const before = snapshot(inc);
  for (const [name, env] of [
    ['..-prefixed child', { PILOT_1_LOCK_FILE: path.join(inc, '..lifecycle.lock') }],
    ['symlinked alias', { PILOT_1_LOCK_FILE: path.join(alias, 'lifecycle.lock') }],
    ['alias itself', { PILOT_1_LOCK_FILE: alias }],
    ['TMPDIR = incident dir', { TMPDIR: inc }],
    ['TMPDIR inside incident dir', { TMPDIR: scratch }],
    ['TMPDIR via alias', { TMPDIR: alias }],
    ['state dir inside incident dir', { PILOT_1_RUNTIME_STATE_DIR: scratch }],
    ['state dir via alias', { PILOT_1_RUNTIME_STATE_DIR: alias }],
    [
      'state dir two missing components beneath alias',
      { PILOT_1_RUNTIME_STATE_DIR: path.join(alias, 'new', 'state') },
    ],
    [
      'lock two missing components beneath alias',
      { PILOT_1_LOCK_FILE: path.join(alias, 'new', 'deeper', 'lifecycle.lock') },
    ],
    ['TMPDIR two missing components beneath alias', { TMPDIR: path.join(alias, 'new', 'tmp') }],
  ]) {
    const r = run(dir, stubs, ['--routine-reset'], { PILOT_1_INCIDENT_LOGS_DIR: inc, ...env });
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.match(
      r.stderr,
      /resolves inside the incident directory|must not be a symbolic link/,
      name,
    );
  }
  assert.ok(!fs.existsSync(path.join(dir, 'call-0.args')), 'psql ran');
  assert.deepEqual(snapshot(inc), before, 'the incident tree changed');
  assert.deepEqual(
    fs.readdirSync(scratch),
    [],
    'scratch files were created inside the incident tree',
  );
  // a symlinked lock file — here a dangling one pointing INTO the incident
  // tree — is refused before the append-open could create its target (Codex R5)
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1link-'));
  const dangling = path.join(linkDir, 'lifecycle.lock');
  let canLinkFiles = true;
  try {
    fs.symlinkSync(path.join(inc, '.incident.lock'), dangling, 'file');
  } catch (e) {
    // Windows needs a privilege for file symlinks; CI (Linux) always runs this.
    if (process.platform === 'win32' && e.code === 'EPERM') canLinkFiles = false;
    else throw e;
  }
  if (canLinkFiles) {
    const rl = run(dir, stubs, ['--routine-reset'], {
      PILOT_1_INCIDENT_LOGS_DIR: inc,
      PILOT_1_LOCK_FILE: dangling,
    });
    assert.equal(rl.status, 2, `dangling symlink: ${rl.stderr}`);
    assert.match(rl.stderr, /must not be a symbolic link/);
    assert.ok(
      !fs.existsSync(path.join(inc, '.incident.lock')),
      'the dangling link was followed and an incident lock created',
    );
    assert.deepEqual(snapshot(inc), before, 'the incident tree changed (dangling symlink)');
  }
  // a lock beside (not inside) the incident directory is fine
  const ok = run(dir, stubs, ['--routine-reset', '--json'], {
    PILOT_1_INCIDENT_LOGS_DIR: inc,
    PILOT_1_LOCK_FILE: path.join(path.dirname(inc), `${path.basename(inc)}.lock`),
  });
  assert.equal(ok.status, 0, ok.stderr);
});

test(
  'env-purge: an unwritable state directory is a usage error before the app is stopped or any SQL runs (journal before the transaction, Codex R8)',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
    const stubs = mkStubs(dir);
    const ro = path.join(dir, 'state');
    fs.mkdirSync(ro);
    fs.chmodSync(ro, 0o555);
    try {
      const r = run(dir, stubs, ['--routine-reset'], { PILOT_1_SKIP_RUNTIME_STEPS: '0' });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /cannot write the operation journal/);
      assert.ok(!fs.existsSync(path.join(dir, 'tx.sql')), 'the transaction must not run');
      assert.deepEqual(composeLog(dir), [], 'the app must not be stopped');
    } finally {
      fs.chmodSync(ro, 0o755);
    }
  },
);

test('runtime-state: private directory, no-follow atomic journal writes (Codex R9)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p1rs-'));
  const dir = path.join(root, 'state');
  assert.equal(ensureStateDir(dir), path.resolve(dir));
  if (process.platform !== 'win32') assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  writeJournal(dir, 'op-1/meta', 'routine-reset|');
  writeJournal(dir, 'op-1/pending');
  writeJournal(dir, 'latest', 'op-1\n');
  assert.equal(fs.readFileSync(path.join(dir, 'latest'), 'utf8'), 'op-1\n');
  writeJournal(dir, 'latest', 'op-2\n');
  assert.equal(fs.readFileSync(path.join(dir, 'latest'), 'utf8'), 'op-2\n');
  assert.deepEqual(
    fs.readdirSync(dir).filter((f) => f.includes('.tmp-')),
    [],
    'no temp files left behind',
  );
  for (const bad of ['../x', '/abs', 'a/../b', 'op 1/meta', ''])
    assert.throws(() => writeJournal(dir, bad), /journal path/);
  // a pre-planted symlink destination is refused, its target untouched
  const victim = path.join(root, 'victim.age');
  fs.writeFileSync(victim, 'EVIDENCE');
  let linked = true;
  try {
    fs.symlinkSync(victim, path.join(dir, 'planted'), 'file');
  } catch (e) {
    if (process.platform === 'win32' && e.code === 'EPERM') linked = false;
    else throw e;
  }
  if (linked) {
    assert.throws(() => writeJournal(dir, 'planted', 'x'), /symbolic link/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'EVIDENCE');
  }
  // a symlinked intermediate directory is refused too (junction works on Windows)
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'p1rs-'));
  fs.symlinkSync(elsewhere, path.join(dir, 'linked-op'), 'junction');
  assert.throws(() => writeJournal(dir, 'linked-op/meta', 'x'), /symbolic link/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  // the state directory itself: symlink / file / (POSIX) group-writable → refused
  const alias = path.join(root, 'alias');
  fs.symlinkSync(dir, alias, 'junction');
  assert.throws(() => ensureStateDir(alias), /symbolic link/);
  const file = path.join(root, 'file');
  fs.writeFileSync(file, '');
  assert.throws(() => ensureStateDir(file), /not a directory/);
  if (process.platform !== 'win32') {
    const loose = path.join(root, 'loose');
    fs.mkdirSync(loose, { mode: 0o777 });
    fs.chmodSync(loose, 0o777);
    assert.throws(() => ensureStateDir(loose), /group\/world-writable/);
  }
});

test(
  'env-purge: a pre-planted symlink at state/latest pointing at a verified incident artifact is refused before the app is stopped and the artifact keeps its bytes (Codex R9)',
  { skip: process.platform === 'win32' },
  () => {
    const id = '2026-09-08T15-45Z-cat1-01';
    const inc = mkIncidentDir();
    const artifact = path.join(inc, `${id}-app.log.age`);
    const before = snapshot(inc);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
    const stubs = mkStubs(dir);
    fs.mkdirSync(path.join(dir, 'state'), { mode: 0o700 });
    fs.symlinkSync(artifact, path.join(dir, 'state', 'latest'), 'file');
    const r = run(dir, stubs, ['--incident-id', id], {
      PILOT_1_INCIDENT_LOGS_DIR: inc,
      PILOT_1_SKIP_RUNTIME_STEPS: '0',
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /cannot write the operation journal .*symbolic link/);
    assert.deepEqual(snapshot(inc), before, 'the incident artifact changed');
    assert.deepEqual(composeLog(dir), [], 'the app must not be stopped');
    assert.ok(!fs.existsSync(path.join(dir, 'tx.sql')), 'no transaction');
  },
);

test(
  'env-purge: a group-writable state directory is refused before anything runs (Codex R9)',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
    const stubs = mkStubs(dir);
    fs.mkdirSync(path.join(dir, 'state'));
    fs.chmodSync(path.join(dir, 'state'), 0o777);
    const r = run(dir, stubs, ['--routine-reset'], { PILOT_1_SKIP_RUNTIME_STEPS: '0' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /runtime state directory refused.*group\/world-writable/);
    assert.ok(!fs.existsSync(path.join(dir, 'call-0.args')), 'psql ran');
    assert.deepEqual(composeLog(dir), []);
  },
);

test('env-purge: the lifecycle lock is a kernel lock on a file that is never unlinked; a held lock refuses before anything runs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  const busy = run(dir, stubs, ['--routine-reset'], { FLOCK_BUSY: '1' });
  assert.equal(busy.status, 1, busy.stderr);
  assert.match(busy.stderr, /another purge lifecycle holds/);
  assert.ok(
    !fs.existsSync(path.join(dir, 'call-0.args')),
    'psql ran while another lifecycle held the lock',
  );
  assert.ok(
    fs.existsSync(path.join(dir, 'lifecycle.lock')),
    'the lock file must exist and never be unlinked',
  );
  const ok = run(dir, stubs, ['--routine-reset', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(
    fs.existsSync(path.join(dir, 'lifecycle.lock')),
    'the lock file must survive a successful run',
  );
  const flockCalls = fs.readFileSync(path.join(dir, 'flock.log'), 'utf8').trim().split('\n');
  assert.ok(
    flockCalls.every((c) => /^-n 9$/.test(c)),
    `flock must be non-blocking on fd 9: ${flockCalls.join(' | ')}`,
  );
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
  assert.match(tx, /REFRESH MATERIALIZED VIEW public\.interaction_signal_current_state_mv;/);
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
  assert.match(txArgs, /-v fail_insert=0/);
  assert.match(txArgs, /--dbname=postgres:\/\/synthetic/);
  assert.ok(fs.existsSync(path.join(dir, 'seed.ran')), 're-seed did not run');
  assert.deepEqual(snapshot(inc), before, 'incident-logs changed');
  assert.deepEqual(composeLog(dir), [], 'compose was invoked although runtime steps were skipped');
});

test('env-purge: routine-reset with runtime steps — stop before the purge, container removed and recreated after, exactly-200 health checks on every URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  const r = run(dir, stubs, ['--routine-reset', '--json'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_CADDY_LOG_PATHS: '/var/log/access.log',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.runtimeStepsSkipped, false);
  assert.deepEqual(composeLog(dir), [
    'exec app pkill -TERM node',
    'stop app',
    'exec redis redis-cli -e FLUSHALL',
    "exec caddy sh -c [ -e '/var/log/access.log' ] && : > '/var/log/access.log'",
    'rm -sf app',
    'up -d app',
  ]);
  const curls = fs.readFileSync(path.join(dir, 'curl.log'), 'utf8').trim().split('\n');
  assert.equal(curls.length, 2);
  assert.ok(curls.every((c) => /-w %\{http_code\}/.test(c) && /--max-time/.test(c)));
  assert.deepEqual(stagesOf(dir, out.operationId), [
    'caddy',
    'completed',
    'pending',
    'purged',
    'recreated',
    'redis',
    'removed',
    'reseeded',
  ]);
  assert.equal(latestOf(dir), out.operationId);
  assert.ok(
    curls.some((c) => c.includes('http://us.test/health')) &&
      curls.some((c) => c.includes('http://gh.test/health')),
  );

  const redirect = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const r2 = run(redirect, mkStubs(redirect), ['--routine-reset'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    CURL_CODE: '302',
    PILOT_1_HEALTH_URLS: 'http://us.test/health',
  });
  assert.equal(r2.status, 4, r2.stderr);
  assert.match(r2.stderr, /did not return HTTP 200 .* \(last: 302\)/);
  // after a failed health check every destructive stage is marked done; the
  // recovery retries the HEALTH CHECK ONLY — no stop, no FLUSHALL, no log
  // truncation, no container recreation (Codex R7)
  const opAfterHealth = fs.readdirSync(path.join(redirect, 'state')).find((f) => f !== 'latest');
  assert.deepEqual(stagesOf(redirect, opAfterHealth), [
    'caddy',
    'pending',
    'purged',
    'recreated',
    'redis',
    'removed',
    'reseeded',
  ]);
  const stubs2 = mkStubs(redirect);
  fs.rmSync(path.join(redirect, 'compose.log'));
  fs.rmSync(path.join(redirect, 'curl.log'));
  fs.rmSync(path.join(redirect, 'seed.ran'));
  const retry = run(
    redirect,
    stubs2,
    ['--finish-runtime', '--operation-id', opAfterHealth, '--json'],
    {
      PILOT_1_SKIP_RUNTIME_STEPS: '0',
      PILOT_1_ACTOR_TENANT: '',
      PSQL_ATTEST: 'routine-reset|',
      PILOT_1_HEALTH_URLS: 'http://us.test/health',
    },
  );
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(composeLog(redirect), [], 'a health-only retry must not touch compose');
  assert.ok(fs.existsSync(path.join(redirect, 'curl.log')), 'the health check ran');
  assert.ok(!fs.existsSync(path.join(redirect, 'seed.ran')), 'the re-seed must not repeat');
  assert.deepEqual(stagesOf(redirect, opAfterHealth), [
    'caddy',
    'completed',
    'pending',
    'purged',
    'recreated',
    'redis',
    'removed',
    'reseeded',
  ]);

  // redis-cli returns exit 0 on an error reply: the reply must be OK, and no
  // later runtime mutation may run (Codex R4)
  const redisErr = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const r3 = run(redisErr, mkStubs(redisErr), ['--routine-reset'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    REDIS_REPLY: '(error) NOAUTH Authentication required.',
  });
  assert.equal(r3.status, 4, r3.stderr);
  assert.match(r3.stderr, /did not acknowledge FLUSHALL/);
  assert.deepEqual(composeLog(redisErr), [
    'exec app pkill -TERM node',
    'stop app',
    'exec redis redis-cli -e FLUSHALL',
  ]);
  assert.ok(
    !fs.existsSync(path.join(redisErr, 'curl.log')),
    'no health check after a failed FLUSHALL',
  );
  const opRedis = fs.readdirSync(path.join(redisErr, 'state')).find((f) => f !== 'latest');
  assert.deepEqual(
    stagesOf(redisErr, opRedis),
    ['pending', 'purged', 'reseeded'],
    'FLUSHALL must not be marked done',
  );
});

test('env-purge: reconciliation reads the count, not a command tag — a rolled-back transaction exits 3 only after reconciling under the advisory lock; a lost COMMIT ack continues; an unreconcilable outcome exits 5 with the app left stopped', () => {
  const rolled = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  let r = run(rolled, mkStubs(rolled), ['--routine-reset'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PSQL_TX_EXIT: '3',
    PSQL_TX_STDERR: 'ERROR:  violates foreign key constraint',
    PSQL_RECONCILE: '0',
  });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /rolled back \(verified under the purge lock/);
  assert.ok(
    fs.existsSync(path.join(rolled, 'reconcile.locked')),
    'reconciliation must take the advisory lock',
  );
  const reconArgs = fs
    .readdirSync(rolled)
    .filter((f) => f.endsWith('.args'))
    .map((f) => fs.readFileSync(path.join(rolled, f), 'utf8'))
    .find((a) => a.includes('-v op='));
  assert.match(reconArgs, /(^| )-q( |$)/, 'the reconciliation lookup must suppress command tags');
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
  // the journal exists before the transaction (Codex R8): pending + rolled_back, never `purged`
  const refusedOp = fs.readdirSync(path.join(refused, 'state')).find((f) => f !== 'latest');
  assert.deepEqual(stagesOf(refused, refusedOp), ['pending', 'rolled_back']);
  assert.equal(latestOf(refused), refusedOp);

  const seedFail = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  r = run(seedFail, mkStubs(seedFail), ['--routine-reset'], { PSQL_SEED_EXIT: '3' });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /--finish-runtime --operation-id [0-9a-f-]{36}/);
});

test("env-purge: --finish-runtime is bound to a committed attestation, to the incident state its mode requires, and to this host's runtime state for an unfinished, latest operation", () => {
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  let r = run(none, mkStubs(none), ['--finish-runtime', '--operation-id', UUID], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
    PSQL_ATTEST: '',
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no committed env\.purge\.executed attestation/);
  assert.ok(!fs.existsSync(path.join(none, 'seed.ran')));
  assert.deepEqual(composeLog(none), []);
  // routine attestation: an incident lock OR an unconsumed manifest blocks recovery (Codex R3)
  for (const [name, inc] of [
    ['incident lock', mkIncidentDir()],
    ['unconsumed manifest', mkIncidentDir({ lock: false })],
  ]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
    mkState(dir, UUID, ['purged'], { mode: 'routine-reset' });
    r = run(dir, mkStubs(dir), ['--finish-runtime', '--operation-id', UUID], {
      PILOT_1_SKIP_RUNTIME_STEPS: '0',
      PILOT_1_ACTOR_TENANT: '',
      PSQL_ATTEST: 'routine-reset|',
      PILOT_1_INCIDENT_LOGS_DIR: inc,
    });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /incident state now blocks routine work/);
    assert.deepEqual(composeLog(dir), [], name);
    assert.ok(!fs.existsSync(path.join(dir, 'seed.ran')), name);
  }
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  mkState(other, UUID, ['purged']);
  r = run(other, mkStubs(other), ['--finish-runtime', '--operation-id', UUID], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
    PSQL_ATTEST: 'incident|2026-09-08T15-45Z-cat1-01',
    PILOT_1_INCIDENT_LOGS_DIR: mkIncidentDir({ lockId: 'someone-else' }),
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /incident state no longer matches/);

  // runtime-state binding (Codex R7): no state → refused; completed → refused; superseded → refused
  const noState = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  r = run(noState, mkStubs(noState), ['--finish-runtime', '--operation-id', UUID], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
    PSQL_ATTEST: 'incident|2026-09-08T15-45Z-cat1-01',
    PILOT_1_INCIDENT_LOGS_DIR: mkIncidentDir(),
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no runtime state for operation/);
  assert.deepEqual(composeLog(noState), []);
  const done = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  mkState(done, UUID, ['purged', 'reseeded', 'redis', 'caddy', 'recreated', 'completed']);
  r = run(done, mkStubs(done), ['--finish-runtime', '--operation-id', UUID], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
    PSQL_ATTEST: 'incident|2026-09-08T15-45Z-cat1-01',
    PILOT_1_INCIDENT_LOGS_DIR: mkIncidentDir(),
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /already completed every runtime stage/);
  assert.deepEqual(composeLog(done), [], 'a completed operation must not repeat any stage');
  const superseded = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  mkState(superseded, UUID, ['purged'], { latest: false });
  mkState(superseded, '00000000-0000-4000-8000-000000000002', ['purged']);
  r = run(superseded, mkStubs(superseded), ['--finish-runtime', '--operation-id', UUID], {
    PSQL_NEWER_OP: '00000000-0000-4000-8000-000000000002',
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
    PSQL_ATTEST: 'incident|2026-09-08T15-45Z-cat1-01',
    PILOT_1_INCIDENT_LOGS_DIR: mkIncidentDir(),
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(
    r.stderr,
    /superseded by a later committed purge \(00000000-0000-4000-8000-000000000002\)/,
  );
  assert.deepEqual(composeLog(superseded), []);

  // resume from `purged`: fence (stop app) first, then every remaining stage once
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  mkState(ok, UUID, ['purged']);
  r = run(ok, mkStubs(ok), ['--finish-runtime', '--operation-id', UUID, '--json'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
    PSQL_ATTEST: 'incident|2026-09-08T15-45Z-cat1-01',
    PILOT_1_INCIDENT_LOGS_DIR: mkIncidentDir(),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    mode: 'finish-runtime',
    operationId: UUID,
    attestedMode: 'incident',
    status: 'finished',
    runtimeStepsSkipped: false,
  });
  assert.ok(!fs.existsSync(path.join(ok, 'tx.sql')), 'a purge transaction ran in recovery mode');
  assert.ok(fs.existsSync(path.join(ok, 'seed.ran')));
  assert.deepEqual(composeLog(ok), [
    'exec app pkill -TERM node',
    'stop app',
    'exec redis redis-cli -e FLUSHALL',
    'rm -sf app',
    'up -d app',
  ]);
  assert.deepEqual(stagesOf(ok, UUID), [
    'caddy',
    'completed',
    'pending',
    'purged',
    'recreated',
    'redis',
    'removed',
    'reseeded',
  ]);
  // and a second recovery of the now-completed operation is refused
  const again = run(ok, mkStubs(ok), ['--finish-runtime', '--operation-id', UUID], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
    PSQL_ATTEST: 'incident|2026-09-08T15-45Z-cat1-01',
    PILOT_1_INCIDENT_LOGS_DIR: mkIncidentDir(),
  });
  assert.equal(again.status, 1, again.stderr);
  assert.match(again.stderr, /already completed/);

  // resume with redis + caddy done: no FLUSHALL / truncate repeated; the app is still fenced before recreation
  const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  mkState(partial, UUID, ['purged', 'reseeded', 'redis', 'caddy'], { mode: 'routine-reset' });
  r = run(partial, mkStubs(partial), ['--finish-runtime', '--operation-id', UUID, '--json'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
    PSQL_ATTEST: 'routine-reset|',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(partial, 'seed.ran')), 're-seed must not repeat');
  assert.deepEqual(composeLog(partial), [
    'exec app pkill -TERM node',
    'stop app',
    'rm -sf app',
    'up -d app',
  ]);
  // removed-but-not-started (crash between `rm` and `up`, or between `up` and
  // its marker): recovery never removes the (possibly running) replacement —
  // an idempotent `up -d` only, no stop, no FLUSHALL (Codex R8)
  const removed = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  mkState(removed, UUID, ['pending', 'purged', 'reseeded', 'redis', 'caddy', 'removed'], {
    mode: 'routine-reset',
  });
  r = run(removed, mkStubs(removed), ['--finish-runtime', '--operation-id', UUID, '--json'], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
    PSQL_ATTEST: 'routine-reset|',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    composeLog(removed),
    ['up -d app'],
    'a replacement container must never be removed again',
  );
  assert.deepEqual(stagesOf(removed, UUID), [
    'caddy',
    'completed',
    'pending',
    'purged',
    'recreated',
    'redis',
    'removed',
    'reseeded',
  ]);

  // a LATER journal whose purge never committed does not supersede (Codex R8)
  const notSuperseded = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const rolledBackOp = '00000000-0000-4000-8000-000000000003';
  mkState(notSuperseded, UUID, ['pending', 'purged'], { latest: false, mode: 'routine-reset' });
  mkState(notSuperseded, rolledBackOp, ['pending', 'rolled_back'], { mode: 'routine-reset' });
  r = run(
    notSuperseded,
    mkStubs(notSuperseded),
    ['--finish-runtime', '--operation-id', UUID, '--json'],
    {
      PILOT_1_SKIP_RUNTIME_STEPS: '0',
      PILOT_1_ACTOR_TENANT: '',
      PSQL_ATTEST: 'routine-reset|',
      PSQL_NOATTEST_OPS: rolledBackOp,
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(composeLog(notSuperseded), [
    'exec app pkill -TERM node',
    'stop app',
    'exec redis redis-cli -e FLUSHALL',
    'rm -sf app',
    'up -d app',
  ]);

  // A-unfinished / B-committed-and-completed / C-rolled-back (Codex R9):
  // `latest` points at C (no attestation) — supersession still comes from the
  // committed history, so recovering A is REFUSED without any runtime mutation
  const abc = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const opB = '00000000-0000-4000-8000-00000000000b';
  const opC = '00000000-0000-4000-8000-00000000000c';
  mkState(abc, UUID, ['pending', 'purged'], { latest: false, mode: 'routine-reset' });
  mkState(
    abc,
    opB,
    ['pending', 'purged', 'reseeded', 'redis', 'caddy', 'removed', 'recreated', 'completed'],
    { latest: false, mode: 'routine-reset' },
  );
  mkState(abc, opC, ['pending', 'rolled_back'], { mode: 'routine-reset' });
  r = run(abc, mkStubs(abc), ['--finish-runtime', '--operation-id', UUID], {
    PILOT_1_SKIP_RUNTIME_STEPS: '0',
    PILOT_1_ACTOR_TENANT: '',
    PSQL_ATTEST: 'routine-reset|',
    PSQL_NOATTEST_OPS: opC,
    PSQL_NEWER_OP: opB,
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`superseded by a later committed purge \\(${opB}\\)`));
  assert.deepEqual(composeLog(abc), [], 'no runtime mutation when superseded');
  assert.ok(!fs.existsSync(path.join(abc, 'seed.ran')));
});

test('env-purge: the test failure hooks — plan points render into the transaction, audit-insert breaks the attestation INSERT itself', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  const stubs = mkStubs(dir);
  let r = run(dir, stubs, ['--routine-reset'], { PILOT_1_TEST_FAIL_AFTER: 'truncate' });
  assert.equal(r.status, 0, r.stderr);
  const tx = txOf(dir);
  assert.ok(tx.indexOf('TRUNCATE TABLE') < tx.indexOf('TEST failure injected after truncate'));
  assert.ok(
    tx.indexOf('TEST failure injected after truncate') < tx.indexOf('DELETE FROM public.accounts'),
  );
  const ins = fs.mkdtempSync(path.join(os.tmpdir(), 'p1p-'));
  r = run(ins, mkStubs(ins), ['--routine-reset'], { PILOT_1_TEST_FAIL_AFTER: 'audit-insert' });
  assert.equal(r.status, 0, r.stderr);
  const argsFiles = fs
    .readdirSync(ins)
    .filter((f) => f.endsWith('.args'))
    .sort();
  const txArgs = argsFiles
    .map((f) => fs.readFileSync(path.join(ins, f), 'utf8'))
    .find((a) => a.includes('-f '));
  assert.match(txArgs, /-v fail_insert=1/);
  assert.ok(!/injected/.test(txOf(ins)), 'audit-insert must not also inject a plan failure');
  assert.match(txOf(ins), /TEST-DOES-NOT-EXIST/);
});
