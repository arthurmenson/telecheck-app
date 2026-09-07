import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }));
vi.mock('pg', () => ({
  default: {
    Client: class {
      on = vi.fn();
      connect = mocks.connect;
      query = mocks.query;
      end = mocks.end;
    },
  },
}));
vi.mock('../../../lib/config.js', () => ({
  config: { databaseUrl: 'postgresql://synthetic', dbSslMode: 'disable' },
}));

import { withPatientCareRead } from './patient-care-read.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.end.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('bounded patient care reads', () => {
  it('closes an active stalled query and prevents late callback continuation', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mocks.query.mockImplementation((sql: string) =>
      sql === 'SELECT synthetic'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ rows: [], rowCount: 0 }),
    );
    const resumed = vi.fn();
    const result = withPatientCareRead(async (tx) => {
      await tx.query('SELECT synthetic');
      resumed();
    });
    const assertion = expect(result).rejects.toThrow('crisis_read_unavailable');
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
    expect(mocks.end).toHaveBeenCalledOnce();
    finish({ rows: [], rowCount: 0 });
    await vi.advanceTimersByTimeAsync(10);
    expect(resumed).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(false);
  });

  it('bounds connection acquisition and does not start SQL after a late connect', async () => {
    let finish: () => void = () => undefined;
    mocks.connect.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const result = withPatientCareRead(async () => undefined);
    const assertion = expect(result).rejects.toThrow('crisis_read_unavailable');
    await vi.advanceTimersByTimeAsync(2_001);
    await assertion;
    finish();
    await vi.advanceTimersByTimeAsync(10);
    expect(mocks.end).toHaveBeenCalledOnce();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('limits read concurrency without a wait queue and recovers after expiry', async () => {
    mocks.connect.mockImplementation(() => new Promise(() => undefined));
    const reads = Array.from({ length: 4 }, () => withPatientCareRead(async () => undefined));
    const settled = Promise.allSettled(reads);
    await expect(withPatientCareRead(async () => undefined)).rejects.toThrow(
      'crisis_read_unavailable',
    );
    await vi.advanceTimersByTimeAsync(2_001);
    expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
    mocks.connect.mockResolvedValue(undefined);
    await expect(withPatientCareRead(async () => 'recovered')).resolves.toBe('recovered');
  });
});
