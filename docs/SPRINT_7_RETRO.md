# Sprint 7 Retrospective — Telecheck-app autonomous build

**Sprint:** 7
**Window:** 2026-05-05 (single-day burn)
**Sprint goal:** Scaffold `tests/perf/` infra (Vitest bench mode) + absorb OR-208 closure into matrix r2 — **Achieved**
**Total commits:** 4 / 4 budgeted (100% utilization — 2nd sprint at exact budget after Sprint 5)

---

## What went well

- **PM-brief verification gate landed clean for the 2nd consecutive sprint.** 7 cited identifiers verified; ALL PASS. The gate is now part of the standing operating model and is mechanically reliable. Sprint 3 + Sprint 5 hallucination class has not recurred.
- **Codex caught a real overclaim.** TLC-018 originally framed itself as "closes OR-218". Codex `perf-bench-r1` HIGH correctly identified that a non-blocking harness without enforceable thresholds can't serve as the launch-blocking gate the ORT row demands. Fix-forward 1-line change to README; Codex re-verify APPROVED. The catch was substantive — the SM had landed the scaffold + the README claim of closure without seeing the contradiction with "bench is signal not gate at v0.1".
- **Three consecutive Codex findings (Sprint 5 / 6 / 7) hit different defect classes.** Sprint 5 = test over-permissiveness; Sprint 6 = soft-skip on missing tables; Sprint 7 = closure-language overclaim. All real, all surfaced classes the SM hadn't caught. The Codex FIRE-vs-SKIP heuristic continues to validate: SKIP for pattern-mirror / docs-only / lockdown-on-existing-code; FIRE for new-coverage / novel-test-class / security-adjacent / first-of-class infra.
- **Vitest bench mode operationally works.** Local-run sanity check showed 5.5M ops/sec on short clean text, 34K ops/sec on 5KB strings. Numbers are usable as Sprint 11 baseline. Worth-it tradeoff for the scaffold complexity.
- **Per-mode setupFiles override learning.** Discovered at execution that Vitest 2 doesn't support per-mode `setupFiles` override under `benchmark:` key. Pivoted to dedicated `vitest.bench.config.ts` — clean separation, documented inline in both configs.
- **Living-doc convention applied 4th time** (matrix r2 amend in place; 3rd amend across the 3 living docs total). Pattern is reproducible at near-zero cost.
- **Pre-pave runway exhaustion is now visible.** TLC-017 traceability matrix §5 + Sprint 7 retro both confirm: after this sprint, the testable-without-upstream-blockers backlog is depleted. No surprise discovery at Sprint 11.

---

## What didn't

