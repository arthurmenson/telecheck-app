import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { splitSql, transactionalMigrationSource } from './migration-source.mjs';

test('keeps function bodies, comments, and quoted semicolons intact', () => {
  const source = `-- BEGIN;\nBEGIN;\nCREATE FUNCTION f() RETURNS void AS $body$ BEGIN RAISE NOTICE 'COMMIT;'; END; $body$ LANGUAGE plpgsql;\n/* outer /* COMMIT; */ comment */ SELECT 'a;''b', "x;y", E'escaped\\';text';\nCOMMIT; -- done`;
  const result = transactionalMigrationSource(source);
  assert.equal(splitSql(result).length, 2);
  assert.match(result, /RAISE NOTICE 'COMMIT;'/);
  assert.match(result, /escaped\\';text/);
});

test('rejects commits in the body, missing transaction ends, and psql commands', () => {
  for (const source of [
    'BEGIN; SELECT 1;',
    'SELECT 1; COMMIT;',
    'BEGIN; SELECT 1; COMMIT; SELECT 2; COMMIT;',
    'SELECT 1; ROLLBACK;',
    '\\connect another_db\nSELECT 1;',
    "SELECT 'unfinished",
  ]) {
    assert.throws(() => transactionalMigrationSource(source), /migration_source_/);
  }
});

test('accepts unwrapped SQL and ignores transaction words in data', () => {
  assert.equal(splitSql(transactionalMigrationSource("SELECT 'BEGIN; COMMIT;';")).length, 1);
  assert.equal(
    splitSql(transactionalMigrationSource('/* COMMIT; */ BEGIN WORK; SELECT 1; END TRANSACTION;'))
      .length,
    1,
  );
});

test('rejects transaction escapes hidden by identifier dollars or CR comments', () => {
  for (const source of [
    'CREATE TABLE foo$tag$(id int); COMMIT; CREATE TABLE bar$tag$(id int); SELECT 1/0;',
    'CREATE TABLE cr_leak(id int) -- split\r; COMMIT;\nSELECT 1/0;',
  ]) {
    assert.throws(
      () => transactionalMigrationSource(source),
      /migration_source_internal_transaction/,
    );
  }
  assert.equal(splitSql('SELECT $é$COMMIT;$é$; SELECT foo$tag$;').length, 2);
});

test('all checked-in forward migrations can use one runner-owned transaction', async () => {
  const directory = new URL('../../migrations/', import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort();
  assert.ok(names.length >= 79);
  for (const name of names) {
    const source = await readFile(new URL(name, directory), 'utf8');
    assert.doesNotThrow(() => transactionalMigrationSource(source), name);
  }
});
