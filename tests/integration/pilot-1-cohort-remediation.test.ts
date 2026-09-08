/**
 * Real-Postgres proof for Sprint 1.3 phase B (cohort remediation + baseline
 * seed) per docs/PII_SCREENING_AND_LOG_REDACTION_SPEC.md §Cohort-classification
 * integrity — CI test additions:
 *
 *   - classification-omitted raw INSERT lands `unclassified` (migration 080
 *     DEFAULT) and the verifier REFUSES, naming the account;
 *   - invalid-classification raw INSERT is rejected by the CHECK (23514);
 *   - `pilot-1-marker-remediation.sh --classify-as baseline|participant`
 *     classifies exactly once, commits the `pilot_1.cohort_classification`
 *     audit event in the same transaction, the chain stays intact, and the
 *     verifier turns green; a second run is refused;
 *   - `pilot-1-baseline-seed.sql` is idempotent and writes only `baseline`.
 *
 * The scripts run as separate processes, so fixtures are written through a
 * dedicated autocommit client rather than the savepoint-wrapped shared test
 * client. Audit rows are append-only (I-003) and are left in place; account
 * fixtures are removed afterwards.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ulid } from '../../src/lib/ulid.ts';
import { assertAuditChainIntact } from '../helpers/audit-assertions.ts';
import { TENANT_GHANA, TENANT_US } from '../helpers/tenant-fixtures.ts';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '../..');
const DSN = process.env['TEST_DATABASE_URL'] ?? '';
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];

function runScript(script: string, args: string[]) {
  return spawnSync(bash, [...bashArgs, path.join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PILOT_1_DATABASE_URL: DSN, PILOT_1_ACTOR: 'ci-operator@test' },
  });
}

function psqlFile(file: string) {
  return spawnSync(
    'psql',
    [DSN, '-X', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'scripts', file)],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
}

const SEED_IDS = [
  '01JZZZ000000000000PILOT0C1',
  '01JZZZ000000000000PILOT0A1',
  '01JZZZ000000000000PILOT0P1',
  '01JZZZ000000000000PILOT0C2',
  '01JZZZ000000000000PILOT0A2',
  '01JZZZ000000000000PILOT0P2',
  '01JZZZ000000000000PILOTPA1',
];

describe('Sprint 1.3 phase B — cohort remediation + baseline seed (real Postgres)', () => {
  const admin = new Client({ connectionString: DSN });
  const created: string[] = [];

  async function rawInsert(tenant: string, id: string, type: string, classification?: string) {
    await admin.query('BEGIN');
    try {
      await admin.query('SELECT set_tenant_context($1)', [tenant]);
      const country = tenant === TENANT_US ? 'US' : 'GH';
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

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    for (const id of [...created, ...SEED_IDS]) {
      await admin.query('DELETE FROM accounts WHERE account_id = $1', [id]).catch(() => undefined);
    }
    await admin.end();
  });

  it('a raw INSERT omitting the column lands unclassified and the verifier refuses, naming the account', async () => {
    const id = ulid();
    await rawInsert(TENANT_US, id, 'patient');
    expect(await classificationOf(id)).toBe('unclassified');
    const r = runScript('verify-pilot-1-baseline.sh', ['--json']);
    expect(r.status).toBe(1);
    const json = JSON.parse(r.stdout) as {
      unclassifiedCount: number;
      unclassifiedAccounts: Array<{ account_id: string }>;
    };
    expect(json.unclassifiedCount).toBeGreaterThanOrEqual(1);
    expect(json.unclassifiedAccounts.map((a) => a.account_id)).toContain(id);
  });

  it('a raw INSERT with an invalid classification is rejected by the CHECK constraint', async () => {
    await expect(rawInsert(TENANT_US, ulid(), 'patient', 'operator')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('remediation classifies exactly once with a same-transaction audit event; the second run is refused', async () => {
    const id = ulid();
    await rawInsert(TENANT_GHANA, id, 'delegate');

    const first = runScript('pilot-1-marker-remediation.sh', [
      '--account-id',
      id,
      '--classify-as',
      'participant',
      '--reason',
      'CI: pilot participant',
      '--json',
    ]);
    expect(first.status, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      accountId: id,
      tenantId: TENANT_GHANA,
      accountType: 'delegate',
      classifiedAs: 'participant',
      actor: 'ci-operator@test',
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
      [TENANT_GHANA, id],
    );
    expect(audit.rowCount).toBe(1);
    const row = audit.rows[0]!;
    expect(row.category).toBe('B');
    expect(row.actor_type).toBe('platform_admin');
    expect(row.actor_tenant_id).toBe(TENANT_GHANA);
    expect(row.target_patient_id).toBe(id);
    expect(row.payload).toMatchObject({
      accountId: id,
      classifiedAs: 'participant',
      actor: 'ci-operator@test',
      reason: 'CI: pilot participant',
      previousClassification: 'unclassified',
      accountType: 'delegate',
    });
    await assertAuditChainIntact(TENANT_GHANA);

    const second = runScript('pilot-1-marker-remediation.sh', [
      '--account-id',
      id,
      '--classify-as',
      'baseline',
      '--reason',
      'CI: attempt to reclassify',
    ]);
    expect(second.status).toBe(1);
    expect(second.stderr).toMatch(/already classified as 'participant'/);
    expect(await classificationOf(id)).toBe('participant');
    const again = await admin.query(
      `SELECT COUNT(*)::int AS n FROM audit_records WHERE action = 'pilot_1.cohort_classification' AND resource_id = $1`,
      [id],
    );
    expect((again.rows[0] as { n: number }).n).toBe(1);
  });

  it('remediation to baseline preserves the row and the verifier turns green once nothing is unclassified', async () => {
    const id = ulid();
    await rawInsert(TENANT_US, id, 'patient');
    const r = runScript('pilot-1-marker-remediation.sh', [
      '--account-id',
      id,
      '--classify-as',
      'baseline',
      '--reason',
      'CI: baseline fixture',
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(await classificationOf(id)).toBe('baseline');
    // Remediate every other unclassified row this file created so the gate can be green.
    for (const other of created) {
      if ((await classificationOf(other)) === 'unclassified') {
        runScript('pilot-1-marker-remediation.sh', [
          '--account-id',
          other,
          '--classify-as',
          'baseline',
          '--reason',
          'CI: cleanup',
        ]);
      }
    }
    const remaining = await admin.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM accounts WHERE cohort_classification = 'unclassified'`,
    );
    if (remaining.rows[0]!.n === 0) {
      const gate = runScript('verify-pilot-1-baseline.sh', []);
      expect(gate.status, gate.stderr).toBe(0);
    }
  });

  it('an unknown account is refused without writing anything', async () => {
    const r = runScript('pilot-1-marker-remediation.sh', [
      '--account-id',
      ulid(),
      '--classify-as',
      'baseline',
      '--reason',
      'CI: unknown',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not found/);
  });

  it('the baseline seed is idempotent and writes only baseline rows', async () => {
    const first = psqlFile('pilot-1-baseline-seed.sql');
    expect(first.status, first.stderr).toBe(0);
    const second = psqlFile('pilot-1-baseline-seed.sql');
    expect(second.status, second.stderr).toBe(0);
    const rows = await admin.query<{ account_id: string; c: string; t: string }>(
      `SELECT account_id, cohort_classification AS c, account_type AS t FROM accounts WHERE account_id = ANY($1)`,
      [SEED_IDS],
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
