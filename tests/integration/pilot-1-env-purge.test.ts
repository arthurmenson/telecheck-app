/**
 * Real-Postgres proof for Sprint 1.3 phase B (env-purge) per
 * docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Sprint 1.3 CI test suite.
 *
 * ISOLATION (Codex R1 / R2): this suite creates its OWN disposable database
 * (`telecheck_purge_<suffix>`) as a schema-only CLONE of the shared, fully
 * migrated test database (replaying the migration inventory into a second
 * database of the same cluster collides on cluster-wide roles — migration 032
 * CREATE ROLE → 42710). Roles, grants, RLS policies, triggers and SECURITY
 * DEFINER owners come with the clone; the tenant baseline rows are copied.
 * Every script receives a DSN that must name that database (guarded), and
 * the database is dropped afterwards.
 *
 *   1. schema-drift: every live base table is classified; the map names only
 *      live tables;
 *   2. FK edges: no preserved table references an allowlist table; preserved →
 *      scoped-delete edges only target accounts;
 *   3. seeded-canary purge (routine-reset): participant patient/delegate rows
 *      and their credentials / devices DELETED; baseline patient / delegate /
 *      clinician / tenant_admin / platform_admin rows AND their credentials /
 *      devices INTACT; every allowlist table empty; preserved counts
 *      unchanged; one attestation per tenant sharing the operation id;
 *      baseline re-seeded; gate green; guarded triggers re-enabled;
 *   4. unclassified account → purge REFUSES naming it, nothing written;
 *   5. attestation-transaction rollback: a failure INSIDE the attestation
 *      INSERT, after the attestation, after TRUNCATE and after the scoped
 *      DELETE — canaries restored, no attestation, exit 3;
 *   6. incident mode: preconditions, single use, two concurrent invocations →
 *      exactly one purge (the other refused by the lifecycle lock or the
 *      single-use check), directory byte-for-byte untouched; lock blocks
 *      routine-reset; --finish-runtime bound to the committed operation.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ulid } from '../../src/lib/ulid.ts';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '../..');
const SHARED_DSN = process.env['TEST_DATABASE_URL'] ?? '';
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];
const AGE_HEADER = 'age-encryption.org/v1';

type Classification = {
  version: number;
  materializedViews?: Record<string, { class: 'allowlist' | 'preserved' }>;
  tables: Record<
    string,
    { class: 'allowlist' | 'preserved' | 'scoped-delete'; predicate?: string }
  >;
};
const MAP = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'scripts', 'pilot-1-purge-classification.json'), 'utf8'),
) as Classification;
const tablesOf = (cls: string) =>
  Object.keys(MAP.tables)
    .filter((t) => MAP.tables[t]!.class === cls)
    .sort();
const SEED_IDS = [
  '01JZZZ000000000000000P1C01',
  '01JZZZ000000000000000P1A01',
  '01JZZZ000000000000000P1F01',
  '01JZZZ000000000000000P1C02',
  '01JZZZ000000000000000P1A02',
  '01JZZZ000000000000000P1F02',
  '01JZZZ000000000000000P1PA1',
];
const GUARDED_TRIGGERS_DISABLED = `SELECT COUNT(*)::text AS n FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid WHERE c.relname IN ('consult_care_binding','consult_care_submission') AND NOT tg.tgisinternal AND tg.tgenabled = 'D'`;

function cloneSchema(fromDsn: string, toDsn: string) {
  const opts = { encoding: 'utf8' as const, maxBuffer: 256 * 1024 * 1024 };
  // rbac_roles is a test-bootstrap fixture (tests/setup.ts), not a migration
  // table: it is excluded so the clone is exactly the migrated schema.
  const schema = spawnSync(
    'pg_dump',
    ['--schema-only', '--no-comments', '-T', 'public.rbac_roles', `--dbname=${fromDsn}`],
    opts,
  );
  if (schema.status !== 0) throw new Error(`pg_dump --schema-only failed: ${schema.stderr}`);
  // Migration 026 runs `SET LOCAL search_path = pg_catalog, public` and then
  // creates its trigger function UNQUALIFIED, so under a superuser migration
  // runner (CI) the function lands in pg_catalog — which pg_dump never dumps,
  // while the trigger definition references it bare. Carry every
  // user-created function that lives in pg_catalog (oid >= 16384) across
  // explicitly, before the schema restore. (Follow-up: fix-forward migration
  // moving the function to public.)
  const catalogFns = spawnSync(
    'psql',
    [
      `--dbname=${fromDsn}`,
      '-X',
      '-A',
      '-t',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      "SELECT COALESCE(string_agg(pg_get_functiondef(oid) || ';', E'\n'), '') FROM pg_proc WHERE pronamespace = 'pg_catalog'::regnamespace AND oid >= 16384",
    ],
    opts,
  );
  if (catalogFns.status !== 0)
    throw new Error(`pg_catalog function listing failed: ${catalogFns.stderr}`);
  if (catalogFns.stdout.trim() !== '') {
    const fnRestore = spawnSync(
      'psql',
      [`--dbname=${toDsn}`, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
      { ...opts, input: catalogFns.stdout },
    );
    if (fnRestore.status !== 0)
      throw new Error(`pg_catalog function restore failed: ${fnRestore.stderr}`);
  }
  // `-f -` makes psql label errors with the dump line (psql:<stdin>:N), so a
  // restore failure can quote the offending statement instead of a bare
  // ERROR line.
  const restore = spawnSync(
    'psql',
    [`--dbname=${toDsn}`, '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
    { ...opts, input: schema.stdout },
  );
  if (restore.status !== 0) {
    const m = /<stdin>:(\d+):/.exec(restore.stderr);
    const lines = schema.stdout.split('\n');
    const at = m ? Number(m[1]) : 0;
    const region = at ? lines.slice(Math.max(0, at - 25), at).join('\n') : '(no line reported)';
    throw new Error(
      `schema restore failed: ${restore.stderr}\n--- dump lines ${Math.max(1, at - 24)}..${at} ---\n${region}`,
    );
  }
  const data = spawnSync(
    'pg_dump',
    [
      '--data-only',
      '--no-comments',
      '-t',
      'public.tenants',
      '-t',
      'public.schema_migrations',
      `--dbname=${fromDsn}`,
    ],
    opts,
  );
  if (data.status !== 0) throw new Error(`pg_dump --data-only failed: ${data.stderr}`);
  const load = spawnSync('psql', [`--dbname=${toDsn}`, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], {
    ...opts,
    input: data.stdout,
  });
  if (load.status !== 0) throw new Error(`baseline data load failed: ${load.stderr}`);
}

function snapshotDir(dir: string) {
  const out: Record<string, { size: number; sha: string }> = {};
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    out[f] = {
      size: fs.statSync(p).size,
      sha: createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
    };
  }
  return out;
}

function mkIncidentDir(id: string, ageMin = 5) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const artifact = path.join(dir, `${id}-app.log.age`);
  fs.writeFileSync(
    artifact,
    Buffer.concat([Buffer.from(AGE_HEADER, 'latin1'), Buffer.alloc(64, 1)]),
  );
  const capturedAt = new Date(Date.now() - ageMin * 60_000).toISOString();
  fs.writeFileSync(
    path.join(dir, `${id}.manifest.json`),
    JSON.stringify({
      incidentId: id,
      status: 'SUCCESS',
      capturedAt,
      artifacts: [{ path: artifact, plaintextBytes: 10, ciphertextBytes: 64 + AGE_HEADER.length }],
      consumed: false,
    }),
  );
  fs.writeFileSync(
    path.join(dir, '.incident.lock'),
    JSON.stringify({ incidentId: id, openedAt: capturedAt, openedBy: 'ci' }),
  );
  return dir;
}

describe('Sprint 1.3 phase B — env-purge (real Postgres, disposable database)', () => {
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const suffix = Array.from(randomBytes(4), (b) => LETTERS[b % 26]).join('');
  const DB_NAME = `telecheck_purge_${suffix.toLowerCase()}`;
  const TENANT = `Telecheck-TP${suffix}`;
  const shared = new Client({ connectionString: SHARED_DSN });
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1lock-'));
  let DSN = '';
  let admin: Client;

  function scriptEnv(extraEnv: Record<string, string> = {}) {
    if (!DSN.includes(DB_NAME))
      throw new Error(
        'disposable-database guard: the purge must never run against the shared database',
      );
    return {
      ...process.env,
      PILOT_1_DATABASE_URL: DSN,
      PILOT_1_ACTOR: 'ci-operator@test',
      PILOT_1_ACTOR_TENANT: TENANT,
      PILOT_1_SKIP_RUNTIME_STEPS: '1',
      PILOT_1_LOCK_FILE: path.join(lockRoot, 'lifecycle.lock'),
      PILOT_1_RUNTIME_STATE_DIR: path.join(lockRoot, 'state'),
      PILOT_1_INCIDENT_LOGS_DIR:
        extraEnv['PILOT_1_INCIDENT_LOGS_DIR'] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-')),
      ...extraEnv,
    };
  }

  function runPurge(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync(
      bash,
      [...bashArgs, path.join(ROOT, 'scripts', 'pilot-1-env-purge.sh'), ...args],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: scriptEnv(extraEnv),
      },
    );
  }

  function runPurgeAsync(args: string[], extraEnv: Record<string, string> = {}) {
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(
        bash,
        [...bashArgs, path.join(ROOT, 'scripts', 'pilot-1-env-purge.sh'), ...args],
        { cwd: ROOT, env: scriptEnv(extraEnv) },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  }

  function runRemediation(id: string) {
    return spawnSync(
      bash,
      [
        ...bashArgs,
        path.join(ROOT, 'scripts', 'pilot-1-marker-remediation.sh'),
        '--account-id',
        id,
        '--classify-as',
        'baseline',
        '--reason',
        'CI: purge suite',
      ],
      { cwd: ROOT, encoding: 'utf8', env: scriptEnv() },
    );
  }

  async function insertAccount(id: string, type: string, classification?: string) {
    const cols = [
      'account_id',
      'tenant_id',
      'phone_e164',
      'first_name',
      'last_name',
      'date_of_birth',
      'gender',
      'country_of_residence',
      'country_of_care',
      'locale',
      'account_type',
    ];
    const vals = [
      '$1',
      '$2',
      '$3',
      "'Synthetic'",
      "'Canary'",
      "'1990-01-01'",
      "'prefer_not_to_say'",
      "'US'",
      "'US'",
      "'en-US'",
      '$4',
    ];
    const params: unknown[] = [
      id,
      TENANT,
      `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`,
      type,
    ];
    if (classification !== undefined) {
      cols.push('cohort_classification');
      params.push(classification);
      vals.push(`$${params.length}`);
    }
    await admin.query(
      `INSERT INTO accounts (${cols.join(', ')}) VALUES (${vals.join(', ')})`,
      params,
    );
  }

  async function insertCredentialAndDevice(accountId: string) {
    await admin.query(
      `INSERT INTO account_pin_credentials (account_id, tenant_id, pin_hash, pin_salt) VALUES ($1, $2, repeat('ab', 32), repeat('cd', 16))`,
      [accountId, TENANT],
    );
    await admin.query(
      `INSERT INTO auth_devices (device_id, tenant_id, account_id, platform, device_public_key) VALUES ($1, $2, $3, 'web', 'canary-public-key')`,
      [ulid(), TENANT, accountId],
    );
  }

  async function count(table: string, where = '', params: unknown[] = []): Promise<number> {
    const r = await admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM public.${table} ${where}`,
      params,
    );
    return Number(r.rows[0]!.n);
  }

  async function guardedTriggersDisabled(): Promise<number> {
    const r = await admin.query<{ n: string }>(GUARDED_TRIGGERS_DISABLED);
    return Number(r.rows[0]!.n);
  }

  async function attestations(): Promise<
    Array<{
      tenant_id: string;
      payload: Record<string, unknown>;
      actor_tenant_id: string;
      target_patient_id: string | null;
    }>
  > {
    const r = await admin.query(
      `SELECT tenant_id, payload, actor_tenant_id, target_patient_id FROM audit_records WHERE action = 'env.purge.executed' ORDER BY recorded_at, tenant_id`,
    );
    return r.rows as never;
  }

  async function seedCanaries() {
    const ids = {
      participantPatient: ulid(),
      participantDelegate: ulid(),
      baselinePatient: ulid(),
      baselineDelegate: ulid(),
      clinician: ulid(),
      tenantAdmin: ulid(),
      platformAdmin: ulid(),
    };
    await insertAccount(ids.participantPatient, 'patient', 'participant');
    await insertAccount(ids.participantDelegate, 'delegate', 'participant');
    await insertAccount(ids.baselinePatient, 'patient', 'baseline');
    await insertAccount(ids.baselineDelegate, 'delegate', 'baseline');
    await insertAccount(ids.clinician, 'clinician', 'baseline');
    await insertAccount(ids.tenantAdmin, 'tenant_admin', 'baseline');
    await insertAccount(ids.platformAdmin, 'platform_admin', 'baseline');
    await insertCredentialAndDevice(ids.participantPatient);
    await insertCredentialAndDevice(ids.baselinePatient);
    const key = `canary-${ulid()}`;
    await admin.query(
      `INSERT INTO idempotency_keys (tenant_id, key, request_hash, response_status, endpoint, actor_id) VALUES ($1, $2, '\\x00', 200, '/ci/purge-canary', 'ci')`,
      [TENANT, key],
    );
    // Replay-cache entries: one for a RETAINED actor (baseline patient), one
    // for a participant actor, in both caches (Codex R4: an unexpired
    // administrative retry must still be replay-protected after a reset).
    const retainedKey = `retained-${ulid()}`;
    const participantKey = `participant-${ulid()}`;
    for (const table of ['idempotency_keys', 'identity_idempotency_keys']) {
      await admin.query(
        `INSERT INTO ${table} (tenant_id, key, request_hash, response_status, endpoint, actor_id) VALUES ($1, $2, '\\x00', 200, '/ci/purge-canary', $3)`,
        [TENANT, retainedKey, ids.baselinePatient],
      );
      await admin.query(
        `INSERT INTO ${table} (tenant_id, key, request_hash, response_status, endpoint, actor_id) VALUES ($1, $2, '\\x00', 200, '/ci/purge-canary', $3)`,
        [TENANT, participantKey, ids.participantPatient],
      );
    }
    // Populated ALLOWLIST canary: the TRUNCATE rollback proof needs a row
    // that the TRUNCATE actually removes and the rollback restores (Codex R5).
    const sessionCanary = ulid();
    // migration 098's identity_staff_session_guard (BEFORE INSERT) reads the
    // bound tenant context, so bind it for this backend first.
    await admin.query('SELECT set_tenant_context($1)', [TENANT]);
    await admin.query(
      `INSERT INTO sessions (session_id, tenant_id, account_id, refresh_token_hash, expires_at) VALUES ($1, $2, $3, repeat('a', 64), NOW() + INTERVAL '1 hour')`,
      [sessionCanary, TENANT, ids.participantPatient],
    );
    expect(await count('sessions', 'WHERE session_id = $1', [sessionCanary])).toBe(1);
    // A RETAINED clinician's cached response for a PARTICIPANT medication_request
    // carries that participant's clinical record (Codex R6): the row must
    // survive (replay protection) with its body tombstoned.
    const clinicianKey = `clinician-${ulid()}`;
    await admin.query(
      `INSERT INTO idempotency_keys (tenant_id, key, request_hash, response_status, response_body, endpoint, actor_id, processing_state)
       VALUES ($1, $2, '\\x00', 200, $3::jsonb, '/ci/medication-requests/approve', $4, 'completed')`,
      [
        TENANT,
        clinicianKey,
        JSON.stringify({
          patient_account_id: ids.participantPatient,
          clinical_notes: 'CANARY-CLINICAL-NOTE',
          dosing: '10mg',
        }),
        ids.clinician,
      ],
    );
    return { ...ids, key, retainedKey, participantKey, sessionCanary, clinicianKey };
  }

  beforeAll(async () => {
    await shared.connect();
    await shared.query(`CREATE DATABASE ${DB_NAME}`);
    DSN = SHARED_DSN.replace(/\/[^/?]+(\?|$)/, `/${DB_NAME}$1`);
    cloneSchema(SHARED_DSN, DSN);
    admin = new Client({ connectionString: DSN });
    await admin.connect();
    // The schema-only clone leaves materialized views unpopulated; populate
    // the stored projection so the purge's REFRESH + post-check are exercised.
    await admin.query('REFRESH MATERIALIZED VIEW public.interaction_signal_current_state_mv');
    await admin.query(
      `INSERT INTO tenants (id, display_name, consumer_dba, legal_entity, consumer_subdomain, country_of_care, kms_key_alias, status, activated_at)
       VALUES ($1, $1, $2, $3, $4, 'US', $5, 'active', NOW()) ON CONFLICT (id) DO NOTHING`,
      [
        TENANT,
        `Heros Health Test ${suffix}`,
        `Telecheck Test ${suffix} Inc.`,
        `${TENANT.toLowerCase()}.heroshealth.com`,
        `alias/telecheck-test-${suffix.toLowerCase()}-data-key`,
      ],
    );
  }, 180_000);

  afterAll(async () => {
    await admin?.end().catch(() => undefined);
    await shared.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => undefined);
    await shared.end();
  });

  it('schema-drift: every live base table is classified, and the map names only live tables', async () => {
    const r = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const live = r.rows.map((x) => x.table_name).sort();
    expect(live.filter((t) => !MAP.tables[t])).toEqual([]);
    expect(Object.keys(MAP.tables).filter((t) => !live.includes(t))).toEqual([]);
    const mv = await admin.query<{ matviewname: string }>(
      `SELECT matviewname FROM pg_matviews WHERE schemaname = 'public' ORDER BY matviewname`,
    );
    const liveViews = mv.rows.map((x) => x.matviewname).sort();
    const mappedViews = Object.keys(MAP.materializedViews ?? {}).sort();
    expect(liveViews).toEqual(mappedViews);
  });

  it('FK edges: no preserved table references an allowlist table; preserved → scoped-delete edges only target accounts', async () => {
    const r = await admin.query<{ child: string; parent: string }>(
      `SELECT DISTINCT tc.table_name AS child, ccu.table_name AS parent
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
    );
    const cls = (t: string) => MAP.tables[t]?.class ?? 'UNCLASSIFIED';
    expect(
      r.rows.filter((e) => cls(e.child) === 'preserved' && cls(e.parent) === 'allowlist'),
    ).toEqual([]);
    for (const e of r.rows.filter(
      (x) => cls(x.child) === 'preserved' && cls(x.parent) === 'scoped-delete',
    ))
      expect(e.parent).toBe('accounts');
    expect(
      r.rows.filter((e) => cls(e.child) === 'UNCLASSIFIED' || cls(e.parent) === 'UNCLASSIFIED'),
    ).toEqual([]);
  });

  it('an unclassified account makes the purge REFUSE, naming it, with nothing written', async () => {
    const c = await seedCanaries();
    const stray = ulid();
    await insertAccount(stray, 'patient');
    const before = (await attestations()).length;
    const r = runPurge(['--routine-reset']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(stray);
    expect(await count('accounts', 'WHERE account_id = $1', [c.participantPatient])).toBe(1);
    expect(await count('idempotency_keys', 'WHERE key = $1', [c.key])).toBe(1);
    expect((await attestations()).length).toBe(before);
    const fixed = runRemediation(stray);
    expect(fixed.status, fixed.stderr).toBe(0);
  });

  it('attestation-transaction: a failure inside the attestation INSERT, after it, after TRUNCATE and after the scoped DELETE rolls everything back and re-enables the guarded triggers', async () => {
    for (const stage of ['audit-insert', 'audit', 'truncate', 'delete']) {
      const c = await seedCanaries();
      const before = (await attestations()).length;
      const r = runPurge(['--routine-reset'], { PILOT_1_TEST_FAIL_AFTER: stage });
      expect(r.status, `${stage}: ${r.stderr}`).toBe(3);
      expect(r.stderr).toMatch(/rolled back \(verified under the purge lock/);
      expect(await count('accounts', 'WHERE account_id = $1', [c.participantPatient])).toBe(1);
      expect(
        await count('account_pin_credentials', 'WHERE account_id = $1', [c.participantPatient]),
      ).toBe(1);
      expect(await count('idempotency_keys', 'WHERE key = $1', [c.key])).toBe(1);
      expect(
        await count('sessions', 'WHERE session_id = $1', [c.sessionCanary]),
        `${stage}: truncated allowlist row restored`,
      ).toBe(1);
      expect(
        await count(
          'idempotency_keys',
          `WHERE key = $1 AND response_body::text LIKE '%CANARY-CLINICAL-NOTE%'`,
          [c.clinicianKey],
        ),
        `${stage}: cached body intact after rollback`,
      ).toBe(1);
      expect((await attestations()).length).toBe(before);
      expect(await guardedTriggersDisabled()).toBe(0);
    }
  });

  it('seeded-canary purge (routine-reset): participants + their credentials/devices deleted, every baseline identity + credentials intact, allowlist empty, preserved unchanged, one attestation per tenant, re-seeded, gate green, triggers re-enabled', async () => {
    const c = await seedCanaries();
    const preserved = tablesOf('preserved').filter(
      (t) => !t.startsWith('_session') && t !== 'audit_records',
    );
    const preservedBefore: Record<string, number> = {};
    for (const t of preserved) preservedBefore[t] = await count(t);
    const baselineBefore = await count('accounts', `WHERE cohort_classification = 'baseline'`);
    const tenantCount = await count('tenants');
    const attestBefore = (await attestations()).length;
    const inc = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
    const dirBefore = snapshotDir(inc);

    const r = runPurge(['--routine-reset', '--json'], { PILOT_1_INCIDENT_LOGS_DIR: inc });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({
      mode: 'routine-reset',
      incidentId: null,
      actorTenantId: TENANT,
      status: 'purged',
      reconciled: false,
      runtimeStepsSkipped: true,
    });

    expect(await count('accounts', 'WHERE account_id = $1', [c.participantPatient])).toBe(0);
    expect(await count('accounts', 'WHERE account_id = $1', [c.participantDelegate])).toBe(0);
    expect(
      await count('account_pin_credentials', 'WHERE account_id = $1', [c.participantPatient]),
    ).toBe(0);
    expect(await count('auth_devices', 'WHERE account_id = $1', [c.participantPatient])).toBe(0);
    for (const id of [
      c.baselinePatient,
      c.baselineDelegate,
      c.clinician,
      c.tenantAdmin,
      c.platformAdmin,
    ]) {
      expect(await count('accounts', 'WHERE account_id = $1', [id]), id).toBe(1);
    }
    expect(
      await count('account_pin_credentials', 'WHERE account_id = $1', [c.baselinePatient]),
    ).toBe(1);
    expect(await count('auth_devices', 'WHERE account_id = $1', [c.baselinePatient])).toBe(1);
    expect(await count('accounts', `WHERE cohort_classification = 'participant'`)).toBe(0);
    expect(
      await count('accounts', `WHERE cohort_classification = 'baseline'`),
    ).toBeGreaterThanOrEqual(baselineBefore);
    for (const t of tablesOf('allowlist')) expect(await count(t), t).toBe(0);
    expect(await count('sessions', 'WHERE session_id = $1', [c.sessionCanary])).toBe(0);
    for (const t of preserved) expect(await count(t), t).toBe(preservedBefore[t]);
    for (const table of ['idempotency_keys', 'identity_idempotency_keys']) {
      expect(await count(table, 'WHERE key = $1', [c.retainedKey]), `${table} retained`).toBe(1);
      expect(await count(table, 'WHERE key = $1', [c.participantKey]), `${table} participant`).toBe(
        0,
      );
      expect(await count(table, `WHERE actor_id = 'ci'`), `${table} non-account actors`).toBe(0);
    }
    // retained clinician row survives, its cached participant record does not
    expect(await count('idempotency_keys', 'WHERE key = $1', [c.clinicianKey])).toBe(1);
    const tomb = await admin.query<{ body: Record<string, unknown> }>(
      `SELECT response_body AS body FROM idempotency_keys WHERE key = $1`,
      [c.clinicianKey],
    );
    expect(tomb.rows[0]!.body).toEqual({ purged: true, by: 'scripts/pilot-1-env-purge.sh' });
    for (const table of ['idempotency_keys', 'identity_idempotency_keys']) {
      expect(
        await count(
          table,
          `WHERE response_body::text LIKE '%' || $1 || '%' OR response_body::text LIKE '%CANARY-CLINICAL-NOTE%'`,
          [c.participantPatient],
        ),
        `${table} still references the participant`,
      ).toBe(0);
    }
    const rows = await attestations();
    expect(rows.length).toBe(attestBefore + tenantCount);
    const mine = rows.filter((x) => x.payload['operationId'] === out['operationId']);
    expect(mine.length).toBe(tenantCount);
    expect(new Set(mine.map((x) => x.tenant_id)).size).toBe(tenantCount);
    for (const row of mine) {
      expect(row.actor_tenant_id).toBe(TENANT);
      expect(row.target_patient_id).toBeNull();
      expect(row.payload).toMatchObject({
        mode: 'routine-reset',
        incidentId: null,
        actor: 'ci-operator@test',
        actorTenantId: TENANT,
        planDigest: out['planDigest'],
        classificationVersion: MAP.version,
      });
      expect(row.payload['tenants']).toContain(row.tenant_id);
    }
    for (const id of SEED_IDS)
      expect(await count('accounts', 'WHERE account_id = $1', [id]), id).toBe(1);
    expect(snapshotDir(inc)).toEqual(dirBefore);
    expect(await guardedTriggersDisabled()).toBe(0);
    const mvState = await admin.query<{ ispopulated: boolean }>(
      `SELECT ispopulated FROM pg_matviews WHERE schemaname = 'public' AND matviewname = 'interaction_signal_current_state_mv'`,
    );
    expect(mvState.rows[0]!.ispopulated).toBe(true);
    expect(await count('interaction_signal_current_state_mv')).toBe(0);
    const gate = spawnSync(
      bash,
      [...bashArgs, path.join(ROOT, 'scripts', 'verify-pilot-1-baseline.sh')],
      { cwd: ROOT, encoding: 'utf8', env: scriptEnv() },
    );
    expect(gate.status, gate.stderr).toBe(0);
  });

  it('incident mode: preconditions, single-use attestation carrying the incident id, two concurrent invocations purge exactly once, directory byte-for-byte untouched; the lock blocks routine-reset; --finish-runtime is bound to the committed operation', async () => {
    const id = `2026-09-08T16-00Z-cat1-${suffix.toLowerCase()}`;
    const inc = mkIncidentDir(id);
    const before = snapshotDir(inc);
    const c = await seedCanaries();

    const blocked = runPurge(['--routine-reset'], { PILOT_1_INCIDENT_LOGS_DIR: inc });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toMatch(/incident lock present/);

    const attestBefore = (await attestations()).length;
    const [a, b] = await Promise.all([
      runPurgeAsync(['--incident-id', id, '--json'], { PILOT_1_INCIDENT_LOGS_DIR: inc }),
      runPurgeAsync(['--incident-id', id, '--json'], { PILOT_1_INCIDENT_LOGS_DIR: inc }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, `${a.stderr}\n${b.stderr}`).toEqual([0, 1]);
    const winner = a.status === 0 ? a : b;
    const loser = a.status === 0 ? b : a;
    expect(loser.stderr).toMatch(/already attested|another purge lifecycle holds/);
    const won = JSON.parse(winner.stdout) as Record<string, unknown>;
    expect(won).toMatchObject({ mode: 'incident', incidentId: id, artifacts: 1 });
    expect(await count('accounts', 'WHERE account_id = $1', [c.participantPatient])).toBe(0);
    expect(await count('idempotency_keys', 'WHERE key = $1', [c.key])).toBe(0);
    const rows = (await attestations()).slice(attestBefore);
    expect(rows.length).toBe(await count('tenants'));
    for (const row of rows)
      expect(row.payload).toMatchObject({
        mode: 'incident',
        incidentId: id,
        artifacts: 1,
        operationId: won['operationId'],
      });
    expect(snapshotDir(inc)).toEqual(before);

    const again = runPurge(['--incident-id', id], { PILOT_1_INCIDENT_LOGS_DIR: inc });
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already attested/);
    expect(snapshotDir(inc)).toEqual(before);

    // recovery is bound to the committed operation, the matching lock and this
    // host's runtime state: the completed operation is refused; after the
    // `completed` marker is removed (as a failure after re-seed would leave
    // it) recovery resumes and completes it once.
    const opDir = path.join(lockRoot, 'state', String(won['operationId']));
    expect(fs.existsSync(path.join(opDir, 'completed'))).toBe(true);
    const refused = runPurge(['--finish-runtime', '--operation-id', String(won['operationId'])], {
      PILOT_1_INCIDENT_LOGS_DIR: inc,
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/already completed every runtime stage/);
    fs.rmSync(path.join(opDir, 'completed'));
    const finish = runPurge(
      ['--finish-runtime', '--operation-id', String(won['operationId']), '--json'],
      { PILOT_1_INCIDENT_LOGS_DIR: inc },
    );
    expect(finish.status, finish.stderr).toBe(0);
    expect(JSON.parse(finish.stdout)).toMatchObject({
      mode: 'finish-runtime',
      attestedMode: 'incident',
      status: 'finished',
    });
    expect(fs.existsSync(path.join(opDir, 'completed'))).toBe(true);
    const bogus = runPurge(
      ['--finish-runtime', '--operation-id', '123e4567-e89b-12d3-a456-426614174000'],
      { PILOT_1_INCIDENT_LOGS_DIR: inc },
    );
    expect(bogus.status).toBe(1);
    expect(bogus.stderr).toMatch(/no committed env\.purge\.executed attestation/);
    expect(snapshotDir(inc)).toEqual(before);

    const stale = mkIncidentDir(`${id}-stale`, 45);
    const s = runPurge(['--incident-id', `${id}-stale`], { PILOT_1_INCIDENT_LOGS_DIR: stale });
    expect(s.status).toBe(1);
    expect(s.stderr).toMatch(/stale/);
  });
});
