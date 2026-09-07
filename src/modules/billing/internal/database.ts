import pg from 'pg';

import type { DbTransaction } from '../../../lib/db.js';

import { BillingError, type BillingActor } from './types.js';

let pool: pg.Pool | undefined;
function billingPool(): pg.Pool {
  const url = process.env['BILLING_DATABASE_URL'];
  if (!url) throw new BillingError('billing.configuration_unavailable');
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
      statement_timeout: 5000,
      query_timeout: 6000,
      lock_timeout: 2000,
      ssl: process.env['NODE_ENV'] === 'production' ? { rejectUnauthorized: true } : false,
    });
    pool.on('error', () => {});
  }
  return pool;
}
export async function assertBillingActor(tx: DbTransaction, actor: BillingActor): Promise<void> {
  const r = await tx.query<{
    tenant_id: string;
    account_id: string;
    actor_role: string;
    country_of_care: string;
  }>('SELECT * FROM public.billing_current_actor()');
  const a = r.rows[0];
  if (
    !a ||
    a.tenant_id !== actor.context.tenantId ||
    a.account_id !== actor.accountId ||
    a.actor_role !== actor.role ||
    a.country_of_care !== actor.context.countryOfCare
  )
    throw new BillingError('billing.actor_unavailable', 403);
}
export async function billingTransaction<T>(
  tenantId: string,
  fn: (tx: DbTransaction) => Promise<T>,
  actor?: BillingActor,
): Promise<T> {
  let client: pg.PoolClient;
  try {
    client = await billingPool().connect();
  } catch {
    // Connection-string parser errors can carry the entire credential-bearing
    // input. Never send those errors to the application's general logger.
    throw new BillingError('billing.persistence_unavailable');
  }
  let discard = false;
  const timer = setTimeout(() => {
    discard = true;
    client.release(true);
  }, 15000);
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    const r = await client.query<{ valid: boolean }>(`SELECT session_user = 'billing_service_role'
      AND current_user = session_user AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
      AND NOT pg_has_role('telecheck_app_role','billing_service_role','MEMBER')
      AND NOT pg_has_role('bind_actor_context_role','billing_service_role','MEMBER') AS valid
      FROM pg_catalog.pg_roles r WHERE rolname = session_user`);
    if (r.rows[0]?.valid !== true) throw new BillingError('billing.database_role_invalid');
    await client.query('SET LOCAL search_path = pg_catalog, public, pg_temp');
    await client.query('SELECT public.set_tenant_context($1)', [tenantId]);
    await client.query("SELECT set_config('app.request_nonce',$1,true)", [actor?.nonce ?? '']);
    if (actor) await assertBillingActor(client, actor);
    const value = await fn(client);
    if (actor) await assertBillingActor(client, actor);
    await client.query('SELECT public.clear_tenant_context()');
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try {
      if (!discard) await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    if (error instanceof BillingError) throw error;
    if ((error as { code?: string }).code === '42501')
      throw new BillingError('billing.actor_unavailable', 403);
    throw new BillingError('billing.persistence_unavailable');
  } finally {
    clearTimeout(timer);
    if (!discard) client.release();
    else {
      try {
        client.release(true);
      } catch {
        /* Already discarded at deadline. */
      }
    }
  }
}
export async function closeBillingPool(): Promise<void> {
  const old = pool;
  pool = undefined;
  await old?.end();
}
