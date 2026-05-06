# Sprint 14 Retrospective — Telecheck-app autonomous build

**Sprint:** 14
**Window:** 2026-05-05 (single-day)
**Sprint goal:** TLC-025 DB-backed bench infrastructure investment — **PARTIAL achievement; ESCALATED to Sprint 15+ TLC-027.**
**Total commits:** 5 / 7 budgeted (71% utilization — first under-budget framework/perf sprint after Sprint 12 + Sprint 13 both at 117-133%)

---

## What went well

- **Honest escalation at round 1.** Sprint 14's TLC-025-SCAFFOLD landed (commit `208e9b5`), got 4 Codex findings (2 HIGH + 2 MEDIUM) on round 1, and ESCALATED rather than spinning into a 4-round fix-forward chain like Sprint 13. The structural shape of r10's findings (all 4 require Postgres validation) was clear at round 1; continuing fix-forward without Postgres would have risked landing more "structurally correct, doesn't actually work" code (closure-path-overclaim recurrence at the SCAFFOLD architecture layer).

- **Sprint 12 escalation pattern extended honestly.** Sprint 12 retro's codified pattern required "3+ fix-forward rounds" before escalating. Sprint 14 retro EXTENDS the pattern: when the validation environment is missing the dependency the code interacts with, escalate at round 1 rather than waiting for the structural shape to surface across multiple rounds. The pattern is no longer "structural-data-availability across N rounds"; it's now "structural-environment-availability AT ANY round." Codex r10's findings already proved the shape — further iteration would have been data-gathering without payoff.

- **Revert was the right call.** Sprint 14 reverted `208e9b5` cleanly at `af193e7` rather than leaving an unfixed scaffold in mainline. Future operators reading the codebase won't be misled into using a scaffold with HIGH-severity unfixed defects. The Promotion Ledger / commit history hygiene rule "prefer fix-forward over revert" doesn't apply when the work is harmful — r10-B in particular argued the scaffold WOULD measure the wrong thing if used. Revert + escalate is more honest than half-fix.

- **PM-brief verification gate landed clean for the 9th consecutive sprint.** All 5 cited identifiers verified pre-execution. PM hallucination class remains eradicated since Sprint 6 spec-corpus identifier check sub-rule.

- **Codex r10's findings demonstrate the scaffold-can-be-structural-too pattern.** Sprint 13 retro flagged "every layer of enforcement is a candidate for the same overclaim class." Sprint 14 r10 surfaced this PRECISELY at the SCAFFOLD layer: TLC-025-SCAFFOLD claimed "production-equivalent measurement of DB-backed code paths" but the savepoint-translation transaction model would have measured a different lock-lifetime than production. This is the same closure-path-overclaim shape, one layer up. The pattern continues to pay dividends.

- **Sprint 14 came in under-budget (5/7 = 71%).** First under-budget framework/perf sprint since Sprint 11. The under-budget came from the escalation path skipping the Codex fix-forward chain — when the environment doesn't permit fix-forward, it doesn't consume reserves. Sprint 14 retro's calibration insight: "1.4× slack + 2 fix-forward reserves" was over-calibrated for an escalation-path sprint. Sprint 15+ retro re-evaluates whether to differentiate "executable in this environment" vs "needs environment-availability" stories at budget-time.

---

## What didn't

- **The scope-narrowing happened DURING execution rather than at planning time.** Sprint 14 plan committed to TLC-025 (full scope: SCAFFOLD + emit-audit bench scenario + threshold expansion). Mid-execution, I narrowed to TLC-025-SCAFFOLD only because I realized I couldn't validate against Postgres in the autonomous shell. That narrowing should have happened at PM kickoff, not mid-execution. **Lesson:** PM brief sub-rule TBD — at planning time, explicitly check "does this story require an environment dependency the autonomous shell doesn't have?" If YES, split into PLAN-ONLY (planning artifact) vs EXECUTE (when env is available). If NO, execute. **Sprint 15 PM kickoff brief should incorporate this check explicitly.**

