/** Server-selected P-038 row/field bindings. Owning-resource authorization is mandatory. */
import {
  decryptClassified,
  encryptClassified,
  type ClassifiedEnvelope,
  type ClassifiedResource,
} from '../../../../lib/classified-kms.js';
import type { DbTransaction } from '../../../../lib/db.js';
import { KmsOperationError } from '../../../../lib/kms-aws.js';

const RESOURCE_TYPES = {
  intake_payload: 'consult_intake_submission',
  summary: 'consult_clinical_summary',
  decision_rationale: 'consult_clinician_decision',
  message: 'consult_follow_up_message',
} as const;

export type ConsultClinicalField = keyof typeof RESOURCE_TYPES;
export interface ConsultClinicalRecord {
  patientId: string;
  rowId: string;
  field: ConsultClinicalField;
}
export interface ConsultCipher {
  encrypt: typeof encryptClassified;
  decrypt: typeof decryptClassified;
}
export const MAX_CONSULT_CLINICAL_BYTES = 64 * 1024;

function descriptor(record: ConsultClinicalRecord): ClassifiedResource {
  if (!Object.hasOwn(RESOURCE_TYPES, record.field)) throw new KmsOperationError();
  return {
    dataClass: 'pii_sensitive_clinical',
    patientId: record.patientId,
    resourceId: record.rowId,
    resourceType: RESOURCE_TYPES[record.field],
    field: record.field,
  };
}

/**
 * The callback must check the persisted consult/claim/consent relationship on
 * this transaction. KMS independently validates the live actor and tenant.
 * Run before the outer audit lock; KMS durably audits on its separate pool.
 * Injection is a trusted composition seam, never a request/config fallback.
 */
export function createConsultClinicalCrypto(
  cipher: ConsultCipher = { encrypt: encryptClassified, decrypt: decryptClassified },
) {
  return {
    async encrypt(
      tx: DbTransaction,
      record: ConsultClinicalRecord,
      value: unknown,
      authorize: () => Promise<void>,
    ): Promise<ClassifiedEnvelope> {
      await authorize();
      const resource = descriptor(record);
      let plaintext: Buffer | undefined;
      try {
        let serialized: string | undefined;
        try {
          serialized = JSON.stringify(value);
        } catch {
          throw new KmsOperationError();
        }
        if (
          serialized === undefined ||
          Buffer.byteLength(serialized, 'utf8') > MAX_CONSULT_CLINICAL_BYTES
        )
          throw new KmsOperationError();
        plaintext = Buffer.from(serialized, 'utf8');
        const envelope = await cipher.encrypt(tx, resource, plaintext);
        await authorize();
        return envelope;
      } finally {
        plaintext?.fill(0);
      }
    },
    async decrypt(
      tx: DbTransaction,
      record: ConsultClinicalRecord,
      envelope: ClassifiedEnvelope,
      authorize: () => Promise<void>,
    ): Promise<unknown> {
      await authorize();
      const resource = descriptor(record);
      let plaintext: Buffer | undefined;
      try {
        plaintext = await cipher.decrypt(tx, resource, envelope);
        if (plaintext.length > MAX_CONSULT_CLINICAL_BYTES) throw new KmsOperationError();
        let value: unknown;
        try {
          // Fatal decoding rejects malformed authenticated bytes rather than
          // replacing them and silently changing the recorded clinical text.
          value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
        } catch {
          // JSON parser messages may contain clinical text. Never propagate them.
          throw new KmsOperationError();
        }
        await authorize();
        return value;
      } finally {
        plaintext?.fill(0);
      }
    },
  };
}

export const consultClinicalCrypto = createConsultClinicalCrypto();
