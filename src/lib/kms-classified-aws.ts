/** Tenant-tagged STS credentials; no shared plaintext-key or credential cache. */
import { randomUUID } from 'node:crypto';

import {
  DecryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
  type DecryptCommandInput,
  type DecryptCommandOutput,
  type GenerateDataKeyCommandInput,
  type GenerateDataKeyCommandOutput,
} from '@aws-sdk/client-kms';
import {
  AssumeRoleCommand,
  STSClient,
  type AssumeRoleCommandInput,
  type AssumeRoleCommandOutput,
} from '@aws-sdk/client-sts';

import { KmsOperationError } from './kms-aws.js';
import {
  validateBinding,
  type KmsDataClass,
  type TenantKeyBinding,
} from './kms-classified-types.js';

export interface ClassifiedKeyTransport {
  assumeRole(input: AssumeRoleCommandInput, signal: AbortSignal): Promise<AssumeRoleCommandOutput>;
  generate(
    binding: TenantKeyBinding,
    credentials: NonNullable<AssumeRoleCommandOutput['Credentials']>,
    input: GenerateDataKeyCommandInput,
    signal: AbortSignal,
  ): Promise<GenerateDataKeyCommandOutput>;
  decrypt(
    binding: TenantKeyBinding,
    credentials: NonNullable<AssumeRoleCommandOutput['Credentials']>,
    input: DecryptCommandInput,
    signal: AbortSignal,
  ): Promise<DecryptCommandOutput>;
}
export interface ClassifiedKeyProvider {
  generate(
    binding: TenantKeyBinding,
    dataClass: KmsDataClass,
  ): Promise<{ plaintext: Buffer; encrypted: Buffer }>;
  decrypt(binding: TenantKeyBinding, dataClass: KmsDataClass, encrypted: Buffer): Promise<Buffer>;
}

export function createClassifiedKeyProvider(
  transport: ClassifiedKeyTransport,
  timeoutMs = 5000,
  maxConcurrent = 4,
): ClassifiedKeyProvider {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isInteger(maxConcurrent) ||
    maxConcurrent < 1 ||
    maxConcurrent > 16
  )
    throw new KmsOperationError();
  let active = 0;
  async function request(
    bindingInput: TenantKeyBinding,
    dataClass: KmsDataClass,
    encryptedInput?: Buffer,
  ) {
    const binding = validateBinding(bindingInput);
    const encrypted = encryptedInput === undefined ? undefined : Buffer.from(encryptedInput);
    if (active >= maxConcurrent || (encrypted && (encrypted.length < 1 || encrypted.length > 6144)))
      throw new KmsOperationError();
    active++;
    const abort = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = (async () => {
      let key: Uint8Array | undefined;
      const assumed = await transport.assumeRole(
        {
          RoleArn: binding.serviceRoleArn,
          RoleSessionName: `telecheck-kms-${randomUUID()}`,
          DurationSeconds: 900,
          Tags: [{ Key: 'tenant_id', Value: binding.tenantId }],
          Policy: JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['kms:GenerateDataKey', 'kms:Decrypt'],
                Resource: binding.cmkArn,
                Condition: {
                  StringEquals: {
                    'kms:EncryptionContext:tenant_id': binding.tenantId,
                    'kms:EncryptionContext:data_class': dataClass,
                  },
                  'ForAllValues:StringEquals': {
                    'kms:EncryptionContextKeys': ['tenant_id', 'data_class'],
                  },
                },
              },
            ],
          }),
        },
        abort.signal,
      );
      try {
        const credentials = assumed.Credentials;
        if (
          abort.signal.aborted ||
          !credentials?.AccessKeyId ||
          !credentials.SecretAccessKey ||
          !credentials.SessionToken ||
          !credentials.Expiration ||
          credentials.Expiration.getTime() <= Date.now() + timeoutMs
        )
          throw new KmsOperationError();
        const context = { tenant_id: binding.tenantId, data_class: dataClass };
        const result =
          encrypted === undefined
            ? await transport.generate(
                binding,
                credentials,
                { KeyId: binding.cmkArn, KeySpec: 'AES_256', EncryptionContext: context },
                abort.signal,
              )
            : await transport.decrypt(
                binding,
                credentials,
                {
                  KeyId: binding.cmkArn,
                  CiphertextBlob: encrypted,
                  EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
                  EncryptionContext: context,
                },
                abort.signal,
              );
        key = result.Plaintext;
        if (
          timedOut ||
          abort.signal.aborted ||
          result.KeyId !== binding.cmkArn ||
          !(key instanceof Uint8Array) ||
          key.length !== 32 ||
          (encrypted !== undefined &&
            (result as DecryptCommandOutput).EncryptionAlgorithm !== 'SYMMETRIC_DEFAULT')
        )
          throw new KmsOperationError();
        const blob = encrypted ?? (result as GenerateDataKeyCommandOutput).CiphertextBlob;
        if (!(blob instanceof Uint8Array) || blob.length < 1 || blob.length > 6144)
          throw new KmsOperationError();
        return { plaintext: Buffer.from(key), encrypted: Buffer.from(blob) };
      } finally {
        key?.fill(0);
        // JS strings cannot be reliably zeroized. Drop references and destroy
        // clients; credentials are never retained in an application cache.
        delete assumed.Credentials;
      }
    })().finally(() => {
      active--;
    });
    // Keep capacity reserved until even a non-cooperating transport settles.
    // Late successful responses are erased before they can escape this scope.
    void pending.then(
      (value) => {
        if (timedOut) value.plaintext.fill(0);
      },
      () => undefined,
    );
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            abort.abort();
            reject(new KmsOperationError());
          }, timeoutMs);
        }),
      ]);
    } catch {
      throw new KmsOperationError();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return {
    generate: (binding, dataClass) => request(binding, dataClass),
    decrypt: async (binding, dataClass, encrypted) =>
      (await request(binding, dataClass, encrypted)).plaintext,
  };
}

export function awsClassifiedTransport(timeoutMs: number): ClassifiedKeyTransport {
  const options = {
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 2000, requestTimeout: timeoutMs },
  };
  const createClient = (
    binding: TenantKeyBinding,
    credentials: NonNullable<AssumeRoleCommandOutput['Credentials']>,
  ) => {
    if (!credentials.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken)
      throw new KmsOperationError();
    return new KMSClient({
      ...options,
      region: binding.primaryRegion,
      credentials: {
        accessKeyId: credentials.AccessKeyId,
        secretAccessKey: credentials.SecretAccessKey,
        sessionToken: credentials.SessionToken,
      },
    });
  };
  return {
    async assumeRole(input, signal) {
      const client = new STSClient({ ...options, region: 'us-east-1' });
      try {
        return await client.send(new AssumeRoleCommand(input), { abortSignal: signal });
      } finally {
        client.destroy();
      }
    },
    async generate(binding, credentials, input, signal) {
      const client = createClient(binding, credentials);
      try {
        return await client.send(new GenerateDataKeyCommand(input), { abortSignal: signal });
      } finally {
        client.destroy();
      }
    },
    async decrypt(binding, credentials, input, signal) {
      const client = createClient(binding, credentials);
      try {
        return await client.send(new DecryptCommand(input), { abortSignal: signal });
      } finally {
        client.destroy();
      }
    },
  };
}
