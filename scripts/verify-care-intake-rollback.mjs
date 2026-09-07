import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function fingerprint(db) {
  const result = {};
  for (const name of [
    'consult_care_binding',
    'consult_care_submission',
    'consult_intake_submission',
    'consult_lifecycle_transition',
    'audit_records',
    'domain_events_outbox',
  ]) {
    result[name] = (
      await db.query(
        `SELECT count(*)::text AS count, md5(COALESCE(string_agg(to_jsonb(t)::text, chr(10) ORDER BY to_jsonb(t)::text),'')) AS digest FROM public.${name} t`,
      )
    ).rows[0];
  }
  return result;
}
/** This released boundary requires reviewed forward recovery; rollback cannot erase care. */
export async function verifyCareIntakeRollback(db) {
  const before = await fingerprint(db);
  await db.query('BEGIN');
  try {
    const source = await readFile(
      new URL('../migrations/rollback/095_rollback.sql', import.meta.url),
      'utf8',
    );
    await assert.rejects(
      db.query(source),
      (error) =>
        error.code === '0A000' &&
        error.message === 'care_intake_rollback_requires_reviewed_forward_migration',
    );
  } finally {
    await db.query('ROLLBACK');
  }
  assert.deepEqual(await fingerprint(db), before);
  console.log(
    'Care intake rollback preserves binding, encrypted clinical records, lifecycle, audit and outbox',
  );
}
