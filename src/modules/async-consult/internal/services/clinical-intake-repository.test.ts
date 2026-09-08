import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  commitHang: false,
  commitError: null as unknown,
  rollbackHang: false,
  cleanupHang: false,
  cleanupError: null as unknown,
}));
vi.mock('../../../../lib/db.js', () => ({
  getPool: () => ({
    connect: async () => ({ query: mocks.query, release: mocks.release }),
  }),
}));
vi.mock('../../../../lib/logger.js', () => ({ logger: { error: vi.fn() } }));
vi.mock('../../../../lib/domain-events.js', () => ({ emitDomainEvent: vi.fn() }));
vi.mock('../../../forms-intake/index.js', () => ({ resolveConsultIntakeDefinition: vi.fn() }));
vi.mock('../../audit.js', () => ({
  emitAsyncConsultIntakeDefinitionBoundAudit: vi.fn(),
  emitAsyncConsultIntakeSubmittedAudit: vi.fn(),
}));

import { IdempotencyReplayError } from '../../../../lib/idempotency.js';
import type { TenantContext } from '../../../../lib/tenant-context.js';

import { careIntakeTransaction } from './clinical-intake-repository.js';

const ctx = {
  tenant: { tenantId: 'Telecheck-US', countryOfCare: 'US' } as TenantContext,
  accountId: '01M1WQJRSCWYKQC9VBEQXWFG0T',
  sessionId: '01M1WQJRSCWYKQC9VBEQXWFG0S',
  actorNonce: '123e4567-e89b-42d3-a456-426614174000',
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const sqls = () => mocks.query.mock.calls.map(([sql]) => String(sql));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.commitHang = false;
  mocks.commitError = null;
  mocks.rollbackHang = false;
  mocks.cleanupHang = false;
  mocks.cleanupError = null;
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql === 'COMMIT') {
      if (mocks.commitHang) return new Promise<never>(() => undefined);
      if (mocks.commitError !== null) throw mocks.commitError;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      if (mocks.rollbackHang) return new Promise<never>(() => undefined);
      return { rows: [] };
    }
    if (sql.includes('clear_tenant_context')) {
      if (mocks.cleanupHang) return new Promise<never>(() => undefined);
      if (mocks.cleanupError !== null) throw mocks.cleanupError;
      return { rows: [] };
    }
    if (sql.includes('kms_current_actor_context'))
      return {
        rows: [
          {
            account_id: ctx.accountId,
            session_id: ctx.sessionId,
            tenant_id: ctx.tenant.tenantId,
            actor_role: 'patient',
            country_of_care: 'US',
          },
        ],
      };
    return { rows: [] };
  });
});

describe('careIntakeTransaction — authority is enforced at the actual COMMIT', () => {
  it('runs work inside BEGIN…COMMIT with both bindings live and never forces the triggers early', async () => {
    const value = await careIntakeTransaction(ctx)(async () => 'done');
    expect(value).toBe('done');
    const q = sqls();
    expect(q.some((x) => x.includes('SET CONSTRAINTS'))).toBe(false);
    expect(q.indexOf('BEGIN')).toBeGreaterThan(
      q.findIndex((x) => x.includes('set_tenant_context')),
    );
    expect(q.indexOf('COMMIT')).toBeGreaterThan(q.indexOf('BEGIN'));
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
    expect(mocks.release).not.toHaveBeenCalledWith(true);
  });

  it('rejects with the COMMIT-time PT401 immediately even when ROLLBACK hangs', async () => {
    vi.useFakeTimers();
    try {
      mocks.commitError = Object.assign(new Error('care_unauthenticated'), { code: 'PT401' });
      mocks.rollbackHang = true;
      const pending = careIntakeTransaction(ctx)(async () => 'x');
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
    mocks.commitError = Object.assign(new Error('care_intake_evidence_required'), {
      code: '23514',
    });
    await expect(careIntakeTransaction(ctx)(async () => 'x')).rejects.toMatchObject({
      code: '23514',
    });
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('bounds a stalled COMMIT, discards its own client, and reports PT503 — never signals a backend', async () => {
    vi.useFakeTimers();
    try {
      mocks.commitHang = true;
      const pending = careIntakeTransaction(ctx)(async () => 'x');
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
      const pending = careIntakeTransaction(ctx)(async () => 'ok');
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
      careIntakeTransaction(ctx)(async () => {
        throw replay;
      }),
    ).rejects.toBe(replay);
    // Pre-work check + the re-check inside the catch.
    expect(sqls().filter((x) => x.includes('kms_current_actor_context')).length).toBe(2);
    await flush();
    expect(mocks.release).toHaveBeenCalledWith();
  });

  it('never arms the COMMIT deadline for work that fails before COMMIT', async () => {
    vi.useFakeTimers();
    try {
      const boom = new Error('work_failed');
      const pending = careIntakeTransaction(ctx)(async () => {
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
});
