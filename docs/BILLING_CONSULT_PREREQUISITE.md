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

Only authenticated provider success bound to the internal payment, expected provider account, mode, amount, currency, reference and purpose marks the intent paid. Provider event IDs and payload hashes deduplicate callbacks; conflicting payloads do not overwrite prior evidence. Payment audit, outbox event and applicable `initiated → intake` transition commit together. A successful payment before consultation creation is reconciled when its owner retrieves confirmation. Duplicate or late callbacks never reopen a terminal consultation. Failed Stripe attempts retain their reusable intent; an explicit provider cancellation is terminal.

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
    "account": "123456",
    "secret_env": "BILLING_GH_PAYSTACK_SECRET",
    "webhook_secret_env": "BILLING_GH_PAYSTACK_SECRET",
    "return_url": "https://your-ghana-patient-host.example/care"
  }
}
```

Examples are placeholders. Bind each registry entry to the correct CCR provider and immutable price account/mode. Stripe uses the configured connected account in `Stripe-Account` and requires that account in verified webhook events. Configure a matching connected-account endpoint; a platform-only event without that account fails closed. Paystack uses its numeric integration ID; API key and webhook HMAC secret must be the same provider secret. Sandbox/live secret prefixes and event modes must agree. Provider calls have an eight-second deadline, fixed HTTPS origins, no redirect following and bounded response bodies.

Stripe confirmation exposes its client secret only to the owning live patient. Paystack confirmation exposes only its validated hosted checkout URL. Store `BILLING_CONFIRMATION_KEY` as a protected 32-byte random key encoded in 64 hexadecimal characters. AES-256-GCM encrypts confirmations with tenant/payment additional authenticated data. Never place this key, provider secrets, raw callbacks or client secrets in logs, audit details, generic caches or the frontend bundle. This initial envelope supports one key version: retain the key for pending confirmations; deploy an explicit re-encryption/keyring migration before rotating it.

The local mock requires **both** `NODE_ENV=development` or `test` and `BILLING_ALLOW_MOCK=true`, registry provider/mode `mock_local_dev`, an explicit account/secret and matching CCR. It still persists real local workflow state and processes a signed, deduplicated synthetic event. Its response says “Synthetic payment — no money is charged.” Production rejects this adapter even when the mock flag is set. A provider error never falls back to mock.

Provider implementation references: [Stripe PaymentIntent creation](https://docs.stripe.com/api/payment_intents/create), [Stripe raw-body signature verification](https://docs.stripe.com/webhooks/signature), [Paystack initialize/verify transaction API](https://paystack.com/docs/api/transaction/) and [Paystack webhook verification](https://paystack.com/docs/payments/webhooks/). Actual sandbox account credentials and externally delivered provider events have not been exercised by the local acceptance checks.

## Reproducible acceptance and remaining work

`npx vitest run -c vitest.billing.config.ts` runs DB-free handler/provider adversarial tests. The full suite retains downstream consult regression coverage using an explicitly synthetic paid fixture; it does not count as payment acceptance.

On a fresh, disposable local PostgreSQL database named `telecheck_billing`, set `NODE_ENV=test`, `BILLING_SYNTHETIC_ACCEPTANCE=true` and `MIGRATION_DATABASE_URL` to a local migration administrator, then run `node --import tsx scripts/verify-billing-ci.mjs`. The bootstrap refuses a nonempty consult database, applies the complete canonical migration chain and a zero-change replay, generates ephemeral role credentials and executes real registration/Billing HTTP under distinct logins. The CI matrix repeats this on PostgreSQL 15 and 16. It provisions synthetic operators and configuration; happy-path prices, quotes, intents, consultations and paid transitions are API-created. Targeted expired-quote/terminal-state preconditions and temporary failure triggers are explicitly identified in the runner.

Acceptance covers US/GH currency and ownership, price/quote acceptance, durable replay, SQL unpaid-intake rejection, signed payment deduplication, wrong money/account/raw-body rejection, private confirmation, atomic local outbox rollback/resume, terminal-state preservation and revoked-session replay. A controlled Stripe HTTP boundary exercises accepted-but-response-lost, local provider-result persistence failure, revocation during provider work and confirmation reads blocked across revocation. These controlled responses are not live-provider tests.

Required follow-on work: durable refunds and cancellation with actual provider confirmation; clinical-decline refund linkage; human-visible reconciliation/recovery of old unknown intents; safe historical-provider/key rotation; financial callback handling during tenant suspension; historical payment reconciliation; production monitoring and separately verified Stripe/Paystack sandbox/live activation. The initial patient journey remains advice-only while these workflows are completed.
