/**
 * backup-redaction-roundtrip.test.ts — Layer 5 proven against real tools.
 *
 * pg_dump (real) -> scripts/pii-scrub.mjs --mode backup -> psql restore into a
 * scratch database. Asserts: restore succeeds (schema + rows intact, counts
 * equal), no seeded PII value survives in text, JSON or bytea columns, and
 * numbers keep their type. Requires pg_dump/psql on PATH (CI runners have
 * them) and TEST_DATABASE_URL (own pools; nothing runs under the harness
 * savepoint because pg_dump reads committed data on its own connection).
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env['TEST_DATABASE_URL'] as string;
const TABLE = `l5_roundtrip_${randomBytes(3).toString('hex')}`;
const SCRATCH_DB = `telecheck_l5_${randomBytes(3).toString('hex')}`;
const SAMPLES = {
  email: 'reach me at test.user@example.com anytime',
  ssn: 'my SSN is 123-45-6789 for the form',
  phone: '(415) 555-0123',
};

let admin: pg.Pool;

function tool(name: string): string {
  const r = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0)
    throw new Error(`${name} is required for the Layer 5 round-trip test (CI runners provide it)`);
  return name;
}

beforeAll(async () => {
  tool('pg_dump');
  tool('psql');
  admin = new pg.Pool({ connectionString: url, max: 2 });
  await admin.query(
    `CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, tenant_id text NOT NULL, body text, note text, meta jsonb DEFAULT '{}'::jsonb NOT NULL, blob bytea, n bigint)`,
  );
  await admin.query(
    `INSERT INTO public.${TABLE} (tenant_id, body, note, meta, blob, n) VALUES
       ('Telecheck-US', $1, E'MRN\n1234567', $2::jsonb, $3::bytea, 3125551212),
       ('Telecheck-US', 'clean synthetic text', NULL, '{"k":2}'::jsonb, decode('00ff10c0', 'hex'), 42)`,
    [SAMPLES.email, JSON.stringify({ ssn: SAMPLES.ssn, n: 7 }), Buffer.from(SAMPLES.phone, 'utf8')],
  );
});

afterAll(async () => {
  await admin?.query(`DROP TABLE IF EXISTS public.${TABLE}`).catch(() => undefined);
  await admin?.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`).catch(() => undefined);
  await admin?.end().catch(() => undefined);
});

describe('Layer 5 round-trip: pg_dump -> pii-scrub -> restore', () => {
  it('restores a scrubbed dump with schema and counts intact and no seeded PII surviving', async () => {
    const dump = spawnSync(
      'pg_dump',
      [
        '--format=plain',
        '--encoding=UTF8',
        '--no-owner',
        '--no-privileges',
        `--table=public.${TABLE}`,
        url,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    expect(dump.status, dump.stderr).toBe(0);
    expect(dump.stdout).toContain(SAMPLES.email);

    const scrub = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.join(process.cwd(), 'scripts', 'pii-scrub.mjs'), '--mode', 'backup'],
      { input: dump.stdout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    expect(scrub.status, scrub.stderr).toBe(0);
    for (const v of [SAMPLES.email, '123-45-6789', '555-0123', '1234567'])
      expect(scrub.stdout).not.toContain(v);

    await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    const scratchUrl = new URL(url);
    scratchUrl.pathname = `/${SCRATCH_DB}`;
    const restore = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', scratchUrl.toString()], {
      input: scrub.stdout,
      encoding: 'utf8',
    });
    expect(restore.status, restore.stderr).toBe(0);

    const scratch = new pg.Pool({ connectionString: scratchUrl.toString(), max: 1 });
    try {
      const rows = await scratch.query<{
        body: string | null;
        note: string | null;
        meta: { ssn?: string; n?: number; k?: number };
        blob: Buffer | null;
        n: string;
      }>(`SELECT body, note, meta, blob, n FROM public.${TABLE} ORDER BY id`);
      expect(rows.rowCount).toBe(2);
      const [r1, r2] = rows.rows;
      expect(r1!.body).not.toContain('test.user@example.com');
      expect(r1!.note).not.toContain('1234567');
      expect(r1!.meta.ssn).not.toContain('123-45-6789');
      expect(r1!.meta.n).toBe(7);
      expect(Buffer.from(r1!.blob!).toString('utf8')).not.toContain('555-0123');
      expect(r1!.n).toBe('0');
      expect(r2!.body).toBe('clean synthetic text');
      expect(r2!.meta).toEqual({ k: 2 });
      expect(Buffer.from(r2!.blob!).toString('hex')).toBe('00ff10c0');
      expect(r2!.n).toBe('42');
    } finally {
      await scratch.end();
    }
  });
});
