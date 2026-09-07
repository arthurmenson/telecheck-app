# Governed clinician enrollment

Identity owns the first staff onboarding step required by Identity & Authentication Spec v1.0 §4.1 and migration083. This increment creates an actual pending clinician account through a narrow Identity-owned capability. It does not establish license verification, staff authentication, clinical eligibility, or permission to read a patient.

## Interface

An authenticated tenant operator with a separately provisioned `clinician_enroller` capability can POST `/v0/identity/staff/enrollments` with exactly `first_name`, `last_name`, `phone_e164`, and nullable `email`. Names are bounded, trimmed, valid Unicode without control characters. Phone is E.164; email is normalized lower case. The server chooses the account ID, clinician role, pending status, tenant and care country. The receipt contains only `account_id` and `status=pending_verification`. There is no invitation-delivery claim or generated password.

GET of the same path accepts only `offset` (0–10000), returns 25 enrolled accounts with bounded names, current account status and enrollment time, and uses `has_more` for paging. This is an authorized operator roster, not a public directory or verified clinician network. Contact information, patient demographics, credential documents and authentication secrets are excluded. Successful reads receive non-sampled Category B attribution and commit before the response is sent. Both routes send `Cache-Control: no-store`.

## Trust and persistence

The main application connection cannot assume `identity_service_role`, insert staff accounts or execute the enrollment functions. The existing dedicated Identity connection invokes private-owner SQL. Every operation derives a live operator from the request nonce, actual account, actual session and active tenant, and additionally requires the tenant-scoped membership. Membership provisioning and revocation remain restricted to a trusted operational principal; neither the app nor Identity service can grant themselves authority. Provisioning records include a responsible operator, evidence hash and bounded reference. Synthetic acceptance records are explicitly labeled fixtures, not production authorization evidence.

Enrollment inserts the pending account and immutable enrollment record together. A deferred constraint requires matching live actor/session/country, a new clinician row in this transaction, Category B audit and a typed correlated outbox event. Audit metadata contains identity IDs and status, not names, phone, email or a credential assertion. Capability revocation is serialized through a row share lock acquired before cache work; final liveness is checked after cache completion and evidence constraints. Replayed and conflicting requests recheck live authority after waits. Session or nonce expiry still prevents commit after an audit wait. Database failures produce bounded errors without database text or contact values.

Birth date, gender and residency are required for patient/delegate accounts as before, but are nullable for staff. Enrollment does not invent these demographics or infer residence from the tenant's care market. The Identity row mapper represents unrecorded staff values as null. Care jurisdiction and professional scope belong to subsequent credential and consultation records.

## Activation and next required work

Database triggers prevent a governed pending account from becoming active or receiving a session through existing patient authentication or direct Identity SQL. Phone-only login gives explicit staff-setup-required failure. This deliberately incomplete activation state must be replaced by a dedicated staff authentication capability with actual phone/password/OTP evidence, 15-minute access tokens, eight-hour refresh lifetime, one active session and five-minute inactivity enforcement per Identity Spec §4.2. Operator password/OTP authentication under §6 is also required for clinical launch.

The clinician-network module must subsequently persist and review real credential evidence, track expiry/revocation, and evaluate authorized service and jurisdiction against patient-confirmed care location. License approval and care-team Consent must gate claims, protected reads, clinical decisions and follow-up. Existing legacy clinical routes are not certified by this enrollment increment. No full-platform, clinical or production readiness is claimed here.

## Validation and reversal

Isolated ordinary-role US/Ghana HTTP acceptance covers authorized enrollment, exact replay, changed-body and duplicate-contact conflicts, injected authority, cross-role/tenant denial, metadata-only roster, missing audit/outbox rollback, private SQL grants, pending activation/session denial, membership revocation, and real blocked-read/write expiry. The patient/delegate demographic constraint remains in force. Migration098 preserves enrollment evidence; its reversal refuses before any mutation. Repair is a reviewed forward migration, not deletion or conversion of real staff identities.
