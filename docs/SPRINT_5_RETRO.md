# Sprint 5 Retrospective — Telecheck-app autonomous build

**Sprint:** 5
**Window:** 2026-05-05 (single-day burn)
**Sprint goal:** Close 2 verified idempotency invariant gaps + audit ORT v1.5 launch-readiness items + reset coverage-audit doc filename convention — **Achieved**
**Total commits:** 4 / 4 budgeted (100% utilization — tightest yet; included 1 Codex fix-forward in-sprint)

---

## What went well

- **Codex earned its keep on TLC-013.** First Codex run since Sprint 1 (Sprint 2/3/4 all skipped per pre-empt rationale). Caught a genuine HIGH finding the SM had missed: TTL test was over-permissive (accepted any 4xx as proof TTL works). Fix-forward in-sprint per HIGH severity gating; Codex re-verify returned APPROVE/Ship. The Sprint 5 plan's "FIRE on TLC-013 because real coverage gaps warrant adversarial scrutiny" judgment validated.
- **Codex round-trip was fast.** Round 1 (~30s) → fix-forward (one Edit) → Round 2 (~30s) → APPROVE. Total in-sprint Codex overhead ≈ 2 minutes. Hard 15-min cap was not approached.
- **PM rubric updates landed in Sprint 4 paid back this sprint.** TLC-014 descope at PM kickoff applied "verify before authoring" sub-rule cleanly. TLC-013 PM brief had wire-protocol vocabulary check passing (verified internal.idempotency.missing_key + body_mismatch in `idempotency.ts`). The sub-rules from Sprint 1/3 retro lessons are doing real work.
- **Living-doc filename convention applied.** Sprint 4 retro process item resolved at Sprint 5 kickoff; both CRISIS_DETECTION_COVERAGE_AUDIT.md (renamed) and ORT_V1_5_TESTABLE_ITEMS_AUDIT.md (new) follow the non-dated single-living-doc pattern with revision-history blocks.
- **Endpoint canonicalization caught at TLC-013 authoring.** SM noticed mid-authoring that the test's UPDATE WHERE clause used `'POST /v0/forms/templates'` but the plugin canonicalizes endpoint as path-only (`/v0/forms/templates`). Fixed before commit; added a `RETURNING (1)::text AS c` + `expect(updated).toBe(1)` sanity check so the test fails loudly if the seed doesn't take. Prevents the "test passes for the wrong reason" failure class.
- **TLC-015 surfaced 4 verified-real Sprint 6+ candidates** with actual ORT row IDs. Sprint 6 backlog is now PM-research-grade rather than improvised.

---

## What didn't

