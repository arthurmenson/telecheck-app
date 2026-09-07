/** Acceptance-only AWS transport. No production module imports this file. */
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';
import type pg from 'pg';

const fixtureKey = createHash('sha256')
  .update('synthetic-billing-AWS-transport-only-not-an-AWS-key')
  .digest();
export function installControlledBillingAws() {
  assert.equal(process.env['BILLING_SYNTHETIC_ACCEPTANCE'], 'true');
  assert.equal(process.env['NODE_ENV'], 'development');
  const originalKms = Object.getOwnPropertyDescriptor(KMSClient.prototype, 'send');
  const originalSts = Object.getOwnPropertyDescriptor(STSClient.prototype, 'send');
  // SDK send is inherited from its base; preserve either shape on restoration.
  const state: { fail: boolean; calls: number; beforeCrypto: (() => Promise<void>) | null } = {
    fail: false,
    calls: 0,
    beforeCrypto: null,
  };
  Object.defineProperty(STSClient.prototype, 'send', {
    configurable: true,
    writable: true,
    value: async (command: unknown) => {
      assert.ok(command instanceof AssumeRoleCommand);
      assert.ok(['Telecheck-US', 'Telecheck-Ghana'].includes(command.input.Tags?.[0]?.Value ?? ''));
      assert.ok(command.input.RoleArn?.includes(':role/billing-synthetic-'));
      return {
        $metadata: {},
        Credentials: {
          AccessKeyId: 'CONTROLLED_TEST_ONLY',
          SecretAccessKey: 'CONTROLLED_TEST_ONLY',
          SessionToken: 'CONTROLLED_TEST_ONLY',
          Expiration: new Date(Date.now() + 3600000),
        },
      };
    },
  });
  Object.defineProperty(KMSClient.prototype, 'send', {
    configurable: true,
    writable: true,
    value: async (command: unknown) => {
      state.calls++;
      assert.ok(command instanceof GenerateDataKeyCommand || command instanceof DecryptCommand);
      const input = command.input;
      assert.equal(input.EncryptionContext?.['data_class'], 'pii_financial');
      assert.deepEqual(Object.keys(input.EncryptionContext ?? {}).sort(), [
        'data_class',
        'tenant_id',
      ]);
      const before = state.beforeCrypto;
      state.beforeCrypto = null;
      if (before) await before();
      if (state.fail) throw new Error('controlled AWS transport unavailable');
      const aad = Buffer.from(JSON.stringify([input.KeyId, input.EncryptionContext]));
      if (command instanceof GenerateDataKeyCommand) {
        const plaintext = randomBytes(32),
          iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', fixtureKey, iv);
        cipher.setAAD(aad);
        const wrapped = Buffer.concat([
          iv,
          cipher.update(plaintext),
          cipher.final(),
          cipher.getAuthTag(),
        ]);
        return { $metadata: {}, KeyId: input.KeyId, Plaintext: plaintext, CiphertextBlob: wrapped };
      }
      const wrapped = Buffer.from(command.input.CiphertextBlob!);
      const decipher = createDecipheriv('aes-256-gcm', fixtureKey, wrapped.subarray(0, 12));
      decipher.setAAD(aad);
      decipher.setAuthTag(wrapped.subarray(-16));
      return {
        $metadata: {},
        KeyId: input.KeyId,
        EncryptionAlgorithm: 'SYMMETRIC_DEFAULT',
        Plaintext: Buffer.concat([decipher.update(wrapped.subarray(12, -16)), decipher.final()]),
      };
    },
  });
  return {
    // Expose mutable controls via accessors, not a second state.
    get fail() {
      return state.fail;
    },
    set fail(value: boolean) {
      state.fail = value;
    },
    get beforeCrypto() {
      return state.beforeCrypto;
    },
    set beforeCrypto(value: (() => Promise<void>) | null) {
      state.beforeCrypto = value;
    },
    get calls() {
      return state.calls;
    },
    restore() {
      if (originalKms) Object.defineProperty(KMSClient.prototype, 'send', originalKms);
      else Reflect.deleteProperty(KMSClient.prototype, 'send');
      if (originalSts) Object.defineProperty(STSClient.prototype, 'send', originalSts);
      else Reflect.deleteProperty(STSClient.prototype, 'send');
    },
  };
}
export async function provisionSyntheticBillingKms(setup: pg.Client, tenant: string) {
  const gh = tenant === 'Telecheck-Ghana';
  assert.ok(gh || tenant === 'Telecheck-US');
  const cmk = `arn:aws:kms:us-east-1:123456789012:key/${gh ? '1' : '0'}b1978c6-cb09-4da0-933e-449b5d1e1c24`;
  const role = `arn:aws:iam::123456789012:role/billing-synthetic-${gh ? 'ghana' : 'us'}`;
  await setup.query('BEGIN');
  try {
    await setup.query('SET LOCAL ROLE kms_provisioner_role');
    await setup.query(
      "INSERT INTO public.tenant_kms_bindings(tenant_id,cmk_arn,service_role_arn,residency_policy) VALUES($1,$2,$3,'us_only')",
      [tenant, cmk, role],
    );
    await setup.query('COMMIT');
  } catch (error) {
    await setup.query('ROLLBACK');
    throw error;
  }
}
