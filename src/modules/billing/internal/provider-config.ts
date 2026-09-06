import { BillingError, type BillingMode, type BillingProvider } from './types.js';

export interface ProviderConfig {
  tenantId: string;
  provider: BillingProvider;
  mode: BillingMode;
  account: string;
  secret: string;
  webhookSecret: string;
  publishableKey: string;
  returnUrl: string;
}
export function resolveProviderConfig(tenantId: string, expectedProvider?: string): ProviderConfig {
  let rows: unknown;
  try {
    rows = JSON.parse(process.env['BILLING_PROVIDERS_JSON'] ?? '{}');
  } catch {
    throw new BillingError('billing.configuration_unavailable');
  }
  const raw = (rows as Record<string, unknown>)?.[tenantId] as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') throw new BillingError('billing.configuration_unavailable');
  const provider = raw['provider'];
  const mode = raw['mode'];
  const account = raw['account'];
  if (
    !['stripe', 'paystack', 'mock_local_dev'].includes(String(provider)) ||
    !['sandbox', 'live', 'mock_local_dev'].includes(String(mode)) ||
    typeof account !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(account)
  )
    throw new BillingError('billing.configuration_unavailable');
  if (expectedProvider !== undefined && provider !== expectedProvider)
    throw new BillingError('billing.configuration_changed', 409);
  const secret = typeof raw['secret_env'] === 'string' ? process.env[raw['secret_env']] : undefined;
  const webhookSecret =
    typeof raw['webhook_secret_env'] === 'string'
      ? process.env[raw['webhook_secret_env']]
      : undefined;
  if (!secret || secret.length < 32 || !webhookSecret || webhookSecret.length < 32)
    throw new BillingError('billing.configuration_unavailable');
  const mock = provider === 'mock_local_dev';
  if (
    mock !== (mode === 'mock_local_dev') ||
    (mock &&
      (!['development', 'test'].includes(process.env['NODE_ENV'] ?? '') ||
        process.env['BILLING_ALLOW_MOCK'] !== 'true'))
  )
    throw new BillingError('billing.mock_forbidden');
  if (!mock && !secret.startsWith(mode === 'sandbox' ? 'sk_test_' : 'sk_live_'))
    throw new BillingError('billing.provider_mode_mismatch');
  if (
    provider === 'stripe' &&
    (!account.startsWith('acct_') || !webhookSecret.startsWith('whsec_'))
  )
    throw new BillingError('billing.configuration_unavailable');
  if (provider === 'paystack' && (!/^\d+$/.test(account) || secret !== webhookSecret))
    throw new BillingError('billing.configuration_unavailable');
  const publishableKey = typeof raw['publishable_key'] === 'string' ? raw['publishable_key'] : '';
  if (
    provider === 'stripe' &&
    !publishableKey.startsWith(mode === 'sandbox' ? 'pk_test_' : 'pk_live_')
  )
    throw new BillingError('billing.provider_mode_mismatch');
  const returnUrl = typeof raw['return_url'] === 'string' ? raw['return_url'] : '';
  let parsed: URL;
  try {
    parsed = new URL(returnUrl);
  } catch {
    throw new BillingError('billing.configuration_unavailable');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    (parsed.protocol !== 'https:' &&
      !(
        mock &&
        parsed.protocol === 'http:' &&
        ['localhost', '127.0.0.1', 'ghana.localhost'].includes(parsed.hostname)
      ))
  )
    throw new BillingError('billing.configuration_unavailable');
  return {
    tenantId,
    provider: provider as BillingProvider,
    mode: mode as BillingMode,
    account,
    secret,
    webhookSecret,
    publishableKey,
    returnUrl,
  };
}
