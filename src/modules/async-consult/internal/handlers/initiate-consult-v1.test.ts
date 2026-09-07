import type { FastifyReply, FastifyRequest } from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { emitDomainEvent } from '../../../../lib/domain-events.js';
import { ensureConsultPayment } from '../../../billing/index.js';
import { emitAsyncConsultInitiatedAudit } from '../../audit.js';

import { initiateConsultV1Handler } from './initiate-consult-v1.js';

const state = vi.hoisted(() => ({ events: [] as string[], created: true, query: vi.fn() }));
vi.mock('../../../billing/index.js', async (original) => ({
  ...(await original<object>()),
  ensureConsultPayment: vi.fn(),
}));
vi.mock('../../audit.js', () => ({
  emitAsyncConsultInitiatedAudit: vi.fn(async () => {
    state.events.push('audit');
  }),
}));
vi.mock('../../../../lib/domain-events.js', () => ({
  emitDomainEvent: vi.fn(async () => {
    state.events.push('outbox');
  }),
}));
vi.mock('../../../../lib/idempotent-handler.js', () => ({
  withIdempotentExecution: async (
    _req: unknown,
    reply: FastifyReply,
    _map: unknown,
    body: (tx: unknown) => Promise<{ status: number; view: unknown }>,
    runTransaction: (fn: typeof body) => ReturnType<typeof body>,
  ) => {
    state.events.push('transaction');
    const result = await runTransaction(body);
    state.events.push('commit');
    return reply.code(result.status).send(result.view);
  },
}));
vi.mock('../../../../lib/db.js', async (original) => ({
  ...(await original<object>()),
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ query: state.query }),
}));
vi.mock('../../../../lib/rls.js', () => ({
  withTenantContext: async (_tx: unknown, _id: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../../../lib/actor-context-binding.js', () => ({
  withActorContext: async (_tx: unknown, nonce: string, fn: () => Promise<unknown>) => {
    expect(nonce).toBe('trusted-nonce');
    return fn();
  },
}));
vi.mock('../../../../lib/with-db-role.js', () => ({
  withDbRole: async (_tx: unknown, role: string, fn: () => Promise<unknown>) => {
    expect(role).toBe('async_consult_patient_initiator');
    return fn();
  },
}));
const id = '01HFG6Z3Q8B7H9P2W4V5K6N7TB';
const input = { consult_type: 'general', initiation_source: 'care_tab', accepted_quote_id: id };
function req(body: unknown = input, role = 'patient'): FastifyRequest {
  return {
    id: 'request',
    headers: { 'idempotency-key': id },
    body,
    actorNonce: 'trusted-nonce',
    tenantContext: { tenantId: 'Telecheck-US', countryOfCare: 'US' },
    actorContext: { accountId: id, tenantId: 'Telecheck-US', role, delegateId: null },
  } as unknown as FastifyRequest;
}
function reply() {
  const sent: { code?: number; body?: unknown } = {};
  const value = {
    header: vi.fn(() => value),
    code: vi.fn((code: number) => {
      sent.code = code;
      return value;
    }),
    send: vi.fn((body: unknown) => {
      sent.body = body;
      return value;
    }),
  };
  return { value: value as unknown as FastifyReply, sent };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.events = [];
  state.created = true;
  state.query.mockImplementation(async (sql: string) => {
    if (sql.includes('billing_assert_live_patient')) {
      state.events.push('authorize-commit');
      return { rows: [], rowCount: 1 };
    }
    state.events.push('consult');
    return {
      rows: [
        {
          consult_id: id,
          created: state.created,
          expected_turnaround_at: new Date('2026-09-06T12:00:00Z'),
        },
      ],
      rowCount: 1,
    };
  });
  vi.mocked(ensureConsultPayment).mockImplementation(async () => {
    state.events.push('provider-before-transaction');
    return {
      payment_id: id,
      consult_type: 'general',
      program_id: null,
      initiation_source: 'care_tab',
      amount_minor: 4900,
      currency: 'USD',
      provider: 'stripe',
      provider_mode: 'sandbox',
    } as Awaited<ReturnType<typeof ensureConsultPayment>>;
  });
});
describe('accepted quote initiation', () => {
  it.each([
    'consult_fee_cents',
    'currency',
    'payment_provider',
    'payment_intent_id',
    'expected_turnaround_at',
    'patient_id',
    'payment_confirmed',
  ])('rejects client authority field %s before provider work', async (field) => {
    const r = reply();
    await initiateConsultV1Handler(req({ ...input, [field]: 'tampered' }), r.value);
    expect(r.sent.code).toBe(400);
    expect(ensureConsultPayment).not.toHaveBeenCalled();
  });
  it.each([
    {},
    null,
    [],
    { ...input, accepted_quote_id: 'wrong' },
    { ...input, consult_type: 'program_pathway', program_id: 'unvalidated' },
    { ...input, initiation_source: 'unknown' },
  ])('rejects malformed or unsupported selection %j', async (body) => {
    const r = reply();
    await initiateConsultV1Handler(req(body), r.value);
    expect(r.sent.code).toBe(400);
    expect(ensureConsultPayment).not.toHaveBeenCalled();
  });
  it.each(['clinician', 'tenant_admin', 'ai_service'])(
    'rejects %s before Billing',
    async (role) => {
      await expect(initiateConsultV1Handler(req(input, role), reply().value)).rejects.toMatchObject(
        { statusCode: 403 },
      );
      expect(ensureConsultPayment).not.toHaveBeenCalled();
    },
  );
  it('rejects missing trust nonce', async () => {
    const request = req();
    request.actorNonce = undefined;
    await expect(initiateConsultV1Handler(request, reply().value)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it('rejects delegate context', async () => {
    const request = req();
    request.actorContext!.delegateId = id;
    await expect(initiateConsultV1Handler(request, reply().value)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
  it('creates provider first, then atomically consult/audit/outbox/cache; returns no secret', async () => {
    const r = reply();
    await initiateConsultV1Handler(req(), r.value);
    expect(state.events).toEqual([
      'provider-before-transaction',
      'transaction',
      'consult',
      'audit',
      'outbox',
      'authorize-commit',
      'commit',
    ]);
    expect(state.query).toHaveBeenCalledWith(
      'SELECT * FROM public.record_billed_consult_initiation($1,$2,$3)',
      [expect.any(String), id, expect.any(String)],
    );
    expect(emitAsyncConsultInitiatedAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        consultFeeCents: 4900,
        currency: 'USD',
        paymentProvider: 'stripe',
      }),
      expect.anything(),
    );
    expect(r.sent.code).toBe(201);
    expect(r.sent.body).toEqual({
      consult_id: id,
      payment_intent_id: id,
      confirmation: {
        kind: 'retrieve',
        href: `/v1/billing/payment-intents/${id}/confirmation`,
        provider: 'stripe',
        mode: 'sandbox',
      },
    });
  });
  it('does not recreate audit/outbox for a durable intent already bound to a consult', async () => {
    state.created = false;
    const r = reply();
    await initiateConsultV1Handler(req(), r.value);
    expect(emitAsyncConsultInitiatedAudit).not.toHaveBeenCalled();
    expect(emitDomainEvent).not.toHaveBeenCalled();
    expect(r.sent.code).toBe(201);
  });
  it('never opens the consult transaction when the provider result is uncertain', async () => {
    vi.mocked(ensureConsultPayment).mockRejectedValue(new Error('provider timeout'));
    await expect(initiateConsultV1Handler(req(), reply().value)).rejects.toThrow();
    expect(state.query).not.toHaveBeenCalled();
    expect(emitDomainEvent).not.toHaveBeenCalled();
  });
  it('propagates outbox failure so the local transaction cannot commit', async () => {
    vi.mocked(emitDomainEvent).mockRejectedValueOnce(new Error('outbox down'));
    await expect(initiateConsultV1Handler(req(), reply().value)).rejects.toThrow('outbox down');
    expect(state.events).not.toContain('commit');
  });
  it('does not commit when the session expires during local outbox work', async () => {
    vi.mocked(emitDomainEvent).mockImplementationOnce(async () => {
      state.query.mockRejectedValueOnce(
        Object.assign(new Error('billing_actor_unavailable'), { code: '42501' }),
      );
      return {} as Awaited<ReturnType<typeof emitDomainEvent>>;
    });
    await expect(initiateConsultV1Handler(req(), reply().value)).rejects.toThrow(
      'billing_actor_unavailable',
    );
    expect(state.events).not.toContain('commit');
  });
});
