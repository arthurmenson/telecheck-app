/**
 * Tenant envelope encryption primitive (ADR-023/024, KMS architecture §2/§4).
 *
 * Only a fresh AES-256 data key is sent through KMS; application payloads stay
 * local. Both the wrapped key and local ciphertext bind the trusted tenant.
 * This primitive does not provision IAM/STS roles, data-class keys, decrypt
 * audit context or rotation infrastructure; those remain separate integration
 * work. Never treat this adapter alone as full KMS operational readiness.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type DecryptCommandInput,
  type DecryptCommandOutput,
  type GenerateDataKeyCommandInput,
  type GenerateDataKeyCommandOutput,
} from '@aws-sdk/client-kms';

import { config } from './config.js';
import { isTenantIdFormat } from './glossary.js';
import type { TenantContext } from './tenant-context.js';

export const KMS_MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_WRAPPED_KEY_BYTES = 6144;
const MAGIC = Buffer.from('TCKMS001', 'ascii');
const HEADER_BYTES = MAGIC.length + 2;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_ENVELOPE_BYTES =
  HEADER_BYTES + MAX_WRAPPED_KEY_BYTES + IV_BYTES + TAG_BYTES + KMS_MAX_PLAINTEXT_BYTES;

type TenantKeyContext = Pick<TenantContext, 'tenantId' | 'kmsKeyAlias'>;

/** Deliberately contains no raw AWS diagnostics, ciphertext, key ID or tenant. */
export class KmsOperationError extends Error {
  constructor() {
    super('Tenant encryption operation is unavailable.');
    this.name = 'KmsOperationError';
  }
}

/** Narrow seam for controlled-transport tests; the default uses the AWS SDK. */
export interface KmsKeyService {
  generateDataKey(
    input: GenerateDataKeyCommandInput,
    signal: AbortSignal,
  ): Promise<GenerateDataKeyCommandOutput>;
  decrypt(input: DecryptCommandInput, signal: AbortSignal): Promise<DecryptCommandOutput>;
}

function snapshotTenant(tenant: TenantKeyContext): { tenantId: string; keyId: string } {
  const tenantId = tenant.tenantId;
  const keyId = tenant.kmsKeyAlias;
  // Accept KMS aliases, key IDs and explicit key/alias ARNs. The value comes
  // from the resolved tenant, never from the ciphertext envelope.
  const keyReference =
    /^(?:alias\/[A-Za-z0-9/_-]+|[a-fA-F0-9-]{36}|mrk-[a-fA-F0-9]{32}|arn:aws(?:-cn|-us-gov)?:kms:[a-z0-9-]+:\d{12}:(?:key\/[A-Za-z0-9-]+|alias\/[A-Za-z0-9/_-]+))$/;
  if (
    typeof tenantId !== 'string' ||
    tenantId.length > 128 ||
    !isTenantIdFormat(tenantId) ||
    typeof keyId !== 'string' ||
    keyId.length > 2048 ||
    !keyReference.test(keyId)
  ) {
    throw new KmsOperationError();
  }
  return { tenantId, keyId };
}

function context(tenantId: string): Record<string, string> {
  // EncryptionContext is visible in CloudTrail: no patient IDs or free text.
  return { tenant_id: tenantId };
}

function authenticatedData(tenantId: string, header: Buffer, wrappedKey: Buffer): Buffer {
  return Buffer.concat([
    header,
    wrappedKey,
    Buffer.from(JSON.stringify({ tenant_id: tenantId, format: 'telecheck-kms-v1' }), 'utf8'),
  ]);
}

/**
 * Bound the caller's wait, including SDK credential resolution. Abort requests
 * at the deadline; if a transport finishes after cancellation, erase any data
 * key it returns rather than leaving it in an abandoned promise result.
 */
async function requestKey<T extends { Plaintext?: Uint8Array | undefined }>(
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new KmsOperationError());
    }, timeoutMs);
  });
  try {
    const pending = Promise.resolve()
      .then(() => request(controller.signal))
      .then((result) => {
        if (controller.signal.aborted) {
          if (result.Plaintext instanceof Uint8Array) result.Plaintext.fill(0);
          throw new KmsOperationError();
        }
        return result;
      });
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

function requireDataKey(key: Uint8Array | undefined): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new KmsOperationError();
}

