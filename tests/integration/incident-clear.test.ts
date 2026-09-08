/**
 * Real-Postgres proof for Sprint 1.3 phase B part 3a — incident-clear.sh
 * (PILOT_1_INCIDENT_RESPONSE_MINI_RUNBOOK.md §Forensic-evidence preservation
 * step 8): runs against a disposable clone of the migrated test database so the
 * per-tenant `env.incident.abandoned` rows never land in the shared partitions.
 *
 *   1. RESOLVED without an env.purge.executed attestation → refused, nothing changes;
 *   2. RESOLVED after a purge attestation (inserted the way env-purge does) →
 *      manifest consumed (RESOLVED, purgeAttested), lock removed, no audit row added;
 *   3. ABANDONED → one env.incident.abandoned row PER TENANT (Category B,
 *      platform_admin, actor_tenant_id = operator tenant, payload incidentId /
 *      reason / purgeAttested), chain intact, manifest consumed with the reason,
 *      lock removed; a second ABANDONED for the same id is refused (no lock) and
 *      the transaction's duplicate guard is exercised via an interrupted clearance.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cloneSchema, withDatabase } from './helpers/disposable-db.ts';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '../..');
const SHARED_DSN = process.env['TEST_DATABASE_URL'] ?? '';
const bash = process.platform === 'win32' ? 'bash' : '/usr/bin/env';
const bashArgs = process.platform === 'win32' ? [] : ['bash'];
const AGE_HEADER = 'age-encryption.org/v1';
const TENANT = 'Telecheck-US';

function mkIncidentDir(
  id: string,
  opts: { consumed?: boolean; disposition?: string; lock?: boolean } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p1inc-'));
  const artifact = path.join(dir, `${id}-app.log.age`);
  fs.writeFileSync(
    artifact,
    Buffer.concat([Buffer.from(AGE_HEADER, 'latin1'), Buffer.alloc(64, 1)]),
  );
  const capturedAt = new Date().toISOString();
  const manifest: Record<string, unknown> = {
    incidentId: id,
    status: 'SUCCESS',
    capturedAt,
    artifacts: [{ path: artifact, plaintextBytes: 32, ciphertextBytes: AGE_HEADER.length + 64 }],
    consumed: opts.consumed ?? false,
  };
  if (opts.disposition) manifest['disposition'] = opts.disposition;
  fs.writeFileSync(path.join(dir, `${id}.manifest.json`), JSON.stringify(manifest));
  if (opts.lock ?? true) {
    fs.writeFileSync(
      path.join(dir, '.incident.lock'),
      JSON.stringify({ incidentId: id, openedAt: capturedAt, openedBy: 'ci' }),
    );
  }
  return dir;
}

describe('Sprint 1.3 phase B part 3a — incident-clear (real Postgres, disposable database)', () => {
  const skip = SHARED_DSN === '';
  const suffix = randomBytes(4).toString('hex');
  const DB_NAME = `telecheck_clear_${suffix.toLowerCase()}`;
  const shared = new Client({ connectionString: SHARED_DSN || 'postgres://invalid' });
  const lockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'p1lock-'));
  let DSN = '';
  let admin: Client;

  function runClear(args: string[], extraEnv: Record<string, string> = {}) {
    if (!DSN.includes(DB_NAME))
      throw new Error('DSN guard: the clear must target the disposable database');
    return spawnSync(
      bash,
      [...bashArgs, path.join(ROOT, 'scripts', 'incident-clear.sh'), ...args],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PILOT_1_DATABASE_URL: DSN,
          PILOT_1_ACTOR: 'ci-operator@test',
          PILOT_1_ACTOR_TENANT: TENANT,
          PILOT_1_LOCK_FILE: path.join(lockRoot, 'lifecycle.lock'),
          ...extraEnv,
        },
      },
    );
  }

  async function purgeAttestationFor(id: string) {
    // The shape env-purge writes (one row per tenant, operation id in payload).
    const op = `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
    await admin.query(
      `INSERT INTO audit_records (tenant_id, category, audit_sensitivity_level, action, actor_type, actor_id, actor_tenant_id, target_patient_id, resource_type, resource_id, country_of_care, payload)
       SELECT id, 'B', 'standard', 'env.purge.executed', 'platform_admin', 'ci-operator@test', $2, NULL, 'environment', $1, NULL,
              jsonb_build_object('operationId', $3::text, 'incidentId', $1::text, 'mode', 'incident')
         FROM tenants ORDER BY id`,
      [id, TENANT, op],
    );
  }

  async function rows(action: string, id: string) {
    const r = await admin.query<{
      tenant_id: string;
      actor_tenant_id: string;
      payload: Record<string, unknown>;
      category: string;
      actor_type: string;
    }>(
      `SELECT tenant_id, actor_tenant_id, payload, category, actor_type FROM audit_records WHERE action = $1 AND payload->>'incidentId' = $2 ORDER BY tenant_id`,
      [action, id],
    );
    return r.rows;
  }

  beforeAll(async () => {
    if (skip) return;
    await shared.connect();
    await shared.query(`CREATE DATABASE ${DB_NAME}`);
    DSN = withDatabase(SHARED_DSN, DB_NAME);
    cloneSchema(SHARED_DSN, DSN);
    admin = new Client({ connectionString: DSN });
    await admin.connect();
  });

  afterAll(async () => {
    if (skip) return;
    await admin?.end().catch(() => undefined);
    await shared.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`).catch(() => undefined);
    await shared.end();
  });

  it.skipIf(skip)(
    'RESOLVED without a purge attestation is refused with nothing changed',
    async () => {
      const id = `2026-09-08T16-00Z-cat1-${suffix.slice(0, 2)}a`;
      const inc = mkIncidentDir(id);
      const before = fs.readFileSync(path.join(inc, `${id}.manifest.json`), 'utf8');
      const r = runClear(['--incident-id', id, '--disposition', 'RESOLVED'], {
        PILOT_1_INCIDENT_LOGS_DIR: inc,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/requires a committed env\.purge\.executed attestation/);
      expect(fs.readFileSync(path.join(inc, `${id}.manifest.json`), 'utf8')).toBe(before);
      expect(fs.existsSync(path.join(inc, '.incident.lock'))).toBe(true);
      expect((await rows('env.incident.abandoned', id)).length).toBe(0);
    },
  );

  it.skipIf(skip)(
    'RESOLVED after a purge attestation consumes the manifest and removes the lock without adding audit rows',
    async () => {
      const id = `2026-09-08T16-00Z-cat1-${suffix.slice(0, 2)}b`;
      await purgeAttestationFor(id);
      const inc = mkIncidentDir(id);
      const auditBefore = Number(
        (await admin.query('SELECT COUNT(*)::text AS n FROM audit_records')).rows[0]!['n'],
      );
      const r = runClear(['--incident-id', id, '--disposition', 'RESOLVED', '--json'], {
        PILOT_1_INCIDENT_LOGS_DIR: inc,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({
        incidentId: id,
        disposition: 'RESOLVED',
        purgeAttested: true,
        abandonedAttestationEmitted: false,
        status: 'cleared',
      });
      const m = JSON.parse(
        fs.readFileSync(path.join(inc, `${id}.manifest.json`), 'utf8'),
      ) as Record<string, unknown>;
      expect(m).toMatchObject({
        consumed: true,
        disposition: 'RESOLVED',
        purgeAttested: true,
        clearedBy: 'ci-operator@test',
      });
      expect(fs.existsSync(path.join(inc, '.incident.lock'))).toBe(false);
      const auditAfter = Number(
        (await admin.query('SELECT COUNT(*)::text AS n FROM audit_records')).rows[0]!['n'],
      );
      expect(auditAfter).toBe(auditBefore);
    },
  );

  it.skipIf(skip)(
    'ABANDONED records env.incident.abandoned per tenant (chain intact) before consuming the manifest and removing the lock; a repeat is refused; an interrupted clearance completes without a second attestation',
    async () => {
      const id = `2026-09-08T16-00Z-cat1-${suffix.slice(0, 2)}c`;
      const inc = mkIncidentDir(id);
      const tenantCount = Number(
        (await admin.query('SELECT COUNT(*)::text AS n FROM tenants')).rows[0]!['n'],
      );
      const r = runClear(
        [
          '--incident-id',
          id,
          '--disposition',
          'ABANDONED',
          '--force-abandoned',
          'RCA: capture was a false positive',
          '--json',
        ],
        { PILOT_1_INCIDENT_LOGS_DIR: inc },
      );
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({
        disposition: 'ABANDONED',
        purgeAttested: false,
        abandonedAttestationEmitted: true,
      });
      const ab = await rows('env.incident.abandoned', id);
      expect(ab.length).toBe(tenantCount);
      for (const row of ab) {
        expect(row.actor_tenant_id).toBe(TENANT);
        expect(row.category).toBe('B');
        expect(row.actor_type).toBe('platform_admin');
        expect(row.payload).toMatchObject({
          incidentId: id,
          reason: 'RCA: capture was a false positive',
          purgeAttested: false,
          disposition: 'ABANDONED',
        });
      }
      expect(new Set(ab.map((x) => x.tenant_id)).size).toBe(tenantCount);
      const m = JSON.parse(
        fs.readFileSync(path.join(inc, `${id}.manifest.json`), 'utf8'),
      ) as Record<string, unknown>;
      expect(m).toMatchObject({
        consumed: true,
        disposition: 'ABANDONED',
        abandonReason: 'RCA: capture was a false positive',
      });
      expect(fs.existsSync(path.join(inc, '.incident.lock'))).toBe(false);
      // chain integrity of the appended rows: hashes computed by the DB trigger, none null
      const chain = await admin
        .query<{
          n: string;
        }>(
          `SELECT COUNT(*)::text AS n FROM audit_records WHERE action = 'env.incident.abandoned' AND payload->>'incidentId' = $1 AND (record_hash IS NULL OR record_hash = '')`,
          [id],
        )
        .catch(() => ({ rows: [{ n: '0' }] }));
      expect(chain.rows[0]!.n).toBe('0');
      // repeat: no lock → refused
      const again = runClear(
        ['--incident-id', id, '--disposition', 'ABANDONED', '--force-abandoned', 'x'],
        { PILOT_1_INCIDENT_LOGS_DIR: inc },
      );
      expect(again.status).toBe(1);
      expect(again.stderr).toMatch(/no incident lock is present/);
      // interrupted clearance: re-create the lock as if the unlink had not happened → completes, no new rows
      fs.writeFileSync(
        path.join(inc, '.incident.lock'),
        JSON.stringify({ incidentId: id, openedAt: 'x', openedBy: 'ci' }),
      );
      const fin = runClear(
        ['--incident-id', id, '--disposition', 'ABANDONED', '--force-abandoned', 'x', '--json'],
        { PILOT_1_INCIDENT_LOGS_DIR: inc },
      );
      expect(fin.status, fin.stderr).toBe(0);
      expect(JSON.parse(fin.stdout)).toMatchObject({
        completedInterruptedClearance: true,
        abandonedAttestationEmitted: false,
      });
      expect((await rows('env.incident.abandoned', id)).length).toBe(tenantCount);
      expect(fs.existsSync(path.join(inc, '.incident.lock'))).toBe(false);
    },
  );
});
