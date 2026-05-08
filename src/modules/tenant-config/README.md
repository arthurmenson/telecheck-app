# `src/modules/tenant-config/` — Tenant Configuration module

Implementation of the tenant-config foundation (Canonical Data Model v1.2 §4.2-§4.6 + Country-Conditional Runtime per ADR-024 + Contracts Pack v5.2 CCR_RUNTIME).

This module owns the platform's configuration layer: per-tenant brand identity, country profiles, CCR (country-conditional runtime) keys that drive protocols / formularies / payment / SMS / regulatory-module routing, and adapter configurations (encrypted payloads for third-party integrations: SMS, payment, video, etc.). It is **not a slice** from the EHBG sprint plan — it's foundational utility infrastructure that every CCR-driven downstream slice depends on.

## Status: read paths implementation-complete (v1.0); admin-write 503-stubbed pending Admin Backend slice v1.1 ratification

The patient-app bootstrap path (`GET /v0/tenant-config/me`) and the read endpoints for country profiles, tenant brand, CCR configs, and adapter configs are live. Admin-write paths (`POST` / `PATCH` / `DELETE` on tenant brand + CCR configs + adapter configs) are scaffolded at the schema + handler level but **return 503 fail-closed** pending Admin Backend slice v1.1 ratification (encryption-at-rest + operator auth + cross-tenant break-glass primitives required before write paths can ship).

Sprint 33 PR-F4 wired the 503-stub markers + the `/ready` endpoint that signals admin-write availability per environment (returns 503 in all environments today).

## Module structure (per `src/modules/README.md` template)

```
tenant-config/
├── index.ts              ← public interface (cross-module-safe exports — primary export is the CCR resolver service)
├── plugin.ts             ← Fastify plugin entry point (registered in src/app.ts under /v0/tenant-config)
├── routes.ts             ← Fastify route registration (10 routes + /health + /ready)
└── internal/             ← module-private; no cross-module imports allowed
    ├── ccr-keys.ts                 ← canonical CCR key registry (post-v1.10 cycle: 11 new keys for marketing + research)
    ├── types.ts                    ← branded IDs (TenantUserId, AdapterConfigId, CcrConfigId)
    ├── handlers/
    │   ├── tenant-config.ts        ← /me bootstrap endpoint (patient-app)
    │   ├── admin.ts                ← admin read endpoints (country-profiles, tenant-brand, ccr-configs, adapter-configs)
    │   └── admin-write.ts          ← admin-write 503-stubs (PATCH tenant-brand, PATCH ccr-configs, POST/PATCH/DELETE adapter-configs)
    ├── services/
    │   └── ccr-resolver.ts         ← CCR key → effective value resolution (consumed by every CCR-driven module)
    └── repositories/
        ├── country-profile-repo.ts ← read-only DB access for `country_profiles`
        ├── tenant-brand-repo.ts    ← tenant-scoped DB access for `tenant_brands`
        ├── ccr-config-repo.ts      ← tenant-scoped DB access for `ccr_configs`
        └── adapter-config-repo.ts  ← tenant-scoped DB access for `adapter_configs`
```

## Routes (under `/v0/tenant-config`)

| Method | Path | Handler | Status |
|---|---|---|---|
| GET | `/health` | inline | liveness probe |
| GET | `/ready` | `adminWriteReadyHandler` | admin-write readiness probe — returns 503 today |
| GET | `/me` | `getTenantConfigMeHandler` | patient-app bootstrap (resolves tenant brand + CCR effective values) |
| GET | `/country-profiles` | `listCountryProfilesHandler` | admin read |
| GET | `/tenant-brand` | `getTenantBrandHandler` | admin read |
| GET | `/ccr-configs` | `listCcrConfigsHandler` | admin read |
| GET | `/adapter-configs` | `listAdapterConfigsHandler` | admin read |
| PATCH | `/tenant-brand` | `patchTenantBrandHandler` | **503-stubbed** pending Admin Backend v1.1 |
| PATCH | `/ccr-configs/:configKey` | `patchCcrConfigHandler` | **503-stubbed** pending Admin Backend v1.1 |
| POST | `/adapter-configs` | `createAdapterConfigHandler` | **503-stubbed** pending Admin Backend v1.1 |
| PATCH | `/adapter-configs/:adapterId` | `patchAdapterConfigHandler` | **503-stubbed** pending Admin Backend v1.1 |
| DELETE | `/adapter-configs/:adapterId` | `deleteAdapterConfigHandler` | **503-stubbed** pending Admin Backend v1.1 |

## Schema

Owned migrations:
- `migrations/018_tenant_config.sql` — `country_profiles` + `tenant_brands` + `ccr_configs` + `adapter_configs`
- `migrations/019_adapter_configs_tenant_users.sql` — `tenant_users` + `adapter_configs` FK alignment

`tenant_users` and `adapter_configs` are scaffolded at the schema level but their service / HTTP wiring belongs with the Admin Backend slice v1.1 (encryption-at-rest + operator auth required for write paths).

## CCR key registry (post-v1.10 cycle)

`internal/ccr-keys.ts` is the canonical registry of CCR keys recognized by the resolver. Post-v1.10 cycle the registry adds 11 new keys (4 marketing + 7 research) per ADR-027 (country-conditional DTC marketing) and ADR-028 (research data partnership Posture A). Per Master PRD v1.10 §10.5, `country_of_care` drives the resolver lookup; `country_of_residence` is decoupled (jurisdictional regulatory residency only).

Reserved CCR keys for adapter-class routing (SMS provider, payment processor, video provider, regulatory module) are recognized but require the corresponding adapter-config row to resolve to an executable value — until the Admin Backend slice v1.1 lands those write paths, the resolver returns the country-profile default.

## Integration test coverage

Located in `tests/integration/`:

- `tenant-config-http.test.ts` — patient-app bootstrap (`/me`) HTTP coverage
- `tenant-config-admin-http.test.ts` — admin read-path HTTP coverage
- `tenant-config-admin-write-blocked.test.ts` — 503 fail-closed regression on all write paths
- `tenant-config-cross-tenant-isolation.test.ts` — I-023 / I-024 / I-025 enforcement
- `tenant-config-resolver.test.ts` — CCR resolver service-layer direct integration
- `tenant-config-migration.test.ts` + `adapter-configs-tenant-users-migration.test.ts` — schema migration regression

## Spec references

- ADR-001 (modular monolith)
- ADR-023 (multi-tenancy Model A)
- ADR-024 (country-conditional runtime)
- ADR-027 (country-conditional DTC marketing — adds 4 marketing CCR keys)
- ADR-028 (research data partnership Posture A — adds 7 research CCR keys)
- Master Platform PRD v1.10 §10.5 (program catalog architecture; CCR runtime decoupling country_of_care vs country_of_residence)
- Canonical Data Model v1.2 §4.2-§4.6 (tenant + tenant_brand + country_profile + ccr_config + adapter_config + tenant_user)
- Contracts Pack v5.2 CCR_RUNTIME, GLOSSARY (forbidden aliases — `tenant.id` is the operating-tenant identifier, never the consumer DBA)
- Tenant Threading Addendum v1.0 §3.X (tenant-config foundation)

## Sprint reference

- Sprint 18+ — tenant-config foundation authored alongside Slice 3 (Consent + Delegation) closure because none of its entities reference `medication_requests` (so it was unblocked while pharmacy / subscription remained on SI-001)
- Sprint 33 PR-F4 — admin-write 503-stub markers landed (1 Codex round)
