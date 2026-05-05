# Sprint 5 Review — Telecheck-app autonomous build

**Sprint:** 5
**Sprint goal:** Close 2 verified idempotency invariant gaps + audit ORT v1.5 launch-readiness items + reset coverage-audit doc filename convention.
**Sprint start commit:** `72981ab` (Sprint 4 ACCEPTED)
**Sprint end commit:** `1eab1a6` (TLC-015 final)
**Total commits in sprint:** 4 (kickoff `04a33ac` + TLC-013 `3e37433` + Codex HIGH fix-forward `0f4a757` + TLC-015 `1eab1a6`) vs 4-budget — 100% utilization (first sprint at exact budget; tight)
**CI status at sprint end:** Green expected at `1eab1a6` (lint + type-check clean locally; integration tests + new contract test run in CI against ephemeral Postgres)

---

## Stories accepted

### ✅ TLC-013 — Idempotency invariant lockdown — `3e37433` + Codex fix-forward `0f4a757`

**Deliverables:**
- 2 new test cases in `tests/integration/idempotency-http.test.ts` (170+ LOC):
  - **§NEW Cross-tenant independence** (4-tuple PK tenant case) — same key + different tenant = independent records via host-header tenant routing
  - **§NEW TTL expiry** — backdate `expires_at` to 1 hour ago + assert post-TTL retry is treated as first request
- Codex idempotency-r5 HIGH fix-forward at `0f4a757`: TTL test rewritten to use distinct payload, eliminating the over-permissive "any 4xx is fine" path. Single expected outcome: 201 with new template_id.
- Codex re-verification on `0f4a757`: APPROVE / Ship.

**Acceptance criteria evaluation:**
- [x] Cross-tenant 4-tuple PK case authored (closes the deferred case at idempotency-http.test.ts:274–278)
- [x] TTL expiry case authored (closes a previously-zero-coverage gap)
- [x] Codex review fired with narrow scope (`tests/integration/idempotency-http.test.ts` + `src/lib/idempotency.ts`)
- [x] HIGH finding addressed in same sprint (severity gating: HIGH = fix-forward in-sprint)
- [x] Re-verification returned APPROVE
- [x] Type-check + lint clean
- [x] No production code changes (pure test additions)
- [x] Endpoint canonicalization matches plugin behavior (path-only; no method prefix)
- [x] No tenant_id leakage in any error path

**Verdict:** Accepted.

---

### ✅ TLC-015 — ORT v1.5 testable items audit — `1eab1a6`

