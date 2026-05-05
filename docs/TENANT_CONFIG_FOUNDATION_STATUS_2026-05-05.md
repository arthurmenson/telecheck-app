# Tenant-Config Foundation — Implementation Status

**Date:** 2026-05-05
**Author:** Autonomous turn (Claude Sonnet 4.5)
**Final commit:** `9740e7b` (HTTP layer; data-layer at `25e6026`; migrations at `eacafeb` + `11fd332`)
**CI status:** ✅ Green at `9740e7b`

---

## Summary

The tenant-config foundation layer covers CDM v1.2 §4.2-§4.6 — five entities that every CCR-driven downstream slice depends on. **NOT a slice from the EHBG §10b sprint plan** — this is foundational utility infrastructure that would otherwise have been inlined inside Identity, Forms-Intake, and Consent (and forced re-inlining in every future slice). Lifted into its own module per ADR-001 modular monolith.

The work was unblocked because none of the §4.2-§4.6 entities reference `medication_requests`, so SI-001 doesn't gate this module. After Slice 4 unblocks, Pharmacy + Refill will be the first heavyweight CCR-driven consumer.

---

## What's built

### CDM §4.2-§4.6 entities — all five scaffolded

| Entity              | Migration | Repo / service             | HTTP                            |
| ------------------- | --------- | -------------------------- | ------------------------------- |
| TenantBrand (#2)    | 018       | tenant-brand-repo          | GET /v0/tenant-config/me        |
| CountryProfile (#3) | 018       | country-profile-repo       | GET /v0/tenant-config/me        |
| CCRConfig (#4)      | 018       | ccr-config-repo + resolver | (Admin Backend slice owns CRUD) |
| AdapterConfig (#5)  | 019       | (schema only at v1.0)      | (Admin Backend slice will own)  |
| TenantUser (#6)     | 019       | (schema only at v1.0)      | (Admin Backend slice will own)  |

Migrations 018 + 019 add 5 tables, 4 updated_at triggers (tenant_brands, ccr_configs, adapter_configs, tenant_users — country_profiles is platform-level + rarely-mutated and uses a simpler default), 5 RLS policies (4 standard tenant_isolation + 1 special-cased tenant_users visibility for platform-admin cross-tenant), and 2 seed rows (Heros Health US + Heros Health Ghana brands). country_profiles is seeded with US + GH country defaults including regulatory module, payment processor, currency, locale, emergency number, crisis helplines, and adapter availability arrays.

### Module structure (`src/modules/tenant-config/`)

```
internal/
├── types.ts                                 # CountryCode + CcrConfigId branded types + 3 entity row shapes
├── handlers/
│   └── tenant-config.ts                    # GET /me handler — patient-app bootstrap snapshot
├── repositories/
│   ├── country-profile-repo.ts             # platform-level reads (no tenant binding required)
│   ├── ccr-config-repo.ts                   # tenant-scoped (RLS enforced)
│   └── tenant-brand-repo.ts                 # tenant-scoped (RLS enforced)
└── services/
    └── ccr-resolver.ts                      # CCR-key resolution surface
plugin.ts                                    # Fastify plugin registers /v0/tenant-config
routes.ts                                    # GET /health + /me
index.ts                                     # ADR-001 public-interface re-exports
```

### CCR resolver service (canonical lookup surface)

The resolver combines per-tenant `ccr_configs` overrides with `country_profiles` defaults. Cross-module callers consume:

```ts
import {
  resolveCcrKey, // generic JSONB override resolver
  getTenantCountryProfile, // full country profile for the tenant's country_of_care
  resolveSmsProvider, // override → country profile fallback (string)
  resolvePaymentProcessor, // override → country profile fallback (string)
  resolveCurrencyCode, // jurisdictional, no per-tenant override
  resolveEmergencyNumber, // jurisdictional, used by crisis-detection surface
  findTenantBrand, // tenant brand snapshot
  findCountryProfile, // platform-level read
  listCountryProfiles, // admin market-rollout UI
  tenantConfigPlugin,
  // + branded types
} from 'src/modules/tenant-config';
```

### HTTP API surface — 2 routes mounted under `/v0/tenant-config`

| Method | Path      | Auth | Purpose                                                  |
| ------ | --------- | ---- | -------------------------------------------------------- |
| GET    | `/health` | none | Module health probe (allowlisted in tenantContextPlugin) |
| GET    | `/me`     | none | Patient-app bootstrap — brand + country profile snapshot |

The `/me` endpoint requires NO auth because brand info (logo, colors, support contact, emergency number) is needed by the patient app at bootstrap, BEFORE login. Tenant resolution comes from the host header via tenantContextPlugin. The response is patient-safe: `tenant_id` stripped from the brand view per Master PRD v1.10 §17 + Glossary v5.2 C3; country_profile is selectively projected to omit operator-side fields (regulatory_module, adapter availability arrays).

---

## Test coverage

| Test file                                      | Cases  | Layer            |
| ---------------------------------------------- | ------ | ---------------- |
| tenant-config-migration.test.ts                | 12     | Schema (mig 018) |
| adapter-configs-tenant-users-migration.test.ts | 12     | Schema (mig 019) |
| tenant-config-resolver.test.ts                 | 9      | Service / repo   |
| tenant-config-http.test.ts                     | 5      | HTTP integration |
| **Total tenant-config foundation**             | **38** | —                |

Sections:

- §1 schema (each migration has its own RLS / CHECK / trigger / seed coverage)
- §2 service (CCR resolver with override + country-profile fallback paths; jurisdictional resolvers — currency + emergency number)
- §3 HTTP (/me US bootstrap, /me Ghana bootstrap, tenant-blind body assertion)

---

## Security gates active

- **I-009** — country_profiles is the canonical registry; no hardcoded country logic. Adding a new market = adding a row + extending `tenants.country_of_care` CHECK constraint via subsequent migration.
- **I-023** — RLS enforced on tenant_brands + ccr_configs + adapter_configs + tenant_users. country_profiles intentionally has no RLS (platform-level data).
- **I-024** — tenant_users RLS uses `tenant_id IS NULL OR tenant_id = current_tenant_id()` — platform admins (`tenant_id IS NULL`) are visible cross-tenant by design (they operate cross-tenant); tenant-scoped operators are visible only from their own tenant.
- **I-025** — `/me` body is tenant-blind (no `Telecheck-*` substring); error envelopes go through canonical errorEnvelopePlugin.
- **I-027** — every audit row carries `tenant_id` (no audit emissions in this module yet — audit lives with the slices that consume the resolver).
- **Master PRD v1.10 §17 + Glossary v5.2 C3** — `tenant_id` stripped from every patient-surface response (PatientBrandView, PatientCountryProfileView).
- **ADR-024** — `adapter_configs.adapter_config` JSONB is encrypted at rest at the application layer using `tenants.kms_key_alias`. The DB schema does NOT enforce that encryption — it is the column-level contract documented in the migration. Encryption wiring lands with Admin Backend slice.

---

## Known limitations / deferred work

| Item                                                          | Status                                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| AdapterConfig service layer + admin CRUD                      | Deferred — Admin Backend slice v1.1 owns this surface                                   |
| TenantUser auth + admin CRUD                                  | Deferred — Admin Backend slice v1.1 owns operator auth integration                      |
| AdapterConfig encryption-at-rest application-layer wiring     | Deferred — lands with Admin Backend slice v1.1 alongside the admin UI                   |
| Brand asset upload (logo_url + design tokens)                 | Deferred — needs object-storage slice (S3/MinIO wiring)                                 |
| TenantBrand mutation surface                                  | Deferred — Admin Backend slice owns; current data layer is read-only                    |
| CCRConfig mutation surface (per-tenant override CRUD)         | Deferred — Admin Backend slice owns                                                     |
| Cross-slice consumers (forms-intake crisis-detection surface) | Deferred — emergency_number surfaces in patient UI, not in audit detail                 |
| Caching layer for resolveCcrKey hot path                      | Deferred — current impl hits DB per call; Redis cache lands when load profile justifies |
| Domain-event emission for tenant-config mutations             | Deferred — outbox pattern lands when first mutation surface lands                       |

---

## Cross-slice consumers (planned)

- **Pharmacy + Refill (Slice 4, blocked on SI-001):** `resolveCcrKey(ctx, 'pharmacy.routing_strategy')` + `getTenantCountryProfile(ctx).available_pharmacy_adapters` to pick adapter.
- **Notifications:** `resolveSmsProvider(ctx)` per-tenant SMS routing.
- **Payments / Subscription:** `resolvePaymentProcessor(ctx)` + `resolveCurrencyCode(ctx)` for Stripe vs Paystack routing.
- **Crisis-detection (I-019 platform floor):** `resolveEmergencyNumber(ctx)` + `getTenantCountryProfile(ctx).crisis_helplines` rendered in patient-side crisis surfaces (frontend; out of scope for the audit emission path).
- **Patient-app bootstrap:** `GET /v0/tenant-config/me` already live; consumed by web + mobile shells.

---

## Resumed-turn commit log (chronological)

```
9740e7b feat(tenant-config): plugin + GET /v0/tenant-config/{health,me}
25e6026 feat(tenant-config): module data layer + CCR resolver service
11fd332 fix(test): wrap tenant_users inserts in withTenantContext
db9aed3 migration(019): adapter_configs + tenant_users (CDM §4.5-§4.6)
eacafeb fix(test): tenant-config §1c uses 7-char non-hex value
34edbc2 migration(018): tenant_brands + country_profiles + ccr_configs (CDM §4.2-§4.4)
58f6cb5 docs(spec-issue): SI-002 — AUDIT_EVENTS v5.2 placeholder action IDs
```

(7 commits across the foundation layer; preceded by Slices 1-3 hardening + SI-001 + the consent-repo ULID-tiebreaker fix earlier in the same resumed turn.)

---

## Next-engineer pickup notes

**To consume the resolver from a downstream slice:**

1. Cross-module callers import from `src/modules/tenant-config/index.ts` only — never reach into `./internal/*`.
2. Most callers want one of the typed resolvers: `resolveSmsProvider`, `resolvePaymentProcessor`, `resolveCurrencyCode`, `resolveEmergencyNumber`. Use `resolveCcrKey` for arbitrary JSONB overrides not yet promoted to a typed resolver.
3. The resolver does NOT cache. For hot-path callers (e.g., per-message SMS provider lookup), wrap the resolver in your own per-request memoization until a Redis cache layer lands.
4. `getTenantCountryProfile(ctx)` returns the full `CountryProfile` row — useful when the caller needs multiple fields (e.g., crisis-detection rendering currency + emergency_number + crisis_helplines together).
5. Do NOT read `country_profiles` / `ccr_configs` / `tenant_brands` / `adapter_configs` directly from cross-module code. The repo modules are `internal/` for a reason — schema is going to evolve and the resolver is the stable contract.

**Production deployment checklist:**

1. Migrations 018 + 019 applied in order.
2. `country_profiles` has a row for every active tenant's `country_of_care` (the platform-level registry — adding a market means inserting a row).
3. `tenants.country_of_care` CHECK constraint matches the populated `country_profiles.country` set.
4. `tenant_brands` has a row for every active tenant; otherwise `findTenantBrand()` returns null and the patient app falls back to design-system defaults (acceptable but not ideal for branded tenants).
5. `adapter_configs.adapter_config` payloads MUST be encrypted at the application layer using `tenants.kms_key_alias` before INSERT. The DB schema does not enforce this — Admin Backend slice will own the writer path with KMS wiring.
