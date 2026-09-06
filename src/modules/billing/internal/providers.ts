import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import type { ProviderConfig } from './provider-config.js';
import {
  BillingError,
  type Confirmation,
  type PaymentIntent,
  type ProviderObservation,
} from './types.js';

export const fingerprint = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');
function secretKey(): Buffer {
  const value = process.env['BILLING_CONFIRMATION_KEY'];
  if (!value || !/^[a-f0-9]{64}$/i.test(value))
    throw new BillingError('billing.configuration_unavailable');
  return Buffer.from(value, 'hex');
}
export function sealConfirmation(
  confirmation: Confirmation,
  tenant: string,
  payment: string,
): Buffer {
  const key = secretKey();
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(['billing-confirmation-v1', tenant, payment])));
    return Buffer.concat([
      Buffer.from([1]),
      iv,
      cipher.update(JSON.stringify(confirmation), 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  } finally {
    key.fill(0);
  }
}
export function openConfirmation(bytes: Buffer, tenant: string, payment: string): Confirmation {
  const key = secretKey();
  try {
    if (bytes[0] !== 1 || bytes.length < 30 || bytes.length > 16384) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
    cipher.setAAD(Buffer.from(JSON.stringify(['billing-confirmation-v1', tenant, payment])));
    cipher.setAuthTag(bytes.subarray(-16));
    return JSON.parse(
      Buffer.concat([cipher.update(bytes.subarray(13, -16)), cipher.final()]).toString('utf8'),
    ) as Confirmation;
  } catch {
    throw new BillingError('billing.confirmation_unavailable');
  } finally {
    key.fill(0);
  }
}
type Json = Record<string, unknown>;
function obj(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BillingError('billing.provider_invalid_response');
  return value as Json;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096)
    throw new BillingError('billing.provider_invalid_response');
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new BillingError('billing.provider_invalid_response');
  return value as number;
}
async function request(
  config: ProviderConfig,
  path: string,
  body?: URLSearchParams | Json,
  key?: string,
): Promise<Json> {
  const base = config.provider === 'stripe' ? 'https://api.stripe.com' : 'https://api.paystack.co';
  const headers: Record<string, string> = { authorization: `Bearer ${config.secret}` };
  if (config.provider === 'stripe') {
    headers['Stripe-Account'] = config.account;
    if (key) headers['Idempotency-Key'] = key;
  }
  if (body)
    headers['content-type'] =
      body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers,
      ...(body
        ? { body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body) }
        : {}),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new BillingError('billing.provider_unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw new BillingError('billing.provider_invalid_response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    let part = await reader.read();
    while (!part.done) {
      const bytes: unknown = part.value;
      if (!(bytes instanceof Uint8Array))
        throw new BillingError('billing.provider_invalid_response');
      size += bytes.length;
      if (size > 65536) {
        await reader.cancel();
        throw new BillingError('billing.provider_invalid_response');
      }
      chunks.push(bytes);
      part = await reader.read();
    }
    return obj(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch {
    throw new BillingError('billing.provider_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
function stripeObject(
  config: ProviderConfig,
  raw: Json,
): Omit<ProviderObservation, 'eventId' | 'type'> {
  const metadata = obj(raw['metadata']);
  if (raw['object'] !== 'payment_intent' || raw['livemode'] !== (config.mode === 'live'))
    throw new BillingError('billing.provider_invalid_response');
  return {
    paymentId: string(metadata['telecheck_payment_id']),
    objectId: string(raw['id']),
    reference: string(metadata['telecheck_reference']),
    amountMinor: integer(raw['amount']),
    currency: string(raw['currency']).toUpperCase(),
    account: config.account,
    mode: config.mode,
  };
}
function paystackObject(
  config: ProviderConfig,
  raw: Json,
): Omit<ProviderObservation, 'eventId' | 'type'> {
  const metadata = obj(raw['metadata']);
  if (
    raw['domain'] !== (config.mode === 'sandbox' ? 'test' : 'live') ||
    String(raw['integration']) !== config.account
  )
    throw new BillingError('billing.provider_invalid_response');
  return {
    paymentId: string(metadata['telecheck_payment_id']),
    objectId: string(raw['reference']),
    reference: string(raw['reference']),
    amountMinor: integer(raw['amount']),
    currency: string(raw['currency']).toUpperCase(),
    account: config.account,
    mode: config.mode,
  };
}
export function assertObservation(
  intent: PaymentIntent,
  observation: Omit<ProviderObservation, 'eventId' | 'type'>,
): void {
  if (
    observation.paymentId !== intent.payment_id ||
    observation.reference !== intent.provider_reference ||
    observation.amountMinor !== intent.amount_minor ||
    observation.currency !== intent.currency ||
    observation.account !== intent.provider_account ||
    observation.mode !== intent.provider_mode ||
    (intent.provider_object_id !== null && observation.objectId !== intent.provider_object_id)
  )
    throw new BillingError('billing.provider_binding_mismatch', 400);
}
export interface Creation {
  objectId: string;
  confirmation: Confirmation | null;
  paid: ProviderObservation | null;
}
export async function createProviderIntent(
  config: ProviderConfig,
  intent: PaymentIntent,
  email: string | null,
): Promise<Creation> {
  if (config.provider === 'mock_local_dev')
    return {
      objectId: intent.provider_reference,
      confirmation: {
        kind: 'mock_local_dev',
        label: 'Synthetic payment — no money is charged',
        confirm_path: `/v1/billing/payment-intents/${intent.payment_id}/mock-confirm`,
        mode: 'mock_local_dev',
      },
      paid: null,
    };
  if (config.provider === 'stripe') {
    // Stripe may prune idempotency keys after 24 hours. Never recreate an
    // uncertain old intent under a potentially expired provider key.
    if (
      intent.provider_object_id === null &&
      Date.now() - intent.accepted_at.getTime() > 23 * 60 * 60 * 1000
    )
      throw new BillingError('billing.reconciliation_required', 409);
    const raw = intent.provider_object_id
      ? await request(
          config,
          `/v1/payment_intents/${encodeURIComponent(intent.provider_object_id)}`,
        )
      : await request(
          config,
          '/v1/payment_intents',
          new URLSearchParams({
            amount: String(intent.amount_minor),
            currency: intent.currency.toLowerCase(),
            'automatic_payment_methods[enabled]': 'true',
            'metadata[telecheck_payment_id]': intent.payment_id,
            'metadata[telecheck_reference]': intent.provider_reference,
          }),
          intent.provider_reference,
        );
    const observation = stripeObject(config, raw);
    assertObservation(intent, observation);
    if (raw['status'] === 'succeeded' && integer(raw['amount_received']) !== intent.amount_minor)
      throw new BillingError('billing.provider_binding_mismatch', 400);
    const paid =
      raw['status'] === 'succeeded'
        ? {
            ...observation,
            eventId: `reconcile:${observation.objectId}:paid`,
            type: 'paid' as const,
          }
        : null;
    return {
      objectId: observation.objectId,
      confirmation: paid
        ? null
        : {
            kind: 'stripe',
            client_secret: string(raw['client_secret']),
            publishable_key: config.publishableKey,
            account: config.account,
            mode: config.mode,
          },
      paid,
    };
  }
  if (!email || email.length > 254) throw new BillingError('billing.verified_email_required', 409);
  let initialized: Json | undefined;
  // The same reference is permanent at Paystack. On an ambiguous creation we
  // only verify it; we never create a second reference to make a retry succeed.
  if (intent.status !== 'creation_unknown' && intent.provider_object_id === null) {
    const response = await request(config, '/transaction/initialize', {
      email,
      amount: intent.amount_minor,
      currency: intent.currency,
      reference: intent.provider_reference,
      callback_url: config.returnUrl,
      metadata: { telecheck_payment_id: intent.payment_id },
    });
    if (response['status'] !== true) throw new BillingError('billing.provider_invalid_response');
    initialized = obj(response['data']);
    if (initialized['reference'] !== intent.provider_reference)
      throw new BillingError('billing.provider_invalid_response');
  }
  const checked = await request(
    config,
    `/transaction/verify/${encodeURIComponent(intent.provider_reference)}`,
  );
  if (checked['status'] !== true) throw new BillingError('billing.provider_invalid_response');
  const raw = obj(checked['data']);
  const observation = paystackObject(config, raw);
  assertObservation(intent, observation);
  const paid =
    raw['status'] === 'success'
      ? { ...observation, eventId: `reconcile:${String(raw['id'])}:paid`, type: 'paid' as const }
      : null;
  if (paid) return { objectId: observation.objectId, confirmation: null, paid };
  if (!initialized) throw new BillingError('billing.reconciliation_required', 409);
  const url = new URL(string(initialized['authorization_url']));
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'checkout.paystack.com' ||
    url.username ||
    url.password
  )
    throw new BillingError('billing.provider_invalid_response');
  return {
    objectId: observation.objectId,
    confirmation: {
      kind: 'redirect',
      url: url.toString(),
      provider: 'paystack',
      mode: config.mode,
    },
    paid: null,
  };
}
function secureEqual(expected: string, received: string | undefined): boolean {
  if (!received || !/^[a-f0-9]+$/i.test(received) || received.length !== expected.length)
    return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}
export function verifyWebhook(
  config: ProviderConfig,
  bytes: Buffer,
  headers: Record<string, unknown>,
  now = Date.now(),
): ProviderObservation | null {
  if (bytes.length > 65536) throw new BillingError('billing.webhook_invalid', 400);
  if (config.provider === 'stripe') {
    const header =
      typeof headers['stripe-signature'] === 'string' ? headers['stripe-signature'] : '';
    const parts = header.split(',');
    const timestamps = parts.filter((p) => p.startsWith('t='));
    const timestamp = timestamps[0]?.slice(2);
    if (
      timestamps.length !== 1 ||
      !timestamp ||
      !/^\d+$/.test(timestamp) ||
      Math.abs(now / 1000 - Number(timestamp)) > 300
    )
      throw new BillingError('billing.webhook_invalid', 400);
    const expected = createHmac('sha256', config.webhookSecret)
      .update(`${timestamp}.`)
      .update(bytes)
      .digest('hex');
    if (!parts.filter((p) => p.startsWith('v1=')).some((p) => secureEqual(expected, p.slice(3))))
      throw new BillingError('billing.webhook_invalid', 400);
  } else {
    const name =
      config.provider === 'paystack' ? 'x-paystack-signature' : 'x-telecheck-mock-signature';
    const expected = createHmac(
      config.provider === 'paystack' ? 'sha512' : 'sha256',
      config.webhookSecret,
    )
      .update(bytes)
      .digest('hex');
    if (!secureEqual(expected, typeof headers[name] === 'string' ? headers[name] : undefined))
      throw new BillingError('billing.webhook_invalid', 400);
  }
  let raw: Json;
  try {
    raw = obj(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new BillingError('billing.webhook_invalid', 400);
  }
  if (config.provider === 'stripe') {
    if (raw['account'] !== config.account || raw['livemode'] !== (config.mode === 'live'))
      throw new BillingError('billing.webhook_invalid', 400);
    const type = (
      {
        'payment_intent.succeeded': 'paid',
        'payment_intent.payment_failed': 'failed',
        'payment_intent.canceled': 'cancelled',
      } as const
    )[String(raw['type']) as 'payment_intent.succeeded'];
    if (!type) return null;
    const data = obj(obj(raw['data'])['object']);
    if (
      type === 'paid' &&
      (data['status'] !== 'succeeded' || data['amount_received'] !== data['amount'])
    )
      throw new BillingError('billing.webhook_invalid', 400);
    return { ...stripeObject(config, data), eventId: string(raw['id']), type };
  }
  if (config.provider === 'paystack') {
    if (raw['event'] !== 'charge.success') return null;
    const data = obj(raw['data']);
    if (data['status'] !== 'success') throw new BillingError('billing.webhook_invalid', 400);
    return {
      ...paystackObject(config, data),
      eventId: `charge.success:${String(data['id'])}`,
      type: 'paid',
    };
  }
  if (
    raw['mode'] !== 'mock_local_dev' ||
    raw['account'] !== config.account ||
    raw['type'] !== 'paid'
  )
    throw new BillingError('billing.webhook_invalid', 400);
  return {
    eventId: string(raw['eventId']),
    type: 'paid',
    paymentId: string(raw['paymentId']),
    objectId: string(raw['objectId']),
    reference: string(raw['reference']),
    amountMinor: integer(raw['amountMinor']),
    currency: string(raw['currency']),
    account: config.account,
    mode: 'mock_local_dev',
  };
}
export function mockSignedObservation(
  config: ProviderConfig,
  intent: PaymentIntent,
): { bytes: Buffer; headers: Record<string, string> } {
  if (config.provider !== 'mock_local_dev' || config.mode !== 'mock_local_dev')
    throw new BillingError('billing.mock_forbidden');
  const bytes = Buffer.from(
    JSON.stringify({
      eventId: `mock:${intent.payment_id}:paid`,
      type: 'paid',
      paymentId: intent.payment_id,
      objectId: intent.provider_reference,
      reference: intent.provider_reference,
      amountMinor: intent.amount_minor,
      currency: intent.currency,
      account: config.account,
      mode: 'mock_local_dev',
    }),
  );
  return {
    bytes,
    headers: {
      'x-telecheck-mock-signature': createHmac('sha256', config.webhookSecret)
        .update(bytes)
        .digest('hex'),
    },
  };
}
