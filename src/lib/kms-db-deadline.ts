/** Client-side limits also cover a server reply that never reaches the client. */
import type { DbTransaction } from './db.js';
import { KmsOperationError } from './kms-aws.js';

export const KMS_DB_LIMITS = { queryMs: 2000, transactionMs: 8000, acquireMs: 2000 } as const;
export interface KmsDbLimits {
  queryMs: number;
  transactionMs: number;
  acquireMs: number;
}
export function validateKmsDbLimits(limits: KmsDbLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isInteger(value) || value < 1 || value > 30_000) throw new KmsOperationError();
  }
}

export function deadlineClient(client: DbTransaction, discard: () => void, limits: KmsDbLimits) {
  const deadline = performance.now() + limits.transactionMs;
  let discarded = false;
  function close() {
    if (discarded) return;
    discarded = true;
    // The owner removes this connection from circulation and closes its socket.
    // Never await a protocol acknowledgement from an uncertain connection.
    discard();
  }
  const tx: DbTransaction = {
    query<R>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<{ rows: R[]; rowCount: number | null }> {
      if (discarded) return Promise.reject(new KmsOperationError());
      const remaining = Math.min(limits.queryMs, deadline - performance.now());
      if (remaining <= 0) {
        close();
        return Promise.reject(new KmsOperationError());
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          close();
          reject(new KmsOperationError());
        }, remaining);
        // Both late completion branches are consumed. They cannot resume the
        // transaction callback or place a timed-out connection back in its pool.
        void Promise.resolve()
          .then(() => client.query<R>(sql, values))
          .then(
            (result) => {
              clearTimeout(timer);
              if (!discarded) resolve(result);
            },
            () => {
              clearTimeout(timer);
              reject(new KmsOperationError());
            },
          );
      });
    },
  };
  return { tx, close, isDiscarded: () => discarded };
}

/** The business transaction owner retains release(); we only cancel its socket. */
const unusableBusinessClients = new WeakSet<DbTransaction>();
export function businessDeadlineClient(client: DbTransaction, limits: KmsDbLimits) {
  const cancellable = client as DbTransaction & { end?: () => unknown };
  if (unusableBusinessClients.has(client) || typeof cancellable.end !== 'function')
    throw new KmsOperationError();
  return deadlineClient(
    client,
    () => {
      unusableBusinessClients.add(client);
      // Native pg.Client.end() destroys an active query's socket immediately.
      // Do not release a pooled business client twice; withTransaction owns it.
      try {
        void Promise.resolve(cancellable.end!()).catch(() => undefined);
      } catch {
        /* Already closed. */
      }
    },
    limits,
  );
}

export async function acquireKmsConnection<T extends { release(error?: boolean): void }>(
  connect: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = Promise.resolve().then(connect);
  void pending.then(
    (client) => {
      if (expired) client.release(true);
    },
    () => undefined,
  );
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new KmsOperationError());
        }, timeoutMs);
      }),
    ]);
  } catch {
    throw new KmsOperationError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