- **Authoring the SCAFFOLD without being able to validate it consumed budget AND surfaced findings I could have anticipated.** Sprint 13 retro pre-emption pattern said "every layer of enforcement is a candidate for the same overclaim class until verified by exercise of the actual gate path." Applied to Sprint 14: I authored a setup file using `setTestPool()` that intercepts BEGIN/COMMIT, knowing the bench would call `withTransaction()`, without thinking through whether savepoint translation matches the real production transaction lifetime. Codex r10-B caught this IN ONE PASS. With more careful authoring-time pre-emption, I might have caught it myself before commit.

- **No in-sprint Codex closures.** Sprint 14 = 0 of 4 findings closed in-sprint; all 4 escalated. First sprint in 14 sprints with zero in-sprint closures. While the escalation was correct, the pattern is worth noting: when environment-availability is the constraint, sprint-level Codex-finding-closure metrics become misleading. Sprint 14 retro distinguishes "in-sprint closures (productive)" from "in-sprint escalations (correct response to environment constraint)".

- **TLC-025-SCAFFOLD's wasted code authoring (300 lines + config wiring + README updates) consumed time that could have gone to other work.** The SCAFFOLD work IS preserved via git history (`208e9b5` is in the log even after revert) and `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md` references the patterns. So it's not entirely wasted — Sprint 15+ TLC-027 can refer back to it for what to NOT do (savepoint translation; conditional setupFiles). But still, ~400 lines of code were authored and reverted in one sprint.

---

## Process changes for Sprint 15

1. **NEW PM rubric sub-rule: environment-dependency check at planning.** Add to `docs/PROJECT_CONVENTIONS.md` §"PM verification gate":

   > At PM brief time, for each proposed sub-story explicitly check: "Does this require an environment dependency (e.g., Postgres, Redis, gh auth, secrets) the autonomous shell does not have?" If YES, split into PLAN-ONLY artifact (acceptance criteria + design + escalation conditions) and EXECUTE artifact (Sprint where env is available). Don't try to land code that only lint+tsc can verify when execution requires real-environment interaction. Sprint 14 / TLC-025 demonstrated the cost: ~400 lines authored, 4 Codex HIGH/MEDIUM findings, full revert, escalation.

2. **EXTEND escalation pattern to cover round-1 environment-availability findings.** Sprint 12 retro pattern required 3+ rounds; Sprint 14 retro adds: "OR if Codex round 1 surfaces findings whose closure all require an environment dependency the autonomous shell doesn't have." Sprint 15+ codifies into PROJECT_CONVENTIONS.md §"Codex review discipline".

3. **Differentiate "executable here" vs "needs env" stories at commit-budget time.** Sprint 13 retro proposed bumping framework/perf reserves from 2 to 4. Sprint 14 retro adds: "executable here" stories use 1.2× / 2-reserves; "needs env" PLAN-ONLY stories need only 1.0× / 0-reserves (no fix-forward expected); "needs env" EXECUTE stories happen in environment-available sprints with 1.5× / 4-reserves. This three-way differentiation matches observed iteration patterns.

4. **Sprint 15 PM kickoff verifies Postgres availability AND Evans signal on perf.yml run accumulation.** If Postgres available AND `perf.yml` has 3-5 stable runs: Sprint 15 executes both TLC-027 and OR-218 closure execution. If only one available: pivot to that one. If neither: pivot to other available work (e.g., PROJECT_CONVENTIONS.md updates codifying the new sub-rules above).

---

## Lessons feeding the PM rubric

**ONE NEW SUB-RULE proposed (first new sub-rule since Sprint 6):**

> **Sub-rule 5: Environment-dependency check.** For each proposed sub-story, explicitly check whether closure requires an environment dependency (Postgres, Redis, gh auth, secrets, CI access) the autonomous shell doesn't have. If YES, split into PLAN-ONLY (planning artifact + escalation conditions) and EXECUTE (env-available sprint). If NO, execute. Sprint 14 / TLC-025 cost demonstrates the rule's value: ~400 lines authored, full revert, escalation.

