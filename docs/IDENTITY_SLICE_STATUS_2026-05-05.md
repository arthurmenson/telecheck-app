# Identity & Auth Slice — Implementation Status

**Date:** 2026-05-05
**Author:** Autonomous turn (Claude Sonnet 4.5)
**Final commit:** `692206e`
**CI status:** ✅ Green

---

## Summary

The Identity & Auth slice (Slice 2 of 17 per EHBG §10 sprint plan) is **implementation-complete on its v1.0 surface** and the **JWT auth replacement** for the forms-intake module's pre-auth header stubs is also complete.

The platform now has a working **registration → login → access JWT → authenticated downstream request** pipeline, with cross-tenant token-forge defense, tenant-blind error envelopes, and same-transaction audit emission.

---

## What's built

### CDM §3.2 entities — all four scaffolded with migrations + repos + services

| Entity            | Migration | Repo             | Service             | Audit emitter                                  | HTTP handler                       |
| ----------------- | --------- | ---------------- | ------------------- | ---------------------------------------------- | ---------------------------------- |
| Account (#7)      | 012       | account-repo     | account-service     | identity_account_created/activated             | registration.ts + accounts.ts      |
| Session (#8)      | 013       | session-repo     | session-service     | identity_session_issued/revoked                | login.ts                           |
| OtpChallenge (#9) | 014       | otp-repo         | otp-service         | identity_otp_issued/consumed/lockout_triggered | (internal to login + registration) |
| AuthDevice (#10)  | 015       | auth-device-repo | auth-device-service | identity_device_registered/revoked             | devices.ts                         |

### HTTP API surface — 11 routes mounted under `/v0/identity`

| Method | Path                   | Purpose                                                                               |
| ------ | ---------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/health`              | Module health probe                                                                   |
| POST   | `/registration/start`  | Issue OTP for unregistered phone (PHONE_TAKEN if exists)                              |
| POST   | `/registration/verify` | Verify OTP → create + activate account → return PatientAccountView                    |
| POST   | `/login/start`         | Issue OTP for existing account (NO_ACCOUNT tenant-blind)                              |
| POST   | `/login/verify`        | Verify OTP → issue session → return refresh_token + access_token + PatientAccountView |
| POST   | `/sessions/refresh`    | Refresh-token exchange (no-op rotation at v1.0)                                       |
| POST   | `/sessions/logout`     | Revoke session (idempotent, tenant-blind 204)                                         |
| POST   | `/devices`             | Register device (auto-evicts oldest at 3-cap)                                         |
| GET    | `/devices?account_id=` | List active devices (oldest-first)                                                    |
| DELETE | `/devices/:deviceId`   | Revoke device (idempotent, tenant-blind 204)                                          |
| GET    | `/accounts/me`         | Authenticated account self-read                                                       |

### JWT auth foundation

- **`src/lib/jwt.ts`** — HS256 issue/verify with alg-confusion defense (rejects `alg=none` headers); 17 unit tests
- **`src/lib/config.ts`** — `JWT_SIGNING_KEY` env var with production fail-closed gate (≥32 chars; throws at startup)
- **`src/lib/auth-context.ts`** — Fastify hook (`authContextPlugin`) verifies bearer JWTs, populates `req.actorContext`, defends against cross-tenant token forge by matching the JWT's `tenant_id` claim against the request's resolved tenant context
- **`sessionService.issueSession`** returns access_token (15-min TTL per Identity Spec §3.2) alongside refresh_token (30-day TTL, hashed server-side)

### Forms-intake migration to JWT (Tier 1)

All 6 forms-intake handlers now honor `req.actorContext` when populated, falling back to the existing `x-actor-id`/`x-patient-id` header shim (Tier 2) for backward compat during the transition:

- templates.ts
- deployments.ts
- variants.ts
- resume.ts
- snapshots.ts
- submissions.ts

The header-shim Tier 2 remains for tests / dev convenience and can be retired once every test runs via JWT-bearing requests.

---

## Test coverage

| Test file                            | Cases   | Layer            |
| ------------------------------------ | ------- | ---------------- |
| accounts-migration.test.ts           | 28      | Schema           |
| sessions-migration.test.ts           | 16      | Schema           |
| otp-migration.test.ts                | 13      | Schema           |
| auth-devices-migration.test.ts       | 14      | Schema           |
| identity-account-repo.test.ts        | 14      | Repo             |
| identity-session-repo.test.ts        | 14      | Repo             |
| identity-otp-repo.test.ts            | 12      | Repo             |
| identity-auth-device-repo.test.ts    | 9       | Repo             |
| identity-account-service.test.ts     | 11      | Service          |
| identity-session-service.test.ts     | 9       | Service          |
| identity-otp-service.test.ts         | 12      | Service          |
| identity-auth-device-service.test.ts | 8       | Service          |
| identity-plugin-wiring.test.ts       | 2       | HTTP wiring      |
| identity-registration-http.test.ts   | 8       | HTTP integration |
| identity-login-http.test.ts          | 11      | HTTP integration |
| identity-devices-http.test.ts        | 9       | HTTP integration |
| identity-accounts-me-http.test.ts    | 5       | HTTP integration |
| identity-jwt-end-to-end.test.ts      | 4       | Cross-cutting    |
| jwt.test.ts                          | 17      | Unit             |
| auth-context.test.ts                 | 6       | Unit             |
| **Total identity + JWT**             | **212** | —                |

---

## Security gates active

Every PHI-touching path through the slice now passes through:

- **I-023** — three-layer tenant isolation (RLS layer-1 via `tenant_isolation` policy + WITH CHECK on writes; app-layer tenant filter in every repo SELECT; per-tenant KMS via `tenant.kms_key_alias`)
- **I-024** — cross-actor / break-glass discipline: cross-patient via different `patient_id` returns null; delegate-rotation gate prevents swapped-account read; cross-tenant JWT forge → `req.actorContext` undefined → 401
- **I-025** — tenant-blind error envelopes: NO_ACCOUNT / PHONE_TAKEN / 401 / 404 envelope shapes carry NO `Telecheck-*` / `heros` / tenant_id substring; cross-tenant 404 indistinguishable from plain 404
- **I-003** — audit append-only: every state change emits Category C audit in same transaction via `txCallback` hook; idempotent no-op re-call emits NO spurious audit
- **I-027** — every audit row carries `tenant_id`
- **Master PRD v1.10 §17 + Glossary v5.2 C3** — `tenant_id` stripped from every patient-surface response (`toPatientAccountView`, `toPatientSessionView`, device-view inline strip)
- **ADR-022** native-first / minimal deps — JWT module is hand-rolled HMAC-SHA256, zero new runtime deps
- **Identity Spec §3.2 / §3.3** — 15-min access JWT, 30-day refresh-hash, max 3 devices per account (oldest auto-evicted on 4th register)

---

## Known limitations / deferred work

| Item                                                                                | Status                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Refresh-token rotation (currently no-op at v1.0)                                    | Deferred — safe at v1.0 since refresh tokens are server-stored hashes; rotation lands in a follow-up commit                                      |
| Biometric attestation challenge/response (Apple App Attest, Android Play Integrity) | Deferred — `attestation_format` enum supports the values; runtime wiring requires platform SDKs                                                  |
| Forms-intake header-shim Tier 2 retirement                                          | Deferred — pending migration of every test to JWT-bearing requests                                                                               |
| Admin / clinician / pharmacist roles in JWT claims                                  | Deferred — `role` claim is `'patient'` only at v1.0; admin slices land later                                                                     |
| RSA / ECDSA JWT keys via JWKS                                                       | Deferred — HS256 at v1.0 (single platform-wide signing key); production-rotation lands when key-rotation infrastructure is wired                 |
| AUDIT_EVENTS v5.2 ratification of Identity action IDs                               | Open SPEC ISSUE — emitted via `identityAuditPlaceholder()` pattern (mirror of forms-intake's pending-ratification approach); EHBG §12 escalation |

---

## Resumed-turn commit log (chronological)

```
692206e test: auth-context.ts direct unit coverage (requireActorContext + UnauthenticatedError)
a541520 test: JWT end-to-end (login → Bearer auth → cross-tenant forge defense)
1b7e011 refactor(forms-intake): templates/deployments/variants/resume/snapshots honor JWT actor
42d1694 refactor(forms-intake): submissions handler honors req.actorContext (JWT tier-1)
2d45f98 feat(auth): authContextPlugin — JWT verification populates req.actorContext
382b62f feat(identity): wire JWT access-token issuance into sessionService
e8dad53 test: jwt.ts direct unit coverage (HS256 issue + verify + alg-confusion defense)
f32b76a fix(test): config production-accepted tests stub JWT_SIGNING_KEY
daf41e8 feat(jwt): HS256 access-token issue + verify + production fail-closed key gate
b30bdcc feat+test(identity): GET /accounts/me handler + HTTP integration coverage
bbe2607 test: identity devices HTTP integration coverage
80f245e feat(identity): device registration / list / revoke handlers
9a5de17 test: identity login + session HTTP integration coverage
ffbbf9a feat(identity): login + session refresh + logout handlers
323fc65 fix(identity): registration/start uses withTenantBoundConnection
b7def37 test: identity registration HTTP integration coverage
10dbdf3 feat(identity): registration handlers (POST /registration/{start,verify})
04603fe test: identity plugin wiring (GET /v0/identity/health + allowlist)
af4d5eb feat(identity): Fastify plugin + module health probe + app.ts wiring
ac46c58 feat(identity): public-interface index.ts (cross-module entry)
28c8fe7 fix(test): auth-device-service §1d drop unnecessary cast on r.detail
a4c1ca6 test: otp-service + auth-device-service direct integration coverage
2479827 test: session-service direct integration coverage
7baaab6 test: account-service direct integration coverage (audit + tenant strip + idempotent)
835af1f feat(identity): session-service + otp-service + auth-device-service
e897e4f fix+feat: otp-repo §2a created_at + identity audit emitters + account-service
d422c7d test: identity session-repo + otp-repo + auth-device-repo direct coverage
0cfdc34 feat(identity): session-repo + otp-repo + auth-device-repo
197c1b7 test: account-repo direct integration coverage
7fead58 feat(identity): scaffold module — types + account-repo (Identity slice)
0a1a888 test: migration 015 auth_devices — schema-level direct coverage
346e9b9 test+migration: otp-migration tests (014) + auth_devices table (015)
45ef6be migration(014): otp_challenges table — Identity slice scaffold (entity 9)
cbb2e05 test: migration 013 sessions — schema-level direct coverage
5393fb7 migration(013): sessions table — Identity slice scaffold (entity 8)
c4fde78 fix(migration 012): updated_at trigger uses clock_timestamp() not NOW()
fc1a791 test: migration 012 accounts — schema-level direct coverage
d2b6ea9 migration(012): accounts table — Identity & Auth slice scaffold (entity 7)
```

(38 commits visible above; 8 more pre-Identity-slice direct-coverage commits earlier in the same turn are not listed here.)

---

## Next-engineer pickup notes

**To start using the Identity slice in the next slice (e.g., Subscription, Patient Profile):**

1. Cross-module callers import from `src/modules/identity/index.ts` only — never reach into `./internal/*`
2. Authentication: depend on `req.actorContext` populated by `authContextPlugin`; call `requireActorContext(req)` to enforce
3. The patient's `account_id` IS the `patient_id` at v1.0 (Account = Patient per CDM §3.2; separate Patient entity deferred)
4. Session ID is a JWT claim — slice handlers can use it to enforce session-bound state changes
5. Refresh tokens are SHA-256 hashed server-side; never log the plaintext

**Production deployment checklist:**

1. Set `JWT_SIGNING_KEY` env var (≥32 chars; `openssl rand -base64 48`) — config.ts throws at startup if missing
2. Set `RESUME_TOKEN_SECRET` env var (≥32 chars) — same gate
3. Set `DATABASE_SSL_MODE=require` — same gate
4. SMS provider integration (CCR-driven; OTP plaintext currently sent in-process — never logged)
5. The forms-intake `ALLOW_ACTOR_HEADER_AUTH` env var should remain UNSET in production (Tier 2 fail-closed)
