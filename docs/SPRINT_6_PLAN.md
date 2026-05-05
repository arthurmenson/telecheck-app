# Sprint 6 Plan — Telecheck-app autonomous build

**Sprint:** 6
**Sprint goal:** Author RLS policy static-analysis lockdown closing OR-112 + OR-236 (highest-leverage launch-blocking gap from TLC-015 ORT audit) + consolidate slice status docs into a build-vs-spec traceability matrix (OR-216).
**Sprint start commit:** `804c294` (PM oversight changes; SM verification gate landed)
**Commit budget:** 7 (1 kickoff + 2 TLC-016 + 1 TLC-016 Codex fix-forward reserve + 1 TLC-017 + 1 review/retro = 6 + 1 slack)
**Codex strategy:** FIRE on TLC-016 with narrow scope; SKIP on TLC-017 (docs consolidation)

---

## PM-brief verification gate findings (NEW — Sprint 6 inaugural application)

Per `docs/SCRUM_OPERATING_MODEL.md` §"PM-brief verification gate" (landed `804c294`), the SM mechanically verified every identifier in the PM brief against its source-of-truth file before accepting. **This is the first sprint where the gate ran.**

| Identifier | Cited at (PM brief §) | Verified at (source-of-truth) | Match |
| --- | --- | --- | --- |
| OR-112 | §2 (TLC-016) | `Telecheck_Operational_Readiness_Todo_v1_5.md:89` | ✓ |
| OR-236 | §2 (TLC-016) | `Telecheck_Operational_Readiness_Todo_v1_5.md:94` | ✓ |
| OR-216 | §2 (TLC-017) | `Telecheck_Operational_Readiness_Todo_v1_5.md:127` | ✓ |
| P-010 | §1 (Promotion Ledger) | `Telecheck_Promotion_Ledger.md:40` | ✓ |
| 21 tenant-scoped tables | §4 | `grep "CREATE POLICY.*ON " migrations/*.sql` returns 21 distinct tables | ✓ |
| 3 policy-name conventions | §5 | grep confirms `tenant_isolation` ×19 / `audit_tenant_isolation` ×1 / `tenant_users_visibility` ×1 | ✓ |
| Existing RLS test = audit_records + soft-fails | §3 | `tests/invariants/i023-tenant-isolation.test.ts:232-275` | ✓ |
| ADR-023 / I-023 | §9 | canonical (already cited throughout codebase) | ✓ |

**Gate result: ALL PASS.** First clean PM brief since the gate was instituted. The Sprint 3 (`internal.module.blocked`) + Sprint 5 (`OR-253/244/255`) hallucination class did NOT recur — the new sub-rules + gate appear to be working.

---

## Promotion Ledger check (verified by PM at kickoff; gate-confirmed)

SI-001 / SI-002 / SI-003 remain **open** upstream. Latest entry is **P-010** (CDM §4.1 SPEC ISSUE resolution; 2026-05-02; verified at `Telecheck_Promotion_Ledger.md:40`). No P-011/012/013 — Slice 4 schema work stays blocked.

---

## Stories committed

### TLC-016 — RLS policy static-analysis lockdown (closes OR-112 + OR-236)

**Estimated commits:** 2 (1 test author + potential 1 Codex fix-forward)
**Decision rule:** 3 (diminishing-returns hygiene) — invariant-coverage discipline; closes highest-leverage launch-blocking item from TLC-015 audit
**Current state baseline (PM verified):** `tests/invariants/i023-tenant-isolation.test.ts:232-275` asserts only on the single `audit_records` table AND soft-fails (`if (rows.length === 0) console.warn(...); return;`). No global RLS-policy lockdown exists across the 21 tenant-scoped tables.

#### Acceptance criteria

- New test file `tests/contracts/rls-policy-coverage-lockdown.test.ts` (sibling pattern to `canonical-glossary.test.ts` + `crisis-detection-coverage-lockdown.test.ts` — DB-backed because `pg_class` + `pg_policies` are runtime catalog tables, not source-grep-able)
- Per-table assertions across the 21 tenant-scoped tables (verified inventory below):
  - For each table: `pg_class.relrowsecurity = true` AND `pg_class.relforcerowsecurity = true` AND `pg_policies` has ≥1 policy row
- **Policy-name canonicalization handling** (per PM brief §5 — Sprint 5 retro internal-canonicalization-pattern check):
  - DO NOT assert a fixed policy name (would silently pass-for-wrong-reason on the `audit_tenant_isolation` / `tenant_users_visibility` exceptions OR fail when those exceptions are correct)
  - Assert `pg_policies WHERE tablename = $1` returns ≥1 row
