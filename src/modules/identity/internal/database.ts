/** Identity owns a separate login connection; application SQL cannot assume it. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';

import { config } from '../../../lib/config.js';
import { getPool, hasTestPool, type DbClient } from '../../../lib/db.js';
import type { IdempotencyCtx } from '../../../lib/idempotency.js';
import {
  withIdempotentExecution as sharedIdempotentExecution,
  type ServiceErrorMapper,
} from '../../../lib/idempotent-handler.js';

let pool: pg.Pool | null = null;

function identityPool(): pg.Pool {
  if (!config.identityDatabaseUrl) {
    if (config.nodeEnv === 'test' && hasTestPool()) return getPool();
    throw new Error('identity_database_unavailable');
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.identityDatabaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 10_000,
      lock_timeout: 3_000,
      ssl: config.dbSslMode === 'require' ? { rejectUnauthorized: false } : false,
    });
    // Pool faults are handled by the operation's bounded failure; no credentials
    // or raw database errors are printed by an idle connection callback.
    pool.on('error', () => {});
  }
  return pool;
}

async function assertIdentityConnection(tx: DbClient): Promise<void> {
  if (!config.identityDatabaseUrl && config.nodeEnv === 'test' && hasTestPool()) return;
  const result = await tx.query<{ valid: boolean }>(`
    SELECT session_user = 'identity_service_role'
       AND current_user = 'identity_service_role'
       AND NOT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)
       AND NOT pg_has_role('telecheck_app_role', 'identity_service_role', 'MEMBER')
       AND NOT pg_has_role('bind_actor_context_role', 'identity_service_role', 'MEMBER')
       AS valid FROM pg_roles WHERE rolname = session_user`);
  if (result.rows[0]?.valid !== true) throw new Error('identity_database_role_invalid');
}

async function withIdentityTransaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
  const client = await identityPool().connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    await assertIdentityConnection(client);
    await client.query('SELECT clear_tenant_context()');
    const result = await fn(client);
    await client.query('SELECT clear_tenant_context()');
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

/** Default Identity repository connections never fall back to the app login. */
export async function withTenantBoundConnection<T>(
  tenantId: string,
  fn: (tx: DbClient) => Promise<T>,
): Promise<T> {
  return withIdentityTransaction(async (tx) => {
    await tx.query('SELECT set_tenant_context($1)', [tenantId]);
    return fn(tx);
  });
}

/** Reservation, credential mutation, audit and cached result commit together. */
export function withIdempotentExecution<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  mapError: ServiceErrorMapper,
  body: (tx: DbClient, context: IdempotencyCtx) => Promise<{ status: number; view: T }>,
): Promise<unknown> {
  return sharedIdempotentExecution(
    req,
    reply,
    mapError,
    body,
    withIdentityTransaction,
    'identity_idempotency_keys',
  );
}

export async function closeIdentityPool(): Promise<void> {
  const closing = pool;
  pool = null;
  await closing?.end();
}

/** Fail boot for a configured but miswired Identity connection. */
export async function verifyIdentityPool(): Promise<void> {
  if (!config.identityDatabaseUrl && config.nodeEnv !== 'production') return;
  await withIdentityTransaction(async (tx) => {
    const result = await tx.query<{ ready: boolean }>(`
      SELECT NOT EXISTS (
          SELECT 1 FROM (VALUES
            ('public.identity_idempotency_keys','SELECT'), ('public.identity_idempotency_keys','INSERT'),
            ('public.identity_idempotency_keys','UPDATE'), ('public.identity_idempotency_keys','DELETE'),
            ('public.account_pin_credentials','SELECT'), ('public.account_pin_credentials','INSERT'),
            ('public.account_pin_credentials','UPDATE')
          ) AS required(table_name, privilege_name)
          WHERE NOT has_table_privilege(current_user, required.table_name, required.privilege_name)
        )
        AND NOT has_table_privilege('telecheck_app_role', 'public.identity_idempotency_keys', 'SELECT,INSERT,UPDATE,DELETE')
        AND NOT has_table_privilege('telecheck_app_role', 'public.account_pin_credentials', 'SELECT,INSERT,UPDATE,DELETE')
        AND NOT has_table_privilege('telecheck_app_role', 'public.sessions', 'INSERT,UPDATE')
        AS ready`);
    if (result.rows[0]?.ready !== true) throw new Error('identity_database_privileges_invalid');
  });
}
