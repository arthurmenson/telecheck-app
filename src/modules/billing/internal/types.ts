import type { TenantContext } from '../../../lib/tenant-context.js';

export class BillingError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 503,
  ) {
    super(code);
  }
}
export type BillingProvider = 'stripe' | 'paystack' | 'mock_local_dev';
export type BillingMode = 'sandbox' | 'live' | 'mock_local_dev';
export interface BillingActor {
  context: TenantContext;
  accountId: string;
  nonce: string;
  role: 'patient' | 'tenant_admin';
}
export interface ConsultSelection {
  consult_type: 'general' | 'program_pathway';
  program_id: string | null;
}
export interface Price extends ConsultSelection {
  id: string;
  tenant_id: string;
  country_of_care: string;
  version: number;
  amount_minor: number;
  currency: string;
  provider: BillingProvider;
  provider_account: string;
  provider_mode: BillingMode;
  turnaround_minutes: number;
  quote_ttl_seconds: number;
  refund_policy: 'full_before_review_or_decline_v1';
}
export interface PaymentIntent extends Price {
  payment_id: string;
  patient_id: string;
  quote_id: string;
  request_hash: string;
  initiation_source: string;
  provider_reference: string;
  provider_object_id: string | null;
  status:
    | 'creating'
    | 'creation_unknown'
    | 'requires_payment'
    | 'paid'
    | 'failed'
    | 'cancelled'
    | 'refund_pending'
    | 'refunded';
  lease_token: string | null;
  lease_expires_at: Date | null;
  accepted_at: Date;
  provider_created_at: Date | null;
  verified_at: Date | null;
  confirmation_ciphertext: Buffer | null;
}
export type Confirmation =
  | {
      kind: 'stripe';
      client_secret: string;
      publishable_key: string;
      account: string;
      mode: BillingMode;
    }
  | { kind: 'redirect'; url: string; provider: 'paystack'; mode: BillingMode }
  | {
      kind: 'mock_local_dev';
      label: 'Synthetic payment — no money is charged';
      confirm_path: string;
      mode: 'mock_local_dev';
    }
  | { kind: 'complete'; status: 'paid' | 'refund_pending' | 'refunded' };
export interface ProviderObservation {
  eventId: string;
  type: 'paid' | 'failed' | 'cancelled' | 'refunded';
  paymentId: string;
  objectId: string;
  reference: string;
  amountMinor: number;
  currency: string;
  account: string;
  mode: BillingMode;
}
