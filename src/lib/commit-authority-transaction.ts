import { withActorContext } from './actor-context-binding.js';
import { getPool, type DbClient, type DbTransaction, type withTransaction } from './db.js';
import {
  IdempotencyBodyMismatchError,
  IdempotencyInFlightError,
  IdempotencyReplayError,
} from './idempotency.js';
import { logger } from './logger.js';
import { readCurrentTenantId } from './rls.js';

/**
 * What a COMMIT-authority transaction must prove: before the work, after
 * it, before disclosing an idempotency outcome, and — via the module's
 * deferred evidence triggers — AT COMMIT.
 */
export interface CommitAuthority {
  tenantId: string;
  /** The request's actor nonce (SI-010 trust anchor). */
  nonce: string;
  /** Re-validates the live actor; throws PT401 / 42501 when it no longer holds. */
  assertLive: (tx: DbTransaction) => Promise<void>;
  /**
   * Builds the error surfaced when the COMMIT's fate is unknown (stalled
   * past the deadline, or a transport/class-08 failure after COMMIT was
   * issued). Must carry `code: 'PT503'` so the module maps it to 503.
   */
  unconfirmed: () => Error;
  /** Structured log event name for a discarded recording connection. */
  discardEvent: string;
  /**
   * Runs right after BEGIN, before any binding is set — e.g. a dedicated
   * pool's connection assertion. A failure here rolls back and passes
   * through unchanged.
   */
  afterBegin?: (tx: DbTransaction) => Promise<void>;
  /** SET LOCAL statement_timeout for the work (default 5s). */
  statementTimeout?: string;
  /** SET LOCAL lock_timeout for the work (default 2s). */
  lockTimeout?: string;
}

/**
 * Wall-clock bound on the COMMIT statement only. PostgreSQL disables
 * `statement_timeout` before running deferred constraint triggers inside
 * COMMIT, so once the evidence triggers fire there their audit/outbox scans
 * are unbounded server-side; this is the client-side bound.
 */
const COMMIT_DEADLINE_MS = 4_000;

/** Bound on post-COMMIT ROLLBACK/cleanup, which run outside SET LOCAL timeouts. */
const CLEANUP_DEADLINE_MS = 2_000;

/**
 * A pool client this primitive may return or DISCARD.
 *
 * `on`/`off` matter as much as `release`: pg-pool removes its idle 'error'
 * listener when a client is checked out, and getPool() only handles POOL
 * errors. On EPIPE/ECONNRESET pg both rejects the in-flight query AND emits
 * a client 'error' event. An emitter error with no listener throws — Node
 * exits with code 1 before any rejection handler runs, taking every other
 * in-flight request with it. (Codex round 3 on PR #303.) So the primitive
 * listens for the whole time it owns the client, including asynchronous
 * cleanup, and only lets go at release.
 */
interface RecordingClient extends DbClient {
  release?: (destroy?: boolean) => void;
  on?: (event: 'error', listener: (error: Error) => void) => unknown;
  off?: (event: 'error', listener: (error: Error) => void) => unknown;
}

/** Attach the ownership-window error listener; returns the detach function. */
function ownClientErrors(client: RecordingClient): () => void {
  const listener = (): void => {
    // The in-flight query rejects with the same failure; the outcome
    // lifecycle classifies it there. Listening is what keeps the process up.
  };
  client.on?.('error', listener);
  return () => client.off?.('error', listener);
}

type CheckoutCallback = (error: Error | null | undefined, client?: unknown) => void;
/** The subset of pg.Pool the primitive needs; a module may supply its own pool. */
export interface CheckoutPool {
  connect: (callback?: CheckoutCallback) => unknown;
}

/**
 * Check a client out of the pool with the error listener attached BEFORE the
 * acquisition promise resolves.
 *
 * `await pool.connect()` is not good enough: pg-pool removes its idle
 * 'error' listener before resolving, and a listener attached after the
 * `await` resumes only runs a microtask later. If one socket read carries
 * the startup ReadyForQuery together with a FATAL (57P01, backend shutdown),
 * pg parses both synchronously and emits 'error' inside that gap with zero
 * listeners: the process exits. (Codex round 4 on PR #303.)
 *
 * The callback form of pg-pool's connect() invokes the callback
 * synchronously with the client (verified against pg-pool 3.13.0 on idle
 * and fresh-client paths), so the listener is attached before anyone else
 * can run. The test harness's pool wrapper is promise-only and ignores a
 * callback; that path has no socket, so resolving through the promise is
 * fine there.
 */
