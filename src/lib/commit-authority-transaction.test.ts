import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  assertLive: vi.fn(),
  commitHang: false,
  commitError: null as unknown,
  rollbackHang: false,
  cleanupHang: false,
  previousTenantId: null as string | null,
  /** Emit a client 'error' event alongside the COMMIT rejection (pg does both). */
  commitEmitsError: false,
  client: null as unknown,
  /** Emit a client 'error' synchronously the instant checkout hands over. */
  emitOnCheckout: null as Error | null,
  /** Exercise the harness-style promise-only connect(). */
  promiseOnlyConnect: false,
}));
// A real EventEmitter, like pg.Client: an 'error' event with no listener
// THROWS out of emit() — the process-exit path the primitive must prevent by
// owning the listener while it owns the client.
vi.mock('./db.js', () => ({
  getPool: () => ({
    // Mirrors pg-pool: with a callback, hand the client over synchronously
    // (returning undefined); without one, return a promise.
    connect: (callback?: (error: Error | null, client?: unknown) => void) => {
      const client = Object.assign(new EventEmitter(), {
        query: mocks.query,
        release: mocks.release,
      });
      mocks.client = client;
      if (mocks.promiseOnlyConnect || !callback) return Promise.resolve(client);
      callback(null, client);
      if (mocks.emitOnCheckout) client.emit('error', mocks.emitOnCheckout);
      return undefined;
    },
  }),
}));
vi.mock('./logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('./rls.js', () => ({
  readCurrentTenantId: async () => mocks.previousTenantId,
}));
vi.mock('./actor-context-binding.js', () => ({
  withActorContext: async (_client: unknown, _nonce: string, fn: () => Promise<unknown>) => fn(),
}));

import { commitAuthorityTransaction, isCommitUnconfirmed } from './commit-authority-transaction.js';
import type { DbClient, DbTransaction } from './db.js';
import { IdempotencyReplayError } from './idempotency.js';

const authority = {
  tenantId: 'Telecheck-US',
  nonce: '123e4567-e89b-42d3-a456-426614174000',
  assertLive: (tx: unknown) => mocks.assertLive(tx) as Promise<void>,
  unconfirmed: () => Object.assign(new Error('recording_unconfirmed'), { code: 'PT503' }),
  discardEvent: 'test.recording_connection.discarded',
};
const run = commitAuthorityTransaction(authority);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const sqls = () => mocks.query.mock.calls.map(([sql]) => String(sql));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.commitHang = false;
  mocks.commitError = null;
  mocks.rollbackHang = false;
  mocks.cleanupHang = false;
  mocks.previousTenantId = null;
  mocks.commitEmitsError = false;
  mocks.client = null;
  mocks.emitOnCheckout = null;
  mocks.promiseOnlyConnect = false;
  mocks.assertLive.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql === 'COMMIT') {
      if (mocks.commitHang) return new Promise<never>(() => undefined);
      if (mocks.commitError !== null) {
        if (mocks.commitEmitsError) {
          const err = mocks.commitError as Error;
          setImmediate(() => (mocks.client as EventEmitter).emit('error', err));
        }
        throw mocks.commitError;
      }
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      if (mocks.rollbackHang) return new Promise<never>(() => undefined);
      return { rows: [] };
    }
    if (sql.includes('clear_tenant_context')) {
      if (mocks.cleanupHang) return new Promise<never>(() => undefined);
      return { rows: [] };
    }
    return { rows: [] };
  });
});

