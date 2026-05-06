# Sprint 22 Retrospective — Telecheck-app autonomous build

**Sprint:** 22
**Window:** 2026-05-06 (single-day, post-Sprint-21 close).
**Sprint goal:** TLC-040 §3b + TLC-041 §1-7 + §7a shared root-cause investigation — **FULL ACCEPTANCE.**
**Total commits:** 2 / 5 budgeted (40% utilization).

---

## What went well

- **Sprint 21's shared-root-cause hypothesis paid off massively.** Sprint 21 retro called the deferral correctly: don't burn budget chasing §3b in isolation when TLC-041 has the same `expected 400 to be ___` symptom. Sprint 22's combined investigation confirmed the hypothesis (idempotency middleware) and closed 8 test cases with ONE fix-forward. This is the highest-leverage sprint in the autonomous arc to date — 8 cases closed in 2 commits.
- **Comparison-with-passing-tests was the right diagnostic technique.** Once both failing patterns matched ("non-GET + JWT + tenant-context + 400"), scanning the passing equivalents (`idempotency-http.test.ts`, `identity-login-http.test.ts`) for what they include that failing tests don't surfaced the missing `Idempotency-Key` header in seconds. Faster than reading middleware source code from scratch.
- **Time-boxed correctly to budget.** Sprint 22 used 2 of 5 commits = 40%. The investigation could have stretched if I'd gone straight to log-tracing instead of starting with comparison; the comparison approach kept the work in a single commit.
- **Required-vs-non-required CI gates handled the merge correctly.** PR #18 had ci.yml failing (6 unrelated tests) but verify-metadata + Performance benchmarks passing → mergeable per branch protection. Confirmed strict mode + minimal required-set is the right tradeoff for the autonomous arc: prevents over-blocking while preserving guardrails.
- **PM-brief verification gate landed clean for the 17th consecutive sprint.**

---

## What didn't

- **6 unrelated test files still failing in ci.yml.** Net ci.yml progress this sprint is +2 (93 → 95). The remaining 6 failures share a different root cause (`installTestAppRole pg/lib/client.js:631` — pg connection error in test setup). These are likely a flake/race; Sprint 23 priority 1 (TLC-044) investigates with the same shared-root-cause discipline.
- **Idempotency-Key requirement was not in test-author guidance.** The IDEMPOTENCY v5.1 contract clearly specifies the header is required for state-changing requests, but test-helper documentation (e.g., `tests/helpers/`) does not surface this. Sprint 23/24 candidate: add a `mintIdempotentRequest()` helper or a default-include rule in `tests/helpers/`, so future state-changing test injects do not silently miss the header.

---

## Process changes for Sprint 23

1. **Apply the same "investigate ONCE, close MANY" discipline to TLC-044.** 6 test files all fail with `installTestAppRole pg/lib/client.js:631` — same diagnostic shape as Sprint 21's `expected 400 to be ___`. Time-box 1 sprint, single-fix should close all 6.
2. **Sprint 23 candidate scope:**
   - **TLC-044** (priority 1, NEW): 6-file `installTestAppRole` flake/race → single fix-forward
   - **TLC-042 + TLC-043**: re-validate post-Sprint-19-merge to see if TLC-034 schema_migrations changes resolved them (or if TLC-044's fix transitively resolves them)
   - **TLC-038**: PROJECT_CONVENTIONS r3 → r4 codification — now has a second proof-point (Sprint 22's shared-root-cause closure pattern); promote to §5.7

---

## Lessons feeding the PM rubric

**Promotion candidate (Sprint 23):** "Shared-root-cause clusters" → PROJECT_CONVENTIONS §5.7.

> When 2+ tickets fail with the same diagnostic shape (same status code expected vs actual; same upstream-of-handler position), defer them as a cluster to a single investigation sprint. ONE root-cause find closes all members. Sprint 21 retro intuited this; Sprint 22 proved it (8 cases / 2 commits / 40% budget).

Comparison-with-passing-tests as a diagnostic technique should also be codified — faster than middleware source-reading when the symptom is "request rejected before reaching handler."

---

## Codex tracking — Sprint 22 finding ledger

| Round | Sub-story | Severity | Status |
|---|---|---|---|
| (none) | TLC-040 §3b + TLC-041 | — | Codex SKIP per §5.2 (test-only header migration) |

Total Sprint 22: 0 Codex rounds; 0 findings.

---

## Final commit cumulative state

- Sprint 22 head: `<TBD>` on `feat/sprint-22-close` (PR #19)
- Sprint commits: 2 (PR #18 substantive `2a748ad` + this Sprint 22 close on PR #19) of 5 budget = 40% utilization
- Process docs: SPRINT_22_PLAN.md + SPRINT_22_REVIEW.md + SPRINT_22_RETRO.md
- Code state: shared-root-cause idempotency-header fix landed (`055b0bd`)
- ci.yml: 95/101 test files passing (+2 from sprint start)
- Sprint 23 hand-off: TLC-044 6-file `installTestAppRole` shared-root-cause investigation