- **Closure-language overclaim was avoidable at SM authoring time.** The README had "bench is signal not gate" right next to "closes OR-218". The contradiction was visible. SM should have caught it before Codex did. Lesson: when a doc's framing asserts both a closure claim AND an operating-model caveat that contradicts it, treat the contradiction as a hard signal that one of them is wrong.
- **Vitest bench mode discovery cost a half-cycle of pivoting.** First attempt (in-config `benchmark:` key with `setupFiles: []`) failed silently; bench was still loading `tests/setup.ts`. Second attempt (dedicated config file) worked. ~10 minutes of execution time spent on the pivot. Process change: when a config-key change doesn't behave as documented, stop and read the framework's per-mode config docs before iterating; don't assume the in-config override syntax works without verification.
- **Comment block parser collision with bench glob.** Same `*/` inside `**/*` esbuild comment-terminator issue surfaced again at line 160 of vitest.config.ts. The note at line 48 (existing) flagged it; SM forgot to apply the note when writing the new bench config block. Process change: when adding any new config block to vitest.config.ts, audit existing comment blocks for the `*/` constraint pattern as a pre-commit check.
- **Codex FIRE caught the closure-language miss but not the comment parser miss.** The comment parser issue was a runtime failure, not a Codex review surface (Codex reads source diffs but doesn't run them). Process change: always run the new infra locally before commit, not just lint+typecheck. (TLC-018 did this catch-via-execution, but only after the commit landed.)

---

## Process changes for Sprint 8

1. **SM closure-language audit before commit.** When closing an ORT row, verify the closure claim is consistent with the operating model the doc itself asserts. If "non-blocking" + "closes launch-blocking row" appear in the same doc, one is wrong.
2. **Pre-commit local-run for new infra.** Don't rely on lint+typecheck alone for new infra (test runners, build configs, scripts). Run the actual command at least once.
3. **Vitest config block addition checklist.** When adding any new config block to `vitest.config.ts`, audit existing comments for the `*/` glob-comment-terminator constraint pattern. Existing note at line 48 was correct; SM forgot to apply it for the new bench block.
4. **Pre-pave-runway-exhaustion is now a Sprint 8 PM kickoff item.** PM should re-check Promotion Ledger AND verify Async Consult PRD section refs (per Sprint 7 verification gate sub-rule extension — when proposing slice authoring, verify the slice PRD section refs exist).

---

## Lessons feeding the PM rubric

- **No new sub-rules proposed by Sprint 7.** The 4 sub-rules from Sprint 1/3/5 retros are stable and working.
- **One reinforcement:** Sprint 7 PM brief was the cleanest yet — every cited identifier had file:line, every test gap had grep evidence, every option-trade-off had a recommendation with rationale. The rubric extensions are converging the PM agent's output toward consistent quality.

---

## Forward-looking notes for Sprint 8

- **PRE-PAVE RUNWAY EXHAUSTION CONFIRMED.** No more pre-pave hygiene work after Sprint 7. Sprint 8+ pivots to:
  - **(a) Slice 4 schema authoring** — if SI-001 closes upstream (PM checks Promotion Ledger for P-011)
  - **(b) Async Consult slice authoring** — PRD v1.0 verified to exist; ~10-20 commits across Sprints 8-10
  - **(c) Surface emergency-access blockers to Evans** — vendor account credentials, AWS deploy access (out-of-repo work that requires Evans's involvement)
- **Recommendation:** Sprint 8 = Async Consult slice authoring (path b). PRD exists, slice is implementation-ready, follows EHBG §10b sequencing. Sprint 8 = skeleton + state machine + types; Sprint 9 = handlers + integration tests; Sprint 10 = full slice integration.
- **Codex strategy for Sprint 8:** Async Consult is a real new slice, not a skeleton. FIRE Codex on every iteration. This is the highest-novelty work since Sprint 1's foundation-layer authoring.
- **Test-cumulative-count growth** (Sprint 1-7): 14 / 13 / 9 / 11 / 2 / 46 / 0 (bench scenarios separate). Async Consult slice will likely add 30-50 cases per sprint of authoring (per Forms-Intake / Identity / Consent precedent).

---

## Codex tracking — 4 findings closed across all sprints

| Sprint | Finding | Severity | Closure |
| --- | --- | --- | --- |
| 1 | `pharmacy-blocked-handler` (liveness/readiness conflation) | MEDIUM | `5615feb` |
| 2/3/4 | (skipped per pre-empt rationale; pattern-mirror / pure-docs / lockdown work) | — | — |
| 5 | `idempotency-r5` (TTL test over-permissive) | HIGH | `0f4a757` |
| 6 | `rls-policy-r1` (soft-skip on missing tables) | MEDIUM | `2dece96` |
| 7 | `perf-bench-r1` (closure-language overclaim) | HIGH | `d879a79` |

All closed in-sprint via fix-forward; Codex re-verify APPROVED on each. Codex earns its keep on real-coverage / novel-test-class / new-infra work; SKIP heuristic for low-novelty work continues to hold.

---

## Final commit cumulative state

- Head: `ba2c7be`
- Sprint commits: 4 (kickoff `cb9fc55` + TLC-018 `d677fd3` + Codex HIGH fix-forward `d879a79` + matrix r2 `ba2c7be`)
- CI: green expected
- DoD: 8 of 8 boxes per story green (Codex finding closed in-sprint with severity-gating standard)
- Process docs added by Sprint 7: SPRINT_7_PLAN.md + SPRINT_7_REVIEW.md + SPRINT_7_RETRO.md (this doc)
- New test infra: `tests/perf/` directory (1 README + 1 bench file + dedicated config)
- New living-doc convention application: matrix r2 (4th living-doc amend total)
- Cumulative Codex findings closed: 4 (Sprint 1 + 5 + 6 + 7)
- PM-brief verification gate runs: 2 (Sprint 6 + 7); both ALL PASS
- Pre-pave runway: **EXHAUSTED**. Sprint 8+ pivots.