/** Version 1 layout: magic(8), wrapped-key length(2), wrapped key, IV, tag, data. */
export function createAwsTenantKms(service: KmsKeyService, timeoutMs = 5000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new KmsOperationError();
  }

  return {
    async encrypt(tenant: TenantKeyContext, plaintext: Buffer): Promise<Buffer> {
      let ownedPlaintext: Buffer | undefined;
      let dataKey: Uint8Array | undefined;
      try {
        const { tenantId, keyId } = snapshotTenant(tenant);
        if (!Buffer.isBuffer(plaintext) || plaintext.length > KMS_MAX_PLAINTEXT_BYTES) {
          throw new KmsOperationError();
        }
        // Snapshot before the first await. A caller cannot change the plaintext
        // or tenant identity while KMS resolves the data key.
        ownedPlaintext = Buffer.from(plaintext);
        const response = await requestKey(timeoutMs, (signal) =>
          service.generateDataKey(
            { KeyId: keyId, KeySpec: 'AES_256', EncryptionContext: context(tenantId) },
            signal,
          ),
        );
        dataKey = response.Plaintext;
        requireDataKey(dataKey);
        if (
          !(response.CiphertextBlob instanceof Uint8Array) ||
          response.CiphertextBlob.byteLength === 0 ||
          response.CiphertextBlob.byteLength > MAX_WRAPPED_KEY_BYTES
        ) {
          throw new KmsOperationError();
        }
        const wrappedKey = Buffer.from(response.CiphertextBlob);
        const header = Buffer.alloc(HEADER_BYTES);
        MAGIC.copy(header);
        header.writeUInt16BE(wrappedKey.length, MAGIC.length);
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(authenticatedData(tenantId, header, wrappedKey));
        const encrypted = Buffer.concat([cipher.update(ownedPlaintext), cipher.final()]);
        return Buffer.concat([header, wrappedKey, iv, cipher.getAuthTag(), encrypted]);
      } catch {
        throw new KmsOperationError();
      } finally {
        if (dataKey instanceof Uint8Array) dataKey.fill(0);
        ownedPlaintext?.fill(0);
      }
    },

    async decrypt(tenant: TenantKeyContext, envelope: Buffer): Promise<Buffer> {
      let dataKey: Uint8Array | undefined;
      let unverifiedPlaintext: Buffer | undefined;
      try {
        const { tenantId, keyId } = snapshotTenant(tenant);
        if (
          !Buffer.isBuffer(envelope) ||
          envelope.length < HEADER_BYTES + 1 + IV_BYTES + TAG_BYTES ||
          envelope.length > MAX_ENVELOPE_BYTES ||
          !envelope.subarray(0, MAGIC.length).equals(MAGIC)
        ) {
          throw new KmsOperationError();
        }
        const wrappedKeyLength = envelope.readUInt16BE(MAGIC.length);
        const ivStart = HEADER_BYTES + wrappedKeyLength;
        const dataStart = ivStart + IV_BYTES + TAG_BYTES;
        if (
          wrappedKeyLength === 0 ||
          wrappedKeyLength > MAX_WRAPPED_KEY_BYTES ||
          dataStart > envelope.length ||
          envelope.length - dataStart > KMS_MAX_PLAINTEXT_BYTES
        ) {
          throw new KmsOperationError();
        }
        const ownedEnvelope = Buffer.from(envelope);
        const wrappedKey = ownedEnvelope.subarray(HEADER_BYTES, ivStart);
        const response = await requestKey(timeoutMs, (signal) =>
          service.decrypt(
            {
              // Required even though symmetric KMS ciphertext identifies its
              // key: never let a hostile envelope choose another tenant's key.
              KeyId: keyId,
              CiphertextBlob: wrappedKey,
              EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
              EncryptionContext: context(tenantId),
            },
            signal,
          ),
        );
        dataKey = response.Plaintext;
        requireDataKey(dataKey);
        const decipher = createDecipheriv(
          'aes-256-gcm',
          dataKey,
          ownedEnvelope.subarray(ivStart, ivStart + IV_BYTES),
          { authTagLength: TAG_BYTES },
        );
        decipher.setAAD(
          authenticatedData(tenantId, ownedEnvelope.subarray(0, HEADER_BYTES), wrappedKey),
        );
        decipher.setAuthTag(ownedEnvelope.subarray(ivStart + IV_BYTES, dataStart));
        unverifiedPlaintext = decipher.update(ownedEnvelope.subarray(dataStart));
        const final = decipher.final();
        return Buffer.concat([unverifiedPlaintext, final]);
      } catch {
        throw new KmsOperationError();
      } finally {
        if (dataKey instanceof Uint8Array) dataKey.fill(0);
        // Never retain unauthenticated bytes if final() rejects the GCM tag.
        unverifiedPlaintext?.fill(0);
      }
    },
  };
}

let defaultAdapter: ReturnType<typeof createAwsTenantKms> | undefined;

function getDefaultAdapter() {
  if (defaultAdapter === undefined) {
    const client = new KMSClient({
      region: config.aws.region,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 2000, requestTimeout: config.tenantKmsRequestTimeoutMs },
      // Use the standard AWS credential chain: supports IAM task/instance roles
      // and short-lived session credentials without copying secrets into config.
    });
    defaultAdapter = createAwsTenantKms(
      {
        generateDataKey: (input, abortSignal) =>
          client.send(new GenerateDataKeyCommand(input), { abortSignal }),
        decrypt: (input, abortSignal) => client.send(new DecryptCommand(input), { abortSignal }),
      },
      config.tenantKmsRequestTimeoutMs,
    );
  }
  return defaultAdapter;
}

export async function awsKmsEncrypt(tenant: TenantKeyContext, plaintext: Buffer): Promise<Buffer> {
  try {
    return await getDefaultAdapter().encrypt(tenant, plaintext);
  } catch {
    throw new KmsOperationError();
  }
}

export async function awsKmsDecrypt(tenant: TenantKeyContext, envelope: Buffer): Promise<Buffer> {
  try {
    return await getDefaultAdapter().decrypt(tenant, envelope);
  } catch {
    throw new KmsOperationError();
  }
}