function checkoutRecordingClient(
  pool: CheckoutPool,
): Promise<{ client: RecordingClient; disown: () => void }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const handOver: CheckoutCallback = (error, raw) => {
      if (settled) return;
      settled = true;
      if (error) {
        reject(error);
        return;
      }
      const client = raw as RecordingClient;
      const disown = ownClientErrors(client);
      resolve({ client, disown });
    };
    const returned = pool.connect(handOver);
    const thenable = returned as { then?: unknown } | null | undefined;
    if (thenable && typeof thenable.then === 'function') {
      (returned as Promise<unknown>).then(
        (raw) => handOver(null, raw),
        (error: unknown) => handOver(error instanceof Error ? error : new Error(String(error))),
      );
    }
  });
}

/** Transaction outcome, captured the instant COMMIT resolves or rejects. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

const nextDiscardSignalAt = new Map<string, number>();
function signalRecordingClientDiscarded(event: string): void {
  const now = performance.now();
  if (now < (nextDiscardSignalAt.get(event) ?? -Infinity)) return;
  nextDiscardSignalAt.set(event, now + 60_000);
  try {
    logger.error(
      { event },
      'Recording connection discarded: cleanup did not complete within its bound',
    );
  } catch {
    // Never let a logger failure replace the response.
  }
}

/**
 * Consumed background work after the outcome has been published: roll back
 * a failed transaction, restore the tenant binding, return the client — or
 * discard it if that cannot finish inside its bound. I-023 holds either
 * way: the binding is restored/cleared, or the backend that held it is
 * destroyed.
 */
function finalizeRecordingClient(
  client: RecordingClient,
  run: Promise<unknown>,
  rollback: boolean,
  previousTenantId: string | null,
  disown: () => void,
  discardEvent: string,
): void {
  const settledRun = run.then(
    () => undefined,
    () => undefined,
  );
  const rolledBack = rollback
    ? settledRun
        .then(() => client.query('ROLLBACK'))
        .then(
          () => undefined,
          () => undefined,
        )
    : settledRun;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('cleanup_deadline')), CLEANUP_DEADLINE_MS);
  });
  // Restore the binding that was in place when this factory took the client,
  // exactly as withTenantContext does — never blindly clear. Under the test
  // harness every factory shares one client with an outer binding. (CI on
  // PR #303: `No active tenant binding`.)
  const restore =
    previousTenantId === null ? 'SELECT clear_tenant_context()' : 'SELECT set_tenant_context($1)';
  const restoreParams = previousTenantId === null ? [] : [previousTenantId];
  void Promise.race([rolledBack.then(() => client.query(restore, restoreParams)), bound])
    .then(
      () => {
        // Returning to the pool: hand the error listener back to pg-pool.
        disown();
        client.release?.();
      },
      () => {
        // Discard keeps the listener: a destroyed client may still emit.
        client.release?.(true);
        signalRecordingClientDiscarded(discardEvent);
      },
    )
    .finally(() => {
      if (timer !== null) clearTimeout(timer);
    });
}

/**
 * Runs `work` in a transaction whose COMMIT is itself authority-checked.
 *
 * The defect class (PRs #302, #303, #304, consent): `withTransaction(() =>
 * withTenantContext(() => withActorContext(work)))` followed by `SET
 * CONSTRAINTS <evidence> IMMEDIATE`. `withTenantContext` DELETES the
 * per-backend tenant binding in its cleanup, before the outer COMMIT; the
 * evidence triggers' live-actor functions need `kms_current_actor_context()`,
 * which needs `current_tenant_id()`, so at COMMIT nothing could re-validate
 * authority — and forcing the triggers IMMEDIATE consumed their events
 * (re-DEFERRING afterwards does not re-queue a consumed event), so the real
 * COMMIT ran with no authority check and an actor nonce expiring in that
 * window was committed under expired authority (`kms_current_actor_context()`
 * compares against `clock_timestamp()`).
 *
 * This primitive owns the client: it sets the tenant binding inside BEGIN,
 * binds the actor nonce, runs the work with both bindings live, and lets the
 * deferred triggers fire AT COMMIT as a genuine authority gate. The outcome
 * is published the instant COMMIT settles; ROLLBACK and cleanup are bounded
 * background work; a stalled COMMIT is bounded client-side and reported via
 * `unconfirmed()` (PT503), with this primitive's own socket destroyed rather
 * than any backend signalled by pid.
 *
 * Nested `withTenantContext` / `withActorContext` inside `work` are safe:
 * the former saves and restores the binding it found (ours), the latter only
 * sets a transaction-local GUC.
 *
 * Returns `typeof withTransaction` so `withIdempotentExecution` can consume
 * it unchanged. An `externalTx` is honoured the way withTransaction honours
 * it: the caller owns BEGIN/COMMIT, and this primitive only runs the
 * live-actor checks around the work.
 */