- **Count assertion** to catch policy-drop regressions: assert exactly 21 tenant-scoped tables have RLS POLICY entries (count from migrations grep). If a future migration drops a policy, the count drifts and the test fires.
- **Exclude platform-level tables** (per PM Risk #2): `tenants` table is platform-level (carries `id` as the tenant identifier; no `tenant_id` column on itself); MUST be excluded from the tenant-scoped enumeration so the test doesn't false-flag the platform-level lookup table.
- Type-check + lint clean
- Codex FIRE on the test file + relevant migration files (narrow scope per Sprint 5 plan precedent)

#### Tenant-scoped table inventory (21 tables; verified at SM gate)

```
accounts, adapter_configs, audit_records, auth_devices, ccr_configs,
consent, consent_versions, delegation_scopes, delegations,
domain_events_outbox, forms_deployment, forms_resume_state,
forms_snapshot, forms_submission, forms_template, forms_variant,
idempotency_keys, otp_challenges, sessions, tenant_brands, tenant_users
```

#### Internal-canonicalization rule (Sprint 5 retro PM rubric sub-rule applied)

Policy-name convention is non-uniform across migrations:
- `tenant_isolation` — 19 tables (default convention)
- `audit_tenant_isolation` — `audit_records` only (`migrations/002_audit_chain.sql:324` per PM citation)
- `tenant_users_visibility` — `tenant_users` only (special-cased for platform-admin cross-tenant visibility per TLC-005; `migrations/019_adapter_configs_tenant_users.sql:226` per PM citation)

The lockdown test must accommodate the 3-name reality. Asserting `pg_policies WHERE tablename = $1` returns ≥1 row (without filtering on policyname) handles all three conventions without coupling to the convention itself.

---

### TLC-017 — Build-vs-spec traceability matrix consolidation (closes OR-216)

**Estimated commits:** 1
**Decision rule:** 6 (UAT / launch-readiness)
**Current state baseline (PM verified):** Existing slice status docs — `FORMS_INTAKE_SLICE_STATUS_*.md`, `IDENTITY_SLICE_STATUS_*.md`, `CONSENT_DELEGATION_SLICE_STATUS_*.md`, etc. — each track a single slice's spec-vs-implementation state. No consolidated cross-slice matrix exists.

#### Acceptance criteria

- New doc `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` (non-dated single living artifact per Sprint 5 PM convention)
- Per-spec-element table mapping each implemented invariant / slice / module to test files covering it:
  - 22 platform invariants (I-001 .. I-031, with skip-rows for invariants not yet active in this repo)
  - 3 implementation-complete slices (Forms-Intake, Identity, Consent + Delegation)
  - 3 BLOCKED-aware skeletons (pharmacy, med-interaction, subscription)
  - 2 foundation modules (tenant-config admin reads + 503 writes)
- For each row: spec ref + canonical version + test files + BLOCKED status (if applicable)
- Cross-link existing slice status docs (don't duplicate them; reference them)
- Revision-history block (r1) per Sprint 5 living-doc convention

---

## Definition of Done — Sprint 6

- [ ] PM-brief verification gate run + findings recorded in SPRINT_6_REVIEW.md (this is now standing per `SCRUM_OPERATING_MODEL.md`)
- [ ] TLC-016 RLS policy lockdown test authored
- [ ] TLC-016 Codex FIRE returns; HIGH/CRITICAL findings closed in-sprint via fix-forward
- [ ] TLC-017 traceability matrix doc filed
- [ ] CI green at sprint end
- [ ] No invariants relaxed (I-023 reaffirmed via lockdown)
- [ ] No production-code changes outside scope (TLC-016 = pure tests; TLC-017 = pure docs)
- [ ] `docs/SPRINT_6_REVIEW.md` filed (with verification gate findings + Codex findings)
- [ ] `docs/SPRINT_6_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 7 (verification gate runs again)

---

## Risks (PM-flagged + SM additions)

- **PM Risk #1: Migration ordering drift.** If a future migration adds/removes a policy without updating the count assertion, drift goes undetected. Mitigation: derive expected list dynamically from `pg_class WHERE relrowsecurity = true AND relname NOT IN (<platform-level set>)`; explicitly assert count = 21 so dropped policies surface as test failures.
- **PM Risk #2: `tenants` table exclusion.** Platform-level lookup; carries `id` as tenant identifier; no `tenant_id` column on itself. Test must exclude.
- **SM addition: tests/setup.ts requires Postgres.** TLC-016 is DB-backed (queries `pg_class` + `pg_policies`); locally skippable but CI provides ephemeral Postgres. Same pattern as existing integration tests.

---

## Codex strategy detail

**TLC-016 — FIRE.** Narrow scope:
```
node "C:/Users/menso/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" adversarial-review "--background --base 804c294 tests/contracts/rls-policy-coverage-lockdown.test.ts migrations/"
```

Hard 15-min cap. If review hasn't completed by sprint review filing time, accept Sprint 6 anyway and surface partial findings as Sprint 7 backlog (per Sprint 2 retro lesson + Sprint 5 precedent — Codex returned in <30s on Sprint 5 TLC-013).

**TLC-017 — SKIP.** Pure docs consolidation; pre-empt rationale (Sprint 4 retro standing rule).
