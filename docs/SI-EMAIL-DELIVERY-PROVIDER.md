# Spec Issue — Transactional email delivery provider

**Status:** OPEN (§12 Spec Issue candidate) — implemented ahead of ratification per operator direction; must be ratified into a canonical notification/messaging contract.
**Raised:** 2026-07-09
**Operator direction:** Evans — "wire up the email delivery provider" (follow-on to the email+PIN auth path, [SI-EMAIL-PIN-AUTH](./SI-EMAIL-PIN-AUTH.md)).

## The divergence

The ratified corpus has **no notification/messaging delivery contract**. Country-driven config (CCR) references an "SMS provider" keyed by `country_of_care`, but neither the CDM, the Contracts Pack, nor any slice PRD defines an **email** delivery abstraction, provider selection, from-address governance, or delivery-failure semantics.

Until this work, both delivery paths were stubs: the phone OTP and the email+PIN passcode were generated, persisted, and then either echoed (staging `dev_passcode` / `dev_otp`, `AUTH_DEV_OTP_ECHO`-gated with a production fail-fast) or discarded. This SI adds a real **email** delivery seam and a first provider (Resend); the **SMS** path remains a stub (its own pending SI).

## What this adds

- **`src/lib/email/`** — a provider-agnostic `EmailSender` interface (`sendPasscode`), a passcode email template (subject + text + HTML), a `NoopEmailSender` (log-only default), and a `ResendEmailSender` (POST `https://api.resend.com/emails`, injected `fetch`).
- **Config** (`EMAIL_PROVIDER` / `RESEND_API_KEY` / `EMAIL_FROM`) with a fail-fast when `resend` is selected without a key.
- **Wiring:** `registration/email/start` and `recovery/pin/start` dispatch the freshly-issued passcode to the sender **after** the DB tx commits, **fire-and-forget**.

## Design constraints honored (do not regress)

- **Fire-and-forget, post-commit.** Delivery is not awaited on the request path: provider latency must not skew the uniform-work response timing that closes the Codex round-6 enumeration/timing oracle, and a provider outage must never fail signup/recovery. The passcode is issued + persisted regardless; delivery is best-effort. It fires only when a code was actually issued (never on an idempotent replay, where the tx body did not run) and only after commit (never for a rolled-back passcode).
- **Tenant-blind (I-025).** Delivery does not change any HTTP response; start endpoints stay uniformly 200. No endpoint reveals whether an email is registered.
- **No secret/credential logging.** The API key is passed in from config, never read from `process.env` in the sender and never logged. Senders log the recipient **domain** only (never the full address) and **never** the passcode. Non-2xx logs Resend's error `name` + HTTP status only, never the response body.
- **Brand = consumer DBA.** The email renders `tenant.consumer_dba` (e.g. "Heros Health"), never the operating-tenant id (Glossary v5.2 C3). No emoji (cross-market rule). Iris `#6E5BD6` is deliberately not used (reserved for AI-authored content).

## Default is inert — activation is an operator action

`EMAIL_PROVIDER` defaults to **`noop`**: merging this changes **no runtime behavior** (passcodes still issue + persist; staging still echoes `dev_passcode`). Turning on real delivery is a config flip that:

1. **Handles a secret** — a valid `RESEND_API_KEY`, stored ONLY in the deployment `.env` / vault, never in git.
2. **Shares PII with an external system** — recipient email + passcode leave the platform for Resend.

Both are operator decisions (per the global safety floor), so the code ships inert and the operator flips it deliberately.

## What ratification must decide

- A canonical notification/messaging contract: provider abstraction, per-`country_of_care` selection (CCR), from-address governance, retry/queue semantics, and delivery-status auditing.
- Whether delivery failures should emit an audit/domain event (currently: a structured error log only; no audit row, since fire-and-forget runs outside the request's audit tx).
- Email template ownership (copy, localization per `country_of_care`, branding source).
- Whether an already-registered address on `registration/email/start` should receive a distinct "you already have an account" email (the API response + timing stay identical either way).

## Code surface

- `src/lib/email/{types,passcode-template,noop-sender,resend-sender,index}.ts` + `email.test.ts`
- `src/lib/config.ts` — `EMAIL_PROVIDER` / `RESEND_API_KEY` / `EMAIL_FROM` + fail-fast refine
- `src/modules/identity/internal/handlers/email-pin-auth.ts` — `dispatchPasscodeEmail` wiring on both start handlers
- `.env.example`, `infra/staging/.env.example` — documented (values never committed)

## Relationship to other SIs

- Follows [SI-EMAIL-PIN-AUTH](./SI-EMAIL-PIN-AUTH.md) (the auth path this delivers for).
- The **SMS-provider SI** (referenced in `config.ts` for `AUTH_DEV_OTP_ECHO`) is the phone-OTP analogue and remains open; a ratified contract should cover both channels.
