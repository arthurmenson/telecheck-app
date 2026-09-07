import pg from 'pg';

import { config } from '../../../lib/config.js';
import type { DbClient } from '../../../lib/db.js';

// Separate from the recording pool: resource contention must not consume its
// connections. No wait queue, at most four short-lived read connections/process.
const MAX_READS = 4;
const READ_DEADLINE_MS = 2_000;
let activeReads = 0;

/** Read operation with a deadline; temporary tenant bindings roll back. */
export async function withPatientCareRead<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
  if (activeReads >= MAX_READS) throw new Error('crisis_read_unavailable');
  activeReads++;
  const client = new pg.Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 1_000,
    application_name: 'crisis_care_bounded_read',
    ssl: config.dbSslMode === 'require' ? { rejectUnauthorized: false } : false,
  });
  // Socket failures must be consumed, never logged with connection/query data.
  client.on('error', () => undefined);
  const deadline = performance.now() + READ_DEADLINE_MS;
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    // pg.Client.end destroys the socket when a query is active. The driver's
    // connectionTimeoutMillis also cancels an unfinished connection handshake.
    void client.end().catch(() => undefined);
  }
  function bounded<R>(operation: () => Promise<R>): Promise<R> {
    const remaining = deadline - performance.now();
    if (closed || remaining <= 0) {
      close();
      return Promise.reject(new Error('crisis_read_unavailable'));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        close();
        reject(new Error('crisis_read_unavailable'));
      }, remaining);
      void Promise.resolve()
        .then(operation)
        .then(
          (result) => {
            clearTimeout(timer);
            if (!closed) resolve(result);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
    });
  }
  const tx: DbClient = {
    query: <R>(sql: string, values?: readonly unknown[]) =>
      bounded(
        () =>
          client.query(sql, values ? [...values] : undefined) as unknown as Promise<{
            rows: R[];
            rowCount: number | null;
          }>,
      ),
  };
  try {
    await bounded(() => client.connect());
    // Tenant authorization writes a temporary binding; always roll it back.
    await tx.query('BEGIN');
    await tx.query("SET LOCAL statement_timeout='1500ms'");
    await tx.query("SET LOCAL lock_timeout='1000ms'");
    const result = await work(tx);
    await tx.query('ROLLBACK');
    return result;
  } finally {
    // Closing a failed/expired read rolls back its transaction; it is never
    // reusable or returned to a pool, and late completion cannot resume work.
    close();
    activeReads--;
  }
}
