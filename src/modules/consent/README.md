# `src/modules/consent/` — Consent + Delegated Access module

Implementation of **Consent + Delegated Access Slice PRD v1.0** (Canonical for development).

This module owns the platform's consent lifecycle (grant / revoke / history) and the delegated-access primitive (caregiver / proxy access to another patient's data, scoped per resource class). All PHI access decisions in downstream modules (forms-intake, async-consult, pharmacy, etc.) ultimately resolve through a consent or a delegation.

## Status: implementation-complete at v1.0 (Sprint 33-34 close, 2026-05-08)

All 12 routes mounted under `/v0/consent` are implemented end-to-end with HTTP-level integration tests, service-layer direct integration tests, cross-tenant isolation tests, idempotency-replay regression, audit hash-chain regression, and tenant-blind error-envelope regression. Sprint 32 PR-C established the reserve-then-execute idempotency pattern that PR-F2 / PR-F3 then mirrored into forms-intake / identity. Sprint 34 cleanup-sweep removed legacy `markIdempotencyManagedByHandler` markers.

Spec issues that remain open at the platform level (not consent-specific):
- **SI-002** — 31 placeholder action IDs in AUDIT_EVENTS v5.2 (consent emits 8 lifecycle events; tracked but not yet ratified upstream)
- **SI-003** — 28 placeholder event-type strings in DOMAIN_EVENTS v5.2 (consent emits 4; same posture)

## Module structure (per `src/modules/README.md` template)

```
consent/
├── index.ts              ← public interface (cross-module-safe exports)
├── plugin.ts             ← Fastify plugin entry point (registered in src/app.ts under /v0/consent)
├── routes.ts             ← Fastify route registration (12 routes + /health)
├── audit.ts              ← AUDIT_EVENTS v5.2 emitters (8 lifecycle events)
├── events.ts             ← DOMAIN_EVENTS v5.2 emitters (4 cross-module-relevant events)
└── internal/             ← module-private; no cross-module imports allowed
    ├── types.ts                    ← branded IDs + scope types
    ├── handlers/
    │   ├── consents.ts             ← grant / revoke / history
    │   └── delegations.ts          ← invite / accept / decline / revoke / list / scope grant+revoke+list
    ├── services/
    │   ├── consent-service.ts      ← consent business logic + state machine
    │   └── delegation-service.ts   ← delegation business logic + scope-grant matrix
    └── repositories/
        ├── consent-repo.ts         ← tenant-scoped DB access for `consents` + `consent_versions`
        └── delegation-repo.ts      ← tenant-scoped DB access for `delegations` + `delegation_scopes`
```

## Routes (under `/v0/consent`)

| Method | Path | Handler | Description |
|---|---|---|---|
| GET | `/health` | inline | liveness probe |
| POST | `/consents` | `grantConsentHandler` | grant a consent (idempotency-protected) |
| POST | `/consents/revoke` | `revokeConsentHandler` | revoke a consent (idempotency-protected) |
| GET | `/consents/me` | `getMyConsentHistoryHandler` | actor-scoped consent history |
| POST | `/delegations` | `inviteDelegateHandler` | invite another patient as a delegate (idempotency-protected) |
| POST | `/delegations/:id/accept` | `acceptDelegationHandler` | invitee accepts an invitation |
| POST | `/delegations/:id/decline` | `declineDelegationHandler` | invitee declines an invitation |
| POST | `/delegations/:id/revoke` | `revokeDelegationHandler` | grantor revokes a delegation |
| GET | `/delegations/granted` | `listGrantedDelegationsHandler` | delegations the actor has granted |
| GET | `/delegations/received` | `listReceivedDelegationsHandler` | delegations the actor has received |
| POST | `/delegations/:id/scopes` | `grantScopeHandler` | grant a scope on an accepted delegation |
| POST | `/delegations/:id/scopes/:scopeId/revoke` | `revokeScopeHandler` | revoke a scope |
| GET | `/delegations/:id/scopes` | `listScopesForDelegationHandler` | list scopes on a delegation |

## Schema

Owned migrations:
- `migrations/016_consent.sql` — `consents` + `consent_versions` (versioned consent records; consent_versions is append-only per I-003)
- `migrations/017_delegations.sql` — `delegations` + `delegation_scopes` (delegation lifecycle + scope-grant matrix)

Composite UNIQUE + composite FK pattern per PROJECT_CONVENTIONS r5 §1.1: `delegation_scopes.(tenant_id, delegation_id)` references `delegations.(tenant_id, id)` so cross-tenant scope-grant binding is structurally impossible.

## Integration test coverage

Located in `tests/integration/`:

- `consent-http.test.ts` — HTTP coverage for all 12 routes
- `consent-idempotency-replay.test.ts` — IDEMPOTENCY v5.1 contract regression (replay returns same body; body-mismatch returns 409)
- `consent-audit-chain.test.ts` — I-003 hash-chain regression for the 8 lifecycle events
- `consent-domain-events.test.ts` — DOMAIN_EVENTS v5.2 envelope shape
- `consent-cross-tenant-isolation.test.ts` — I-023 / I-024 / I-025 enforcement
- `consent-error-envelope-tenant-blind.test.ts` — I-025 cross-tenant-existence-leak regression
- `consent-service.test.ts` + `delegation-service.test.ts` — service-layer direct integration
- `delegation-http.test.ts` + `delegation-http-coverage-gaps.test.ts` — delegation-specific HTTP edge cases
- `consent-plugin-wiring.test.ts` — plugin smoke test
- `consent-migration.test.ts` + `delegations-migration.test.ts` — schema migration regression

## Spec references

- ADR-001 (modular monolith)
- ADR-023 (multi-tenancy Model A)
- ADR-028 (research data partnership Posture A — adds 5th `research_data_use` consent tier; gated by I-029)
- Consent + Delegated Access Slice PRD v1.0
- Canonical Data Model v1.2 §3 entities #11 (Consent) + #12 (ConsentVersion) + #13 (Delegation) + #14 (DelegationScope)
- State Machines v1.1 §2 (consent lifecycle) + §4 (delegation lifecycle)
- Contracts Pack v5.2 INVARIANTS (I-003 audit append-only, I-023 / I-024 / I-025 / I-027 tenant isolation), AUDIT_EVENTS, DOMAIN_EVENTS, IDEMPOTENCY (v5.1), GLOSSARY
- Tenant Threading Addendum v1.0 §3.X (consent slice)

## Sprint reference

- Sprints 7-9 — initial slice authoring (TLC-019 through TLC-021)
- Sprint 32 PR-C — reserve-then-execute idempotency pattern established here first; mirrored into forms-intake / identity in Sprint 33 PR-F2 / PR-F3
- Sprint 33-34 SI-006 closure — consent module already used the reserve-then-execute pattern; Sprint 34 cleanup-sweep removed legacy `markIdempotencyManagedByHandler` no-op markers + extended the Group F source-grep lockdown
