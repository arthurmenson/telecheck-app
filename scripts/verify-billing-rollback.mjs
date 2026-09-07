/** Verify the deliberate refusal of unsafe financial schema downgrades. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export async function verifyBillingRollbackRefusal(db) {
  const tables = [
    'billing_consult_price',
    'billing_consult_quote',
    'billing_payment_intent',
    'billing_provider_event',
    'billing_refund_intent',
    'consult',
    'consult_lifecycle_transition',
    'audit_records',
    'domain_events_outbox',
  ];
  async function fingerprint() {
    const rows = {};
    for (const table of tables) {
      rows[table] = (
        await db.query(`SELECT count(*)::int AS count,
        md5(COALESCE(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text),'')) AS hash FROM public.${table} t`)
      ).rows[0];
    }
    rows.functions = (
      await db.query(`SELECT p.proname,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname LIKE 'billing_%' ORDER BY p.oid`)
    ).rows;
    rows.constraints = (
      await db.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid IN ('public.billing_payment_intent'::regclass,'public.consult'::regclass) ORDER BY oid`)
    ).rows;
    rows.triggers = (
      await db.query(`SELECT tgname,pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgrelid='public.consult_lifecycle_transition'::regclass AND NOT tgisinternal ORDER BY oid`)
    ).rows;
    rows.roles = (
      await db.query(`SELECT rolname,rolsuper,rolinherit,rolbypassrls,rolcreaterole,rolcreatedb
      FROM pg_roles WHERE rolname LIKE 'billing_%' ORDER BY rolname`)
    ).rows;
    return rows;
  }
  const before = await fingerprint();
  for (const migration of ['088', '089']) {
    const sql = await readFile(
      new URL(`../migrations/rollback/${migration}_rollback.sql`, import.meta.url),
      'utf8',
    );
    await db.query('BEGIN');
    try {
      await assert.rejects(
        db.query(sql),
        (error) =>
          error.code === '0A000' &&
          error.message === 'billing_rollback_requires_reviewed_forward_migration',
      );
    } finally {
      await db.query('ROLLBACK');
    }
    assert.deepEqual(
      await fingerprint(),
      before,
      `${migration} must retain financial evidence and admission guards`,
    );
  }
  console.log(
    'PASS Billing 088/089 unsafe downgrade refusal; financial rows, audit/outbox, functions, constraints, roles and admission triggers unchanged.',
  );
}
