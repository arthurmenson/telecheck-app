# Protected care intake contract

This engineering amendment implements the patient intake portion of the general care journey. It follows `Care-journey-design-counsel.md` in the platform execution evidence. It does not approve clinical content, activate production providers, implement a clinician decision, or declare the full care journey complete.

## Patient API

`GET /v1/async-consults/:consult_id/care-progress` returns a live own-patient status projection for recovering an existing consultation after reload: consultation ID, payment intent ID and observed payment status, the accepted price's amount/currency/provider/mode, current lifecycle state, protected intake status (`not_started`, `in_progress`, `submitted`) and latest protected submission ID or null. It reveals no clinical answers, provider credentials or consent grants. Reading status remains available before payment and after care-consent withdrawal; this does not authorize further clinical work. It rejects delegates, staff callers, a different patient and query authority overrides, and rechecks live identity after database waits. A historical unverified intake is not relabeled as a protected submission. This endpoint covers cases already created; recovery of a payment reservation that predates case creation is subsequent Billing work.

`POST /v1/async-consults/:consult_id/intake/begin` accepts an empty body and a ULID `Idempotency-Key`. A live own-patient session, a Billing-verified paid intent bound to the case, and an available reviewed Forms deployment are required. It records the exact immutable definition before returning presentation fields. Repeated calls retain that version. Existing bindings may survive ordinary supersession; retirement prevents a new submission. The definition is bounded by the Forms public contract.

`POST /v1/async-consults/:consult_id/intake` accepts:

```json
{
  "definition": {
    "deployment_id": "<ULID>",
    "template_id": "<ULID>",
    "template_version": 1,
    "schema_hash": "<SHA-256>"
  },
  "answers": { "field_id": "patient-entered answer" }
}
```

These definition fields are claims about the rendered version, checked against the persisted binding. The server derives patient, country, payment, consent, submission ID and encryption identity. Unknown, hidden, invalid, overlong and incomplete answers fail according to that exact Forms schema. Patient/tenant/payment/consent authority fields and `intake_payload_envelope` are rejected, including mixed plaintext/envelope requests. The normal response is `201 {submission_id,status:"submitted"}`. All responses use `Cache-Control: no-store`. Delegated intake is not enabled by this amendment.

Crisis Response admission runs as route `preValidation`, after parser/authentication and before global idempotency handling, case-path checks and ordinary form validation. Every string value in an admitted JSON body is considered by the public admission operation, including fields that are invalid for the business schema. The parser limit is 1 MiB; this is an ingress bound, not the ordinary answer allowance. A detected event commits independently of the ordinary care transaction. A recorded interruption with available disclosure returns 202 with the actual event ID and pending escalation. Unrecorded or unconfirmed outcomes return 503 with the appropriate truthful status and available market resources. A known recorded event whose final disclosure check is unavailable also returns 503, with `recording_status=recorded`, `escalation_status=pending`, `disclosure_status=unavailable` and no event ID. Actual session invalidation returns an authorization denial. Resource retrieval follows recording, is independently bounded and cancels blocked queries. Ordinary intake never continues after an interruption. See SI-026 for metadata-only retention and detector limitations.

## Persistence and authorization

Migration095 adds private, FORCE-RLS `consult_care_binding` and `consult_care_submission` tables. The private NOLOGIN owner receives bounded public operations from Billing, Forms and Consent. It receives no direct access to payment secrets, consent records or key material. Billing owns the paid-case check and locks the actual payment intent. Its existing private owner receives narrowly scoped `UPDATE(id)` solely for PostgreSQL row-share locking; no application payment DML capability is introduced.

The immutable binding stores the reviewed safe presentation. The submission proof binds the actual intake row, case, patient, session, classified DEK version and exact consent admission. Required care/jurisdictional consent is checked before and after provider work and at transaction completion. Declining optional AI interpretation does not prevent ordinary care.

The application encrypts bounded clinical JSON with `pii_sensitive_clinical` and exact row AAD: `consult_intake_submission/<submission_id>/intake_payload`. The encrypted record includes the immutable definition reference and validated answers. It does not create a duplicate plaintext Forms submission. The former ciphertext-only SQL entry point is no longer executable by patient/delegate caller roles. A private wrapper invokes it only after paid-case, current consent and immutable form checks. SQL validates envelope metadata and keyring identity; authenticated encryption/decryption remains the server KMS operation.

Encryption completes before Consent/consult/audit advisory locks are acquired. The append operation serializes with Consent choices and case lifecycle, then rechecks the authority and definition. Same-transaction audit and domain outbox evidence are enforced by deferred constraints; a missing or mismatched record rolls back submission and lifecycle. New `async_consult.intake_definition_bound` is Category C with resource `consult_care_binding`; its corresponding domain event is `async_consult.intake_definition_bound.v1`. Existing intake-submitted audit remains Category C; its outbox carries metadata, consent publication/hash and the actual AI choice, never answers.

Care routes handle idempotency entirely inside the transaction that rechecks live authority. Both cached receipts and changed-body/in-flight conflicts reauthorize after cache waits. The cache contains only the safe receipt or reviewed presentation, plus the standard request digest; it does not store clinical answers or a ciphertext upload alternative. This amendment does not change global idempotency digest policy.

Rollback095 refuses before mutation with SQLSTATE0A000. Clinical data and the authorization boundary require a reviewed forward repair. Historical unverifiable ciphertext is not upgraded or relabeled by this migration.

## Reproducible verification

`npm run test:care-intake` runs focused contract, crypto, service and real Fastify lifecycle tests. `npm run verify:care-intake` runs the isolated acceptance bootstrap; it requires `NODE_ENV=test`, `CARE_SYNTHETIC_ACCEPTANCE=true` and a loopback `MIGRATION_DATABASE_URL` for an empty `telecheck_care_intake` database. The CI workflow runs PostgreSQL15 and16.

The bootstrap applies the complete canonical chain and verifies zero-change replay, provisions separate app/Identity/Billing/KMS/bind credentials, and runs real loopback HTTP in development. Test-only operator memberships/catalog configuration are provisioned explicitly. Patients register through Identity; form/policy/price/quote/payment/consult/binding/submission operations traverse their actual APIs. Payment and AWS transports are explicitly synthetic. Real delivery, production credentials and clinical review are not inferred from these tests.

Coverage includes US/Ghana positive submission with optional AI declined, wrong subject, legacy-envelope rejection, ordinary SQL caller denial, persisted crisis before invalid case/body/retry key, concurrent safety retry deduplication, omitted-evidence rollback, care withdrawal/session expiry during encryption, and expiry during begin/submission replay, changed-body and outbox waits. Rollback checks compare retained clinical/lifecycle/audit/outbox fingerprints before and after rejection. The full repository suite and independent complete-change review are additional release requirements.

## Continuing implementation

Manual review queuing, licensed clinician assignment/claim and protected intake reads, server-encrypted advice, patient result projection, follow-up, real AI execution and production provider/clinical activation remain separate work. The older v0 care mutations and remaining v1 envelope-based decision/follow-up/preparation surfaces must be retired or upgraded before the full integrated clinical journey is released. Existing readiness prose is not acceptance evidence for those capabilities.