describe('commitAuthorityTransaction — authority is enforced at the actual COMMIT', () => {
  it('runs work inside BEGIN…COMMIT with both bindings live and never forces the triggers early', async () => {
    const value = await run(async () => 'done');
    expect(value).toBe('done');
    const q = sqls();
    expect(q.some((x) => x.includes('SET CONSTRAINTS'))).toBe(false);
    expect(q.findIndex((x) => x.includes('set_tenant_context'))).toBeGreaterThan(
      q.indexOf('BEGIN'),
    );
    expect(q.indexOf('COMMIT')).toBeGreaterThan(q.indexOf('BEGIN'));
    const st = mocks.query.mock.calls.find(([sql]) => String(sql).includes('statement_timeout'));
    expect(st?.[1]).toEqual(['5000']);
    expect(q.some((x) => x.includes('SET LOCAL'))).toBe(false);
    // Live check before the work and again after it.
    expect(mocks.assertLive).toHaveBeenCalledTimes(2);
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
    expect(mocks.release).not.toHaveBeenCalledWith(true);
  });

  it('honours the configured timeouts, parameterized and validated', async () => {
    await commitAuthorityTransaction({
      ...authority,
      statementTimeoutMs: 10_000,
      lockTimeoutMs: 3_000,
    })(async () => 'x');
    const st = mocks.query.mock.calls.find(([sql]) => String(sql).includes('statement_timeout'));
    const lt = mocks.query.mock.calls.find(([sql]) => String(sql).includes('lock_timeout'));
    expect(st?.[1]).toEqual(['10000']);
    expect(lt?.[1]).toEqual(['3000']);
    // Validation is fail-fast at construction, before any client is taken.
    expect(() => commitAuthorityTransaction({ ...authority, statementTimeoutMs: 0 })).toThrow(
      'commit_authority_invalid_timeout',
    );
    expect(() => commitAuthorityTransaction({ ...authority, lockTimeoutMs: 1.5 })).toThrow(
      'commit_authority_invalid_timeout',
    );
    expect(() => commitAuthorityTransaction({ ...authority, lockTimeoutMs: 700_000 })).toThrow(
      'commit_authority_invalid_timeout',
    );
  });

  it('runs afterBegin inside the transaction before any binding is set', async () => {
    const order: string[] = [];
    mocks.query.mockImplementation(async (sql: string) => {
      order.push(String(sql));
      return { rows: [] };
    });
    await commitAuthorityTransaction({
      ...authority,
      afterBegin: async (tx) => {
        await tx.query('SELECT assert_connection()');
      },
    })(async () => 'x');
    const begin = order.indexOf('BEGIN');
    const assertion = order.indexOf('SELECT assert_connection()');
    const bind = order.findIndex((x) => x.includes('set_tenant_context'));
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(assertion).toBeGreaterThan(begin);
    expect(bind).toBeGreaterThan(assertion);
  });

  it('an afterBegin failure rolls back and passes through unchanged', async () => {
    const boom = Object.assign(new Error('identity_connection_unavailable'), { code: '42501' });
    await expect(
      commitAuthorityTransaction({
        ...authority,
        afterBegin: async () => {
          throw boom;
        },
      })(async () => 'x'),
    ).rejects.toBe(boom);
    expect(mocks.assertLive).not.toHaveBeenCalled();
    expect(sqls().includes('COMMIT')).toBe(false);
    await flush();
    expect(sqls().includes('ROLLBACK')).toBe(true);
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('on a caller-owned client runs the full lifecycle but never checks out, binds, listens, or releases', async () => {
    const calls: string[] = [];
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async (sql: string) => {
        calls.push(String(sql));
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const value = await commitAuthorityTransaction({
      ...authority,
      callerOwnedClient: client as unknown as DbClient,
    })(async () => 'owned-by-caller');
    expect(value).toBe('owned-by-caller');
    expect(calls[0]).toBe('BEGIN');
    expect(calls.includes('COMMIT')).toBe(true);
    expect(calls.some((x) => x.includes('set_tenant_context'))).toBe(false);
    expect(calls.some((x) => x.includes('current_tenant_id'))).toBe(false);
    expect(calls.some((x) => x.includes('statement_timeout'))).toBe(true);
    expect(mocks.assertLive).toHaveBeenCalledTimes(2);
    // Pool never touched; the caller's client never released or listened on.
    expect(mocks.client).toBeNull();
    await flush();
    expect(client.release).not.toHaveBeenCalled();
    expect(client.listenerCount('error')).toBe(0);
  });

  it('on a caller-owned client a failed work still rolls back, and a stalled COMMIT reports PT503 without destroying it', async () => {
    vi.useFakeTimers();
    try {
      let hang = false;
      const calls: string[] = [];
      const client = {
        query: vi.fn(async (sql: string) => {
          calls.push(String(sql));
          if (sql === 'COMMIT' && hang) return new Promise<never>(() => undefined);
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      const boom = new Error('work_failed');
      await expect(
        commitAuthorityTransaction({
          ...authority,
          callerOwnedClient: client as unknown as DbClient,
        })(async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.includes('ROLLBACK')).toBe(true);
      expect(calls.some((x) => x.includes('clear_tenant_context'))).toBe(false);

      hang = true;
      const pending = commitAuthorityTransaction({
        ...authority,
        callerOwnedClient: client as unknown as DbClient,
      })(async () => 'x');
      const rejection = expect(pending).rejects.toMatchObject({ code: 'PT503' });
      await vi.advanceTimersByTimeAsync(4_100);
      await rejection;
      expect(client.release).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('with an external transaction only guards the work — the caller owns BEGIN/COMMIT', async () => {
    const external = { query: vi.fn(async () => ({ rows: [] })) } as unknown as DbTransaction;
    const value = await run(async () => 'ext', external);
    expect(value).toBe('ext');
    expect(mocks.assertLive).toHaveBeenCalledTimes(2);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  });

  it('rejects with the COMMIT-time PT401 immediately even when ROLLBACK hangs', async () => {
    vi.useFakeTimers();
    try {
      mocks.commitError = Object.assign(new Error('unauthenticated'), {
        code: 'PT401',
        severity: 'ERROR',
      });
      mocks.rollbackHang = true;
      const pending = run(async () => 'x');
      const rejection = expect(pending).rejects.toMatchObject({ code: 'PT401' });
      await vi.advanceTimersByTimeAsync(0);
      await rejection;
      expect(mocks.release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(mocks.release).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('surfaces a constraint violation raised at COMMIT as itself (a known rollback)', async () => {
    mocks.commitError = Object.assign(new Error('evidence_required'), {
      code: '23514',
      severity: 'ERROR',
    });
    await expect(run(async () => 'x')).rejects.toMatchObject({ code: '23514' });
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('bounds a stalled COMMIT, discards its own client, and reports PT503 — never signals a backend', async () => {
    vi.useFakeTimers();
    try {
      mocks.commitHang = true;
      const pending = run(async () => 'x');
      const rejection = expect(pending).rejects.toMatchObject({ code: 'PT503' });
      await vi.advanceTimersByTimeAsync(3_900);
      expect(mocks.release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      await rejection;
      expect(mocks.release).toHaveBeenCalledWith(true);
      expect(sqls().some((x) => x.includes('pg_cancel_backend'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns an acknowledged COMMIT immediately even when cleanup hangs, then discards the client', async () => {
    vi.useFakeTimers();
    try {
      mocks.cleanupHang = true;
      const pending = run(async () => 'ok');
      await vi.advanceTimersByTimeAsync(0);
      expect(await pending).toBe('ok');
      expect(mocks.release).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_100);
      expect(mocks.release).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-checks the live actor before surfacing an idempotency replay', async () => {
    const replay = new IdempotencyReplayError(200, {});
    await expect(
      run(async () => {
        throw replay;
      }),
    ).rejects.toBe(replay);
    expect(mocks.assertLive).toHaveBeenCalledTimes(2);
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('restores the binding that was in place when it took the client, and only clears when there was none', async () => {
    mocks.previousTenantId = 'Telecheck-Ghana';
    await run(async () => 'x');
    await flush();
    const sets = mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes('set_tenant_context'),
    );
    expect(sets[0]?.[1]).toEqual(['Telecheck-US']);
    expect(sets[sets.length - 1]?.[1]).toEqual(['Telecheck-Ghana']);
    expect(sqls().some((x) => x.includes('clear_tenant_context'))).toBe(false);
    expect(mocks.release).toHaveBeenCalledWith();

    vi.clearAllMocks();
    mocks.previousTenantId = null;
    await run(async () => 'x');
    await flush();
    expect(sqls().some((x) => x.includes('clear_tenant_context'))).toBe(true);
  });

  it('stamps only the errors it produces for an unknown COMMIT outcome — a server PT503 is not one', async () => {
    // Codex R3 on the consolidation refactor: the database raises PT503 for
    // definite pre-COMMIT failures too (migration 094 isolation guard), so
    // callers must classify on the discriminator, never on the code.
    mocks.commitError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const unconfirmed = await run(async () => 'x').catch((e: unknown) => e);
    expect(isCommitUnconfirmed(unconfirmed)).toBe(true);
    expect((unconfirmed as { code?: string }).code).toBe('PT503');

    vi.clearAllMocks();
    mocks.commitError = null;
    const serverPt503 = Object.assign(new Error('isolation_unavailable'), {
      code: 'PT503',
      severity: 'ERROR',
    });
    const definite = await run(async () => {
      throw serverPt503;
    }).catch((e: unknown) => e);
    expect(definite).toBe(serverPt503);
    expect(isCommitUnconfirmed(definite)).toBe(false);
    expect(isCommitUnconfirmed(null)).toBe(false);
    expect(isCommitUnconfirmed({ code: 'PT503' })).toBe(false);
  });

  it('treats a no-SQLSTATE rejection of an issued COMMIT as indeterminate: PT503 and discard', async () => {
    mocks.commitError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await expect(run(async () => 'x')).rejects.toMatchObject({ code: 'PT503' });
    expect(mocks.release).toHaveBeenCalledWith(true);
  });

  it('treats a class-08 SQLSTATE on an issued COMMIT as indeterminate: PT503 and discard', async () => {
    for (const code of ['08007', '08006', '08000']) {
      vi.clearAllMocks();
      mocks.commitError = Object.assign(new Error('connection exception'), {
        code,
        severity: 'FATAL',
      });
      await expect(
        run(async () => 'x'),
        code,
      ).rejects.toMatchObject({ code: 'PT503' });
      expect(mocks.release).toHaveBeenCalledWith(true);
    }
  });

  it('treats a FATAL/PANIC after an issued COMMIT as indeterminate — termination is not rollback', async () => {
    // Codex R1 on PR #306: PostgreSQL may send an ErrorResponse while the
    // client awaits ReadyForQuery, so CommandComplete(COMMIT) followed by
    // FATAL 57P01 rejects the COMMIT promise although the transaction
    // committed. SQLSTATE + severity proves server origin, not rollback.
    for (const [code, severity] of [
      ['57P01', 'FATAL'],
      ['57P02', 'FATAL'],
      ['XX000', 'PANIC'],
    ] as const) {
      vi.clearAllMocks();
      mocks.commitError = Object.assign(new Error('terminating connection'), { code, severity });
      await expect(
        run(async () => 'x'),
        `${code} ${severity}`,
      ).rejects.toMatchObject({
        code: 'PT503',
      });
      expect(mocks.release).toHaveBeenCalledWith(true);
      expect(sqls().includes('ROLLBACK')).toBe(false);
    }
  });

  it('a FATAL before COMMIT is issued is a definite failure, not indeterminate', async () => {
    const boom = Object.assign(new Error('terminating connection'), {
      code: '57P01',
      severity: 'FATAL',
    });
    await expect(
      run(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(sqls().includes('COMMIT')).toBe(false);
  });

  it('treats EPIPE on an issued COMMIT as indeterminate — a SQLSTATE shape is not a server raise', async () => {
    mocks.commitError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    await expect(run(async () => 'x')).rejects.toMatchObject({ code: 'PT503' });
    expect(mocks.release).toHaveBeenCalledWith(true);
  });

  it('survives the driver emitting a client error event alongside the COMMIT rejection', async () => {
    mocks.commitError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    mocks.commitEmitsError = true;
    await expect(run(async () => 'x')).rejects.toMatchObject({ code: 'PT503' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.release).toHaveBeenCalledWith(true);
    // Retained after discard: a destroyed client may still emit late.
    expect((mocks.client as EventEmitter).listenerCount('error')).toBe(1);
  });

  it('is already listening when pool checkout hands the client over — no microtask gap', async () => {
    mocks.emitOnCheckout = Object.assign(new Error('terminating connection'), {
      code: '57P01',
      severity: 'FATAL',
    });
    await expect(run(async () => 'x')).resolves.toBe('x');
  });

  it('still works with a promise-only pool (the test harness wrapper)', async () => {
    mocks.promiseOnlyConnect = true;
    await expect(run(async () => 'y')).resolves.toBe('y');
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('listens for client errors for the whole ownership window, then lets go at release', async () => {
    let duringWork = -1;
    await run(async () => {
      duringWork = (mocks.client as EventEmitter).listenerCount('error');
      return 'x';
    });
    expect(duringWork).toBe(1);
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
    expect((mocks.client as EventEmitter).listenerCount('error')).toBe(0);
  });

  it('does NOT treat a pre-COMMIT connection failure as indeterminate', async () => {
    const boom = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await expect(
      run(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
    expect(mocks.release).not.toHaveBeenCalledWith(true);
  });

  it('never arms the COMMIT deadline for work that fails before COMMIT', async () => {
    vi.useFakeTimers();
    try {
      const boom = new Error('work_failed');
      const pending = run(async () => {
        throw boom;
      });
      const rejection = expect(pending).rejects.toBe(boom);
      await vi.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(sqls().includes('COMMIT')).toBe(false);
      expect(mocks.release).toHaveBeenCalledWith();
      expect(mocks.release).not.toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a live-actor failure AFTER the work rolls back before COMMIT is ever issued', async () => {
    mocks.assertLive
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('unauthenticated'), { code: 'PT401' }));
    await expect(run(async () => 'x')).rejects.toMatchObject({ code: 'PT401' });
    expect(sqls().includes('COMMIT')).toBe(false);
    await flush();
    expect(sqls().includes('ROLLBACK')).toBe(true);
    expect(mocks.release).toHaveBeenCalledWith();
  });
});
