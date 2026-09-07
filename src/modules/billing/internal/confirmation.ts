import { z } from 'zod';

import {
  decryptClassified,
  encryptClassified,
  type ClassifiedResource,
} from '../../../lib/classified-kms.js';
import type { DbTransaction } from '../../../lib/db.js';

import { BillingError, type Confirmation, type PaymentIntent } from './types.js';

function descriptor(intent: PaymentIntent): ClassifiedResource {
  return {
    dataClass: 'pii_financial',
    patientId: intent.patient_id,
    resourceType: 'billing_payment_intent',
    resourceId: intent.payment_id,
    field: 'payment_confirmation',
  };
}
const mode = z.enum(['sandbox', 'live']);
const confirmationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('stripe'),
      client_secret: z.string().min(1).max(4096),
      publishable_key: z.string().min(1).max(4096),
      account: z.string().min(1).max(128),
      mode,
    })
    .strict(),
  z
    .object({
      kind: z.literal('redirect'),
      url: z.url().max(4096),
      provider: z.literal('paystack'),
      mode,
    })
    .strict(),
]);
export async function sealConfirmation(
  tx: DbTransaction,
  intent: PaymentIntent,
  value: Confirmation,
) {
  const bytes = Buffer.from(JSON.stringify(confirmationSchema.parse(value)));
  try {
    return await encryptClassified(tx, descriptor(intent), bytes);
  } finally {
    bytes.fill(0);
  }
}
export async function openConfirmation(
  tx: DbTransaction,
  intent: PaymentIntent,
): Promise<Confirmation> {
  if (
    !intent.confirmation_ciphertext ||
    !intent.confirmation_dek_id ||
    !intent.confirmation_iv ||
    !intent.confirmation_tag ||
    !intent.confirmation_alg ||
    !intent.confirmation_alg_version ||
    !intent.confirmation_aad ||
    !intent.confirmation_encrypted_at
  )
    throw new BillingError('billing.confirmation_unavailable', 409);
  const bytes = await decryptClassified(tx, descriptor(intent), {
    ciphertext: intent.confirmation_ciphertext,
    dekId: intent.confirmation_dek_id,
    iv: intent.confirmation_iv,
    tag: intent.confirmation_tag,
    alg: intent.confirmation_alg,
    algVersion: intent.confirmation_alg_version,
    aad: intent.confirmation_aad,
    encryptedAt: intent.confirmation_encrypted_at,
  });
  try {
    return confirmationSchema.parse(JSON.parse(bytes.toString('utf8')));
  } finally {
    bytes.fill(0);
  }
}
export function mockConfirmation(intent: PaymentIntent): Confirmation {
  if (intent.provider !== 'mock_local_dev' || intent.provider_mode !== 'mock_local_dev')
    throw new BillingError('billing.mock_forbidden');
  return {
    kind: 'mock_local_dev',
    mode: 'mock_local_dev',
    label: 'Synthetic payment — no money is charged',
    confirm_path: `/v1/billing/payment-intents/${intent.payment_id}/mock-confirm`,
  };
}
