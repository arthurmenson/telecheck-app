import { z } from 'zod';

import type { TenantId } from './glossary.js';

export const KMS_DATA_CLASSES = [
  'pii_demographic',
  'pii_clinical',
  'pii_sensitive_clinical',
  'pii_financial',
  'pii_conversation',
  'pii_audit_payload',
  'pii_research_consented',
] as const;
export type KmsDataClass = (typeof KMS_DATA_CLASSES)[number];
export const kmsClassSchema = z.enum(KMS_DATA_CLASSES);
const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
export const kmsDescriptorSchema = z
  .object({
    dataClass: kmsClassSchema,
    patientId: ulid.nullable(),
    resourceType: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    resourceId: z
      .string()
      .regex(
        /^(?:[0-7][0-9A-HJKMNP-TV-Z]{25}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
      ),
    field: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  })
  .strict();
/** A server-selected descriptor, after authorization of the actual resource. */
export type ClassifiedResource = z.infer<typeof kmsDescriptorSchema>;
export interface ClassifiedEnvelope {
  ciphertext: Buffer;
  dekId: string;
  iv: Buffer;
  tag: Buffer;
  alg: string;
  algVersion: string;
  aad: Buffer;
  encryptedAt: Date;
}
export interface KmsActor {
  tenantId: TenantId;
  accountId: string;
  sessionId: string;
  role: 'patient' | 'clinician' | 'tenant_admin';
  countryOfCare: string;
  /** Internal request secret. Never include in logs, AWS inputs or errors. */
  nonce: string;
  transactionId: string;
}
export interface TenantKeyBinding {
  tenantId: TenantId;
  cmkArn: string;
  serviceRoleArn: string;
  primaryRegion: 'us-east-1';
  residencyPolicy: 'us_only' | 'us_with_dr_fallback';
  replicaArn: string | null;
}
export interface ClassKeyVersion {
  dekId: string;
  encryptedDek: Buffer;
}
export type KmsFailureReason =
  | 'cross_tenant_decrypt'
  | 'encryption_context_mismatch'
  | 'access_denied'
  | 'cmk_not_found'
  | 'kms_service_error';
export type KmsAuditAction =
  | 'kms.dek_created'
  | 'kms.dek_rotation_started'
  | 'kms.dek_lookup'
  | 'kms.decrypt_invoked'
  | 'kms.decrypt_failed';

/** Runtime validation is repeated even for records returned by the database. */
export function validateBinding(binding: TenantKeyBinding): TenantKeyBinding {
  const key =
    /^arn:aws:kms:(us-east-1|us-west-2):(\d{12}):key\/(mrk-[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
  const primary = key.exec(binding.cmkArn);
  const role = /^arn:aws:iam::(\d{12}):role\/[A-Za-z0-9+=,.@_/-]{1,512}$/.exec(
    binding.serviceRoleArn,
  );
  const replica = binding.replicaArn === null ? null : key.exec(binding.replicaArn);
  if (
    !primary ||
    primary[1] !== 'us-east-1' ||
    binding.primaryRegion !== 'us-east-1' ||
    !role ||
    role[1] !== primary[2] ||
    !['us_only', 'us_with_dr_fallback'].includes(binding.residencyPolicy) ||
    (binding.residencyPolicy === 'us_only' && binding.replicaArn !== null) ||
    (binding.residencyPolicy === 'us_with_dr_fallback' &&
      (!replica ||
        replica[1] !== 'us-west-2' ||
        replica[2] !== primary[2] ||
        replica[3] !== primary[3] ||
        !primary[3]?.startsWith('mrk-')))
  ) {
    throw new Error('Invalid tenant key binding');
  }
  return { ...binding };
}
