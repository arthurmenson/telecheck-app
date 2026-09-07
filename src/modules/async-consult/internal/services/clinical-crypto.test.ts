import { describe, expect, it, vi } from 'vitest';

import type { ClassifiedEnvelope } from '../../../../lib/classified-kms.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { KmsOperationError } from '../../../../lib/kms-aws.js';

import {
  createConsultClinicalCrypto,
  MAX_CONSULT_CLINICAL_BYTES,
  type ConsultClinicalField,
} from './clinical-crypto.js';

const tx = { query: vi.fn() } as DbTransaction;
const patientId = '01K5BFNXP505NB6KS229BKCNQ3';
const rowId = '01K5BFNXP505NB6KS229BKCNQ4';
const envelope: ClassifiedEnvelope = {
  ciphertext: Buffer.from('authenticated-test-ciphertext'),
  dekId: '01K5BFNXP505NB6KS229BKCNQ5',
  iv: Buffer.alloc(12),
  tag: Buffer.alloc(16),
  aad: Buffer.from('test-aad'),
  alg: 'AES-256-GCM',
  algVersion: '2',
  encryptedAt: new Date(),
};

function setup() {
  const encrypt = vi.fn(async () => envelope);
  const decrypt = vi.fn(async () => Buffer.from('{"answer":"synthetic clinical text"}'));
  const authorize = vi.fn(async () => {});
  return { encrypt, decrypt, authorize, crypto: createConsultClinicalCrypto({ encrypt, decrypt }) };
}

describe('consult clinical encryption boundary', () => {
  it.each([
    ['intake_payload', 'consult_intake_submission'],
    ['summary', 'consult_clinical_summary'],
    ['decision_rationale', 'consult_clinician_decision'],
    ['message', 'consult_follow_up_message'],
  ] as const)(
    'pins %s to its actual persisted resource and patient',
    async (field, resourceType) => {
      const s = setup();
      await s.crypto.encrypt(tx, { patientId, rowId, field }, { answer: 'synthetic' }, s.authorize);
      expect(s.encrypt).toHaveBeenCalledWith(
        tx,
        {
          patientId,
          resourceId: rowId,
          resourceType,
          field,
          dataClass: 'pii_sensitive_clinical',
        },
        expect.any(Buffer),
      );
      expect(s.authorize).toHaveBeenCalledTimes(2);
      expect(s.authorize.mock.invocationCallOrder[0]).toBeLessThan(
        s.encrypt.mock.invocationCallOrder[0]!,
      );
      expect(s.authorize.mock.invocationCallOrder[1]).toBeGreaterThan(
        s.encrypt.mock.invocationCallOrder[0]!,
      );
      expect(
        (s.encrypt.mock.calls[0] as unknown as [unknown, unknown, Buffer])[2].every(
          (byte) => byte === 0,
        ),
      ).toBe(true);
    },
  );

  it.each(['encrypt', 'decrypt'] as const)(
    'never calls %s before owning-resource authorization',
    async (operation) => {
      const s = setup();
      s.authorize.mockRejectedValue(new Error('not authorized'));
      const record = { patientId, rowId, field: 'message' as const };
      await expect(
        operation === 'encrypt'
          ? s.crypto.encrypt(tx, record, { message: 'private' }, s.authorize)
          : s.crypto.decrypt(tx, record, envelope, s.authorize),
      ).rejects.toThrow('not authorized');
      expect(s.encrypt).not.toHaveBeenCalled();
      expect(s.decrypt).not.toHaveBeenCalled();
    },
  );

  it.each(['encrypt', 'decrypt'] as const)(
    'suppresses %s output if the relationship expires during crypto',
    async (operation) => {
      const s = setup();
      s.authorize
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('claim expired'));
      const record = { patientId, rowId, field: 'decision_rationale' as const };
      await expect(
        operation === 'encrypt'
          ? s.crypto.encrypt(tx, record, { text: 'private' }, s.authorize)
          : s.crypto.decrypt(tx, record, envelope, s.authorize),
      ).rejects.toThrow('claim expired');
      expect(s.authorize).toHaveBeenCalledTimes(2);
      if (operation === 'decrypt') {
        const bytes = (await s.decrypt.mock.results[0]!.value) as Buffer;
        expect(bytes.every((byte) => byte === 0)).toBe(true);
      }
    },
  );

  it('returns parsed plaintext only after successful crypto, audit and final ownership checks', async () => {
    const s = setup();
    expect(
      await s.crypto.decrypt(
        tx,
        { patientId, rowId, field: 'intake_payload' },
        envelope,
        s.authorize,
      ),
    ).toEqual({ answer: 'synthetic clinical text' });
    const bytes = (await s.decrypt.mock.results[0]!.value) as Buffer;
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    s.decrypt.mockRejectedValueOnce(new KmsOperationError());
    await expect(
      s.crypto.decrypt(tx, { patientId, rowId, field: 'summary' }, envelope, s.authorize),
    ).rejects.toBeInstanceOf(KmsOperationError);
  });

  it.each([
    Buffer.from('{"private_value":"secret"'),
    Buffer.from([0xff]),
    Buffer.alloc(MAX_CONSULT_CLINICAL_BYTES + 1),
  ])('does not expose malformed or oversized authenticated plaintext in errors', async (bytes) => {
    const s = setup();
    s.decrypt.mockResolvedValueOnce(bytes);
    await expect(
      s.crypto.decrypt(tx, { patientId, rowId, field: 'summary' }, envelope, s.authorize),
    ).rejects.toThrow('Tenant encryption operation is unavailable.');
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects unknown field, oversized JSON and unsafe serialization without a cipher call', async () => {
    const s = setup();
    const record = { patientId, rowId, field: 'message' as const };
    await expect(
      s.crypto.encrypt(tx, { ...record, field: 'other' as ConsultClinicalField }, {}, s.authorize),
    ).rejects.toBeInstanceOf(KmsOperationError);
    for (const value of [
      undefined,
      '😀'.repeat(MAX_CONSULT_CLINICAL_BYTES / 4),
      {
        toJSON: () => {
          throw new Error('private data in parser error');
        },
      },
    ]) {
      await expect(s.crypto.encrypt(tx, record, value, s.authorize)).rejects.toThrow(
        'Tenant encryption operation is unavailable.',
      );
    }
    expect(s.encrypt).not.toHaveBeenCalled();
  });
});
