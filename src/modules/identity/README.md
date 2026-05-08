# `src/modules/identity/` — Identity & Auth module

Implementation of **Identity & Authentication Spec v1.0** (Canonical for development).

This module owns the platform's authentication primitives — phone-based registration, OTP-gated login, JWT access + refresh token issuance, session lifecycle, and trusted-device registration. Every other module's actor context is resolved by `src/lib/auth-context.ts` from the JWT this module issues; the `x-actor-id` header shim is a Tier 2 fallback gated by the `ALLOW_ACTOR_HEADER_AUTH` env flag.

## Status: implementation-complete at v1.0 (Sprint 33-34 close, 2026-05-08)

All 10 functional routes mounted under `/v0/identity` (plus `/health`) are implemented end-to-end with HTTP-level integration tests, service-layer direct integration tests, JWT end-to-end coverage, cross-tenant isolation tests, and (post-Sprint 33-34) IDEMPOTENCY v5.1 contract HTTP coverage on registration / login / device-register paths.

Sprint 33 PR-F3 migrated 8 handlers to the reserve-then-execute idempotency pattern + landed the 900s TTL override on auth-flow paths (aligned to JWT `access_token` TTL per `src/lib/jwt.ts`) + closed the `sessionRefresh` exempt-paths fix. Sprint 34 PRs #60-#62 added §4-§5 HTTP coverage of the IDEMPOTENCY v5.1 contract (replay returns same body; body-mismatch returns 409) on `/devices`, `/login/verify`, and `/registration/verify`.

## Module structure (per `src/modules/README.md` template)

```
identity/
├── index.ts              ← public interface (cross-module-safe exports)
├── plugin.ts             ← Fastify plugin entry point (registered in src/app.ts under /v0/identity)
├── routes.ts             ← Fastify route registration (10 routes + /health)
├── audit.ts              ← AUDIT_EVENTS v5.2 emitters (registration / login / session / device events)
├── events.ts             ← DOMAIN_EVENTS v5.2 emitters
└── internal/             ← module-private; no cross-module imports allowed
    ├── types.ts                    ← branded IDs (AccountId, SessionId, OtpChallengeId, AuthDeviceId)
    ├── handlers/
    │   ├── registration.ts         ← /registration/start, /registration/verify
    │   ├── login.ts                ← /login/start, /login/verify
    │   ├── accounts.ts             ← /accounts/me, /sessions/refresh, /sessions/logout
    │   └── devices.ts              ← /devices (POST + GET) + /devices/:deviceId (DELETE)
    ├── services/
    │   ├── account-service.ts      ← account creation + phone-uniqueness invariant
    │   ├── otp-service.ts          ← OTP challenge issuance + verification + lockout
    │   ├── session-service.ts      ← JWT pair issuance, refresh-token rotation, logout
    │   └── auth-device-service.ts  ← trusted-device registration + revocation
    └── repositories/
        ├── account-repo.ts         ← tenant-scoped DB access for `accounts`
        ├── otp-repo.ts             ← tenant-scoped DB access for `otp_challenges` + `otp_lockouts`
        ├── session-repo.ts         ← tenant-scoped DB access for `sessions`
        └── auth-device-repo.ts     ← tenant-scoped DB access for `auth_devices`
```

## Routes (under `/v0/identity`)

| Method | Path | Handler | Description |
|---|---|---|---|
| GET | `/health` | inline | liveness probe |
| POST | `/registration/start` | `registrationStartHandler` | issue an OTP challenge for a new account (idempotency-protected, 900s TTL) |
| POST | `/registration/verify` | `registrationVerifyHandler` | verify OTP + create account + issue JWT pair (idempotency-protected, 900s TTL) |
| POST | `/login/start` | `loginStartHandler` | issue an OTP challenge for an existing account (idempotency-protected, 900s TTL) |
| POST | `/login/verify` | `loginVerifyHandler` | verify OTP + issue JWT pair (idempotency-protected, 900s TTL) |
| POST | `/sessions/refresh` | `sessionRefreshHandler` | rotate refresh token + issue new access token (exempt from idempotency per Sprint 33 PR-F3 fix) |
| POST | `/sessions/logout` | `sessionLogoutHandler` | revoke active session |
| POST | `/devices` | `registerDeviceHandler` | register a trusted device (idempotency-protected) |
| GET | `/devices` | `listDevicesHandler` | list actor's trusted devices |
| DELETE | `/devices/:deviceId` | `revokeDeviceHandler` | revoke a trusted device |
| GET | `/accounts/me` | `getMyAccountHandler` | actor-scoped account read |

## Schema

Owned migrations:
- `migrations/012_accounts.sql` — `accounts` + `uq_account_tenant_phone` (phone unique within a tenant) + `UNIQUE (tenant_id, account_id)` for downstream composite-FK pattern
- `migrations/013_sessions.sql` — `sessions` (access + refresh token pair tracking)
- `migrations/014_otp.sql` — `otp_challenges` + `otp_lockouts`
- `migrations/015_auth_devices.sql` — `auth_devices`

Composite UNIQUE + composite FK pattern per PROJECT_CONVENTIONS r5 §1.1.

## Integration test coverage

Located in `tests/integration/`:

- `identity-registration-http.test.ts` — registration flow + §5 IDEMPOTENCY v5.1 contract regression (Sprint 34 PR #62)
- `identity-login-http.test.ts` — login flow + §5 IDEMPOTENCY v5.1 contract regression (Sprint 34 PR #61)
- `identity-devices-http.test.ts` — device flow + §4 IDEMPOTENCY v5.1 contract regression (Sprint 34 PR #60)
- `identity-accounts-me-http.test.ts` — accounts/me HTTP coverage
- `identity-jwt-end-to-end.test.ts` — JWT issuance + refresh + verification end-to-end
- `identity-cross-tenant-isolation.test.ts` — I-023 / I-024 / I-025 enforcement
- `identity-domain-events.test.ts` — DOMAIN_EVENTS v5.2 envelope shape
- `identity-{account,session,otp,auth-device}-{repo,service}.test.ts` — repo + service layer direct integration (8 files)
- `identity-plugin-wiring.test.ts` — plugin smoke test
- `{accounts,sessions,otp,auth-devices}-migration.test.ts` — schema migration regression (4 files)

## Spec references

- ADR-001 (modular monolith)
- ADR-022 (native-first / open-source-first / self-hosted-first)
- ADR-023 (multi-tenancy Model A)
- Identity & Authentication Spec v1.0
- Canonical Data Model v1.2 §3 entities #5 (Account) + #6 (Session) + #7 (OtpChallenge) + #8 (AuthDevice)
- State Machines v1.1 §1 (account lifecycle) + §5 (session lifecycle)
- Contracts Pack v5.2 INVARIANTS (I-003 audit append-only, I-023 / I-024 / I-025 / I-027 tenant isolation), AUDIT_EVENTS, DOMAIN_EVENTS, IDEMPOTENCY (v5.1)
- Tenant Threading Addendum v1.0 §3.X (identity slice)

## Sprint reference

- Sprints 9-12 — initial slice authoring (JWT migration was a multi-sprint cross-cut)
- Sprint 33 PR-F3 — reserve-then-execute idempotency migration (8 handlers; 5 Codex rounds) + 900s TTL override + sessionRefresh exempt-paths fix
- Sprint 34 PRs #60-#62 — IDEMPOTENCY v5.1 contract HTTP coverage on devices / login / registration