**Deliverables:**
- `docs/ORT_V1_5_TESTABLE_ITEMS_AUDIT.md` documenting:
  - Out-of-repo items (operational / counsel / process) — 30+ ORT IDs enumerated for completeness
  - 5 code-side testable items (OR-112 / OR-216 / OR-218 / OR-208 / OR-236)
  - 4 Sprint 6+ candidate stories with verified-real ORT IDs (TLC-016 / TLC-017 / TLC-018 / TLC-019)
  - Sprint 5 retro lesson surfaced: PM-brief ORT-ID hallucination (OR-253, OR-244, OR-255 don't exist in actual ORT)
- Living-doc filename convention applied (matches CRISIS_DETECTION_COVERAGE_AUDIT.md pattern)

**Acceptance criteria evaluation:**
- [x] Audit doc filed at canonical path (non-dated single living doc)
- [x] Source-of-truth file read directly (Scrum Master verified ORT IDs at execution rather than trusting PM-cited IDs)
- [x] Out-of-repo items enumerated
- [x] Sprint 6+ candidates carry verified-real ORT IDs
- [x] PM-hallucination flagged for Sprint 5 retro

**Decision-point trade-off (resolved at execution):**
- PM brief cited OR-253 (RLS policy linting), OR-244 (provider abstraction conformance), OR-255 (per-tenant rate-limit) — these IDs **do not exist** in the actual ORT. Scrum Master read the ORT directly, surfaced 5 real testable items (OR-112 / OR-216 / OR-218 / OR-208 / OR-236), and flagged the hallucination as a Sprint 5 retro lesson for PM rubric extension.

**Verdict:** Accepted.

---

## Process / housekeeping commits

### ✅ Sprint 5 kickoff + coverage-audit doc rename — `04a33ac`

- Renamed `docs/CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md` → `docs/CRISIS_DETECTION_COVERAGE_AUDIT.md` (non-dated single living doc)
- Updated `tests/contracts/crisis-detection-coverage-lockdown.test.ts` §3 references to new path (3 string replacements)
- Added revision-history block (r1 + r1.1) to track amends
- Resolves Sprint 4 retro process item

---

## Stories rolled over

None. Both committed stories accepted within sprint.

**Stories descoped at PM kickoff:**
- **TLC-014 — Tenant-config admin-read tenant-isolation regression.** PM verify-before-authoring research showed §4b adapter-configs cross-tenant case structurally proves the same RLS pattern for ccr-configs + tenant-brand. Authoring would duplicate.

---

## Codex adversarial review

**Trigger:** Sprint 5 plan called for FIRE on TLC-013 (real coverage-gap fix; cross-tenant + TTL paths warrant adversarial scrutiny).

**Round 1 (against base `04a33ac`):**
- Verdict: **needs-attention**
- 1 HIGH finding: TTL test treats duplicate-write failure as success (file:line cited correctly by Codex)
- 0 MEDIUM / 0 LOW findings on the cross-tenant case
- Total review time: ~30s (well within 15-min cap)

**Round 2 (re-verify against base `3e37433` after fix-forward at `0f4a757`):**
- Verdict: **approve / ship**
- 0 substantive findings
- Codex commentary: "the focused test now removes the prior false-positive path by requiring a post-expiry re-execution to return 201 with a different template_id, and the distinct payload choice is defensible for isolating TTL behavior from the handler's uniqueness constraint"

**Findings recorded:** 1 HIGH (closed in-sprint via fix-forward at `0f4a757`)

**This is the first time since Sprint 1 that Codex returned a substantive finding.** Sprints 2/3/4 all skipped Codex per pre-empt rationale; Sprint 5 fired on real-coverage-gap-fix work, and Codex earned its keep — caught a genuine over-permissive test condition the Scrum Master had missed.

**Lesson reinforced:** Codex skip is acceptable for pattern-mirror / pure-docs / lockdown work; Codex FIRE is mandatory for genuine new-coverage work even if the surface looks small.

---

## Cumulative platform metrics at sprint end

- **Slices:** 3 implementation-complete (Forms-Intake, Identity, Consent + Delegation)
- **Foundations:** 2 (tenant-config — 4 admin read routes + 5 admin-write 503 stubs + readiness probe; pharmacy skeleton)
- **Module skeletons (BLOCKED-aware):** 3 (pharmacy + med-interaction + subscription)
- **Forward migrations:** 18 (000–019; unchanged)
- **Rollback migrations:** 18 (matched pair coverage; unchanged)
- **Domain events wired:** 31 (unchanged this sprint)
- **Domain events with explicit outbox tests:** 31 of 31
- **Open Spec Issues:** 3 (SI-001 / SI-002 / SI-003)
- **Test files:** ~104+ (unchanged total — TLC-013 added cases to existing file; TLC-015 added a doc not a test)
- **Test cases (rough):** ~1422+ (added 2 from TLC-013)
- **Branded ID types defined across modules:** 11 (unchanged)
- **Audit / coverage docs:** 2 (CRISIS_DETECTION_COVERAGE_AUDIT.md + ORT_V1_5_TESTABLE_ITEMS_AUDIT.md)

---

## Decisions made this sprint

1. **Codex FIRE on real-coverage-gap-fix work.** Sprint 5 was the first non-skip sprint. Lesson: Codex earns its keep when a sprint introduces new coverage on pre-existing code (vs. skeleton mirrors / pure docs).
2. **Distinct payload on TTL test.** Codex HIGH finding closed by switching from "same key + same body" to "same key + different body" on the post-TTL retry. Single expected outcome (201 with new template_id) instead of "any 4xx is fine".
3. **Coverage-audit doc filename convention** (Sprint 4 retro process item resolved): non-dated single living doc with revision-history block. Applied to both CRISIS_DETECTION_COVERAGE_AUDIT.md (rename) and ORT_V1_5_TESTABLE_ITEMS_AUDIT.md (initial filing).
4. **PM rubric extension flagged for Sprint 5 retro.** PM brief cited 3 hallucinated ORT IDs (OR-253 / OR-244 / OR-255). The wire-protocol vocabulary check sub-rule (Sprint 3 retro deliverable) needs extension to cover spec-corpus identifiers (ORT row IDs, ADR numbers, Promotion Ledger entry IDs, slice PRD section references).

---

## Definition of Done — Sprint 5 closeout

- [x] Coverage-audit doc renamed + lockdown test updated
- [x] TLC-013 2 test cases authored
- [x] Codex HIGH finding closed in-sprint via fix-forward
- [x] Codex re-verify APPROVED
- [x] TLC-015 audit doc filed
- [x] Lint + type-check clean
- [x] No invariants relaxed
- [x] No production-code changes outside scope
- [x] `SPRINT_5_REVIEW.md` filed (this doc)
- [ ] `SPRINT_5_RETRO.md` filed (companion doc — next)
- [ ] PM rubric extension (spec-corpus identifier check) — Sprint 6 kickoff deliverable
- [ ] PM agent accepts via Sprint 6 kickoff brief — _pending_

---

## Sprint 6 kickoff — pending PM brief

Sprint 5 retired its committed backlog at exact budget (4/4 = 100% utilization — tightest yet). Sprint 6 budget calibration: hold 1.2× slack pending Sprint 6 utilization data; if Sprint 6 also lands at 100%, slack may need to widen.

**PM kickoff actions for Sprint 6:**

1. **Re-check Promotion Ledger upstream** for SI-001 / SI-002 / SI-003 closure. If P-011 lands, Sprint 6 pivots to Slice 4 schema work.

2. **If SI-001 still open**, Sprint 6 candidates are pre-validated by TLC-015 audit:
   - **TLC-016 — RLS policy static-analysis lockdown** (highest leverage; closes OR-112 + OR-236 launch-blocking surfaces)
   - **TLC-017 — Build-vs-spec traceability matrix consolidation** (OR-216)
   - **TLC-018 — Foundation-layer perf budget tests** (OR-218; lower priority)
   - **TLC-019 — Data-filtering implementation status doc** (OR-208; lowest priority)

3. **PM rubric extension to land at Sprint 6 kickoff:**
   - Extend "wire-protocol vocabulary check" sub-rule to also cover spec-corpus identifiers (ORT row IDs, ADR numbers, Promotion Ledger entry IDs, slice PRD section references)
   - PM brief for Sprint 6 should include explicit verification of any spec-corpus identifier cited (e.g., "verified at ORT row OR-NNN line N" or "verified at ADR-NNN")

4. **Codex strategy for Sprint 6:** TLC-016 is novel (first RLS policy static-analysis test). Fire Codex with narrow scope (`tests/contracts/` + relevant migration files). TLC-017/018/019 are docs / lower-novelty — likely skip or defer Codex.