export function commitAuthorityTransaction(
  authority: CommitAuthority,
  pool: () => CheckoutPool = () => getPool() as unknown as CheckoutPool,
): typeof withTransaction {
  const statementTimeout = authority.statementTimeout ?? '5s';
  const lockTimeout = authority.lockTimeout ?? '2s';
  const guarded = async <T>(tx: DbTransaction, work: (tx: DbTransaction) => Promise<T>) => {
    await authority.assertLive(tx);
    let value: T;
    try {
      value = await work(tx);
      await authority.assertLive(tx);
    } catch (error) {
      // An idempotency replay/mismatch/in-flight outcome is still only
      // disclosed to a live, authorised actor.
      if (
        error instanceof IdempotencyReplayError ||
        error instanceof IdempotencyBodyMismatchError ||
        error instanceof IdempotencyInFlightError
      )
        await authority.assertLive(tx);
      throw error;
    }
    return value;
  };

  return async <T>(
    work: (tx: DbTransaction) => Promise<T>,
    externalTx?: DbTransaction,
  ): Promise<T> => {
    if (externalTx !== undefined) return guarded(externalTx, work);

    const { client, disown } = await checkoutRecordingClient(pool());
    let previousTenantId: string | null = null;
    let commitIssued = false;

    let settled: Settled<T> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let armDeadline: () => void = () => undefined;
    const deadline = new Promise<never>((_, reject) => {
      armDeadline = () => {
        deadlineTimer = setTimeout(() => {
          reject(Object.assign(new Error('commit_deadline'), { code: 'COMMIT_DEADLINE' }));
        }, COMMIT_DEADLINE_MS);
      };
    });

    const run = (async () => {
      await client.query('BEGIN');
      try {
        if (authority.afterBegin !== undefined) await authority.afterBegin(client);
        // The probe needs a transaction (it uses a sub-savepoint), so it runs
        // after BEGIN. The tenant binding is per-backend, not
        // transaction-local, so setting it here still holds through COMMIT.
        previousTenantId = await readCurrentTenantId(client);
        await client.query('SELECT set_tenant_context($1)', [authority.tenantId]);
        const result = await withActorContext(client, authority.nonce, async () => {
          await client.query(`SET LOCAL statement_timeout='${statementTimeout}'`);
          await client.query(`SET LOCAL lock_timeout='${lockTimeout}'`);
          return guarded(client, work);
        });
        armDeadline();
        commitIssued = true;
        // The deferred evidence triggers fire HERE, with tenant and actor
        // bindings both still in scope.
        await client.query('COMMIT');
        settled = { ok: true, value: result };
        return result;
      } catch (error) {
        settled = { ok: false, error };
        throw error;
      } finally {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      }
    })();

    const unconfirmed = () => {
      // The COMMIT's fate is unknown: destroy THIS socket so it can never be
      // re-borrowed mid-COMMIT; never signal a backend by pid. Surface as
      // PT503 (503) so the caller is told to check status before retrying
      // — never as a success and never as a definite failure.
      run.catch(() => undefined);
      // Keep listening: a destroyed client can still emit a late 'error'
      // (pg-pool only re-attaches its own listener on RETURN, not destroy).
      client.release?.(true);
      return authority.unconfirmed();
    };

    try {
      const value = await Promise.race([run, deadline]);
      finalizeRecordingClient(client, run, false, previousTenantId, disown, authority.discardEvent);
      const outcome = settled as Settled<T> | null;
      return outcome?.ok ? outcome.value : value;
    } catch (error) {
      const outcome = settled as Settled<T> | null;
      if (outcome?.ok) {
        finalizeRecordingClient(
          client,
          run,
          false,
          previousTenantId,
          disown,
          authority.discardEvent,
        );
        return outcome.value;
      }
      if (outcome && !outcome.ok) {
        // A server RAISE during COMMIT (PT401, 42501, 23514, ...) is a
        // definite rollback and passes through. A rejection with no SQLSTATE
        // (ECONNRESET) or a class-08 connection exception (08007
        // transaction_resolution_unknown) arriving AFTER COMMIT was issued is
        // indeterminate — the write and its idempotency record may have
        // committed — and must not be rethrown as if it were a known failure.
        // A SQLSTATE shape alone does not prove the server raised: EPIPE is
        // five uppercase characters too. pg's server errors always carry
        // `severity`; transport errors never do. (Codex rounds 1–2, PR #303.)
        const failure = outcome.error as { code?: unknown; severity?: unknown } | null;
        const code = failure?.code;
        const sqlState =
          typeof code === 'string' &&
          /^[0-9A-Z]{5}$/.test(code) &&
          typeof failure?.severity === 'string'
            ? code
            : null;
        const indeterminate = commitIssued && (sqlState === null || sqlState.startsWith('08'));
        if (indeterminate) throw unconfirmed();
        // A known outcome always wins over the deadline.
        finalizeRecordingClient(
          client,
          run,
          true,
          previousTenantId,
          disown,
          authority.discardEvent,
        );
        throw outcome.error;
      }
      if ((error as { code?: unknown } | null)?.code === 'COMMIT_DEADLINE') throw unconfirmed();
      finalizeRecordingClient(client, run, true, previousTenantId, disown, authority.discardEvent);
      throw error;
    }
  };
}
