/** Three-tier AES-GCM container fitted to migration 056's eight columns. */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { KMS_MAX_PLAINTEXT_BYTES, KmsOperationError } from './kms-aws.js';
import {
  kmsDescriptorSchema,
  type ClassifiedEnvelope,
  type ClassifiedResource,
} from './kms-classified-types.js';

const MAGIC = Buffer.from('TCROW002');
const PREFIX_BYTES = 8 + 12 + 16 + 32;
const VERSION = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function aad(
  tenantId: string,
  descriptor: ClassifiedResource,
  dekId: string,
  encryptedAt: Date,
): Buffer {
  return Buffer.from(
    JSON.stringify([
      'telecheck-classified',
      2,
      tenantId,
      descriptor.dataClass,
      descriptor.patientId,
      descriptor.resourceType,
      descriptor.resourceId,
      descriptor.field,
      dekId,
      'AES-256-GCM',
      encryptedAt.toISOString(),
    ]),
  );
}

function seal(
  key: Buffer,
  iv: Buffer,
  context: Buffer,
  input: Buffer,
): { bytes: Buffer; tag: Buffer } {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(context);
  return { bytes: Buffer.concat([cipher.update(input), cipher.final()]), tag: cipher.getAuthTag() };
}

function open(key: Buffer, iv: Buffer, tag: Buffer, context: Buffer, input: Buffer): Buffer {
  let provisional: Buffer | undefined;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(context);
    cipher.setAuthTag(tag);
    provisional = cipher.update(input);
    const end = cipher.final();
    return Buffer.concat([provisional, end]);
  } finally {
    provisional?.fill(0);
  }
}

/** Snapshot and authenticate the envelope metadata before any external request. */
export function snapshotEnvelope(
  tenantId: string,
  descriptor: ClassifiedResource,
  value: ClassifiedEnvelope,
): ClassifiedEnvelope {
  kmsDescriptorSchema.parse(descriptor);
  if (
    !value ||
    !VERSION.test(value.dekId) ||
    value.alg !== 'AES-256-GCM' ||
    value.algVersion !== '2' ||
    !Buffer.isBuffer(value.ciphertext) ||
    value.ciphertext.length < PREFIX_BYTES ||
    value.ciphertext.length > PREFIX_BYTES + KMS_MAX_PLAINTEXT_BYTES ||
    !value.ciphertext.subarray(0, 8).equals(MAGIC) ||
    !Buffer.isBuffer(value.iv) ||
    value.iv.length !== 12 ||
    !Buffer.isBuffer(value.tag) ||
    value.tag.length !== 16 ||
    !Buffer.isBuffer(value.aad) ||
    value.aad.length > 1024 ||
    !(value.encryptedAt instanceof Date) ||
    !Number.isFinite(value.encryptedAt.getTime())
  ) {
    throw new KmsOperationError();
  }
  const expected = aad(tenantId, descriptor, value.dekId, value.encryptedAt);
  if (value.aad.length !== expected.length || !timingSafeEqual(value.aad, expected))
    throw new KmsOperationError();
  return {
    ciphertext: Buffer.from(value.ciphertext),
    dekId: value.dekId,
    iv: Buffer.from(value.iv),
    tag: Buffer.from(value.tag),
    alg: value.alg,
    algVersion: value.algVersion,
    aad: expected,
    encryptedAt: new Date(value.encryptedAt),
  };
}

export function encryptRow(
  tenantId: string,
  descriptor: ClassifiedResource,
  dekId: string,
  classKey: Buffer,
  plaintext: Buffer,
): ClassifiedEnvelope {
  if (
    classKey.length !== 32 ||
    !VERSION.test(dekId) ||
    !Buffer.isBuffer(plaintext) ||
    plaintext.length > KMS_MAX_PLAINTEXT_BYTES
  )
    throw new KmsOperationError();
  kmsDescriptorSchema.parse(descriptor);
  const rowKey = randomBytes(32);
  try {
    const encryptedAt = new Date();
    const context = aad(tenantId, descriptor, dekId, encryptedAt);
    const wrapIv = randomBytes(12);
    const wrapped = seal(
      classKey,
      wrapIv,
      Buffer.concat([Buffer.from('row-key:'), context]),
      rowKey,
    );
    const iv = randomBytes(12);
    const data = seal(rowKey, iv, Buffer.concat([Buffer.from('row-data:'), context]), plaintext);
    return {
      ciphertext: Buffer.concat([MAGIC, wrapIv, wrapped.tag, wrapped.bytes, data.bytes]),
      dekId,
      iv,
      tag: data.tag,
      alg: 'AES-256-GCM',
      algVersion: '2',
      aad: context,
      encryptedAt,
    };
  } finally {
    rowKey.fill(0);
  }
}

export function decryptRow(
  tenantId: string,
  descriptor: ClassifiedResource,
  envelope: ClassifiedEnvelope,
  classKey: Buffer,
): Buffer {
  let rowKey: Buffer | undefined;
  try {
    const value = snapshotEnvelope(tenantId, descriptor, envelope);
    if (classKey.length !== 32) throw new KmsOperationError();
    rowKey = open(
      classKey,
      value.ciphertext.subarray(8, 20),
      value.ciphertext.subarray(20, 36),
      Buffer.concat([Buffer.from('row-key:'), value.aad]),
      value.ciphertext.subarray(36, 68),
    );
    return open(
      rowKey,
      value.iv,
      value.tag,
      Buffer.concat([Buffer.from('row-data:'), value.aad]),
      value.ciphertext.subarray(PREFIX_BYTES),
    );
  } catch {
    throw new KmsOperationError();
  } finally {
    rowKey?.fill(0);
  }
}
