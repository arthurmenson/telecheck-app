# Sprint 6 Retrospective — Telecheck-app autonomous build

**Sprint:** 6
**Window:** 2026-05-05 (single-day burn)
**Sprint goal:** Author RLS policy lockdown closing OR-112 + OR-236 + consolidate slice status docs into traceability matrix (OR-216) — **Achieved**
**Total commits:** 4 / 7 budgeted (57% utilization — back below the Sprint 5 100% spike)

---

## What went well

- **PM-brief verification gate worked first time.** Inaugural run on the Sprint 6 PM brief returned ALL PASS across 8 cited identifiers. No hallucinations recurred. The Sprint 3 (`internal.module.blocked`) + Sprint 5 (`OR-253/244/255`) failure class is now mechanically caught at brief time AND brief-time prevention (PM rubric sub-rules) appears to be working — neither line of defense had to fire this sprint because the PM agent self-verified cleanly.
- **PM rubric sub-rules paid back at execution.** TLC-016 needed careful policy-name canonicalization handling (3 distinct names in production migrations). PM brief surfaced this explicitly with "DO NOT assert a fixed policy name" — exactly what the Sprint 5 internal-canonicalization-pattern sub-rule was designed for. SM applied it without re-deriving.
- **Codex caught a real bug fast.** ~30s round-trip from FIRE to MEDIUM finding. The §3 platform-level test was soft-skipping on missing tables — exactly the false-green class the lockdown is meant to prevent. Fix-forward was 1-line; Codex re-verify APPROVED in another ~30s. Total Codex overhead this sprint ~1.5 minutes.
- **Severity-gating deviation surfaced explicitly.** Strict reading says MEDIUM = defer; the deviation is rule-aware and rationale-documented in the fix-forward commit. Sprint 6 retro will propose a sub-rule extension; this is exactly how process drift gets caught and codified.
- **3rd application of living-doc convention.** CRISIS_DETECTION_COVERAGE_AUDIT.md → ORT_V1_5_TESTABLE_ITEMS_AUDIT.md → BUILD_VS_SPEC_TRACEABILITY_MATRIX.md. All three follow the same pattern (non-dated single artifact + revision-history block). Reproducible at near-zero cost.
- **TLC-017 surfaced a clear "pre-pave runway nearing exhaustion" signal.** §5 of the traceability matrix sequences Sprint 7+ candidates and flags that after TLC-018/019 close, work pivots to either Slice 4 (if SI-001 closes upstream) OR operational items requiring Evans's emergency access. This is the kind of forward visibility that lets Sprint 11 launch-prep not be a surprise.

---

## What didn't

- **PM utilization signal is volatile.** Sprint utilizations: 33% / 30% / 43% / 75% / 100% / 57%. Sprint 5's 100% looked like a tightening trend; Sprint 6 retreated. Hard to read forward. Hold 1.2× slack for Sprint 7 and watch.
- **TLC-016 §3 false-green path was a real miss.** Codex caught it in 30 seconds; SM had not surfaced it during authoring. Lesson: when authoring contract-lockdown tests, audit each early-`return` for "does this hide a real failure from CI?" Add to SM execution checklist for Sprint 7+ contract-lockdown work.
- **Severity-gating ambiguity exposed.** Sprint 6 hit the first MEDIUM finding on a contract-lockdown surface; strict severity gating said "defer", judgment said "fix-forward". The deviation worked but only because rationale was documented. If a future sprint hits the same situation and an SM doesn't document the deviation, the audit trail breaks. Sprint 7 should land a sub-rule extension to remove the ambiguity.

---

## Process changes for Sprint 7

1. **Add severity-gating sub-rule to `SCRUM_OPERATING_MODEL.md`:** "MEDIUM findings on contract-lockdown surfaces (`tests/contracts/`) where the fix is trivial (≤5 LOC) AND the finding hits the test's core value proposition = fix-forward in-sprint." General MEDIUM-deferral rule remains for all other surfaces.
2. **Add SM execution checklist entry:** for any new contract-lockdown test, audit each early-`return` / soft-skip for "does this hide a real failure from CI?" Apply before commit, not after Codex.
3. **Pre-pave-runway-exhaustion signal:** TLC-017 traceability matrix now serves as the canonical view of "what's left to close before SI-001 / slice-PRD ratifications unblock further work". PM should reference §5 of the matrix when proposing Sprint 7+ stories.

---

## Lessons feeding the PM rubric

- The PM rubric extensions from Sprint 1/3/5 retros are stable and working; no new sub-rules proposed by Sprint 6.
- One sub-rule clarification: PM should also surface "is the SM's execution path obvious?" for stories that require non-trivial test authoring. TLC-016's policy-name canonicalization handling was non-obvious; PM surfacing it saved SM re-derivation. PM did this implicitly; codify as: "When the story requires non-trivial test authoring, the brief should explicitly call out any production-code conventions the test depends on (canonicalization rules, naming exceptions, schema variations)." This is a slight strengthening of the existing internal-canonicalization-pattern check sub-rule.

---

## Forward-looking notes for Sprint 7

- **Sprint 7 candidates pre-validated:** TLC-018 (foundation-layer perf budget tests; OR-218; Codex FIRE-eligible if measurement infra is novel) + TLC-019 (data-filtering status doc; OR-208; Codex SKIP).
- **After Sprint 7, pre-pave runway is exhausted.** PM should surface to Evans either:
  - (a) "All testable launch-readiness items closed; awaiting SI-001/002/003 upstream OR slice PRD ratifications OR Evans's emergency-access actions for vendor integration" — possibly emergency surfacing
  - (b) Pivot to authoring an Async Consult slice if a draft PRD exists in the spec corpus (PM grep at Sprint 8 kickoff)
- **Codex strategy stable.** SKIP for pattern-mirrors / docs / lockdown-on-existing-code. FIRE for new-coverage / novel-test-class / security-adjacent work. Sprint 5 + Sprint 6 both validated.
- **Test-cumulative-count growth:** Sprint 1 = 14; Sprint 2 = 13; Sprint 3 = 9; Sprint 4 = 11; Sprint 5 = 2; Sprint 6 = 46. Sprint 6 is the largest case-count jump because TLC-016 used `it.each` over 21 tables × 2 cases. Cumulative since baseline ≈ +95 cases.

---

## Final commit cumulative state

- Head: `c9bf34c`
- Sprint commits: 4 (kickoff `b03958e` + TLC-016 `75640ef` + Codex MEDIUM fix-forward `2dece96` + TLC-017 `c9bf34c`)
- CI: green expected (lint + type-check clean; integration + 2 new contract tests run in CI)
- DoD: 8 of 8 boxes per story green (Codex finding closed in-sprint with severity-gating deviation documented)
- Process docs added by Sprint 6: SPRINT_6_PLAN.md + BUILD_VS_SPEC_TRACEABILITY_MATRIX.md + SPRINT_6_REVIEW.md + SPRINT_6_RETRO.md (this doc)
- New test file: tests/contracts/rls-policy-coverage-lockdown.test.ts (265 LOC, 46 cases)
- New living-doc artifact: BUILD_VS_SPEC_TRACEABILITY_MATRIX.md
- Cumulative Codex findings closed: 3 (1 Sprint 1 MEDIUM + 1 Sprint 5 HIGH + 1 Sprint 6 MEDIUM)
