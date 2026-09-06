#!/usr/bin/env node
/** Cross-platform, checksum-verified, atomic PostgreSQL migration runner. */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { transactionalMigrationSource } from './lib/migration-source.mjs';

export async function applyMigrations(client, directory, report = () => {}) {
  await client.query("SELECT pg_advisory_lock(hashtext('telecheck_operational_migrations'))");
  try {
    await client.query('SET standard_conforming_strings = on');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), checksum_sha TEXT
    )`);
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum_sha TEXT');
    const files = (await readdir(directory))
      .filter((name) => /^\d{3}_[a-zA-Z0-9_-]+\.sql$/.test(name))
      .sort();
    if (!files.length) throw new Error('migration_inventory_empty');
    const sources = new Map();
    // Validate the complete inventory before executing any migration.
    for (const name of files) {
      const raw = await readFile(resolve(directory, name));
      const checksum = createHash('sha256').update(raw).digest('hex');
      sources.set(name, { checksum, sql: transactionalMigrationSource(raw.toString('utf8')) });
    }
    const applied = await client.query(
      'SELECT filename, checksum_sha FROM schema_migrations ORDER BY filename',
    );
    for (const row of applied.rows) {
      if (!sources.has(row.filename)) throw new Error('migration_history_missing_source');
      if (!/^[a-f0-9]{64}$/.test(row.checksum_sha ?? ''))
        throw new Error('migration_history_requires_verified_adoption');
      if (sources.get(row.filename).checksum !== row.checksum_sha)
        throw new Error('migration_source_checksum_changed');
    }
    const history = new Set(applied.rows.map((row) => row.filename));
    const latest = applied.rows.at(-1)?.filename;
    if (latest && files.some((name) => name < latest && !history.has(name)))
      throw new Error('migration_history_out_of_order');
    // The canonical chain assumes this least-privileged login role exists.
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telecheck_app_role') THEN
        CREATE ROLE telecheck_app_role NOINHERIT NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$`);
    let count = 0;
    for (const name of files) {
      if (history.has(name)) continue;
      const source = sources.get(name);
      await client.query('BEGIN');
      try {
        await client.query("SET LOCAL lock_timeout = '10s'");
        await client.query("SET LOCAL statement_timeout = '120s'");
        await client.query(source.sql);
        await client.query('INSERT INTO schema_migrations(filename, checksum_sha) VALUES ($1,$2)', [
          name,
          source.checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        // Avoid leaking SQL text, parameters, connection strings or DB error detail.
        const code =
          typeof error?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
            ? error.code
            : 'unknown';
        throw new Error(`migration_apply_failed:${name}:${code}`);
      }
      count += 1;
      report(name);
    }
    return { applied: count, previouslyApplied: history.size };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('telecheck_operational_migrations'))");
  }
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error('MIGRATION_DATABASE_URL is required; use the dedicated migration principal');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const result = await applyMigrations(
      client,
      fileURLToPath(new URL('../migrations/', import.meta.url)),
      (name) => console.log(`Applied ${name}`),
    );
    console.log(JSON.stringify(result));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message =
      error instanceof Error && /^(migration_|MIGRATION_DATABASE_URL)/.test(error.message)
        ? error.message
        : 'migration_connection_or_setup_failed';
    console.error(message);
    process.exitCode = 1;
  });
}
