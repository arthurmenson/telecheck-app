import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from './db.js';
import { KmsOperationError } from './kms-aws.js';
import { acquireKmsConnection, businessDeadlineClient, deadlineClient } from './kms-db-deadline.js';
import { createKmsAuditUnavailableSignal } from './kms-operational-signal.js';

describe('KMS client-side database deadlines', () => {
  it('discards a stalled query once and cannot issue later SQL on that connection', async () => {
    const query = vi.fn(() => new Promise<never>(() => undefined));
    const discard = vi.fn();
    const bounded = deadlineClient({ query }, discard, {
      queryMs: 20,
      transactionMs: 100,
      acquireMs: 20,
    });
    await expect(bounded.tx.query('COMMIT')).rejects.toThrow(KmsOperationError);
    await expect(bounded.tx.query('ROLLBACK')).rejects.toThrow(KmsOperationError);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it('enforces the total transaction budget even when each individual reply is fast', async () => {
    const query: DbTransaction['query'] = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const discard = vi.fn();
    const bounded = deadlineClient({ query }, discard, {
      queryMs: 100,
      transactionMs: 20,
      acquireMs: 20,
    });
    await bounded.tx.query('BEGIN');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(bounded.tx.query('COMMIT')).rejects.toThrow(KmsOperationError);
    expect(query).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
  });
  it('discards a connection delivered after acquisition timed out', async () => {
    const client = { release: vi.fn() };
    let deliver!: (value: typeof client) => void;
    const pending = acquireKmsConnection(
      () =>
        new Promise<typeof client>((resolve) => {
          deliver = resolve;
        }),
      20,
    );
    await expect(pending).rejects.toThrow(KmsOperationError);
    deliver(client);
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('cancels the business socket without consuming its owner release', async () => {
    const client = {
      query: vi.fn(() => new Promise<never>(() => undefined)),
      end: vi.fn(() => new Promise<never>(() => undefined)),
      release: vi.fn(),
    };
    const bounded = businessDeadlineClient(client, {
      queryMs: 20,
      transactionMs: 100,
      acquireMs: 20,
    });
    await expect(bounded.tx.query('SELECT private_context')).rejects.toThrow(KmsOperationError);
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(client.release).not.toHaveBeenCalled();
    expect(() =>
      businessDeadlineClient(client, { queryMs: 20, transactionMs: 100, acquireMs: 20 }),
    ).toThrow(KmsOperationError);
  });
  it('fails closed when a caller adapter cannot cancel its socket', () => {
    const client: DbTransaction = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    expect(() =>
      businessDeadlineClient(client, { queryMs: 20, transactionMs: 100, acquireMs: 20 }),
    ).toThrow(KmsOperationError);
    expect(client.query).not.toHaveBeenCalled();
  });
});

it('aggregates audit-unavailable signals without receiving request or error details', () => {
  let now = 0;
  const report = vi.fn();
  const signal = createKmsAuditUnavailableSignal(report, () => now);
  signal();
  signal();
  now = 59_999;
  signal();
  expect(report).toHaveBeenCalledTimes(1);
  now = 60_000;
  signal();
  expect(report).toHaveBeenCalledTimes(2);
  expect(report.mock.calls).toEqual([[], []]);
});
