# Tenant-Config Foundation — Implementation Status

**Date:** 2026-05-05 (Sprint 33-34 amendment 2026-05-08)
**Author:** Autonomous turn (Claude Sonnet 4.5)
**Final commit:** `c378dd7` (resolveQuietHours tests; resolver+CCR_KEYS at `fb13a90`+`37a7205`; cross-tenant tests at `ecf0f4a`; HTTP layer at `9740e7b`; data layer at `25e6026`; migrations at `eacafeb`+`11fd332`)
**Sprint 33-34 amendment final commit:** `dc06541` (PR #46 PR-F4 admin-write 503-stub markers landed alongside the SI-006 reserve-then-execute closure; admin-write paths fail-closed pending Admin Backend slice v1.1 ratification)
**CI status:** ✅ Green at all amendment commits

---

## Sprint 33-34 amendment (2026-05-08)

The tenant-config foundation read paths shipped at v1.0 in the Sprint 5-7 burst (per the original body below). Sprint 33-34 SI-006 reserve-then-execute closure had a focused impact on this module:

- **PR #46 / PR-F4 (Sprint 33)** — admin-write 503-stub markers landed across `internal/handlers/admin-write.ts` (PATCH `/tenant-brand`, PATCH `/ccr-configs/:configKey`, POST `/adapter-configs`, PATCH `/adapter-configs/:adapterId`, DELETE `/adapter-configs/:adapterId`). Each handler returns `{ status: 503 }` with the canonical error envelope, signaling that admin-write is unavailable pending Admin Backend slice v1.1 ratification (encryption-at-rest + operator auth + cross-tenant break-glass primitives required before write paths can ship). The `/ready` endpoint at `routes.ts` returns 503 in all environments today via `adminWriteReadyHandler`, so Kubernetes/LB readiness probes continue to keep traffic off the admin-write surface. (1 Codex round; clean close.)

What did NOT change in Sprint 33-34:

- Read paths remain at v1.0: patient-app `GET /v0/tenant-config/me` bootstrap + admin-read endpoints for country profiles, tenant brand, CCR configs, adapter configs all continue to work as authored.
- Cross-tenant isolation tests (`tenant-config-cross-tenant-isolation.test.ts`) continue to pass; I-023 / I-024 / I-025 enforcement unchanged.
- CCR resolver service (`ccr-resolver.ts`) and the CCR key registry (`ccr-keys.ts`, including the 11 v1.10-cycle additions for marketing + research) unchanged.
- Schema layer (`migrations/018_tenant_config.sql` + `migrations/019_adapter_configs_tenant_users.sql`) unchanged.

What benefited indirectly from Sprint 33-34:

- The 503-stub handlers are now wired through the same canonical error envelope path that the implementation-complete slices use — when Admin Backend v1.1 ratifies and write paths un-stub, they will use the reserve-then-execute idempotency pattern + `withIdempotency` + handler-owned cache writes (per PROJECT_CONVENTIONS r5 §3.7) without any per-handler scaffolding cost.
- The cross-cutting `audit_dedupe_markers` table (`migrations/022_audit_dedupe_markers.sql`) is available for any Category A audit emit on the future write paths (admin-action audit emission per AUDIT_EVENTS v5.2).

**On-resume sequencing when Admin Backend v1.1 ratifies:** unstub the 5 admin-write handlers (PATCH tenant-brand, PATCH ccr-configs, POST adapter-configs, PATCH adapter-configs, DELETE adapter-configs) → wire `withIdempotency` + reserve-then-execute pattern → emit `tenant_config.<scope>.<verb>` audit events (Category A, dedupe-marker-protected per Sprint 34 PR #49 pattern) → flip `/ready` to return 200 once env-gate criteria are met. Cross-tenant isolation tests already cover the read paths; write-path cross-tenant tests are the new addition.

### Spec references for the amendment

- `docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.3 "Implementation Closure" (the redesign that admin-write paths will inherit when they unstub)
- `docs/PROJECT_CONVENTIONS.md` r5 §3.7 / §3.8 / §3.9 + §5.11 + §5.12 (the patterns admin-write handlers will follow)
- `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 (cross-slice cumulative state; tenant-config row notes Sprint 33 PR-F4 503-stub markers)
- Master PRD v1.10 §10.5 (program catalog architecture + CCR runtime; the v1.10 cycle's 11 new CCR keys were canonicalized in `ccr-keys.ts` as part of the v1.10.1 hygiene cycle)

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
  resolveQuietHours, // override → country profile fallback (QuietHours object)
  findTenantBrand, // tenant brand snapshot
  findCountryProfile, // platform-level read
  listCountryProfiles, // admin market-rollout UI
  CCR_KEYS, // canonical CCR key constants — use instead of hardcoded literals
  type CcrKey, // string-literal union of CCR_KEYS values
  type QuietHours, // {start, end, timezone_anchor}
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

| Test file                                      | Cases  | Layer                                       |
| ---------------------------------------------- | ------ | ------------------------------------------- |
| tenant-config-migration.test.ts                | 12     | Schema (mig 018)                            |
| adapter-configs-tenant-users-migration.test.ts | 12     | Schema (mig 019)                            |
| tenant-config-resolver.test.ts                 | 12     | Service / repo (9 baseline + 3 quiet-hours) |
| tenant-config-http.test.ts                     | 5      | HTTP integration                            |
| tenant-config-cross-tenant-isolation.test.ts   | 4      | Cross-tenant                                |
| **Total tenant-config foundation**             | **45** | —                                           |

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

- **Pharmacy + Refill (Slice 4 prescribe surface implemented post-SI-001 P-011 2026-05-12; refill/dispense/shipment surface blocked on SI-007 — per PR #173 per-slice STATUS refresh 2026-05-17):** `resolveCcrKey(ctx, 'pharmacy.routing_strategy')` + `getTenantCountryProfile(ctx).available_pharmacy_adapters` to pick adapter.
- **Notifications:** `resolveSmsProvider(ctx)` per-tenant SMS routing.
- **Payments / Subscription:** `resolvePaymentProcessor(ctx)` + `resolveCurrencyCode(ctx)` for Stripe vs Paystack routing.
- **Crisis-detection (I-019 platform floor):** `resolveEmergencyNumber(ctx)` + `getTenantCountryProfile(ctx).crisis_helplines` rendered in patient-side crisis surfaces (frontend; out of scope for the audit emission path).
- **Patient-app bootstrap:** `GET /v0/tenant-config/me` already live; consumed by web + mobile shells.

---

## Resumed-turn commit log (chronological)

```
c378dd7 test: 3 new resolveQuietHours cases (default + override + malformed)
fb13a90 feat(tenant-config): resolveQuietHours typed resolver + QuietHours type
37a7205 feat(tenant-config): canonical CCR key constants per CCR_RUNTIME v5.2
ecf0f4a test: tenant-config CCR resolver cross-tenant isolation (4 cases)
9e94e38 docs(tenant-config): foundation status doc + README implementation table update
9740e7b feat(tenant-config): plugin + GET /v0/tenant-config/{health,me}
25e6026 feat(tenant-config): module data layer + CCR resolver service
11fd332 fix(test): wrap tenant_users inserts in withTenantContext
db9aed3 migration(019): adapter_configs + tenant_users (CDM §4.5-§4.6)
eacafeb fix(test): tenant-config §1c uses 7-char non-hex value
34edbc2 migration(018): tenant_brands + country_profiles + ccr_configs (CDM §4.2-§4.4)
58f6cb5 docs(spec-issue): SI-002 — AUDIT_EVENTS v5.2 placeholder action IDs
```

(12 commits across the foundation layer; preceded by Slices 1-3 hardening + SI-001 + the consent-repo ULID-tiebreaker fix earlier in the same resumed turn.)

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
