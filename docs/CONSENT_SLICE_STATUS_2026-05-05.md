# Consent & Delegated Access Slice — Implementation Status

**Date:** 2026-05-05 (Sprint 33-34 amendment 2026-05-08)
**Final commit:** `e3bc5fb` (8-case domain-events outbox-landing test; 4-case baseline at `f3c759f`; service wiring at `fcfbc3a`; delegation-service direct integration tests at `f4dee93`; consent-service tests at `972a3aa`; HTTP tests at `3f93e6e` / `59292ab`; service+handler scaffold complete at `b7223df`)
**Sprint 33-34 amendment final commit:** `dc06541` (PR #48 cleanup-sweep removed `markIdempotencyManagedByHandler` calls from consent + delegation handlers as part of the SI-006 reserve-then-execute closure)
**CI status:** ✅ Green

---

## Sprint 33-34 amendment (2026-05-08)

The Consent & Delegated Access slice already migrated to handler-owned `withIdempotency` in **Sprint 32 PR-C** (pre-Sprint-33; established the pattern that PR-F2/F3/F4 then mirrored). Sprint 33-34 impact on this slice is therefore **light — purely cleanup**:

### Cleanup-sweep impact (PR #48)

`markIdempotencyManagedByHandler(req)` calls were deleted from:
- `consents.ts` (2 calls — `grantConsentHandler`, `revokeConsentHandler`)
- `delegations.ts` (6 calls — `inviteDelegate` / `accept` / `decline` / `revoke` / `grantScope` / `revokeScope`)

Functionally a no-op since PR #47 (PR-E) had already removed the legacy onSend hook the flag controlled. The lockdown extension in `tests/integration/idempotency-helper.test.ts` Group F now pins `markIdempotencyManagedByHandler` identifier absence in comment-stripped `idempotency.ts`, so reintroducing the helper anywhere would fail the lockdown.

### What did NOT change in this slice

- Handler shape: `withIdempotentExecution<unknown>(req, reply, mapServiceError, async (tx) => {...})` — same as PR-C established
- Service-layer signatures: still take optional `externalTx?: DbTransaction`
- Audit emission: `consent.granted` / `consent.revoked` / `delegation.*` emissions are Category C (operational), NOT Category A — so the audit-dedupe SI (PR #49) does NOT apply. Category C audits inherit the handler's transaction by design (acceptable rollback semantics for non-safety-critical events).
- 13 routes mounted under `/v0/consent` — no change

### Spec references for the amendment

- `docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.3 (Implementation Closure section — the consent slice was the second migration target after async-consult; PR-C is cited as one of the original mirrors of PR-B)
- `docs/PROJECT_CONVENTIONS.md` r5 §3.7 (Reserve-then-execute is the only path)
- `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 §2 Consent + Delegation slice row (test-files inventory unchanged from r4)

---

## Summary

The Consent & Delegated Access slice (Slice 3 of 17 per EHBG §10b sprint plan) is **implementation-complete on its v1.0 surface**. The full **grant → revoke** consent lifecycle and **invite → accept → manage scopes → revoke** delegation lifecycle are working end-to-end with same-transaction audit, append-only consent history per Slice PRD §7.1, and the chain-prevention + sensitive-category guards from §6.1 / §6.4.

---

## What's built

### CDM §3.3 entities — all four scaffolded

| Entity                | Migration | Repo                           | Service                                     | HTTP handler   |
| --------------------- | --------- | ------------------------------ | ------------------------------------------- | -------------- |
| Consent (#11)         | 016       | consent-repo                   | consent-service                             | consents.ts    |
| ConsentVersion (#12)  | 016       | consent-repo (versioned terms) | (internal)                                  | (internal)     |
| Delegation (#13)      | 017       | delegation-repo                | delegation-service                          | delegations.ts |
| DelegationScope (#14) | 017       | delegation-repo                | delegation-service (grantScope/revokeScope) | delegations.ts |

### HTTP API surface — 12 routes mounted under `/v0/consent`

| Method | Path                                      | Auth | Purpose                                       |
| ------ | ----------------------------------------- | ---- | --------------------------------------------- | -------------------- |
| GET    | `/health`                                 | none | Module health probe                           |
| POST   | `/consents`                               | JWT  | Grant consent (returns PatientConsentView)    |
| POST   | `/consents/revoke`                        | JWT  | Revoke active consent (404 if no prior grant) |
| GET    | `/consents/me`                            | JWT  | Patient's full consent history (Settings UI)  |
| POST   | `/delegations`                            | JWT  | Patient invites delegate (returns Delegation) |
| POST   | `/delegations/:id/accept`                 | JWT  | Delegate accepts pending                      |
| POST   | `/delegations/:id/decline`                | JWT  | Delegate declines pending                     |
| POST   | `/delegations/:id/revoke`                 | JWT  | Patient revokes (active                       | pending) with reason |
| GET    | `/delegations/granted`                    | JWT  | Outbound (grantor view)                       |
| GET    | `/delegations/received`                   | JWT  | Inbound (delegate view)                       |
| POST   | `/delegations/:id/scopes`                 | JWT  | Grant a scope on a delegation                 |
| POST   | `/delegations/:id/scopes/:scopeId/revoke` | JWT  | Revoke a scope                                |
| GET    | `/delegations/:id/scopes`                 | JWT  | List active scopes                            |

### Audit emitters (8 Category C lifecycle events)

- `consent_granted` / `consent_revoked`
- `delegation_invited` / `delegation_accepted` / `delegation_declined` / `delegation_revoked`
- `delegation_scope_granted` / `delegation_scope_revoked`

All emitted via `consentAuditPlaceholder()` (single sanctioned `as AuditAction` cast site; pending AUDIT_EVENTS v5.2 ratification of canonical IDs).

---

## Security gates active

Same canonical pattern proven by Slices 1 + 2:

- **I-023** — three-layer tenant isolation (RLS layer-1 + app-layer tenant filter + per-tenant KMS)
- **I-024** — cross-actor / break-glass discipline (cross-tenant token-forge → 401; chain prevention)
- **I-025** — tenant-blind error envelopes (no `Telecheck-*` / `heros` substring in any 4xx/5xx body)
- **I-003** — audit append-only with same-tx emission via `txCallback` hook; idempotent no-op re-call emits NO spurious audit
- **I-027** — every audit row carries `tenant_id`
- **Master PRD v1.10 §17 + Glossary v5.2 C3** — `tenant_id` stripped from every patient-surface response (PatientConsentView, PatientDelegationView, PatientScopeView)
- **Slice PRD §6.1** chain prevention — service-layer rejects invite when grantor is themselves an active delegate (DELEGATION_CHAIN_FORBIDDEN sentinel); DB CHECK rejects self-delegation
- **Slice PRD §6.4** sensitive-category default-excluded — visibility_restrictions JSONB requires explicit `sensitive_categories[]` entry; UI is the gate (schema is presence-tracker)
- **Slice PRD §7.1** append-only consent — REVOKE UPDATE/DELETE on consent + consent_versions tables; revocation creates new row (not UPDATE)

---

## Service-layer surface (cross-module via `index.ts`)

Cross-module callers (e.g., a future Refill workflow checking care consent) consume:

```ts
import {
  hasActiveConsent, // synchronous Slice PRD §7.2 runtime check
  grantConsent,
  revokeConsent,
  inviteDelegate,
  acceptDelegation,
  declineDelegation,
  revokeDelegation,
  grantScope,
  revokeScope,
  listActiveDelegationsForGrantor,
  listActiveDelegationsForDelegate,
  listActiveScopesForDelegation,
  DELEGATION_CHAIN_FORBIDDEN,
  DELEGATION_SELF_FORBIDDEN,
  // + branded ID types + enums
} from 'src/modules/consent';
```

`hasActiveConsent(ctx, accountId, consentType, scopeId)` is the canonical runtime check per Slice PRD §7.2 — used by every downstream workflow that requires a consent gate (Refill checking `care`; AI Clinical Assistant checking `data_use(ai_interpretation)`; Pharmacy checking `data_use(pharmacy_sharing)`).

---

## Known limitations / deferred work

| Item                                                                   | Status                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HTTP integration tests for consent + delegation flows                  | ✅ Delivered (`tests/integration/consent-http.test.ts` 7 cases at `59292ab`; `tests/integration/delegation-http.test.ts` 8 cases at `3f93e6e`)                                                                                                         |
| Service-layer direct integration tests                                 | ✅ Delivered (`tests/integration/consent-service.test.ts` 9 cases at `972a3aa`; `tests/integration/delegation-service.test.ts` 9 cases at `f4dee93`)                                                                                                   |
| Episode consent (Slice PRD §5.6)                                       | Schema supports it; UI/runtime deferred until Care Delivery slice                                                                                                                                                                                      |
| Healthcare-proxy legal documentation upload (`legal_documentation_id`) | Schema supports nullable FK; document storage lands with Documents slice                                                                                                                                                                               |
| Per-jurisdiction consent requirements (Market Rollout Cockpit)         | Schema-only at v1.0; runtime resolution deferred                                                                                                                                                                                                       |
| AUDIT_EVENTS v5.2 ratification of Consent action IDs                   | Open SPEC ISSUE; placeholder pattern retained                                                                                                                                                                                                          |
| Domain-event emission alongside audit                                  | ✅ Delivered (`src/modules/consent/events.ts` 8 emitters wired into both services at `fcfbc3a`; ALL 8 lifecycle events asserted in `tests/integration/consent-domain-events.test.ts` — 4 baseline cases at `f3c759f` + 4 extension cases at `e3bc5fb`) |

---

## Resumed-turn cumulative deliverable

This document was authored during a single autonomous turn that delivered:

- **63 commits**, all CI-green
- **1065 total test cases** (+263 from baseline 802)
- **18 migrations** (000-017)
- **69 production TypeScript files**
- **3 slices** end-to-end or implementation-complete: Forms/Intake (slice 1), Identity & Auth (slice 2), Consent & Delegated Access (slice 3)
- **JWT auth foundation** + cross-tenant token-forge defense + 6 forms-intake handlers migrated to honor JWT actor
