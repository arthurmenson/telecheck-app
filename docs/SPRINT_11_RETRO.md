# Sprint 11 Retrospective — Telecheck-app autonomous build

**Sprint:** 11
**Window:** 2026-05-05 (single-day; lighter than Sprint 9 + Sprint 10)
**Sprint goal:** Close OR-218 via 3-condition perf-budget hardening — **Partially achieved (2 of 3 conditions closed; 3rd intentionally deferred to Sprint 12+)**
**Total commits:** 5 / 10 budgeted (50% utilization)

---

## What went well

- **PM-brief verification gate landed clean for the 6th consecutive sprint.** Sprint 3 + Sprint 5 hallucination class has not recurred since `804c294`. The discipline is now stable across 6 PM iterations.
- **Doc-drift catch via flag-as-unverified** (Sprint 10 retro lesson): PM Sprint 11 brief flagged `vitest bench --baseline` as unverified; SM gate verification caught the doc-drift at `tests/perf/README.md:9` + `:34`. Sprint 10 retro lesson delivered substantive value within 1 sprint.
- **End-to-end local verification BEFORE commit.** Sprint 7 retro lesson "pre-commit local-run for new infra" applied: bench harness + threshold check ran cleanly locally before commits landed. Caught the JSON-shape gotcha (percentiles directly on task object, not nested under `.result`) at authoring time, not at Codex review.
- **Codex iteration produced consistently substantive findings** but at lower density than Sprint 9/10. 4 fix-forward closures (2 HIGH + 2 MEDIUM) across 2 sub-stories (TLC-023a + TLC-023b). Each surfaced a real defect class. Each round converged in 1 fix-forward (vs Sprint 10 TLC-021d's 4 rounds).
- **Mid-sprint pivot on warn-only-landing semantics.** Codex r1 on TLC-023b correctly identified that `continue-on-error: true` at the workflow level contradicts the "warn-only" intent. Right interpretation: warn-only is a branch-protection-layer concern (workflow not required), not a workflow-level concern (always passes regardless of breach). Subtle but important distinction; Codex earned its keep on the discipline.
- **TLC-023c deferred cleanly.** Sprint 11 plan + `tests/perf/README.md` had documented the v0.1 → blocking transition as gradual; deferring TLC-023c to Sprint 12 is exactly the design intent, not a scope-cutting compromise.

---

## What didn't

- **JSON-shape gotcha cost 1 retest cycle.** Initial check-thresholds.ts assumed `task.result.p99` shape; actual is `task.p99` directly. Caught at authoring (local end-to-end run) BEFORE commit, but it was an avoidable miss. PM brief could have included a "vitest 2.1 outputJson shape spec" — but that's pushing PM scope; alternative: SM should always run the new infra at least once before authoring assumptions about it. Sprint 11 retro reinforces Sprint 7 process change #2 ("pre-commit local-run for new infra").
- **5/10 commit utilization is far below the 1.3× slack budget.** Sprint 11 was lighter than expected. The work is genuinely simpler than Sprint 9/10 schema authoring (perf-budget framework is mostly mechanics, not security-relevant business logic). For Sprint 12+, budget should reflect the lower-novelty class: 1.2× slack rather than 1.3×.
- **TLC-023c carry-over to Sprint 12 splits a single ORT row across 2 sprints.** OR-218 closure is 2-of-3 conditions met at Sprint 11 close; the 3rd condition (required-blocking via branch protection) needs CI variance data. Pragmatically OK, but the ORT row remains "scaffolded, not closed" until TLC-023c lands. Sprint 12 + 13 retros should track whether CI-runner variance stabilization actually materializes within 3-5 runs.

---

## Process changes for Sprint 12

1. **Slack heuristic refinement: lower-novelty work uses 1.2× slack.** Sprint 11 was the first sprint since pre-pave runway exhaustion (Sprint 7 retro flag) where the work was framework/mechanics-heavy rather than security-relevant business logic. Pattern: schema/state-machine/service authoring = 1.3× + 4 fix-forward reserves; framework/perf/test-infra = 1.2× + 2 fix-forward reserves.

2. **TLC-024 candidate sequencing:** Sprint 12 PM kickoff considers TLC-024 (second bench target — likely `withTenantBoundConnection` or `emitAudit` perf scenario) as a sibling to TLC-023c branch-protection wire-up. Both close out OR-218's residual scope + extend the perf coverage to the next hot path.

3. **OR-218 promotion check at Sprint 13+:** if Sprint 12 closes TLC-023c with stable CI variance, Sprint 13 PM kickoff considers whether the perf bench is generic enough to be a published convention (move thresholds to a configurable file + extend to per-slice automatic discovery). For now, hardcoded 4 thresholds in check-thresholds.ts is the right v0.1 shape.

---

## Lessons feeding the PM rubric

- **No new sub-rules proposed.** The 4 sub-rules from Sprint 1/3/5 retros + 2 sub-rules from Sprint 9/10 retros are stable across 6 PM iterations.
- **Reinforcement:** Sprint 10 retro's "flag-as-unverified instead of guess" pattern delivered a real catch this sprint (the `--baseline` doc-drift). That validates the pattern; no further refinement needed.

---

## Forward-looking notes for Sprint 12

- **Sprint 12 candidate scope** (PM verifies at kickoff):
  - TLC-023c branch-protection wire-up (Evans coordinates emergency-only-access for `gh api ... branches/main/protection`)
  - TLC-024 second bench target (likely `withTenantBoundConnection` or `emitAudit` perf scenario)
  - SI-001/002/003 status check + pivot to Slice 4 if any closed
- **Sprint 12 budget:** 1.2× slack + 2 fix-forward reserves = ~8 commits expected
- **Codex strategy for Sprint 12:** FIRE on novel-of-class authoring (new bench scenario integrating with existing infra is novel-of-class — the harness pattern is established but the per-scenario assertions are new). SKIP on TLC-023c (mechanical branch-protection wire-up).

---

## Codex tracking — Sprint 11 finding ledger

| Round | Sub-story | Severity | Finding | Closure |
| --- | --- | --- | --- | --- |
| r1 (TLC-023a) | check-thresholds.ts | HIGH + MEDIUM | p75/p99 midpoint approximation; `.js` doc-drift | `3dbf021` |
| r1 (TLC-023b) | perf.yml + check-thresholds.ts | HIGH + MEDIUM | continue-on-error contradicts warn-only intent; `!== undefined` insufficient | `2f1422a` |

**Total Sprint 11:** 2 HIGH + 2 MEDIUM closed across 2 fix-forward rounds (1 per sub-story).

**Cumulative across all sprints:** 23 HIGH + 7 MEDIUM = 30 Codex findings closed.

---

## Final commit cumulative state

- Head: `2f1422a`
- Sprint commits: 5 (kickoff `ec3051b` + TLC-023a `0c94cb6` + TLC-023a r1 `3dbf021` + TLC-023b `b67c6ac` + TLC-023b r1 `2f1422a`)
- CI: green expected
- DoD: 8 of 10 boxes green; 2 boxes deferred to Sprint 12 (TLC-023c + retro filing)
- Process docs added by Sprint 11: SPRINT_11_PLAN.md + SPRINT_11_REVIEW.md + SPRINT_11_RETRO.md (this doc)
- New CI workflow: `.github/workflows/perf.yml`
- New baseline file: `tests/perf/baseline.json`
- New threshold script: `tests/perf/check-thresholds.ts`
- OR-218 closure progress: 2 of 3 conditions closed (thresholds + CI workflow); TLC-023c (required-blocking via branch protection) deferred to Sprint 12+
