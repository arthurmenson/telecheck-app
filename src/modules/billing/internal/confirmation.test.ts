import { beforeEach, describe, expect, it, vi } from 'vitest';

import { decryptClassified, encryptClassified } from '../../../lib/classified-kms.js';
import type { DbTransaction } from '../../../lib/db.js';

import { openConfirmation, sealConfirmation } from './confirmation.js';
import type { PaymentIntent } from './types.js';

vi.mock('../../../lib/classified-kms.js', () => ({
  encryptClassified: vi.fn(),
  decryptClassified: vi.fn(),
}));
const tx = {} as DbTransaction;
const intent = {
  patient_id: '01HFG6Z3Q8B7H9P2W4V5K6N7TA',
  payment_id: '01HFG6Z3Q8B7H9P2W4V5K6N7TB',
  confirmation_ciphertext: Buffer.from('classified'),
  confirmation_dek_id: '01HFG6Z3Q8B7H9P2W4V5K6N7TC',
  confirmation_iv: Buffer.alloc(12),
  confirmation_tag: Buffer.alloc(16),
  confirmation_alg: 'AES-256-GCM',
  confirmation_alg_version: '2',
  confirmation_aad: Buffer.from('bound'),
  confirmation_encrypted_at: new Date(),
} as PaymentIntent;
const value = {
  kind: 'stripe' as const,
  client_secret: 'pi_synthetic_secret',
  publishable_key: 'pk_test_synthetic',
  account: 'acct_synthetic',
  mode: 'sandbox' as const,
};
beforeEach(() => vi.resetAllMocks());
describe('financial confirmation uses the public classified boundary', () => {
  it('selects financial class and exact patient/payment/field on encrypt and erases the temporary buffer', async () => {
    await sealConfirmation(tx, intent, value);
    const [passed, descriptor, bytes] = vi.mocked(encryptClassified).mock.calls[0]!;
    expect(passed).toBe(tx);
    expect(descriptor).toEqual({
      dataClass: 'pii_financial',
      patientId: intent.patient_id,
      resourceType: 'billing_payment_intent',
      resourceId: intent.payment_id,
      field: 'payment_confirmation',
    });
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });
  it('awaits the audited classified decrypt and erases returned bytes after projection', async () => {
    const bytes = Buffer.from(JSON.stringify(value));
    vi.mocked(decryptClassified).mockResolvedValue(bytes);
    await expect(openConfirmation(tx, intent)).resolves.toEqual(value);
    expect(decryptClassified).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        dataClass: 'pii_financial',
        patientId: intent.patient_id,
        resourceId: intent.payment_id,
        field: 'payment_confirmation',
      }),
      expect.objectContaining({ dekId: intent.confirmation_dek_id }),
    );
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });
  it('does not substitute local encryption when classified KMS fails', async () => {
    vi.mocked(encryptClassified).mockRejectedValue(new Error('unavailable'));
    await expect(sealConfirmation(tx, intent, value)).rejects.toThrow('unavailable');
  });
  it('does not disclose when classified decrypt/audit fails', async () => {
    vi.mocked(decryptClassified).mockRejectedValue(new Error('audit unavailable'));
    await expect(openConfirmation(tx, intent)).rejects.toThrow('audit unavailable');
  });
  it('rejects incomplete envelopes before calling KMS', async () => {
    await expect(openConfirmation(tx, { ...intent, confirmation_dek_id: null })).rejects.toThrow(
      'billing.confirmation_unavailable',
    );
    expect(decryptClassified).not.toHaveBeenCalled();
  });
  it('erases malformed decrypted data rather than returning an unvalidated confirmation', async () => {
    const bytes = Buffer.from('{"kind":"stripe","client_secret":"secret","extra":"unexpected"}');
    vi.mocked(decryptClassified).mockResolvedValue(bytes);
    await expect(openConfirmation(tx, intent)).rejects.toThrow();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });
});
