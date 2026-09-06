# Tenant KMS envelope primitive

The internal AWS envelope primitive is implemented and covered by controlled-transport tests. The existing public `kms.encrypt` / `kms.decrypt` entry remains **fail-closed outside tests** until the mandatory classified caller context, tenant IAM/CMK binding and decrypt-audit integration is supplied. Credentials alone do not activate it, and there is no environment bypass flag. This package is a prerequisite for full KMS integration, not operational readiness.

## Encryption and format

`src/lib/kms-aws.ts` uses AWS SDK v3 with the normal credential chain. It generates a fresh AES-256 data key, encrypts application data locally with AES-256-GCM, and stores the wrapped data key with the ciphertext. The master key never leaves AWS KMS; returned plaintext data keys are erased after use. This follows the [GenerateDataKey envelope pattern](https://docs.aws.amazon.com/kms/latest/APIReference/API_GenerateDataKey.html).

The KMS encryption context contains only the operating tenant ID. Local authenticated data binds that same tenant plus the format, header and wrapped key. Decrypt always supplies the caller's trusted tenant key reference rather than selecting a key from the envelope, consistent with the [AWS Decrypt KeyId recommendation](https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html).

The internal version 1 binary format is `TCKMS001` (8 bytes), wrapped-key length (2 bytes, big endian), wrapped key, random IV (12 bytes), authentication tag (16 bytes) and ciphertext. Wrapped keys are limited to 6,144 bytes and application payloads to 16 MiB. Unknown versions, invalid lengths, malformed tenant/key references and tampering fail closed. This prerequisite format must be reconciled with the complete data-class key hierarchy before clinical activation; it does not change existing eight-field consult/crisis wire envelopes.

Caller-owned inputs are copied before asynchronous key operations. No plaintext is returned until GCM authentication succeeds. Owned plaintext copies, provisional decrypted bytes and SDK-returned data keys are erased, including malformed or late responses. JavaScript/OpenSSL internal copies cannot be guaranteed to support complete erasure. Errors contain a fixed safe message without a raw cause or AWS diagnostics.

`TENANT_KMS_REQUEST_TIMEOUT_MS` bounds the caller's wait (default 5,000 ms, maximum 30,000 ms); the SDK transport receives an abort signal, a two-second connection timeout and two-attempt retry limit. A late response after cancellation has its key erased. Cancellation does not assert instant termination of every credential-provider operation.

## Compatibility and remaining integration

The old local AES-GCM format remains accepted only under `NODE_ENV=test`. Local ciphertext is never automatically treated as AWS ciphertext or migrated to production. The new decoder uses the caller's configured key reference; automatic rotation of the same KMS key works, while retargeting an alias to a different key requires an audited historical-key/re-encryption strategy.

The canonical KMS Architecture v1.0 was promoted by P-027 despite its stale physical DRAFT header. Full compliance still requires explicit data-class classification, tenant-specific STS roles/session tags and CMK policy, required successful/failed decrypt audit, key lifecycle/rotation and operational DR verification. No default class is assigned to mixed intake data. The generic primitive also cannot infer synthetic-only tenancy; a local sandbox provider requires its own reviewed runtime/cohort restrictions.

## Validation

`npm run test:unit` includes real AES-GCM tests with a controlled KMS transport: binary/empty/large payloads, explicit key/context requests, cross-tenant and wrong-key denials, AAD defense, tampering, malformed and oversized envelopes, key cleanup, caller mutation, timeout and late responses. Direct KMS tests retain test-format compatibility and prove AWS credentials cannot bypass the public activation gate. No live AWS credentials, keys or requests are needed for these tests.
