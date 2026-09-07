import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { applyMigrations } from './migrate.mjs';

const privateTables = [
  'consent_care_membership',
  'consent_care_policy',
  'consent_care_policy_term',
  'consent_care_decision',
];
const retainedTables = ['consent', 'consent_versions', 'audit_records', 'domain_events_outbox'];
const filename = '093_care_consent_publication.sql';
async function fingerprint(db, names) {
  const result = {};
  for (const name of names) {
    const rows = await db.query(
      `SELECT to_jsonb(t) AS row FROM public.${name} t ORDER BY to_jsonb(t)::text COLLATE "C"`,
    );
    result[name] = createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex');
  }
  return result;
}
/** Run only in the dedicated synthetic acceptance database, using its migration connection. */
export async function verifyCareConsentRollback(db, populated, prefixDirectory) {
  assert.equal(
    (await db.query('SELECT current_database() AS name')).rows[0].name,
    'telecheck_consent',
  );
  const counts = [];
  for (const name of privateTables)
    counts.push(Number((await db.query(`SELECT count(*) AS n FROM public.${name}`)).rows[0].n));
  assert.equal(
    counts.some((count) => count > 0),
    populated,
  );
  const retainedBefore = await fingerprint(db, retainedTables);
  const source = await readFile(
    new URL('../migrations/rollback/093_rollback.sql', import.meta.url),
    'utf8',
  );
  if (populated) {
    const privateBefore = await fingerprint(db, privateTables);
    await db.query('BEGIN');
    try {
      await assert.rejects(
        db.query(source),
        (error) =>
          error.code === '0A000' &&
          error.message === 'consent_rollback_requires_reviewed_forward_migration',
      );
    } finally {
      await db.query('ROLLBACK');
    }
    assert.deepEqual(await fingerprint(db, privateTables), privateBefore);
    assert.deepEqual(await fingerprint(db, retainedTables), retainedBefore);
    console.log(
      'PASS populated consent rollback refused; private decisions, policy and canonical evidence preserved.',
    );
    return;
  }
  assert.equal(typeof prefixDirectory, 'string', 'An isolated canonical prefix is required.');
  assert.equal(
    (await db.query('SELECT max(filename) AS name FROM schema_migrations')).rows[0].name,
    filename,
    'Verify rollback at migration 093 before later dependent migrations are installed.',
  );
  await db.query('BEGIN');
  try {
    await db.query(source);
    assert.equal(
      (await db.query("SELECT to_regclass('public.consent_care_decision') AS name")).rows[0].name,
      null,
    );
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM pg_roles WHERE rolname LIKE 'consent_care_%'",
        )
      ).rows[0].n,
      0,
    );
    assert.deepEqual(await fingerprint(db, retainedTables), retainedBefore);
    assert.equal(
      (await db.query('DELETE FROM schema_migrations WHERE filename=$1', [filename])).rowCount,
      1,
    );
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
  assert.equal((await applyMigrations(db, prefixDirectory)).applied, 1);
  assert.equal((await applyMigrations(db, prefixDirectory)).applied, 0);
  assert.deepEqual(await fingerprint(db, retainedTables), retainedBefore);
  console.log(
    'PASS committed empty consent rollback and canonical reapplication/replay preserve earlier evidence.',
  );
}
