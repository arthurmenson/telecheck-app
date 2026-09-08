/**
 * Real-Postgres proof for Sprint 1.3 phase B (cohort remediation + baseline
 * seed) per docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Cohort-classification
 * integrity — CI test additions:
 *
 *   - classification-omitted raw INSERT lands `unclassified` (migration 080
 *     DEFAULT) and the verifier REFUSES, naming the account;
 *   - invalid-classification raw INSERT is rejected by the CHECK (23514);
 *   - `pilot-1-marker-remediation.sh` classifies exactly once, commits the
 *     `pilot_1.cohort_classification` audit event in the same transaction
 *     with the OPERATOR's home tenant as actor_tenant_id, the chain stays
 *     intact, a second run is refused, staff can never become participants,
 *     and two concurrent runs classify exactly once;
 *   - `pilot-1-baseline-seed.sql` and `seed-staging-accounts.sql` are
 *     idempotent, every row they create is `baseline`, and the staging seed
 *     refuses (naming the id) when an existing fixture has drifted.
 *
 * Isolation: remediation commits audit rows, which are append-only (I-003)
 * and cannot be cleaned up, so every remediated fixture lives in a
 * DISPOSABLE tenant created by this file (never Telecheck-US / -Ghana,
 * whose audit partitions other suites assert on). Seed rows carry no audit
 * and are deleted afterwards. Scripts run as separate processes, so fixtures
 * are written through a dedicated autocommit client rather than the
 * savepoint-wrapped shared test client.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ulid } from '../../src/lib/ulid.ts';
import { assertAuditChainIntact } from '../helpers/audit-assertions.ts';
import { TENANT_US, withTenantContext } from '../helpers/tenant-fixtures.ts';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '../..');
const DSN = process.env['TEST_DATABASE_URL'] ?? '';
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];

function scriptEnv(actorTenant: string) {
  return {
    ...process.env,
    PILOT_1_DATABASE_URL: DSN,
    PILOT_1_ACTOR: 'ci-operator@test',
    PILOT_1_ACTOR_TENANT: actorTenant,
  };
}

function runScript(script: string, args: string[], actorTenant: string) {
  return spawnSync(bash, [...bashArgs, path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: scriptEnv(actorTenant),
  });
}

function runScriptAsync(script: string, args: string[], actorTenant: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(bash, [...bashArgs, path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      env: scriptEnv(actorTenant),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function psqlFile(file: string) {
  return spawnSync(
    'psql',
    [DSN, '-X', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'scripts', file)],
    { cwd: ROOT, encoding: 'utf8' },
  );
}

const STAGING_SEED_IDS = [
  '01JZZZ00000000000000000P01',
  '01JZZZ00000000000000000C01',
  '01JZZZ00000000000000000A02',
  '01JZZZ00000000000000000P02',
  '01JZZZ00000000000000000C02',
];
const STAGING_TEMPLATE_IDS = ['01JZZZ0000000000000000TP01', '01JZZZ0000000000000000TP02'];
const SEED_IDS = [
  '01JZZZ000000000000000P1C01',
  '01JZZZ000000000000000P1A01',
  '01JZZZ000000000000000P1F01',
  '01JZZZ000000000000000P1C02',
  '01JZZZ000000000000000P1A02',
  '01JZZZ000000000000000P1F02',
  '01JZZZ000000000000000P1PA1',
];

describe('Sprint 1.3 phase B — cohort remediation + baseline seed (real Postgres)', () => {
  const admin = new Client({ connectionString: DSN });
  const created: string[] = [];
  // Disposable tenants: the operator's home tenant and the target tenant.
  const suffix = randomBytes(2).toString('hex').toUpperCase();
  const OPERATOR_TENANT = `Telecheck-TR${suffix}A`;
  const TARGET_TENANT = `Telecheck-TR${suffix}B`;

  async function createTenant(id: string, country: 'US' | 'GH') {
    await admin.query(
      `INSERT INTO tenants (id, display_name, consumer_dba, legal_entity, consumer_subdomain,
          country_of_care, kms_key_alias, status, activated_at)
       VALUES ($1, $1, $2, $3, $4, $5, $6, 'active', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [
        id,
        `Heros Health Test ${id.slice(-6)}`,
        `Telecheck Test ${id.slice(-6)} Inc.`,
        `${id.toLowerCase()}.heroshealth.com`,
        country,
        `alias/telecheck-test-${id.toLowerCase()}-data-key`,
      ],
    );
  }

  async function rawInsert(tenant: string, id: string, type: string, classification?: string) {
    await admin.query('BEGIN');
    try {
      await admin.query('SELECT set_tenant_context($1)', [tenant]);
      const country = tenant === TARGET_TENANT || tenant === 'Telecheck-Ghana' ? 'GH' : 'US';
      const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
      await admin.query(
        `INSERT INTO accounts (account_id, tenant_id, phone_e164, first_name, last_name, date_of_birth,
            gender, country_of_residence, country_of_care, locale, account_type
            ${classification === undefined ? '' : ', cohort_classification'})
         VALUES ($1, $2, $3, 'Synthetic', 'Fixture', '1990-01-01', 'prefer_not_to_say', $4, $4, 'en-US', $5
            ${classification === undefined ? '' : ', $6'})`,
        classification === undefined
          ? [id, tenant, phone, country, type]
          : [id, tenant, phone, country, type, classification],
      );
      await admin.query('COMMIT');
      created.push(id);
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }
  }

  async function classificationOf(id: string): Promise<string | null> {
    const r = await admin.query<{ c: string }>(
      'SELECT cohort_classification AS c FROM accounts WHERE account_id = $1',
      [id],
    );
    return r.rows[0]?.c ?? null;
  }

  async function auditCountFor(id: string): Promise<number> {
    const r = await admin.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM audit_records WHERE action = 'pilot_1.cohort_classification' AND resource_id = $1`,
      [id],
    );
    return r.rows[0]!.n;
  }

  async function deleteAccount(id: string) {
    await admin.query('DELETE FROM accounts WHERE account_id = $1', [id]).catch(() => undefined);
  }

  async function allAccountIds(): Promise<Set<string>> {
    const r = await admin.query<{ account_id: string }>('SELECT account_id FROM accounts');
    return new Set(r.rows.map((row) => row.account_id));
  }

  beforeAll(async () => {
    await admin.connect();
    await createTenant(OPERATOR_TENANT, 'US');
    await createTenant(TARGET_TENANT, 'GH');
  });

  afterAll(async () => {
    for (const templateId of STAGING_TEMPLATE_IDS) {
      await admin
        .query('DELETE FROM forms_template WHERE template_id = $1', [templateId])
        .catch(() => undefined);
    }
    for (const id of [...created, ...SEED_IDS, ...STAGING_SEED_IDS]) await deleteAccount(id);
    // The disposable tenants keep their (append-only) audit rows and stay.
    await admin.end();
  });

  it('a raw INSERT omitting the column lands unclassified and the verifier refuses, naming the account', async () => {
    const id = ulid();
    await rawInsert(TARGET_TENANT, id, 'patient');
    expect(await classificationOf(id)).toBe('unclassified');
    const r = runScript('verify-pilot-1-baseline.sh', ['--json'], OPERATOR_TENANT);
    expect(r.status).toBe(1);
    const json = JSON.parse(r.stdout) as {
      unclassifiedCount: number;
      unclassifiedAccounts: Array<{ account_id: string }>;
    };
    expect(json.unclassifiedCount).toBeGreaterThanOrEqual(1);
    expect(json.unclassifiedAccounts.map((a) => a.account_id)).toContain(id);
    await deleteAccount(id);
  });

  it('a raw INSERT with an invalid classification is rejected by the CHECK constraint', async () => {
    await expect(rawInsert(TARGET_TENANT, ulid(), 'patient', 'operator')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('remediation classifies exactly once with a same-transaction audit event attributed to the OPERATOR tenant; the second run is refused', async () => {
    const id = ulid();
    await rawInsert(TARGET_TENANT, id, 'delegate');

    const first = runScript(
      'pilot-1-marker-remediation.sh',
      [
        '--account-id',
        id,
        '--classify-as',
        'participant',
        '--reason',
        'CI: pilot participant',
        '--json',
      ],
      OPERATOR_TENANT,
    );
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(first.stdout)).toMatchObject({
      accountId: id,
      tenantId: TARGET_TENANT,
      accountType: 'delegate',
      classifiedAs: 'participant',
      actor: 'ci-operator@test',
      actorTenantId: OPERATOR_TENANT,
      status: 'classified',
    });
    expect(await classificationOf(id)).toBe('participant');

    const audit = await admin.query<{
      payload: Record<string, unknown>;
      actor_tenant_id: string;
      target_patient_id: string;
      category: string;
      actor_type: string;
    }>(
      `SELECT payload, actor_tenant_id, target_patient_id, category, actor_type
         FROM audit_records
        WHERE tenant_id = $1 AND action = 'pilot_1.cohort_classification' AND resource_id = $2`,
      [TARGET_TENANT, id],
    );
    expect(audit.rowCount).toBe(1);
    const row = audit.rows[0]!;
    expect(row.category).toBe('B');
    expect(row.actor_type).toBe('platform_admin');
    // The row lives in the TARGET tenant's partition; actor_tenant_id is the
    // OPERATOR's home tenant (migration 029), which differs here.
    expect(row.actor_tenant_id).toBe(OPERATOR_TENANT);
    expect(row.target_patient_id).toBe(id);
    expect(row.payload).toMatchObject({
      accountId: id,
      classifiedAs: 'participant',
      actor: 'ci-operator@test',
      actorTenantId: OPERATOR_TENANT,
      reason: 'CI: pilot participant',
      previousClassification: 'unclassified',
      accountType: 'delegate',
    });
    // The shared test client runs under the app role with FORCE RLS: the
    // chain walk must run under a bound tenant context.
    await withTenantContext(TARGET_TENANT, () => assertAuditChainIntact(TARGET_TENANT));

    const second = runScript(
      'pilot-1-marker-remediation.sh',
      ['--account-id', id, '--classify-as', 'baseline', '--reason', 'CI: attempt to reclassify'],
      OPERATOR_TENANT,
    );
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/already classified as 'participant'/);
    expect(await classificationOf(id)).toBe('participant');
    expect(await auditCountFor(id)).toBe(1);
  });

  it('a staff account can never be classified participant; it can be classified baseline', async () => {
    for (const type of ['clinician', 'tenant_admin', 'platform_admin']) {
      const id = ulid();
      await rawInsert(TARGET_TENANT, id, type);
      const refused = runScript(
        'pilot-1-marker-remediation.sh',
        [
          '--account-id',
          id,
          '--classify-as',
          'participant',
          '--reason',
          'CI: staff as participant',
        ],
        OPERATOR_TENANT,
      );
      expect(refused.status, refused.stderr).toBe(1);
      expect(refused.stderr).toMatch(/only patient\/delegate accounts/);
      expect(await classificationOf(id)).toBe('unclassified');
      expect(await auditCountFor(id)).toBe(0);
      const ok = runScript(
        'pilot-1-marker-remediation.sh',
        ['--account-id', id, '--classify-as', 'baseline', '--reason', 'CI: staff baseline'],
        OPERATOR_TENANT,
      );
      expect(ok.status, ok.stderr).toBe(0);
      expect(await classificationOf(id)).toBe('baseline');
      expect(await auditCountFor(id)).toBe(1);
    }
  });

  it('two concurrent remediations of the same account classify it exactly once with exactly one audit row', async () => {
    const id = ulid();
    await rawInsert(TARGET_TENANT, id, 'patient');
    const [a, b] = await Promise.all([
      runScriptAsync(
        'pilot-1-marker-remediation.sh',
        ['--account-id', id, '--classify-as', 'participant', '--reason', 'CI: race A'],
        OPERATOR_TENANT,
      ),
      runScriptAsync(
        'pilot-1-marker-remediation.sh',
        ['--account-id', id, '--classify-as', 'baseline', '--reason', 'CI: race B'],
        OPERATOR_TENANT,
      ),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses, `${a.stderr}\n${b.stderr}`).toEqual([0, 1]);
    const finalClass = await classificationOf(id);
    expect(['participant', 'baseline']).toContain(finalClass);
    expect(await auditCountFor(id)).toBe(1);
  });

  it('an unknown account is refused without writing anything; an unknown actor tenant is a usage error', async () => {
    const r = runScript(
      'pilot-1-marker-remediation.sh',
      ['--account-id', ulid(), '--classify-as', 'baseline', '--reason', 'CI: unknown'],
      OPERATOR_TENANT,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not found/);
    const bad = runScript(
      'pilot-1-marker-remediation.sh',
      ['--account-id', ulid(), '--classify-as', 'baseline', '--reason', 'CI: unknown tenant'],
      'Telecheck-NOPE',
    );
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/does not exist/);
  });

  it('the staging seed refuses when an existing fixture has drifted from baseline, naming it; every row it creates is baseline', async () => {
    // Upgrade case (Codex R2): the fixture pre-exists as 'unclassified'.
    const drifted = STAGING_SEED_IDS[0]!;
    await deleteAccount(drifted);
    await rawInsert(TENANT_US, drifted, 'patient');
    const refused = psqlFile('seed-staging-accounts.sql');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(drifted);
    expect(refused.stderr).toMatch(/pilot-1-marker-remediation/);
    await deleteAccount(drifted);

    const before = await allAccountIds();
    const ok = psqlFile('seed-staging-accounts.sql');
    expect(ok.status, ok.stderr).toBe(0);
    const after = await allAccountIds();
    const newIds = [...after].filter((id) => !before.has(id));
    expect(newIds.sort()).toEqual([...STAGING_SEED_IDS].sort());
    const rows = await admin.query<{ c: string }>(
      `SELECT cohort_classification AS c FROM accounts WHERE account_id = ANY($1)`,
      [newIds],
    );
    for (const row of rows.rows) expect(row.c).toBe('baseline');
  });

  it('the baseline seed is idempotent, every row it creates is baseline, and every seeded id is a canonical ULID', async () => {
    const before = await allAccountIds();
    const first = psqlFile('pilot-1-baseline-seed.sql');
    expect(first.status, first.stderr).toBe(0);
    const second = psqlFile('pilot-1-baseline-seed.sql');
    expect(second.status, second.stderr).toBe(0);
    const after = await allAccountIds();
    const newIds = [...after].filter((id) => !before.has(id));
    expect(newIds.sort()).toEqual([...SEED_IDS].sort());
    for (const id of newIds) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const rows = await admin.query<{ account_id: string; c: string; t: string }>(
      `SELECT account_id, cohort_classification AS c, account_type AS t FROM accounts WHERE account_id = ANY($1)`,
      [newIds],
    );
    expect(rows.rowCount).toBe(SEED_IDS.length);
    for (const row of rows.rows) expect(row.c).toBe('baseline');
    expect(rows.rows.map((r) => r.t).sort()).toEqual([
      'clinician',
      'clinician',
      'patient',
      'patient',
      'platform_admin',
      'tenant_admin',
      'tenant_admin',
    ]);
  });
});
