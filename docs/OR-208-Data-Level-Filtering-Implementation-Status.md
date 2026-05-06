# OR-208 — Data-level filtering implementation status

**Filed:** 2026-05-06 (Sprint 31 / TLC-019)
**ORT row:** OR-208 (Tier 2: data-level filtering implementation choice — RLS vs view vs app-layer)
**Status:** Resolved by ADR-023 + implementation; this doc captures rationale + the test surface that proves it.

---

## ORT row text

> **OR-208** — Data-level filtering implementation choice (RLS vs view vs app-layer).

The original ORT row asked which of three filtering approaches the platform would use. Per the ORT v1.5 testable-items audit (`docs/ORT_V1_5_TESTABLE_ITEMS_AUDIT.md` line 84-94), this was already implicitly resolved by ADR-023 (multi-tenancy 3-layer enforcement) but lacked a status doc consolidating the decision rationale + test surface.

---

## Decision: 3-layer enforcement

Per ADR-023 (Multi-Tenancy Architecture; Model A — single deployment, logical isolation), the platform uses **all three** filtering layers, not "one of three":

1. **PostgreSQL Row-Level Security (RLS)** — first line of defense. Every PHI-touching table has `FORCE ROW LEVEL SECURITY` plus a `tenant_isolation` policy that filters rows by `current_setting('app.current_tenant_id')`.
2. **Application-layer filtering** — defense in depth. Repos add `WHERE ... AND tenant_id = $N` predicates explicitly alongside RLS, per PROJECT_CONVENTIONS §2.1. Catches drift if RLS is misconfigured or bypassed (e.g., a SUPERUSER role accidentally running queries).
3. **Per-tenant KMS keys** — defense at rest. Each tenant has a distinct KMS key alias (`alias/telecheck-<tenant>-data-key`). Sensitive fields (e.g., `adapter_configs.adapter_config` JSON) are encrypted with the per-tenant key. Cross-tenant decryption is structurally impossible because the wrong KMS key cannot decrypt another tenant's payload.

The three layers were chosen because each catches failure modes the others miss. RLS alone is bypassed by SUPERUSER; app-layer alone is bypassed by ORM-generated raw SQL that omits the predicate; KMS alone doesn't filter rows (it just renders cross-tenant rows unreadable). Three layers + audit-chain proof of access pattern = the I-023 "three-layer tenant isolation" invariant that the spec's compliance story rests on.

---

## Why not view-based filtering

A view-based pattern (`CREATE VIEW patients_for_tenant AS SELECT ... WHERE tenant_id = current_setting('app.current_tenant_id')`) was considered as an alternative to RLS but rejected:

- **Schema sprawl:** every tenant-scoped table would need a paired view; ~40+ views across the platform.
- **Trigger composition:** views don't compose cleanly with `BEFORE INSERT` triggers (e.g., the audit-chain hash-chain trigger).
- **Cross-table joins:** views still need RLS or app-layer filtering on the underlying tables when used in joins.
- **Postgres optimizer:** RLS policies are pushed into query plans via the planner; views with WHERE-clauses sometimes are not.
- **Migration overhead:** every schema change requires updating both the table and the view in lockstep.