- **PM brief hallucinated 3 ORT IDs** (OR-253, OR-244, OR-255 don't exist in the actual ORT — highest in §3 is OR-243). Same failure class as Sprint 3's wire-protocol-identifier hallucination (PM proposed `internal.module.blocked` instead of canonical `internal.service.unavailable`). The wire-protocol vocabulary check sub-rule in the PM rubric currently only covers error codes / event types / state values; spec-corpus identifiers (ORT row IDs, ADR numbers, Promotion Ledger entries, slice PRD section refs) are NOT covered. The SM caught the hallucination at execution time by reading the ORT directly, but the rubric should prevent it at PM-brief time.
- **Sprint 5 hit 100% budget utilization.** Tightest yet (33% / 30% / 43% / 75% / 100% across Sprints 1-5). The trend is concerning — if Sprint 6 also lands at 100%+, the 1.2× slack is likely too tight. Mitigation: watch Sprint 6 actuals; if 100%+, widen to 1.3×.
- **Codex fix-forward consumed 1 commit of budget.** This is fine — the budget formula already includes "fix-forward room" per Sprint 1 plan — but the budget formula itself doesn't currently distinguish "story commits" from "fix-forward commits". For Sprints with Codex FIRE, the budget should explicitly reserve N fix-forward slots = expected-Codex-findings-with-HIGH-severity. Defer this refinement to Sprint 6+ if Codex FIRE becomes more frequent.
- **TLC-013 endpoint canonicalization required reading idempotency.ts mid-authoring.** Should have been caught by PM verify-before-authoring (PM should have read idempotency.ts and noted the canonicalization rule). Defer this to Sprint 6 PM rubric: PM grep should also surface internal canonicalization patterns when the test depends on them.

---

## Process changes for Sprint 6

1. **Extend PM rubric "wire-protocol vocabulary check" sub-rule to spec-corpus identifiers.** Sprint 6 kickoff commit should include the rubric edit. Specifically:
   - ORT row IDs (verify against `Telecheck_Operational_Readiness_Todo_v1_5.md`)
   - ADR numbers (verify against `Telecheck_ADR_Set_v1_0.md` + addenda)
   - Promotion Ledger entry IDs (verify against `Telecheck_Promotion_Ledger.md`)
   - Slice PRD section references (verify against the cited slice PRD file)

2. **PM brief should include `internal canonicalization patterns` check when test depends on internal API contracts.** When a story authors a test that depends on internal canonicalization (URL path, header normalization, key formatting), PM should grep the production code for the canonicalization function and surface the rule. Mitigates the TLC-013 endpoint-canonicalization gotcha.

3. **Budget formula refinement for Codex FIRE sprints.** Reserve explicit fix-forward slot(s) when Codex is fired. Concretely: budget = sum(story commits × 1.2) + 1 (kickoff) + 1 (review/retro) + 1 per Codex-FIRE story (fix-forward reserve). For Sprint 5 retro: this would have been 2×1.2 + 1 + 1 + 1 = ~5 commits budget vs 4 actual + reserve = 5. Sprint 5 came in at 4 because Codex returned only 1 HIGH (closed in 1 commit) — tighter than reserve.

4. **Watch utilization signal.** If Sprint 6 lands at 100%+, widen slack to 1.3×. The 1.2× was correct for Sprint 1-4 (33-75%); convergence at 100% suggests too tight.

---

## Lessons feeding the PM rubric

- **PM should not propose spec-corpus identifiers without verification.** Same failure class as wire-protocol identifiers. Add to `.claude/agents/project-manager.md` as a sub-rule extension. (Sprint 6 kickoff deliverable.)
- **PM should grep internal canonicalization functions when tests depend on them.** Add to "What you do" section under decision rule 4 / 6. When proposing a test that asserts on URL paths, header values, key formats, etc., PM brief should include the canonicalization rule the test depends on. (Sprint 6 kickoff deliverable.)

---

## Forward-looking notes for Sprint 6

- **Sprint 6 candidates are pre-validated** by TLC-015 audit:
  - TLC-016 RLS policy static-analysis lockdown (highest leverage; OR-112 + OR-236)
  - TLC-017 Build-vs-spec traceability consolidation (OR-216)
  - TLC-018 Foundation-layer perf budget tests (OR-218; lower priority)
  - TLC-019 Data-filtering implementation status doc (OR-208; lowest)
- **Codex strategy for Sprint 6:** TLC-016 is novel (first RLS policy static-analysis test) — FIRE with narrow scope. TLC-017 (docs consolidation) and TLC-019 (status doc) — likely SKIP per pre-empt rationale. TLC-018 (perf budget) — depends on which surfaces ship; if measurement infra needs authoring, FIRE; if it's just adding assertions to existing infra, SKIP.
- **Pre-pave runway is now mostly exhausted.** TLC-013 closed the last clean idempotency gap; TLC-016 is the last clean static-analysis-lockdown candidate. After Sprint 6, work pivots to either Slice 4 (if SI-001 closes) OR launch-readiness items that depend on slice authoring (which would be blocked).

---

## Codex tracking — first substantive sprint

- **Sprint 1:** Codex returned 1 MEDIUM (`pharmacy-blocked-handler`). Closed via fix-forward at `5615feb`.
- **Sprint 2:** Codex SKIPPED.
- **Sprint 3:** Codex SKIPPED.
- **Sprint 4:** Codex SKIPPED.
- **Sprint 5:** Codex FIRED on TLC-013. Returned 1 HIGH (`idempotency-r5`). Closed via fix-forward at `0f4a757`. Re-verify: APPROVE/ship.

Cumulative Codex findings: 2 (1 MEDIUM + 1 HIGH); both closed in-sprint via fix-forward; both surfaced classes of bugs the SM had not caught (pharmacy liveness/readiness conflation; idempotency TTL test over-permissive). Codex pattern is healthy: SKIP for low-novelty, FIRE for new-coverage work.

---

## Final commit cumulative state

- Head: `1eab1a6`
- Sprint commits: 4 (kickoff `04a33ac` + TLC-013 `3e37433` + Codex fix-forward `0f4a757` + TLC-015 `1eab1a6`)
- CI: green expected (lint + type-check clean; integration + contract tests run in CI)
- DoD: 8 of 8 boxes per story green (Codex findings included; HIGH closed in-sprint)
- Process docs added by Sprint 5: SPRINT_5_PLAN.md + ORT_V1_5_TESTABLE_ITEMS_AUDIT.md + SPRINT_5_REVIEW.md + SPRINT_5_RETRO.md (this doc)
- Coverage-audit docs renamed to non-dated convention: 1 (CRISIS_DETECTION_COVERAGE_AUDIT.md)
- Module skeletons: 3 (unchanged)
- Branded ID types: 11 (unchanged)
- Cumulative Codex findings closed: 2 (1 MEDIUM + 1 HIGH)
