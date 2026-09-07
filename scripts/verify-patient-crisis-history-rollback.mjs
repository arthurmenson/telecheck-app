import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function fingerprint(db) {
  const result = {};
  for (const name of [
    'crisis_event',
    'crisis_care_admission',
    'crisis_event_lifecycle_transition',
    'notification_crisis_dispatch_ledger',
    'notification_crisis_provider_attempt',
    'notification_crisis_escalation_obligation',
    'audit_records',
    'domain_events_outbox',
  ]) {
    result[name] = (
      await db.query(
        `SELECT count(*)::text AS count,md5(COALESCE(string_agg(to_jsonb(t)::text,chr(10) ORDER BY to_jsonb(t)::text),'')) AS digest FROM public.${name} t`,
      )
    ).rows[0];
  }
  return result;
}
/** Committed read removal/reapplication, restricted to disposable local acceptance. */
export async function verifyPatientCrisisHistoryRollback(db) {
  assert.equal(process.env.CARE_SYNTHETIC_ACCEPTANCE, 'true');
  // Validate the actual client's destination. Docker's published localhost
  // connection reaches a bridge address inside PostgreSQL; inet_server_addr()
  // describes that server interface, not whether this is a local test client.
  assert(['127.0.0.1', 'localhost', '::1'].includes(db.connectionParameters?.host));
  assert.equal(db.connectionParameters?.database, 'telecheck_care_intake');
  const identity = (await db.query('SELECT current_database() AS db')).rows[0];
  assert.equal(identity.db, 'telecheck_care_intake');
  const before = await fingerprint(db);
  const definition = (
    await db.query(
      "SELECT pg_get_functiondef('public.crisis_care_patient_history(integer)'::regprocedure) AS definition",
    )
  ).rows[0].definition;
  const rollback = await readFile(
    new URL('../migrations/rollback/097_rollback.sql', import.meta.url),
    'utf8',
  );
  const source = await readFile(
    new URL('../migrations/097_patient_crisis_history.sql', import.meta.url),
    'utf8',
  );
  await db.query('BEGIN');
  try {
    await db.query(rollback);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
  assert.equal(
    (await db.query("SELECT to_regprocedure('public.crisis_care_patient_history(integer)') AS fn"))
      .rows[0].fn,
    null,
  );
  assert.deepEqual(await fingerprint(db), before);
  await db.query('BEGIN');
  try {
    await db.query(source);
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
  assert.equal(
    (
      await db.query(
        "SELECT pg_get_functiondef('public.crisis_care_patient_history(integer)'::regprocedure) AS definition",
      )
    ).rows[0].definition,
    definition,
  );
  assert.deepEqual(await fingerprint(db), before);
  console.log(
    'Crisis097 committed rollback/reapply preserves events,admission,lifecycle,dispatch,provider attempts,obligations,audit and outbox',
  );
}