This raises the PM rubric sub-rule count from 4 (Sprint 6 baseline) to 5. Sprint 8/9/10 retro extensions remain stable. The new sub-rule is the first directly tied to autonomous-shell-vs-real-environment friction.

---

## Forward-looking notes for Sprint 15

- **Sprint 15 candidate scope (in priority order):**
  - **TLC-027 EXECUTE** — only if Postgres is available in Sprint 15's environment. Per acceptance criteria in `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md`. ~7-9 commits estimated (real `pg.Pool` override in `src/lib/db.ts` + canonicalization + migration tracking + CI workflow + first DB-backed bench scenario).
  - **OR-218 EXECUTE** — only if Evans confirms 3-5 stable `perf.yml` main runs. Per `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md` §1. ~2-3 commits.
  - **PROJECT_CONVENTIONS.md update** (always available; in-budget regardless of env) — codify Sprint 14 retro's NEW PM rubric sub-rule 5 + extend Codex escalation pattern + differentiated commit-budget calibration.
  - **SI-001/002/003 status check** at PM kickoff. If any closed → pivot to Slice 4.

- **Cumulative state at Sprint 14 close:**
  - 4 implementation-complete slices
  - 21 forward migrations + paired rollbacks
  - 35 of 35 domain events with same-tx outbox tests
  - 39 Codex findings closed (23 HIGH + 16 MEDIUM); **2 finding-classes escalated** (TLC-024 r4 → TLC-026 [closed Sprint 13]; TLC-025 r10 → TLC-027 [pending Sprint 15+])
  - 9 consecutive PM-brief verification gate ALL PASS
  - 5 living-doc artifacts (TLC-027 escalation doc added)

- **OR-218 closure path:** unchanged from Sprint 13 — closure path BUILT; execution awaits Evans + perf.yml run accumulation.

- **TLC-027 closure path:** Sprint 15+ executes against env with Postgres. Acceptance criteria in `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md`.

---

## Codex tracking — Sprint 14 finding ledger

| Round | Sub-story | Severity | Status | Closure |
| --- | --- | --- | --- | --- |
| r10-A | TLC-025 | HIGH | ESCALATED | setupFiles fail-open — escalated to TLC-027 |
| r10-B | TLC-025 | HIGH | ESCALATED | savepoint translation breaks lock semantics — escalated to TLC-027 |
| r10-C | TLC-025 | MEDIUM | ESCALATED | URL collision check string-equality — escalated to TLC-027 |
| r10-D | TLC-025 | MEDIUM | ESCALATED | migration replay full-file skip — escalated to TLC-027 |

**Total Sprint 14:** 0 in-sprint closures; 4 ESCALATED to Sprint 15+.

**Cumulative across all sprints:** 23 HIGH + 16 MEDIUM closed; 2 finding-classes escalated (Sprint 12 → Sprint 13; Sprint 14 → Sprint 15+). **First-ever HIGH-severity escalation; first sprint with zero in-sprint closures.** Both legitimate responses to environment-availability constraints.

---

## Final commit cumulative state

- Head: `<TBD when retro+review commit lands>`
- Sprint commits: 5 (kickoff + SCAFFOLD attempt + revert + TLC-027 escalation doc + this combined review/retro doc)
- CI: green expected
- DoD: 11 of 11 boxes green at retro commit
- Process docs added by Sprint 14: SPRINT_14_PLAN.md (kickoff) + TLC-027-DB-BENCH-INFRA-ESCALATION.md + SPRINT_14_REVIEW.md + SPRINT_14_RETRO.md (this doc)
- Code state: working tree at `af193e7` is identical to `d433703` (Sprint 14 kickoff baseline) for the SCAFFOLD-modified files; SCAFFOLD experience preserved in git log + escalation doc
- OR-218 closure progress: unchanged from Sprint 13
- TLC-027 escalated; Sprint 15+ executes against env with Postgres availability
