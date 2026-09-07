import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../../../../lib/db.js';
import { asTenantId } from '../../../../lib/glossary.js';
import { IdempotencyReplayError } from '../../../../lib/idempotency.js';

import { formsGovernanceTransaction } from './publication-evidence.js';

vi.mock('../../../../lib/rls.js', () => ({
  withTenantContext: (_tx: unknown, _tenant: unknown, body: () => Promise<unknown>) => body(),
}));
vi.mock('../../../../lib/actor-context-binding.js', () => ({
  withActorContext: (_tx: unknown, _nonce: unknown, body: () => Promise<unknown>) => body(),
}));

const context = {
  tenantId: asTenantId('Telecheck-US'),
  accountId: 'operator',
  sessionId: 'session',
  actorNonce: 'nonce',
};
describe('Forms authorization around the whole idempotent transaction', () => {
  it('checks again after the callback including cache completion and outbox work', async () => {
    const denied = Object.assign(new Error('scope unavailable'), { code: '42501' });
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(denied);
    const body = vi.fn().mockResolvedValue({ status: 201, body: { template_id: 'synthetic' } });
    await expect(
      formsGovernanceTransaction(context, 'forms.consult_template.created')(body, {
        query,
      } as unknown as DbTransaction),
    ).rejects.toBe(denied);
    expect(body).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('revalidates cached replay before allowing its response through the shared helper', async () => {
    const denied = Object.assign(new Error('scope unavailable'), { code: '42501' });
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(denied);
    const cached = new IdempotencyReplayError(201, { template_id: 'synthetic' });
    await expect(
      formsGovernanceTransaction(context, 'forms.consult_template.created')(
        async () => {
          throw cached;
        },
        { query } as unknown as DbTransaction,
      ),
    ).rejects.toBe(denied);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('preserves an authorized cached response as the original replay exception', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const cached = new IdempotencyReplayError(201, { template_id: 'synthetic' });
    await expect(
      formsGovernanceTransaction(context, 'forms.consult_template.created')(
        async () => {
          throw cached;
        },
        { query } as unknown as DbTransaction,
      ),
    ).rejects.toBe(cached);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('preserves the original SQL failure without querying an aborted transaction', async () => {
    const failed = Object.assign(new Error('original SQL validation failure'), { code: '22023' });
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValue(new Error('transaction aborted'));
    await expect(
      formsGovernanceTransaction(context, 'forms.consult_template.created')(
        async () => {
          throw failed;
        },
        { query } as unknown as DbTransaction,
      ),
    ).rejects.toBe(failed);
    expect(query).toHaveBeenCalledOnce();
  });
});
