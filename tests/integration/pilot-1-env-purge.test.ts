/**
 * Real-Postgres proof for Sprint 1.3 phase B (env-purge) per
 * docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Sprint 1.3 CI test suite:
 *
 *   1. schema-drift: every live base table in `public` is classified and the
 *      map names no table that does not exist;
 *   2. preserved-to-purged FK edges: none from a preserved table to an
 *      allowlist table; preserved → scoped-delete edges only target accounts;
 *   3. seeded-canary purge (routine-reset): participant canaries DELETED,
 *      baseline canaries of every identity type INTACT, every allowlist table
 *      empty, preserved row counts unchanged, one `env.purge.executed`
 *      attestation in the operator's tenant, baseline re-seeded, gate green;
 *   4. unclassified account → purge REFUSES naming it, nothing written;
 *   5. attestation-transaction: an injected failure after the attestation,
 *      after TRUNCATE and after the scoped DELETE rolls everything back —
 *      canaries restored, no attestation row, non-zero exit;
 *   6. incident mode against a scratch incident directory: preconditions,
 *      single-use attestation with the incident id, directory byte-for-byte
 *      untouched in both modes; a lock blocks routine-reset.
 *
 * Runtime steps (docker compose) are skipped via PILOT_1_SKIP_RUNTIME_STEPS=1;
 * the DB purge, the attestation and the re-seed are the real thing. All
 * fixtures live in a disposable letters-only tenant which is also the
 * operator's home tenant, so the attestation never lands in a shared partition.
 * The purge itself truncates every allowlist table database-wide — each test
 * file owns its fixtures, so that is the intended blast radius.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ulid } from '../../src/lib/ulid.ts';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '../..');
const DSN = process.env['TEST_DATABASE_URL'] ?? '';
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];
const AGE_HEADER = 'age-encryption.org/v1';

type Classification = {
  version: number;
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

describe('Sprint 1.3 phase B — env-purge (real Postgres)', () => {
  const admin = new Client({ connectionString: DSN });
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const suffix = Array.from(randomBytes(4), (b) => LETTERS[b % 26]).join('');
  const TENANT = `Telecheck-TP${suffix}`;
  const created: string[] = [];

  function runPurge(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync(
      bash,
      [...bashArgs, path.join(ROOT, 'scripts', 'pilot-1-env-purge.sh'), ...args],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PILOT_1_DATABASE_URL: DSN,
          PILOT_1_ACTOR: 'ci-operator@test',
          PILOT_1_ACTOR_TENANT: TENANT,
          PILOT_1_SKIP_RUNTIME_STEPS: '1',
          PILOT_1_INCIDENT_LOGS_DIR:
            extraEnv['PILOT_1_INCIDENT_LOGS_DIR'] ??
            fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-')),
          ...extraEnv,
        },
      },
    );
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
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PILOT_1_DATABASE_URL: DSN,
          PILOT_1_ACTOR: 'ci-operator@test',
          PILOT_1_ACTOR_TENANT: TENANT,
        },
      },
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
    created.push(id);
  }

  async function insertIdempotencyCanary(key: string) {
    await admin.query(
      `INSERT INTO idempotency_keys (tenant_id, key, response_status, endpoint, actor_id) VALUES ($1, $2, 200, '/ci/purge-canary', 'ci')`,
      [TENANT, key],
    );
  }

  async function count(table: string, where = '', params: unknown[] = []): Promise<number> {
    const r = await admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM public.${table} ${where}`,
      params,
    );
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
      `SELECT tenant_id, payload, actor_tenant_id, target_patient_id FROM audit_records WHERE action = 'env.purge.executed' AND tenant_id = $1 ORDER BY recorded_at`,
      [TENANT],
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
    const key = `canary-${ulid()}`;
    await insertIdempotencyCanary(key);
    return { ...ids, key };
  }

  beforeAll(async () => {
    await admin.connect();
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
  });

  afterAll(async () => {
    for (const id of [...created, ...SEED_IDS]) {
      await admin.query('DELETE FROM accounts WHERE account_id = $1', [id]).catch(() => undefined);
    }
    await admin.end();
  });

  it('schema-drift: every live base table is classified, and the map names only live tables', async () => {
    const r = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const live = r.rows.map((x) => x.table_name).sort();
    const mapped = Object.keys(MAP.tables).sort();
    expect(live.filter((t) => !MAP.tables[t])).toEqual([]);
    expect(mapped.filter((t) => !live.includes(t))).toEqual([]);
  });

  it('FK edges: no preserved table references an allowlist table; preserved → scoped-delete edges only target accounts', async () => {
    const r = await admin.query<{ child: string; parent: string }>(
      `SELECT DISTINCT tc.table_name AS child, ccu.table_name AS parent
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`,
    );
    const cls = (t: string) => MAP.tables[t]?.class ?? 'UNCLASSIFIED';
    const preservedToAllow = r.rows.filter(
      (e) => cls(e.child) === 'preserved' && cls(e.parent) === 'allowlist',
    );
    expect(preservedToAllow).toEqual([]);
    const preservedToScoped = r.rows.filter(
      (e) => cls(e.child) === 'preserved' && cls(e.parent) === 'scoped-delete',
    );
    for (const e of preservedToScoped) expect(e.parent).toBe('accounts');
    const unclassified = r.rows.filter(
      (e) => cls(e.child) === 'UNCLASSIFIED' || cls(e.parent) === 'UNCLASSIFIED',
    );
    expect(unclassified).toEqual([]);
  });

  it('an unclassified account makes the purge REFUSE, naming it, with nothing written', async () => {
    const c = await seedCanaries();
    const stray = ulid();
    await insertAccount(stray, 'patient');
    const before = await attestations();
    const r = runPurge(['--routine-reset']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(stray);
    expect(await count('accounts', 'WHERE account_id = $1', [c.participantPatient])).toBe(1);
    expect(await count('idempotency_keys', 'WHERE key = $1', [c.key])).toBe(1);
    expect((await attestations()).length).toBe(before.length);
    const fixed = runRemediation(stray);
    expect(fixed.status, fixed.stderr).toBe(0);
  });

  it('attestation-transaction: an injected failure after the attestation, after TRUNCATE and after the scoped DELETE rolls everything back', async () => {
    for (const stage of ['audit', 'truncate', 'delete']) {
      const c = await seedCanaries();
      const before = (await attestations()).length;
      const r = runPurge(['--routine-reset'], { PILOT_1_TEST_FAIL_AFTER: stage });
      expect(r.status, `${stage}: ${r.stderr}`).toBe(3);
      expect(r.stderr).toMatch(/rolled back/);
      expect(await count('accounts', 'WHERE account_id = $1', [c.participantPatient])).toBe(1);
      expect(await count('accounts', 'WHERE account_id = $1', [c.participantDelegate])).toBe(1);
      expect(await count('idempotency_keys', 'WHERE key = $1', [c.key])).toBe(1);
      expect((await attestations()).length).toBe(before);
      // leave the canaries for the next stage / the real purge
    }
  });

  it('seeded-canary purge (routine-reset): participants deleted, every baseline identity intact, allowlist empty, preserved unchanged, one attestation, re-seeded, gate green', async () => {
    const c = await seedCanaries();
    const preserved = tablesOf('preserved').filter(
      (t) => !t.startsWith('_session') && t !== 'audit_records',
    );
    const preservedBefore: Record<string, number> = {};
    for (const t of preserved) preservedBefore[t] = await count(t);
    const baselineAccountsBefore = await count(
      'accounts',
      `WHERE cohort_classification = 'baseline'`,
    );
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
      runtimeStepsSkipped: true,
    });

    expect(await count('accounts', 'WHERE account_id = $1', [c.participantPatient])).toBe(0);
    expect(await count('accounts', 'WHERE account_id = $1', [c.participantDelegate])).toBe(0);
    for (const id of [
      c.baselinePatient,
      c.baselineDelegate,
      c.clinician,
      c.tenantAdmin,
      c.platformAdmin,
    ]) {
      expect(await count('accounts', 'WHERE account_id = $1', [id]), id).toBe(1);
    }
    expect(await count('accounts', `WHERE cohort_classification = 'participant'`)).toBe(0);
    // no baseline account of ANY type deleted (the re-seed may add the 7 P1 rows)
    expect(
      await count('accounts', `WHERE cohort_classification = 'baseline'`),
    ).toBeGreaterThanOrEqual(baselineAccountsBefore);
    for (const t of tablesOf('allowlist')) expect(await count(t), t).toBe(0);
    for (const t of preserved) expect(await count(t), t).toBe(preservedBefore[t]);
    const rows = await attestations();
    expect(rows.length).toBe(attestBefore + 1);
    const last = rows.at(-1)!;
    expect(last.actor_tenant_id).toBe(TENANT);
    expect(last.target_patient_id).toBeNull();
    expect(last.payload).toMatchObject({
      mode: 'routine-reset',
      incidentId: null,
      actor: 'ci-operator@test',
      actorTenantId: TENANT,
      planDigest: out['planDigest'],
      classificationVersion: MAP.version,
    });
    expect(Array.isArray(last.payload['tenants'])).toBe(true);
    expect(last.payload['tenants']).toContain(TENANT);
    for (const id of SEED_IDS)
      expect(await count('accounts', 'WHERE account_id = $1', [id]), id).toBe(1);
    expect(snapshotDir(inc)).toEqual(dirBefore);
    const gate = spawnSync(
      bash,
      [...bashArgs, path.join(ROOT, 'scripts', 'verify-pilot-1-baseline.sh')],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, PILOT_1_DATABASE_URL: DSN } },
    );
    expect(gate.status, gate.stderr).toBe(0);
  });

  it('incident mode: preconditions, single-use attestation carrying the incident id, directory byte-for-byte untouched; the lock blocks routine-reset', async () => {
    const id = `2026-09-08T16-00Z-cat1-${suffix.toLowerCase()}`;
    const inc = mkIncidentDir(id);
    const before = snapshotDir(inc);
    const c = await seedCanaries();

    const blocked = runPurge(['--routine-reset'], { PILOT_1_INCIDENT_LOGS_DIR: inc });
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toMatch(/incident lock present/);

    const r = runPurge(['--incident-id', id, '--json'], { PILOT_1_INCIDENT_LOGS_DIR: inc });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ mode: 'incident', incidentId: id, artifacts: 1 });
    expect(await count('accounts', 'WHERE account_id = $1', [c.participantPatient])).toBe(0);
    expect(await count('idempotency_keys', 'WHERE key = $1', [c.key])).toBe(0);
    const last = (await attestations()).at(-1)!;
    expect(last.payload).toMatchObject({ mode: 'incident', incidentId: id, artifacts: 1 });
    expect(snapshotDir(inc)).toEqual(before);

    const again = runPurge(['--incident-id', id], { PILOT_1_INCIDENT_LOGS_DIR: inc });
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already attested/);
    expect(snapshotDir(inc)).toEqual(before);

    const stale = mkIncidentDir(`${id}-stale`, 45);
    const s = runPurge(['--incident-id', `${id}-stale`], { PILOT_1_INCIDENT_LOGS_DIR: stale });
    expect(s.status).toBe(1);
    expect(s.stderr).toMatch(/stale/);
  });
});
