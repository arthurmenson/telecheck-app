/** Identity owns a separate login connection; application SQL cannot assume it. */
import type { FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';

import { config } from '../../../lib/config.js';
import { getPool, hasTestPool, type DbClient } from '../../../lib/db.js';
import { IdempotencyReplayError, type IdempotencyCtx } from '../../../lib/idempotency.js';
import {
  withIdempotentExecution as sharedIdempotentExecution,
  type ServiceErrorMapper,
} from '../../../lib/idempotent-handler.js';

import {
  assertPatientPinSessionReceipt,
  PatientPinSessionUnavailable,
} from './services/patient-pin-session-receipt.js';

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
    // pg also emits an error directly on a checked-out client when its socket
    // closes. Its query rejects into rollback/discard; the event must not crash
    // the process or expose transport details before that safe response runs.
    pool.on('connect', (client) => client.on('error', () => {}));
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

export async function withIdentityTransaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
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
  afterCommit?: () => void,
): Promise<unknown> {
  return sharedIdempotentExecution(
    req,
    reply,
    (error, response, requestId) => {
      if (!(error instanceof PatientPinSessionUnavailable))
        return mapError(error, response, requestId);
      void response.code(401).send({
        error: {
          code: 'internal.auth.unauthenticated',
          message: 'Sign in again to continue.',
          request_id: requestId,
        },
      });
      return true;
    },
    body,
    async (work) => {
      const result = await withIdentityTransaction(async (tx) => {
        try {
          const result = await work(tx);
          await assertPatientPinSessionReceipt(req, tx, result);
          return result;
        } catch (error) {
          if (error instanceof IdempotencyReplayError) {
            await assertPatientPinSessionReceipt(req, tx, {
              status: error.cachedStatus,
              body: error.cachedBody,
            });
          }
          throw error;
        }
      });
      // Only a successfully acknowledged COMMIT reaches this notification.
      // Replays and mapped failures leave via the exception path above.
      afterCommit?.();
      return result;
    },
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
