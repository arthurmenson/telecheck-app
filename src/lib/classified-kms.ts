/** Public classified API: authorization first, authenticated bytes, durable audit. */
import { ulid } from 'ulid';

import { config } from './config.js';
import type { DbTransaction } from './db.js';
import { KMS_MAX_PLAINTEXT_BYTES, KmsOperationError } from './kms-aws.js';
import {
  awsClassifiedTransport,
  createClassifiedKeyProvider,
  type ClassifiedKeyProvider,
} from './kms-classified-aws.js';
import {
  defaultClassifiedKmsStore,
  sameKmsActor,
  type ClassifiedKmsStore,
} from './kms-classified-store.js';
import {
  kmsDescriptorSchema,
  type ClassifiedEnvelope,
  type ClassifiedResource,
  type KmsActor,
  type KmsFailureReason,
  type TenantKeyBinding,
} from './kms-classified-types.js';
import { decryptRow, encryptRow, snapshotEnvelope } from './kms-row-envelope.js';

export type {
  ClassifiedEnvelope,
  ClassifiedResource,
  KmsDataClass,
} from './kms-classified-types.js';

/** Dependency injection exercises the identical production engine with controlled transports. */
export function createClassifiedKms(
  store: ClassifiedKmsStore,
  provider: ClassifiedKeyProvider,
  maxConcurrent = 4,
) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16)
    throw new KmsOperationError();
  let active = 0;
  async function admit<T>(work: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) throw new KmsOperationError();
    active++;
    try {
      return await work();
    } finally {
      active--;
    }
  }
  async function verify(tx: DbTransaction, actor: KmsActor, descriptor: ClassifiedResource) {
    if (!sameKmsActor(actor, await store.actor(tx, descriptor))) throw new KmsOperationError();
  }
  async function writeKey(
    actor: KmsActor,
    descriptor: ClassifiedResource,
    binding: TenantKeyBinding,
  ) {
    const activeKey = await store.active(actor, descriptor);
    if (activeKey) {
      const version = await store.lookup(actor, descriptor, activeKey.dekId);
      return {
        dekId: version.dekId,
        plaintext: await provider.decrypt(binding, descriptor.dataClass, version.encryptedDek),
      };
    }
    const generated = await provider.generate(binding, descriptor.dataClass);
    try {
      const candidate = { dekId: ulid(), encryptedDek: generated.encrypted };
      const installed = await store.install(actor, descriptor, candidate, false);
      // A concurrent request may have committed its version first.
      if (installed.dekId !== candidate.dekId) {
        const winner = await store.lookup(actor, descriptor, installed.dekId);
        return {
          dekId: winner.dekId,
          plaintext: await provider.decrypt(binding, descriptor.dataClass, winner.encryptedDek),
        };
      }
      return { dekId: installed.dekId, plaintext: Buffer.from(generated.plaintext) };
    } finally {
      generated.plaintext.fill(0);
    }
  }
  return {
    async encrypt(
      tx: DbTransaction,
      descriptorInput: ClassifiedResource,
      plaintextInput: Buffer,
    ): Promise<ClassifiedEnvelope> {
      let plaintext: Buffer | undefined;
      let classKey: Buffer | undefined;
      try {
        const descriptor = kmsDescriptorSchema.parse(descriptorInput);
        if (!Buffer.isBuffer(plaintextInput) || plaintextInput.length > KMS_MAX_PLAINTEXT_BYTES)
          throw new KmsOperationError();
        plaintext = Buffer.from(plaintextInput);
        return await admit(async () => {
          const actor = await store.actor(tx, descriptor);
          const binding = await store.binding(tx, actor);
          const version = await writeKey(actor, descriptor, binding);
          classKey = version.plaintext;
          await verify(tx, actor, descriptor);
          return encryptRow(actor.tenantId, descriptor, version.dekId, classKey, plaintext!);
        });
      } catch {
        throw new KmsOperationError();
      } finally {
        plaintext?.fill(0);
        classKey?.fill(0);
      }
    },
    async decrypt(
      tx: DbTransaction,
      descriptorInput: ClassifiedResource,
      envelopeInput: ClassifiedEnvelope,
    ): Promise<Buffer> {
      let actor: KmsActor | undefined;
      let descriptor: ClassifiedResource | undefined;
      let binding: TenantKeyBinding | undefined;
      let classKey: Buffer | undefined;
      let plaintext: Buffer | undefined;
      let failureReason: KmsFailureReason = 'kms_service_error';
      try {
        descriptor = kmsDescriptorSchema.parse(descriptorInput);
        // Copy bounded caller-owned fields before yielding. Tenant AAD is
        // checked against the DB-derived tenant below, never a caller tenant.
        let captured: ClassifiedEnvelope | undefined;
        try {
          if (
            !envelopeInput ||
            !Buffer.isBuffer(envelopeInput.ciphertext) ||
            envelopeInput.ciphertext.length > KMS_MAX_PLAINTEXT_BYTES + 68 ||
            !Buffer.isBuffer(envelopeInput.aad) ||
            envelopeInput.aad.length > 1024 ||
            !Buffer.isBuffer(envelopeInput.iv) ||
            envelopeInput.iv.length !== 12 ||
            !Buffer.isBuffer(envelopeInput.tag) ||
            envelopeInput.tag.length !== 16 ||
            !(envelopeInput.encryptedAt instanceof Date)
          )
            throw new KmsOperationError();
          captured = {
            ciphertext: Buffer.from(envelopeInput.ciphertext),
            aad: Buffer.from(envelopeInput.aad),
            iv: Buffer.from(envelopeInput.iv),
            tag: Buffer.from(envelopeInput.tag),
            dekId: envelopeInput.dekId,
            alg: envelopeInput.alg,
            algVersion: envelopeInput.algVersion,
            encryptedAt: new Date(envelopeInput.encryptedAt),
          };
        } catch {
          failureReason = 'encryption_context_mismatch';
        }
        const stableDescriptor = descriptor;
        return await admit(async () => {
          actor = await store.actor(tx, stableDescriptor);
          binding = await store.binding(tx, actor);
          failureReason = 'encryption_context_mismatch';
          if (!captured) throw new KmsOperationError();
          const envelope = snapshotEnvelope(actor.tenantId, stableDescriptor, captured);
          failureReason = 'kms_service_error';
          const version = await store.lookup(actor, stableDescriptor, envelope.dekId);
          classKey = await provider.decrypt(
            binding,
            stableDescriptor.dataClass,
            version.encryptedDek,
          );
          failureReason = 'encryption_context_mismatch';
          plaintext = decryptRow(actor.tenantId, stableDescriptor, envelope, classKey);
          failureReason = 'access_denied';
          await verify(tx, actor, stableDescriptor);
          failureReason = 'kms_service_error';
          await store.audit(actor, stableDescriptor, binding, 'kms.decrypt_invoked', {
            dek_version_id: envelope.dekId,
            decrypted_byte_count: plaintext.length,
          });
          // Audit's independent transaction revalidates again before COMMIT.
          const released = plaintext;
          plaintext = undefined;
          return released;
        });
      } catch {
        plaintext?.fill(0);
        if (!actor && descriptor) {
          actor = (await store.auditActor(tx)) ?? undefined;
          failureReason = 'access_denied';
        }
        if (actor && descriptor) {
          // Audit failures remain fail-closed; no raw DB/AWS failure data and
          // no recursive retries that could amplify an outage.
          await store
            .audit(actor, descriptor, binding, 'kms.decrypt_failed', {
              failure_reason: failureReason,
              error_code: 'classified_decrypt_unavailable',
            })
            .catch(() => undefined);
        }
        throw new KmsOperationError();
      } finally {
        classKey?.fill(0);
        plaintext?.fill(0);
      }
    },
    /** Advance write version only. Immutable historical records keep their version. */
    async rotateWriteVersion(
      tx: DbTransaction,
      descriptorInput: ClassifiedResource,
    ): Promise<string> {
      let key: Buffer | undefined;
      try {
        const descriptor = kmsDescriptorSchema.parse(descriptorInput);
        return await admit(async () => {
          const actor = await store.actor(tx, descriptor);
          if (actor.role !== 'tenant_admin') throw new KmsOperationError();
          const binding = await store.binding(tx, actor);
          const generated = await provider.generate(binding, descriptor.dataClass);
          key = generated.plaintext;
          await verify(tx, actor, descriptor);
          return (
            await store.install(
              actor,
              descriptor,
              { dekId: ulid(), encryptedDek: generated.encrypted },
              true,
            )
          ).dekId;
        });
      } catch {
        throw new KmsOperationError();
      } finally {
        key?.fill(0);
      }
    },
  };
}

let engine: ReturnType<typeof createClassifiedKms> | undefined;
function defaultEngine() {
  engine ??= createClassifiedKms(
    defaultClassifiedKmsStore(),
    createClassifiedKeyProvider(
      awsClassifiedTransport(config.tenantKmsRequestTimeoutMs),
      config.tenantKmsRequestTimeoutMs,
      config.kmsMaxConcurrentOperations,
    ),
    config.kmsMaxConcurrentOperations,
  );
  return engine;
}
export const encryptClassified = async (
  tx: DbTransaction,
  resource: ClassifiedResource,
  plaintext: Buffer,
): Promise<ClassifiedEnvelope> => defaultEngine().encrypt(tx, resource, plaintext);
export const decryptClassified = async (
  tx: DbTransaction,
  resource: ClassifiedResource,
  envelope: ClassifiedEnvelope,
): Promise<Buffer> => defaultEngine().decrypt(tx, resource, envelope);
export const rotateClassifiedWriteVersion = async (
  tx: DbTransaction,
  resource: ClassifiedResource,
): Promise<string> => defaultEngine().rotateWriteVersion(tx, resource);
