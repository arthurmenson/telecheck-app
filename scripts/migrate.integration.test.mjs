import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { applyMigrations } from './migrate.mjs';

test('real PostgreSQL: rollback, atomic tracking, replay and checksum refusal', async () => {
  const configured = process.env.MIGRATION_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  assert.ok(
    configured,
    'TEST_DATABASE_URL or MIGRATION_TEST_DATABASE_URL must name the test cluster',
  );
  const base = new URL(configured);
  const database = `telecheck_migration_check_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base.href, connectionTimeoutMillis: 10_000 });
  const directory = await mkdtemp(join(tmpdir(), 'telecheck-migration-check-'));
  let client;
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    created = true;
    base.pathname = `/${database}`;
    client = new pg.Client({ connectionString: base.href, connectionTimeoutMillis: 10_000 });
    await client.connect();
    const first =
      'BEGIN; CREATE TABLE example (id integer PRIMARY KEY); INSERT INTO example VALUES (1); COMMIT;';
    await writeFile(join(directory, '001_example.sql'), first);
    await writeFile(
      join(directory, '002_fails.sql'),
      'BEGIN; CREATE TABLE should_rollback(id integer); INSERT INTO example VALUES (1); COMMIT;',
    );
    await assert.rejects(
      applyMigrations(client, directory),
      /migration_apply_failed:002_fails.sql:23505/,
    );
    assert.deepEqual((await client.query('SELECT filename FROM schema_migrations')).rows, [
      { filename: '001_example.sql' },
    ]);
    assert.equal(
      (await client.query("SELECT to_regclass('should_rollback') AS relation")).rows[0].relation,
      null,
    );
    await writeFile(
      join(directory, '002_fails.sql'),
      'BEGIN; INSERT INTO example VALUES (2); COMMIT;',
    );
    assert.deepEqual(await applyMigrations(client, directory), {
      applied: 1,
      previouslyApplied: 1,
    });
    assert.deepEqual(await applyMigrations(client, directory), {
      applied: 0,
      previouslyApplied: 2,
    });
    assert.equal(
      (await client.query('SELECT count(*)::int AS count FROM example')).rows[0].count,
      2,
    );
    await writeFile(join(directory, '001_example.sql'), first + '\n-- changed');
    await assert.rejects(applyMigrations(client, directory), /migration_source_checksum_changed/);
    await writeFile(join(directory, '001_example.sql'), first);
    for (const source of [
      'CREATE TABLE foo$tag$(id int); COMMIT; CREATE TABLE bar$tag$(id int); SELECT 1/0;',
      'CREATE TABLE cr_leak(id int) -- split\r; COMMIT;\nSELECT 1/0;',
    ]) {
      await writeFile(join(directory, '003_escape.sql'), source);
      await assert.rejects(
        applyMigrations(client, directory),
        /migration_source_internal_transaction/,
      );
      assert.equal(
        (await client.query("SELECT to_regclass('foo$tag$') AS relation")).rows[0].relation,
        null,
      );
      assert.equal(
        (await client.query("SELECT to_regclass('cr_leak') AS relation")).rows[0].relation,
        null,
      );
    }
    await rm(join(directory, '003_escape.sql'));
    await writeFile(
      join(directory, '003_string_mode.sql'),
      'SET standard_conforming_strings = off;',
    );
    await writeFile(
      join(directory, '004_string_probe.sql'),
      String.raw`CREATE TABLE string_mode_leak(id int);
SELECT '\'; SELECT '; COMMIT; SELECT '\'; SELECT ';
SELECT 1/0;`,
    );
    await assert.rejects(
      applyMigrations(client, directory),
      /migration_apply_failed:004_string_probe.sql:/,
    );
    assert.equal(
      (await client.query("SELECT to_regclass('string_mode_leak') AS relation")).rows[0].relation,
      null,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM schema_migrations WHERE filename = '004_string_probe.sql'",
        )
      ).rows[0].count,
      0,
    );
    await rm(join(directory, '004_string_probe.sql'));
    await client.query(
      "UPDATE schema_migrations SET checksum_sha = NULL WHERE filename = '001_example.sql'",
    );
    await assert.rejects(
      applyMigrations(client, directory),
      /migration_history_requires_verified_adoption/,
    );
  } finally {
    await client?.end();
    // Only the random database created by this test is eligible for removal.
    if (created && /^telecheck_migration_check_[a-f0-9]{16}$/.test(database))
      await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