RLS is the more maintainable shape for the same security guarantee, especially with `FORCE ROW LEVEL SECURITY` (which applies even to the table owner — so accidental owner-as-user queries don't bypass).

---

## Implementation pointers

### RLS layer (Layer 1)

- `migrations/003_rls_helpers.sql` — defines `set_tenant_context($1)` and `current_tenant_id()` helper functions used by RLS policies.
- Each tenant-scoped table's migration adds `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `CREATE POLICY tenant_isolation ON ... USING (tenant_id = current_tenant_id())`.
- Tenant-scoped tables are inventoried in `tests/contracts/rls-policy-coverage-lockdown.test.ts` (TLC-016 / Sprint 6); the test asserts every entry has a corresponding policy with the expected USING clause.
- 50 cases pinned in the lockdown test as of Sprint 31 (cross-checked via grep in this sprint).

### Application-layer (Layer 2)

- Every repo's tenant-scoped query adds `AND tenant_id = $N` explicitly per PROJECT_CONVENTIONS §2.1.
- Examples: `src/modules/async-consult/internal/repositories/consult-repo.ts:152`; `src/modules/tenant-config/internal/repositories/ccr-config-repo.ts:67`.
- The `src/lib/tenant-context.ts` middleware sets `app.current_tenant_id` per request — this is what RLS policies read; app-layer predicates use the same value passed explicitly.
- Cross-tenant test coverage: `tests/integration/identity-cross-tenant-isolation.test.ts`, `tests/integration/consent-cross-tenant-isolation.test.ts`, `tests/integration/async-consult-cross-tenant-isolation.test.ts`, `tests/integration/tenant-isolation.test.ts`.

### KMS layer (Layer 3)

- `src/lib/kms.ts` — per-tenant key resolution + encrypt/decrypt.
- `migrations/008_tenant_users_adapter_configs.sql` (or equivalent) — `adapter_configs.adapter_config` is encrypted with the per-tenant key alias resolved via `tenants.kms_key_alias`.
- ADR-024 covers the per-tenant KMS architecture.
- Cross-tenant decryption-attempt test: `tests/integration/kms.test.ts`.

---

## Test surface (proves all three layers are live)

| Test | Layer | What it proves |
|---|---|---|
| `tests/contracts/rls-policy-coverage-lockdown.test.ts` | 1 (RLS) | Every tenant-scoped table has a `tenant_isolation` policy with the expected USING clause |
| `tests/integration/rls.test.ts` | 1 (RLS) | RLS policies actually filter cross-tenant rows at query time under non-superuser context |
| `tests/integration/tenant-isolation.test.ts` | 1+2 | End-to-end cross-tenant access denial across module boundaries |
| `tests/integration/{module}-cross-tenant-isolation.test.ts` (5 files) | 1+2 | Per-module cross-tenant access is denied (returns null/404, not 403) per I-025 tenant-blind error envelope |
| `tests/integration/kms.test.ts` | 3 (KMS) | Per-tenant key isolation + cross-tenant decryption fails-closed |
| `tests/invariants/i023-tenant-isolation.test.ts` | 1+2+3 | Invariant-level pin of the three-layer enforcement guarantee |

50 RLS-policy coverage cases + 5 per-module cross-tenant suites + the i023 invariant test = the proof surface. None of these are flaky in current ci.yml (modulo the unrelated TLC-050 audit-emit flake).

---

## Why this status doc and not a code change

The implementation has been live since Sprint 5+ and stable. ORT OR-208 was a "decide and document" item, not a "implement" item. The decision was already implicit in ADR-023 + the existing implementation; this doc closes the documentation gap so the ORT row can be marked Resolved.

The `tests/contracts/rls-policy-coverage-lockdown.test.ts` lockdown is what makes the decision durable — any new tenant-scoped table without a matching RLS policy fails the lockdown test at PR time.

---

## Spec references

- ADR-023 (Multi-Tenancy Architecture; Model A 3-layer enforcement)
- ADR-024 (Per-tenant KMS keys)
- I-023 (three-layer tenant isolation — platform-floor invariant)
- I-025 (tenant-blind error envelopes)
- I-027 (every audit record carries tenant_id)
- PROJECT_CONVENTIONS §2.1 (explicit tenant_id predicate alongside RLS)
- PROJECT_CONVENTIONS §1.4 (RLS lockdown maintenance discipline)
- ORT v1.5 OR-208 (data-level filtering implementation choice)
- ORT v1.5 OR-112 (multi-tenant isolation testing battery — overlapping coverage)
- ORT v1.5 OR-236 (multi-tenant isolation security review — overlapping coverage)
- `docs/ORT_V1_5_TESTABLE_ITEMS_AUDIT.md` (this doc closes line 84-94)
