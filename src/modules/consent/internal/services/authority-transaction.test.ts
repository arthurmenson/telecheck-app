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
// THROWS out of emit() — the process-exit path the module must prevent by
// owning the listener while it owns the client.
vi.mock('../../../../lib/db.js', () => ({
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
vi.mock('../../../../lib/logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('../../../../lib/rls.js', () => ({
  readCurrentTenantId: async () => mocks.previousTenantId,
}));
vi.mock('../../../../lib/actor-context-binding.js', () => ({
  withActorContext: async (_client: unknown, _nonce: string, fn: () => Promise<unknown>) => fn(),
}));

import { IdempotencyReplayError } from '../../../../lib/idempotency.js';

import { consentAuthorityTransaction } from './authority-transaction.js';

const authority = {
  tenantId: 'Telecheck-US',
  nonce: '123e4567-e89b-42d3-a456-426614174000',
  assertLive: (tx: unknown) => mocks.assertLive(tx) as Promise<void>,
};
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

describe('consentAuthorityTransaction — authority is enforced at the actual COMMIT', () => {
  it('runs work inside BEGIN…COMMIT with both bindings live and never forces the triggers early', async () => {
    const value = await consentAuthorityTransaction(authority)(async () => 'done');
    expect(value).toBe('done');
    const q = sqls();
    expect(q.some((x) => x.includes('SET CONSTRAINTS'))).toBe(false);
    expect(q.findIndex((x) => x.includes('set_tenant_context'))).toBeGreaterThan(
      q.indexOf('BEGIN'),
    );
    expect(q.indexOf('COMMIT')).toBeGreaterThan(q.indexOf('BEGIN'));
    // Live check before the work and again after it.
    expect(mocks.assertLive).toHaveBeenCalledTimes(2);
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
    expect(mocks.release).not.toHaveBeenCalledWith(true);
  });

  it('rejects with the COMMIT-time PT401 immediately even when ROLLBACK hangs', async () => {
    vi.useFakeTimers();
    try {
      mocks.commitError = Object.assign(new Error('consent_unauthenticated'), {
        code: 'PT401',
        severity: 'ERROR',
      });
      mocks.rollbackHang = true;
      const pending = consentAuthorityTransaction(authority)(async () => 'x');
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
    mocks.commitError = Object.assign(new Error('consent_policy_evidence_required'), {
      code: '23514',
      severity: 'ERROR',
    });
    await expect(consentAuthorityTransaction(authority)(async () => 'x')).rejects.toMatchObject({
      code: '23514',
    });
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('bounds a stalled COMMIT, discards its own client, and reports PT503 — never signals a backend', async () => {
    vi.useFakeTimers();
    try {
      mocks.commitHang = true;
      const pending = consentAuthorityTransaction(authority)(async () => 'x');
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
      const pending = consentAuthorityTransaction(authority)(async () => 'ok');
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
      consentAuthorityTransaction(authority)(async () => {
        throw replay;
      }),
    ).rejects.toBe(replay);
    // Pre-work check + the re-check inside the catch.
    expect(mocks.assertLive).toHaveBeenCalledTimes(2);
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('restores the binding that was in place when it took the client, and only clears when there was none', async () => {
    mocks.previousTenantId = 'Telecheck-Ghana';
    await consentAuthorityTransaction(authority)(async () => 'x');
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
    await consentAuthorityTransaction(authority)(async () => 'x');
    await flush();
    expect(sqls().some((x) => x.includes('clear_tenant_context'))).toBe(true);
  });

  it('treats a no-SQLSTATE rejection of an issued COMMIT as indeterminate: PT503 and discard', async () => {
    mocks.commitError = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    await expect(consentAuthorityTransaction(authority)(async () => 'x')).rejects.toMatchObject({
      code: 'PT503',
    });
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
        consentAuthorityTransaction(authority)(async () => 'x'),
        code,
      ).rejects.toMatchObject({ code: 'PT503' });
      expect(mocks.release).toHaveBeenCalledWith(true);
    }
  });

  it('treats EPIPE on an issued COMMIT as indeterminate — a SQLSTATE shape is not a server raise', async () => {
    mocks.commitError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    await expect(consentAuthorityTransaction(authority)(async () => 'x')).rejects.toMatchObject({
      code: 'PT503',
    });
    expect(mocks.release).toHaveBeenCalledWith(true);
  });

  it('survives the driver emitting a client error event alongside the COMMIT rejection', async () => {
    mocks.commitError = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    mocks.commitEmitsError = true;
    await expect(consentAuthorityTransaction(authority)(async () => 'x')).rejects.toMatchObject({
      code: 'PT503',
    });
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
    await expect(consentAuthorityTransaction(authority)(async () => 'x')).resolves.toBe('x');
  });

  it('still works with a promise-only pool (the test harness wrapper)', async () => {
    mocks.promiseOnlyConnect = true;
    await expect(consentAuthorityTransaction(authority)(async () => 'y')).resolves.toBe('y');
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('listens for client errors for the whole ownership window, then lets go at release', async () => {
    let duringWork = -1;
    await consentAuthorityTransaction(authority)(async () => {
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
      consentAuthorityTransaction(authority)(async () => {
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
      const pending = consentAuthorityTransaction(authority)(async () => {
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
      .mockRejectedValueOnce(
        Object.assign(new Error('consent_unauthenticated'), { code: 'PT401' }),
      );
    await expect(consentAuthorityTransaction(authority)(async () => 'x')).rejects.toMatchObject({
      code: 'PT401',
    });
    expect(sqls().includes('COMMIT')).toBe(false);
    await flush();
    expect(sqls().includes('ROLLBACK')).toBe(true);
    expect(mocks.release).toHaveBeenCalledWith();
  });
});
