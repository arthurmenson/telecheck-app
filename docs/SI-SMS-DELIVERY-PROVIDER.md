# Spec Issue — Transactional SMS delivery provider

**Status:** OPEN (§12 Spec Issue candidate) — implemented ahead of ratification per operator direction; must be ratified into a canonical notification/messaging contract.
**Raised:** 2026-07-12
**Operator direction:** Evans — "wire up the sms provider with telnyx" (the phone-OTP analogue of [SI-EMAIL-DELIVERY-PROVIDER](./SI-EMAIL-DELIVERY-PROVIDER.md); referenced throughout config.ts as the "SMS-provider SI").

## The divergence

The ratified corpus references an "SMS provider" as a country-driven (CCR) concern but defines no delivery contract — no provider abstraction, sender governance, or delivery-failure semantics. Until this work the phone OTP was generated + persisted then either echoed (staging `dev_otp`, `AUTH_DEV_OTP_ECHO`-gated) or **discarded**, so phone login/registration was unreachable without the echo. This SI adds a real SMS delivery seam and a first provider (Telnyx). It is the direct analogue of the email-delivery SI and should be ratified together with it under one notification contract.

## What this adds

- **`src/lib/sms/`** — a provider-agnostic `SmsSender` (`sendPasscode`), a passcode SMS template, a `NoopSmsSender` (log-only default), and a `TelnyxSmsSender` (POST `https://api.telnyx.com/v2/messages`, injected `fetch`).
- **Config** — `SMS_PROVIDER` (noop|telnyx, default **noop**), `TELNYX_API_KEY`, and a sender (`SMS_FROM` E.164 number **or** `TELNYX_MESSAGING_PROFILE_ID`), with a fail-fast when `telnyx` is selected without a key or sender.
- **Wiring** — `login/start` and `registration/start` dispatch the issued OTP to the sender **after** the tx commits, **fire-and-forget**.

## Design constraints honored (identical to the email sender)

- **Fire-and-forget, post-commit, not awaited.** Provider latency never skews response timing; a provider outage never fails login/registration. Fires only when a code was issued (never on idempotent replay) and only after commit.
- **No secret/credential logging.** The API key is passed from config, never read from `process.env` in the sender and never logged. Senders log the recipient's **last 4 digits** only (never the full E.164 number) and **never** the OTP. Non-2xx logs the Telnyx error `code` (clamped to a safe token) + HTTP status; transport errors log a closed-set label (`timeout`|`transport_error`). This carries the full secret-leak hardening the Resend sender converged on over Codex PR#274 (r1 sanitized rethrow + abort-bounded body parse, r2 closed-set labels).
- **Brand = consumer DBA.** No emoji. Kept ≤160 chars for single-segment delivery where possible.

## Default is inert — activation is an operator action

`SMS_PROVIDER` defaults to **`noop`**: merging changes no runtime behavior (OTP still issues + persists; staging echo unaffected). Turning on real delivery is a config flip that handles a secret (`TELNYX_API_KEY`) and shares PII (recipient phone + OTP) with an external system — both operator decisions.

## What ratification must decide

- The shared notification/messaging contract (with email): provider abstraction, per-`country_of_care` selection (CCR — a Ghana number/route differs from US), sender governance, delivery-status auditing, retry/queue semantics.
- 10DLC / toll-free / short-code registration and per-country compliance (US A2P 10DLC brand+campaign registration is required before high-volume delivery).
- Whether delivery failures should emit an audit/domain event (currently: a structured error log only).

## Code surface

- `src/lib/sms/{types,passcode-template,noop-sender,telnyx-sender,index}.ts` + `sms.test.ts`
- `src/lib/config.ts` — `SMS_PROVIDER` / `TELNYX_API_KEY` / `SMS_FROM` / `TELNYX_MESSAGING_PROFILE_ID` + fail-fast
- `src/modules/identity/internal/handlers/login.ts` — `dispatchPasscodeSms` helper + `login/start` wiring
- `src/modules/identity/internal/handlers/registration.ts` — `registration/start` wiring (now captures + delivers the OTP; previously discarded)
- `.env.example`, `infra/staging/.env.example` — documented (values never committed)

## Relationship to other SIs

- Direct analogue of [SI-EMAIL-DELIVERY-PROVIDER](./SI-EMAIL-DELIVERY-PROVIDER.md); ratify together.
- Unblocks dropping the `AUTH_DEV_OTP_ECHO` staging affordance for the phone path (Addendum 354 noted phone-OTP staging login was blocked on this SI).
