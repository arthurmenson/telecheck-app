/**
 * Disposable-database helper for the Pilot 1 lifecycle suites (env-purge,
 * incident-clear): a schema-only CLONE of the shared, fully migrated test
 * database plus the tenant baseline rows, so scripts that append per-tenant
 * audit rows or purge tables never touch the shared partitions.
 *
 * Replaying the migration inventory into a second database of the same
 * cluster collides on cluster-wide roles (migration 032 CREATE ROLE → 42710),
 * hence the clone. Migration 026 runs `SET LOCAL search_path = pg_catalog,
 * public` and creates its trigger function UNQUALIFIED, so under a superuser
 * runner the function lands in pg_catalog — which pg_dump never dumps, while
 * the trigger definition references it bare. User-created functions living in
 * pg_catalog (oid >= 16384) are therefore carried across explicitly before the
 * schema restore. (Follow-up: fix-forward migration moving it to public.)
 */
import { spawnSync } from 'node:child_process';

export function cloneSchema(fromDsn: string, toDsn: string) {
  const opts = { encoding: 'utf8' as const, maxBuffer: 256 * 1024 * 1024 };
  // rbac_roles is a test-bootstrap fixture (tests/setup.ts), not a migration
  // table: it is excluded so the clone is exactly the migrated schema.
  const schema = spawnSync(
    'pg_dump',
    ['--schema-only', '--no-comments', '-T', 'public.rbac_roles', `--dbname=${fromDsn}`],
    opts,
  );
  if (schema.status !== 0) throw new Error(`pg_dump --schema-only failed: ${schema.stderr}`);
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

/** Replace the database name in a libpq URL. */
export function withDatabase(dsn: string, dbName: string) {
  return dsn.replace(/\/[^/?]+(\?|$)/, `/${dbName}$1`);
}
