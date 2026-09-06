import { createHmac } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  paystackCredentialAccount,
  resolveProviderConfig,
  type ProviderConfig,
} from './provider-config.js';
import { assertObservation, createProviderIntent, verifyWebhook } from './providers.js';
import type { PaymentIntent } from './types.js';

const config: ProviderConfig = {
  tenantId: 'Telecheck-US',
  provider: 'stripe',
  mode: 'sandbox',
  account: 'acct_synthetic',
  secret: 'sk_test_' + 'a'.repeat(32),
  webhookSecret: 'whsec_' + 'b'.repeat(32),
  publishableKey: 'pk_test_synthetic',
  returnUrl: 'https://example.invalid/return',
};
const intent = {
  payment_id: '01HFG6Z3Q8B7H9P2W4V5K6N7TB',
  tenant_id: 'Telecheck-US',
  provider_reference: 'tc-synthetic',
  provider_object_id: null,
  amount_minor: 4900,
  currency: 'USD',
  provider_account: config.account,
  provider_mode: 'sandbox',
  accepted_at: new Date(),
  status: 'creating',
} as PaymentIntent;
function stripe(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_synthetic',
    object: 'payment_intent',
    amount: 4900,
    amount_received: 4900,
    currency: 'usd',
    livemode: false,
    status: 'succeeded',
    client_secret: 'pi_synthetic_secret_private',
    metadata: {
      telecheck_payment_id: intent.payment_id,
      telecheck_reference: intent.provider_reference,
    },
    ...overrides,
  };
}
function signed(data: unknown, at = Date.now(), configOverride = config) {
  const bytes = Buffer.from(JSON.stringify(data));
  const t = String(Math.floor(at / 1000));
  return {
    bytes,
    headers: {
      'stripe-signature': `t=${t},v1=${createHmac('sha256', configOverride.webhookSecret).update(`${t}.`).update(bytes).digest('hex')}`,
    },
  };
}
function event(data = stripe()) {
  return {
    id: 'evt_synthetic',
    type: 'payment_intent.succeeded',
    account: config.account,
    livemode: false,
    data: { object: data },
  };
}
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('BILLING_ALLOW_MOCK', 'true');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
describe('raw provider verification and immutable money binding', () => {
  it('verifies Stripe raw bytes with timestamp and account', () => {
    const s = signed(event());
    const o = verifyWebhook(config, s.bytes, s.headers)!;
    expect(o).toMatchObject({
      type: 'paid',
      paymentId: intent.payment_id,
      amountMinor: 4900,
      currency: 'USD',
    });
    expect(() => assertObservation(intent, o)).not.toThrow();
  });
  it('accepts a valid rotated Stripe signature among multiple signatures', () => {
    const s = signed(event());
    expect(
      verifyWebhook(config, s.bytes, {
        'stripe-signature': s.headers['stripe-signature'] + ',v1=' + '0'.repeat(64),
      }),
    ).not.toBeNull();
  });
  it.each([-301000, 301000])('rejects signature timestamp outside tolerance %d', (offset) => {
    const s = signed(event(), Date.now() + offset);
    expect(() => verifyWebhook(config, s.bytes, s.headers)).toThrow();
  });
  it('rejects duplicate timestamps', () => {
    const s = signed(event());
    expect(() =>
      verifyWebhook(config, s.bytes, {
        'stripe-signature': s.headers['stripe-signature'] + ',t=1',
      }),
    ).toThrow();
  });
  it.each(['', 'bad', 't=NaN,v1=ff', 't=1,v1=ff'])(
    'rejects malformed signature %s',
    (signature) => {
      expect(() =>
        verifyWebhook(config, Buffer.from('{}'), { 'stripe-signature': signature }),
      ).toThrow();
    },
  );
  it('rejects mutation including only whitespace in the raw body', () => {
    const s = signed(event());
    expect(() =>
      verifyWebhook(config, Buffer.concat([s.bytes, Buffer.from(' ')]), s.headers),
    ).toThrow();
  });
  it('rejects malformed JSON even if signed', () => {
    const bytes = Buffer.from('{');
    const t = String(Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', config.webhookSecret)
      .update(`${t}.`)
      .update(bytes)
      .digest('hex');
    expect(() =>
      verifyWebhook(config, bytes, { 'stripe-signature': `t=${t},v1=${sig}` }),
    ).toThrow();
  });
  it.each([{ account: 'acct_other' }, { livemode: true }])(
    'rejects signed wrong merchant/mode %j',
    (change) => {
      const s = signed({ ...event(), ...change });
      expect(() => verifyWebhook(config, s.bytes, s.headers)).toThrow();
    },
  );
  it.each([{ amount_received: 1 }, { status: 'processing' }, { livemode: true }])(
    'does not treat incomplete/wrong-mode payment as paid %j',
    (change) => {
      const s = signed(event(stripe(change)));
      expect(() => verifyWebhook(config, s.bytes, s.headers)).toThrow();
    },
  );
  it.each([
    { paymentId: 'other' },
    { reference: 'other' },
    { amountMinor: 1 },
    { currency: 'GHS' },
    { account: 'acct_other' },
    { mode: 'live' },
  ])('rejects trusted-provider binding mismatch %j', (change) => {
    const s = signed(event());
    expect(() =>
      assertObservation(intent, {
        ...verifyWebhook(config, s.bytes, s.headers)!,
        ...change,
      } as Parameters<typeof assertObservation>[1]),
    ).toThrow();
  });
  it('rejects changed existing provider object', () => {
    const s = signed(event());
    expect(() =>
      assertObservation(
        { ...intent, provider_object_id: 'pi_other' },
        verifyWebhook(config, s.bytes, s.headers)!,
      ),
    ).toThrow();
  });
  it('ignores a correctly signed unrelated Stripe event', () => {
    const s = signed({ ...event(), type: 'customer.created' });
    expect(verifyWebhook(config, s.bytes, s.headers)).toBeNull();
  });
  it('bounds webhook body bytes before parsing', () => {
    expect(() => verifyWebhook(config, Buffer.alloc(65537), {})).toThrow();
  });
  const paystack = {
    ...config,
    tenantId: 'Telecheck-Ghana',
    provider: 'paystack' as const,
    account: paystackCredentialAccount(config.secret),
    webhookSecret: 'sk_test_' + 'a'.repeat(32),
  };
  function paystackEvent(change: Record<string, unknown> = {}) {
    return {
      event: 'charge.success',
      data: {
        id: 123,
        reference: intent.provider_reference,
        amount: 4900,
        currency: 'GHS',
        domain: 'test',
        status: 'success',
        metadata: { telecheck_payment_id: intent.payment_id },
        ...change,
      },
    };
  }
  function signedPaystack(data: unknown) {
    const bytes = Buffer.from(JSON.stringify(data));
    return {
      bytes,
      headers: {
        'x-paystack-signature': createHmac('sha512', paystack.webhookSecret)
          .update(bytes)
          .digest('hex'),
      },
    };
  }
  it('verifies the documented Paystack shape, credential authority and server reference without data.integration', () => {
    const s = signedPaystack(paystackEvent());
    expect(verifyWebhook(paystack, s.bytes, s.headers)).toMatchObject({
      eventId: 'charge.success:123',
      account: paystackCredentialAccount(config.secret),
      currency: 'GHS',
      type: 'paid',
    });
  });
  it.each([{ domain: 'live' }, { status: 'pending' }])(
    'rejects signed Paystack mismatch %j',
    (change) => {
      const s = signedPaystack(paystackEvent(change));
      expect(() => verifyWebhook(paystack, s.bytes, s.headers)).toThrow();
    },
  );
  it('does not accept a Stripe signature on Paystack', () => {
    const s = signed(paystackEvent());
    expect(() => verifyWebhook(paystack, s.bytes, s.headers)).toThrow();
  });
  it('does not let an unrelated credential or account label authenticate a Paystack event', () => {
    const signed = signedPaystack(paystackEvent());
    expect(() =>
      verifyWebhook({ ...paystack, account: 'paystack_wrong' }, signed.bytes, signed.headers),
    ).toThrow('billing.provider_account_mismatch');
    const wrongSecret = 'sk_test_wrong_integration_secret_000000000';
    expect(() =>
      verifyWebhook(
        {
          ...paystack,
          secret: wrongSecret,
          webhookSecret: wrongSecret,
          account: paystackCredentialAccount(wrongSecret),
        },
        signed.bytes,
        signed.headers,
      ),
    ).toThrow('billing.webhook_invalid');
  });
});
describe('durable provider creation protocol', () => {
  it('sends only authoritative amount, opaque metadata and one stable Stripe idempotency key on retry', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(stripe({ status: 'requires_payment_method' })), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    for (const status of ['creating', 'creation_unknown'] as const) {
      const result = await createProviderIntent(config, { ...intent, status }, null);
      expect(result.confirmation).toMatchObject({ kind: 'stripe', mode: 'sandbox' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(call[0]).toBe('https://api.stripe.com/v1/payment_intents');
      expect((call[1].headers as Record<string, string>)['Idempotency-Key']).toBe(
        intent.provider_reference,
      );
      const fields = new URLSearchParams(call[1].body as string);
      expect(fields.get('amount')).toBe('4900');
      expect(fields.get('currency')).toBe('usd');
      expect(fields.get('metadata[telecheck_payment_id]')).toBe(intent.payment_id);
      expect(fields.has('patient_id')).toBe(false);
    }
  });
  it('uses retrieval after a provider object is recorded', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(stripe()), { status: 200 }));
    vi.stubGlobal('fetch', f);
    const result = await createProviderIntent(
      config,
      { ...intent, provider_object_id: 'pi_synthetic' },
      null,
    );
    expect(result.paid?.type).toBe('paid');
    expect(f).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/payment_intents/pi_synthetic',
      expect.objectContaining({ method: 'GET' }),
    );
  });
  it('never repeats an unknown Stripe creation after provider idempotency retention may expire', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(
      createProviderIntent(
        config,
        { ...intent, status: 'creation_unknown', accepted_at: new Date(Date.now() - 24 * 3600000) },
        null,
      ),
    ).rejects.toThrow('billing.reconciliation_required');
    expect(f).not.toHaveBeenCalled();
  });
  it('rejects a retrieved succeeded intent whose received amount differs from the accepted quote', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify(stripe({ amount_received: 1 })), { status: 200 }),
      ),
    );
    await expect(
      createProviderIntent(config, { ...intent, provider_object_id: 'pi_synthetic' }, null),
    ).rejects.toThrow('billing.provider_binding_mismatch');
  });
  it.each([400, 401, 500, 503])(
    'does not silently fall back to mock on provider HTTP %d',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('private provider error', { status })),
      );
      await expect(createProviderIntent(config, intent, null)).rejects.toThrow(
        'billing.provider_unavailable',
      );
    },
  );
  it('rejects success with wrong money before storing any confirmation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(stripe({ amount: 1 })), { status: 200 })),
    );
    await expect(createProviderIntent(config, intent, null)).rejects.toThrow(
      'billing.provider_binding_mismatch',
    );
  });
  it('rejects oversized provider response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('x'.repeat(65537), { status: 200 })),
    );
    await expect(createProviderIntent(config, intent, null)).rejects.toThrow(
      'billing.provider_unavailable',
    );
  });
  it('aborts a nonresponsive provider at eight seconds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, opts: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            opts.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      ),
    );
    const promise = createProviderIntent(config, intent, null);
    const checked = expect(promise).rejects.toThrow('billing.provider_unavailable');
    await vi.advanceTimersByTimeAsync(8001);
    await checked;
  });
  it('Paystack unknown creation verifies the same reference without another initialization', async () => {
    const paystack = {
      ...config,
      provider: 'paystack' as const,
      webhookSecret: config.secret,
      tenantId: 'Telecheck-Ghana',
      account: paystackCredentialAccount(config.secret),
    };
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: true,
            data: {
              id: 1,
              reference: intent.provider_reference,
              amount: 4900,
              currency: 'GHS',
              domain: 'test',
              status: 'success',
              metadata: { telecheck_payment_id: intent.payment_id },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', f);
    const p = {
      ...intent,
      provider: 'paystack' as const,
      currency: 'GHS',
      provider_account: paystackCredentialAccount(config.secret),
      status: 'creation_unknown' as const,
    };
    expect((await createProviderIntent(paystack, p, 'synthetic@example.invalid')).paid?.type).toBe(
      'paid',
    );
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(
      `https://api.paystack.co/transaction/verify/${intent.provider_reference}`,
      expect.objectContaining({ method: 'GET' }),
    );
  });
  it('does not invent a checkout URL after ambiguous Paystack acceptance', async () => {
    const paystack = {
      ...config,
      provider: 'paystack' as const,
      account: paystackCredentialAccount(config.secret),
      webhookSecret: config.secret,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              status: true,
              data: {
                id: 1,
                reference: intent.provider_reference,
                amount: 4900,
                currency: 'GHS',
                domain: 'test',
                status: 'abandoned',
                metadata: { telecheck_payment_id: intent.payment_id },
              },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(
      createProviderIntent(
        paystack,
        {
          ...intent,
          currency: 'GHS',
          provider_account: paystackCredentialAccount(config.secret),
          status: 'creation_unknown',
        },
        'synthetic@example.invalid',
      ),
    ).rejects.toThrow('billing.reconciliation_required');
  });
});
describe('confirmation secrecy and explicit configuration', () => {
  function mockConfig() {
    vi.stubEnv('BILLING_MOCK_SECRET', 'a'.repeat(32));
    vi.stubEnv(
      'BILLING_PROVIDERS_JSON',
      JSON.stringify({
        'Telecheck-US': {
          provider: 'mock_local_dev',
          mode: 'mock_local_dev',
          account: 'synthetic',
          secret_env: 'BILLING_MOCK_SECRET',
          webhook_secret_env: 'BILLING_MOCK_SECRET',
          return_url: 'http://localhost/return',
        },
      }),
    );
  }
  it('requires an explicit mock selection and allow flag', () => {
    mockConfig();
    expect(resolveProviderConfig('Telecheck-US', 'mock_local_dev').mode).toBe('mock_local_dev');
    vi.stubEnv('BILLING_ALLOW_MOCK', 'false');
    expect(() => resolveProviderConfig('Telecheck-US')).toThrow('billing.mock_forbidden');
  });
  it('rejects mock in production even when explicitly enabled', () => {
    mockConfig();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => resolveProviderConfig('Telecheck-US')).toThrow('billing.mock_forbidden');
  });
  it('rejects a CCR/config provider mismatch', () => {
    mockConfig();
    expect(() => resolveProviderConfig('Telecheck-US', 'stripe')).toThrow(
      'billing.configuration_changed',
    );
  });
  it('has no unknown-tenant/provider default', () => {
    mockConfig();
    expect(() => resolveProviderConfig('Telecheck-Ghana')).toThrow();
  });
});
