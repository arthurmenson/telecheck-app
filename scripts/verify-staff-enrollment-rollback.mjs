import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function verifyStaffEnrollmentRollback(db) {
  assert.equal(process.env.CARE_SYNTHETIC_ACCEPTANCE, 'true');
  assert(['127.0.0.1', 'localhost', '::1'].includes(db.connectionParameters?.host));
  assert.equal(db.connectionParameters?.database, 'telecheck_care_intake');
  assert.equal(
    (await db.query('SELECT current_database() AS db')).rows[0].db,
    'telecheck_care_intake',
  );
  async function snapshot() {
    const result = {};
    for (const name of [
      'accounts',
      'identity_staff_enrollment',
      'identity_staff_membership',
      'audit_records',
      'domain_events_outbox',
    ])
      result[name] = (
        await db.query(
          `SELECT count(*)::text AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,chr(10) ORDER BY to_jsonb(t)::text),'')) AS digest FROM public.${name} t`,
        )
      ).rows[0];
    return result;
  }
  const before = await snapshot();
  const rollback = await readFile(
    new URL('../migrations/rollback/098_rollback.sql', import.meta.url),
    'utf8',
  );
  await db.query('BEGIN');
  try {
    await assert.rejects(db.query(rollback), (e) => e.code === '0A000');
  } finally {
    await db.query('ROLLBACK');
  }
  assert.deepEqual(await snapshot(), before);
  console.log(
    'Staff098 downgrade refusal preserves identities, enrollment, membership, audit and outbox',
  );
}
