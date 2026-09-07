# Patient discovery and recovery of accepted consultation payments

A provider intent can survive an interrupted request before the local consultation
exists. Patients can discover that accepted payment after reloading and resume its
existing provider identity, price and local case creation.

GET /v1/billing/consult-payments accepts only an integer offset from 0 through
10000. Its no-store response contains items, offset, limit (25), has_more and
has_unresolved_payment. Items are ordered by acceptance time and ID descending.
Each contains payment_intent_id, nullable consult_id, payment_status, accepted_at,
price (amount_minor, currency, provider, mode), and resume_available. No provider
reference, operation key, confirmation secret, ciphertext or patient identifier
is exposed. The unresolved flag examines all of this patient's accepted
consultation payments, including rows outside the current page: creating,
creation_unknown, requires_payment, or paid without a case.

POST /v1/async-consults/payments/:payment_id/resume accepts an empty object and
an Idempotency-Key. The authenticated patient must own the payment in the current
operating tenant and country. Recovery uses the original stored operation lock,
provider idempotency reference and immutable accepted price. A live creation lease
returns 409; expired/uncertain creation retries the same provider object. Failed,
cancelled or refund states cannot be resumed. Provider configuration changes
require resolution and never silently substitute another merchant or mode.

The successful 201 response is the existing initiation receipt: consult_id,
payment_intent_id and confirmation retrieval metadata. The same atomic case,
lifecycle, audit, outbox and authorized receipt cache boundary serves original
initiation and recovery. Concurrent/original/recovery retry keys converge on one
case per payment. No recovery path accepts a new quote or amount. Payment remains
unconfirmed until verified by Billing.

Migration096 adds only a private Billing-owned metadata projection callable by
the isolated Billing service. Its live actor checks bracket data reads; the
service also reauthorizes after waits and before transaction completion. Rollback
removes this projection without deleting financial or clinical history.

The patient interface uses unresolved reservations to guide recovery before
requesting another quote. This is not a global prohibition on distinct clinical
cases, a provider reconciliation worker, a refund executor or proof of live
provider activation. Synthetic runtime acceptance controls external transports,
while exercising real PostgreSQL roles, registration, quote acceptance, provider
reservation, case creation and failure recovery.
