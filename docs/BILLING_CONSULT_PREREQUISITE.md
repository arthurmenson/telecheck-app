# General consultation Billing prerequisite

This module implements server pricing, accepted quotes, durable provider-intent creation, private payment confirmation and verified-payment admission to intake. It is a prerequisite for the first advice-only consultation journey. Refund execution, cancellation coordination and operational provider activation remain separate required work; this document does not certify a production payment launch or a complete clinical journey.

## HTTP contract

All patient/operator operations use the resolved tenant host, a live Identity session and the SI-010 request nonce. Mutations require a new 26-character ULID `Idempotency-Key`; retries of the same operation reuse it. Delegates are not supported in this slice. Patient confirmation is always `Cache-Control: no-store` and never stored in the general idempotency response cache.

| Endpoint                                            | Caller                                           | Body or response                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/billing/consult-prices`                   | Current active tenant administrator              | `{ "consult_type":"general", "version":1, "amount_minor":4900, "turnaround_minutes":60, "quote_ttl_seconds":600 }`                                                                |
| `POST /v1/billing/consult-quotes`                   | Current patient                                  | `{ "consult_type":"general" }`; returns quote ID, immutable pricing version, integer minor amount, country currency, provider/mode, expiry, turnaround and recorded refund policy |
| `POST /v1/async-consults`                           | Current patient                                  | `{ "consult_type":"general", "initiation_source":"care_tab", "accepted_quote_id":"<quote ULID>" }`; returns consult ID, internal payment ID and a confirmation retrieval link     |
| `GET /v1/billing/payment-intents/:id/confirmation`  | Owning current patient                           | Discriminated `stripe`, `redirect`, `mock_local_dev`, or `complete` response                                                                                                      |
| `POST /v1/billing/payment-intents/:id/mock-confirm` | Owning current patient, explicit local mock only | Empty object; signs a synthetic provider observation and processes the real deduplication/payment transition path                                                                 |
| `POST /v1/billing/webhooks/:provider`               | Verified provider signature                      | Original JSON bytes, maximum 64 KiB; no user session or idempotency header required                                                                                               |

No patient-provided amount, currency, provider, provider payment ID, patient ID or turnaround timestamp is accepted by consultation initiation. Unknown fields fail validation. Program consultation selection remains unavailable until Program entity and country validation are integrated. Accepted initiation sources are `program_enrollment`, `care_tab`, `mode_1_handoff`, `medication_detail` and `rpm_ccm_dashboard`; they do not grant Program eligibility.

An administrator publishes consecutive immutable versions. Repeating the current version with exactly the same policy is idempotent; changing that version conflicts. Currency comes from TenantConfig's country profile and the provider comes from its `payment.processor` CCR resolution. Quotes last 60–900 seconds, belong to one patient and can fund only one intent. A changed current version or expired quote requires fresh patient acceptance. A previously accepted durable operation resumes its original frozen price.

The quote records `full_before_review_or_decline_v1` as the intended refund policy. This slice does not execute that policy. Do not expose cancellation or clinician decline as completed payment workflows until durable refund coordination and real refund confirmation are implemented.

## Persistence and authority

Migrations 088–089 create immutable price/quote/provider-event records, mutable provider-intent evidence and a reserved refund-intent table. Every table forces tenant RLS. The ordinary application and nonce binder cannot read or write Billing tables, assume the Billing role, or invoke the verified-payment consumer.

Provision a distinct login/password for `billing_service_role` and put only that connection in `BILLING_DATABASE_URL`. Keep the role non-superuser, without BYPASSRLS, role/database creation, replication, inheritance or role memberships. `billing_context_owner` and `billing_consult_owner` remain NOLOGIN function owners. Never grant their roles to the ordinary application. Every acquired Billing connection validates these attributes, starts explicit READ COMMITTED, binds tenant/nonce and rechecks the live session/account/nonce before protected results commit. Production connections verify the PostgreSQL TLS certificate.

A Billing reservation commits before provider I/O. Its opaque provider reference is stable, its accepted quote is immutable and its creation lease is fenced. Network, provider-response or local persistence ambiguity becomes `creation_unknown`; retry the original operation key/body, never manufacture a new reference to report success. Stripe retries use the same provider idempotency key for at most 23 hours after acceptance and retrieve a recorded object when available. Old unknown objects require reconciliation. Paystack unknown creation only verifies the permanent reference; a lost checkout URL requires reconciliation if payment is still pending.

Only authenticated provider success bound to the internal payment, expected provider account, mode, amount, currency, reference and purpose marks the intent paid. Provider event IDs and payload hashes deduplicate callbacks; conflicting payloads do not overwrite prior evidence. Payment audit, outbox event and applicable `initiated → intake` transition commit together. A successful payment before consultation creation is reconciled when its owner retrieves confirmation. Duplicate or late callbacks never reopen a terminal consultation. Failed Stripe attempts retain their reusable intent; an explicit provider cancellation is terminal. A delayed failure cannot regress `cancelled` to `requires_payment`, regardless of delivery order; the database also rejects that regression. Contradictory payment evidence after cancellation remains recorded for reconciliation and cannot automatically reopen it.

The old caller-authoritative initiation wrapper is revoked from application slice roles. New consult creation uses `record_billed_consult_initiation` and derives money/patient/provider from Billing evidence. It rechecks patient authority after its locks and writes; the HTTP transaction rechecks after local audit, outbox and cache work, including blocked cached replays. A database transition trigger also rejects the old migration-059 unpaid-intake path. New consultation payment bindings are enforced by a composite foreign key. Historical opaque payment IDs are retained under a NOT VALID constraint; they are not silently relabeled as paid. Inventory and reconcile historical rows before validating that constraint. The unique intent-per-consult index deliberately refuses conflicting legacy duplicates.

These are forward-only financial migrations. Do not drop payment, event or audit evidence to roll back an application release. Use a reviewed forward correction if a later schema change is necessary.

## Provider configuration

`BILLING_PROVIDERS_JSON` maps each tenant to a public configuration record. Secret fields contain environment-variable names, never secret values:

```json
{
  "Telecheck-US": {
    "provider": "stripe",
    "mode": "sandbox",
    "account": "acct_REPLACE_WITH_VERIFIED_ACCOUNT",
    "secret_env": "BILLING_US_STRIPE_SECRET",
    "webhook_secret_env": "BILLING_US_STRIPE_WEBHOOK_SECRET",
    "publishable_key": "pk_test_REPLACE_WITH_PUBLISHABLE_KEY",
    "return_url": "https://your-patient-host.example/care"
  },
  "Telecheck-Ghana": {
    "provider": "paystack",
    "mode": "sandbox",
    "account": "paystack_REPLACE_WITH_CREDENTIAL_SHA256",
    "secret_env": "BILLING_GH_PAYSTACK_SECRET",
    "webhook_secret_env": "BILLING_GH_PAYSTACK_SECRET",
    "return_url": "https://your-ghana-patient-host.example/care"
  }
}
```

Examples are placeholders. Bind each registry entry to the correct CCR provider and immutable price account/mode. Stripe uses the configured connected account in `Stripe-Account` and requires that account in verified webhook events. Configure a matching connected-account endpoint; a platform-only event without that account fails closed. Sandbox/live secret prefixes and event modes must agree. Provider calls have an eight-second deadline, fixed HTTPS origins, no redirect following and bounded response bodies.

The documented Paystack verify/webhook transaction schema does not supply a numeric integration ID. Paystack authority instead uses the exact API credential for authenticated verification and the same secret for the original-body HMAC. Its immutable `account` value is `paystack_` followed by lowercase SHA-256 of the UTF-8 concatenation `telecheck-paystack-credential-v1`, a NUL byte, and the secret. The configured account must match this fingerprint on every operation. This is a credential binding, not evidence of merchant approval or a numeric merchant identity. The initialize metadata is sent as a JSON-encoded string and the returned reference, amount, currency, mode and internal payment metadata are checked. See the official [transaction API](https://paystack.com/docs/api/transaction/) and [webhook authentication](https://paystack.com/docs/payments/webhooks/) contracts.

Credential rotation changes the Paystack account binding. Never replace the secret in place while pending transactions use its old fingerprint: first inventory pending and paid transactions and deploy a reviewed migration/reconfiguration that preserves verification and reconciliation under the appropriate old authority. This slice does not implement multi-version provider credentials or certify external merchant onboarding.

Stripe client secrets and Paystack checkout URLs are financial confirmation capabilities. Billing encrypts them through the public classified KMS API as `pii_financial`, bound to the tenant, owning patient, `billing_payment_intent`, payment ID and `payment_confirmation` field. Provision an approved immutable tenant KMS binding and the separate `kms_service_role` login in `KMS_DATABASE_URL`; Billing cannot assume this role. The envelope retains its DEK, IV, tag, version, exact AAD and encrypted timestamp. There is no global Billing key or local cryptographic fallback. Public KMS keyring rotation/retention rules apply.

Encryption uses the initiating patient's actual bound session before the durable provider-result transaction commits. It does not invent worker or human context; authority or KMS failure leaves the existing intent `creation_unknown` for truthful retry. Confirmation retrieval uses the owning current patient, awaits classified decryption and the independently committed `kms.decrypt_invoked` audit, then rechecks payment state and live authority. KMS, binding, audit or authority failure returns no secret. Never place provider credentials, plaintext confirmations or raw callbacks in audit details, logs or general caches. The local mock reconstructs its explicitly synthetic nonsecret response and stores no encrypted confirmation.

The local mock requires **both** `NODE_ENV=development` or `test` and `BILLING_ALLOW_MOCK=true`, registry provider/mode `mock_local_dev`, an explicit account/secret and matching CCR. It still persists real local workflow state and processes a signed, deduplicated synthetic event. Its response says “Synthetic payment — no money is charged.” Production rejects this adapter even when the mock flag is set. A provider error never falls back to mock.

Provider implementation references: [Stripe PaymentIntent creation](https://docs.stripe.com/api/payment_intents/create), [Stripe raw-body signature verification](https://docs.stripe.com/webhooks/signature), [Paystack initialize/verify transaction API](https://paystack.com/docs/api/transaction/) and [Paystack webhook verification](https://paystack.com/docs/payments/webhooks/). Actual sandbox account credentials and externally delivered provider events have not been exercised by the local acceptance checks.

## Reproducible acceptance and remaining work

Migrations 088 and 089 have explicit rollback companions that stop with SQLSTATE `0A000` before changing anything. They intentionally require a reviewed forward correction: dropping Billing evidence cannot reverse an external provider transaction, and restoring the previous consult wrapper would reopen unpaid intake. During release recovery, disable new payment initiation at the deployment boundary, preserve callbacks/reconciliation and financial records, and use a compatible application release or forward migration. These companions are a refusal of unsafe database downgrade, not a successful reverse migration. The isolated CI bootstrap executes both refusals on empty and populated schemas and verifies that financial rows, audit/outbox records, functions, constraints, roles and admission triggers remain unchanged.

`npx vitest run -c vitest.billing.config.ts` runs DB-free handler/provider adversarial tests. The full suite retains downstream consult regression coverage using an explicitly synthetic paid fixture; it does not count as payment acceptance.

On a fresh, disposable local PostgreSQL database named `telecheck_billing`, set `NODE_ENV=test`, `BILLING_SYNTHETIC_ACCEPTANCE=true` and `MIGRATION_DATABASE_URL` to a local migration administrator, then run `node --import tsx scripts/verify-billing-ci.mjs`. The bootstrap refuses a nonempty consult database, applies the complete canonical migration chain and a zero-change replay, generates ephemeral role credentials and executes real registration/Billing HTTP under distinct logins. The CI matrix repeats this on PostgreSQL 15 and 16. It provisions synthetic operators and configuration; happy-path prices, quotes, intents, consultations and paid transitions are API-created. Targeted expired-quote/terminal-state preconditions and temporary failure triggers are explicitly identified in the runner.

Acceptance covers US/GH currency and ownership, price/quote acceptance, durable replay, SQL unpaid-intake rejection, signed payment deduplication, wrong money/account/raw-body rejection, private confirmation, atomic local outbox rollback/resume, terminal-state preservation and revoked-session replay. Controlled Stripe and Paystack HTTP boundaries exercise accepted-but-response-lost, local provider-result persistence failure, absent KMS binding, unavailable KMS, documented Paystack shapes without `integration`, changed credentials, raw signatures and duplicate callbacks. Both cancellation/failure orders and duplicate delivery are checked.

Financial acceptance uses the production public classified KMS API, real PostgreSQL keyring/audit persistence and a distinct KMS login. Only AWS STS/KMS transport is controlled in `scripts/billing-controlled-aws.ts`, explicitly gated by synthetic acceptance and development mode; no production module imports it. It tests successful financial decrypt audits, tenant/class/patient/payment/field tamper rejection before AWS calls, KMS failure, durable-audit failure and authority expiry/revocation during crypto and blocked audit. This verifies application boundaries, not actual AWS policy enforcement or provider activation. No `NODE_ENV` value activates a production mock transport.

Required follow-on work: durable refunds and cancellation with actual provider confirmation; clinical-decline refund linkage; human-visible reconciliation/recovery of old unknown intents; safe historical-provider/key rotation; financial callback handling during tenant suspension; historical payment reconciliation; production monitoring and separately verified Stripe/Paystack sandbox/live activation. The initial patient journey remains advice-only while these workflows are completed.
