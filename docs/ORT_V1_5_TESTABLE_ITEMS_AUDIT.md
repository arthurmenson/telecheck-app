# ORT v1.5 Testable Items Audit

**Living artifact** — amend in place when re-run; bump revision-line below.

**Revision history:**
- **r1 (2026-05-05, Sprint 5 / TLC-015):** initial audit. Scrum Master read `Telecheck_Operational_Readiness_Todo_v1_5.md` directly to surface code-side testable items (PM brief had cited some ORT IDs that don't exist in the actual ORT — Sprint 5 retro lesson).

**Author:** Scrum Master (Claude Code main turn)
**Source-of-truth:** `Telecheck_Operational_Readiness_Todo_v1_5.md` (sibling spec corpus repo `arthurmenson/telecheckONE`)

---

## Purpose

Surface which ORT v1.5 items are testable / implementable in the **telecheck-app code repo** (vs. operational items owned by Counsel / Operations / external vendors). The output of this audit drives Sprint 6+ story candidates.

The ORT is a 311-row launch-readiness tracker spanning Tier 0 (reviewer-blocking) → Tier 3 (post-launch follow-on). Most items are owned by Counsel (Security / Privacy / Regulatory / Clinical / AI / Product / Operations) or external partners. A subset are code-side and land on this repo's backlog.

---

## Out-of-repo (operational / counsel / process items — NOT code-side)

These are listed for completeness so the audit is comprehensive; they are out of scope for this telecheck-app build.

| OR ID | Item | Owner |
| --- | --- | --- |
| OR-001 / OR-002 / OR-004 / OR-005 / OR-006 | Threat model / DPIA / clinical safety case / AI bias / etc. | Counsel |
| OR-101 / OR-102 / OR-104 / OR-106..110 | Ghana legal entity / regulatory / pharmacovigilance / pricing / KB sourcing | Counsel + Registry §6 |
| OR-113 / OR-114 / OR-115 | Marketing copy governance lead / first molecule approval / CCR marketing keys | Product Lead + Regulatory |
| OR-116..119 | REC partnership / consent text / DSA template / de-id standard (research data) | Privacy + Legal |
| OR-201..207 / OR-209..215 | Various clinical / AI / privacy / operations contracts | Counsel |
| OR-217 | Pen test scope (pre-launch external pen test) | Counsel Security |
| OR-219 / OR-227 / OR-220..228 / OR-231..233 | Patient research / IA / UX specs | UI/UX Pressure Review |
| OR-234 / OR-237 / OR-238 / OR-239 / OR-240 | US legal entity / tenant onboarding manual / SOC 2 evidence / LiveKit ops / Faster-Whisper | Operations + Counsel |
| OR-241 | Per-tenant audit log access UI | Code-side BUT depends on Admin Backend slice v1.1 (BLOCKED — TLC-009 already pre-paved 503 surface) |
| OR-242 | Platform-admin break-glass implementation | Code-side BUT depends on Admin Backend slice v1.1 |
| OR-243 | Tenant configuration UI | Code-side BUT depends on Admin Backend slice v1.1 |

---

## Code-side testable items (Sprint 6+ candidates)

These are items that are testable / implementable in this repo without depending on slices that haven't been authored.

### OR-112 — Multi-tenant isolation testing battery (Tier 1; launch-blocking)

**Original ORT text:** Test strategy specification — integration, e2e, clinical safety, regression — scope expanded 2026-04-25 to include multi-tenant isolation testing (cross-tenant access attempts, RLS policy validation, per-tenant KMS key isolation).

**Code-side scope:**
- Cross-tenant access-attempt suite per module (already partially done in TLC-002 identity + TLC-004 §4b adapter-config + consent-cross-tenant-isolation.test.ts)
- RLS policy validation across all tenant-scoped tables (gap: no static-analysis test today asserts every tenant-scoped table has RLS POLICY rows)
- Per-tenant KMS key isolation tests (depends on Admin Backend slice v1.1's encryption-at-rest wiring — partially blocked)

**Estimated story shape:** 1-2 commits per module's cross-tenant suite; 1 commit for RLS policy static-analysis test (mirror of `canonical-glossary.test.ts` pattern)

**Sprint 6+ candidate:** **TLC-016 — RLS policy static-analysis lockdown test.** Verify-before-authoring: PM grep at kickoff confirms there's no existing test asserting RLS POLICY rows for every tenant-scoped table; if there is, descope. Decision rule: 3 (diminishing-returns hygiene).

### OR-216 — Build vs spec traceability matrix (Tier 1)

**Original ORT text:** Build vs spec traceability matrix.

**Code-side scope:**
- Authoring a doc that maps each implemented spec invariant / endpoint / state-machine to the test file(s) covering it
- This is a documentation deliverable, not a test
- Already partially done via the per-slice status docs (`FORMS_INTAKE_SLICE_STATUS_*`, etc.); could be consolidated

**Estimated story shape:** 1 commit (single doc author + cross-link existing slice status docs)

**Sprint 6+ candidate:** **TLC-017 — Build-vs-spec traceability matrix consolidation.** Decision rule: 6 (UAT / launch-readiness).

### OR-218 — Performance and load test plan (Tier 1)

**Original ORT text:** Performance and load test plan (interaction engine <2s, emergency <60s under p95 load) — scope expanded 2026-04-25 to include AI lab interpretation accuracy regression per ADR-019.

**Code-side scope:**
- Performance budget tests (e.g., assert handler latency p95 < N ms under representative load)
- Most of this depends on slices that don't exist yet (interaction engine = Med Interaction slice; AI lab = Labs slice)
- Achievable today: foundation-layer perf tests (idempotency lookup, audit emit, RLS query) under representative load

**Estimated story shape:** 2-3 commits (per-foundation-layer perf test)

**Sprint 6+ candidate:** **TLC-018 — Foundation-layer perf budget tests.** Decision rule: 6 (launch-readiness). Lower priority than OR-112/OR-216 because most surfaces depend on unauthored slices.

### OR-208 — Data-level filtering implementation choice (Tier 2)

**Original ORT text:** Data-level filtering implementation choice (RLS vs view vs app-layer).

**Code-side scope:**
- Already RESOLVED implicitly: ADR-023 chose 3-layer enforcement (RLS + app-layer + per-tenant KMS). Implementation matches at `src/lib/rls.ts` + `src/lib/tenant-context.ts`.
- Remaining: a status doc capturing the decision rationale + the test surface that proves it (cross-references to existing tests)

**Estimated story shape:** 1 commit (status doc)

**Sprint 6+ candidate:** **TLC-019 — Data-filtering implementation status doc.** Decision rule: 6. Lower priority — implicit closure already exists in ADR-023.

### OR-236 — Multi-tenant isolation security review (Tier 1; launch-blocking)

**Original ORT text:** Multi-tenant isolation security review — application-layer filtering, PostgreSQL RLS policies, per-tenant KMS keys, cross-tenant access attempt testing.

**Code-side scope:**
- Largely overlaps with OR-112; security-review angle is mostly the same testing surface
- Counsel Security review of code-side artifacts is out-of-repo (process item)

**Recommendation:** Roll into TLC-016 (OR-112 RLS policy lockdown). No separate Sprint candidate.

---

## Recommended Sprint 6+ sequencing

Based on this audit, recommended Sprint 6 candidates (PM verifies at kickoff per "verify before authoring"):

1. **TLC-016 — RLS policy static-analysis lockdown** (highest leverage; closes OR-112 + OR-236 launch-blocking surfaces; static-analysis pattern already proven via `canonical-glossary.test.ts` + `crisis-detection-coverage-lockdown.test.ts`)
2. **TLC-017 — Build-vs-spec traceability matrix consolidation** (consolidates existing slice status docs; closes OR-216)
3. **TLC-018 — Foundation-layer perf budget tests** (lower priority; lands when foundation surfaces are stable)
4. **TLC-019 — Data-filtering implementation status doc** (lowest priority; ADR-023 implicit closure already exists)

If SI-001 closes between Sprint 5 and Sprint 6, all of TLC-016..019 yield to Slice 4 schema work (the launch-critical path).

---

## Sprint 5 retro lesson (PM brief contract-vocabulary check failed on ORT IDs)

The PM brief at Sprint 5 kickoff cited specific ORT IDs (OR-253, OR-244, OR-255) that **do not exist in the actual ORT** (the ORT's highest-numbered item in §3 is OR-243). This is the same failure class that the Sprint 3 retro flagged for wire-protocol identifiers (`internal.module.blocked` was hallucinated and would have been a Codex finding had it shipped).

The PM rubric currently has a "wire-protocol vocabulary check" sub-rule for error codes / event types / state values. **Sprint 5 retro will extend this to spec-corpus identifiers** (ORT row IDs, ADR numbers, Promotion Ledger entry IDs, slice PRD section references). PM should NOT propose specific spec-corpus identifiers without verifying they exist in the source-of-truth file.

The Scrum Master caught this here at execution time (read the ORT directly instead of trusting the PM-cited IDs); next sprint the rubric should prevent the hallucination at PM-brief time.

---

## Spec references

- `Telecheck_Operational_Readiness_Todo_v1_5.md` (the source ORT)
- ADR-023 (multi-tenancy 3-layer enforcement — drives OR-112 + OR-208 + OR-236)
- ADR-019 (AI lab interpretation accuracy regression — referenced from OR-218)
- ADR-024 (per-tenant KMS — drives OR-241/242/243 indirectly)
- Master PRD v1.10 §17 + Glossary v5.2 C3 (brand-structure rules — relevant for OR-234 / OR-243)
