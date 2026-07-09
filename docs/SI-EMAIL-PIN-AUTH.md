# Spec Issue — Email + 6-digit-PIN authentication path

**Status:** OPEN (§12 Spec Issue candidate) — implemented ahead of ratification per operator direction; must be ratified into the Identity spec + CDM.
**Raised:** 2026-07-09
**Operator direction:** Evans — "build the signup to allow setting a 6-digit PIN with email address to login; for resets or recoveries use a passcode into email." Chosen as an **addition** alongside the phone + SMS-OTP path (not a replacement).

## The divergence

The ratified **Identity & Authentication Spec v1.0** (§2 registration, §3 login) specifies **phone number + 6-digit SMS OTP** as the auth mechanism, and CDM v1.2 §3.2 models `Account` (phone as primary identifier) + `OTP`. There is **no** email+PIN mechanism, no persistent-credential entity, and no email-passcode entity in the ratified corpus.

This work adds an **alternative** auth path:

- **Signup:** email + set a 6-digit PIN (email verified via a one-time emailed passcode).
- **Login:** email + 6-digit PIN.
- **Reset/recovery:** one-time passcode delivered to email → set a new PIN.

The phone+OTP path is **untouched** and remains fully functional. Email+PIN and phone+OTP coexist.

## Schema changes (migration 078)

1. `accounts.phone_e164` → **NULLABLE** (email-only accounts have no phone). Additive — the phone+OTP flow always supplies a phone. Adds `account_has_identifier` CHECK (phone OR email required) + a per-tenant unique email index.
2. **`account_pin_credentials`** (NEW entity) — the persistent 6-digit PIN as a **scrypt** hash + per-credential salt, with failed-attempt lockout.
3. **`email_passcodes`** (NEW entity) — the email analogue of `otp_challenges` (SHA-256 hashed one-time codes; email_registration + pin_recovery purposes).

## Security posture

- **PIN** hashed with `node:crypto` **scrypt** + 16-byte salt (NOT SHA-256 — a persistent 6-digit PIN has a 1e6 space and needs a slow KDF against DB leak). PIN login is rate-limited with lockout.
- **Email passcodes** mirror the `otp_challenges` disciplines: SHA-256 at rest, 5-min TTL, 3 attempts, cooldown lockout, one-time consume, tenant-blind envelopes (I-025).
- All tables tenant-scoped with RLS ENABLE+FORCE (I-023/I-027).

## What ratification must decide

- Canonical entity names/shapes for `AccountPinCredential` + `EmailPasscode` in CDM.
- Whether `accounts.phone_e164` nullability + the email-identifier model is accepted platform-wide.
- PIN policy (length, lockout thresholds, rotation) as a ratified spec, not code-local constants.
- Email delivery provider (staging uses the same echo posture as the SMS OTP stub).

## Code surface

- `migrations/078_email_pin_auth.sql` (+ rollback)
- `src/modules/identity/internal/services/pin-service.ts`, `email-passcode-service.ts`
- `src/modules/identity/internal/repositories/pin-credentials-repo.ts`, `email-passcode-repo.ts`
- `src/modules/identity/internal/handlers/email-pin-auth.ts`
- Routes added to `src/modules/identity/routes.ts` under `/v0/identity`.
