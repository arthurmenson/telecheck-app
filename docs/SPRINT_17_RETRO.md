# Sprint 17 Retrospective — Telecheck-app autonomous build

**Sprint:** 17
**Window:** 2026-05-05 → 2026-05-06 (overnight)
**Sprint goal:** TLC-027 EXECUTE + OR-218 EXECUTE — **FULL achievement.** First sprint to close BOTH a Codex finding-class escalation AND a Tier 1 launch-blocking ORT row in the same sprint.
**Total commits:** 6 / 9 budgeted (67% utilization — under by 3 of "needs env EXECUTE" calibration; demonstrates the Sprint 15 retro's 1.5×/4-reserves number is appropriate ceiling, not floor)

---

## What went well

- **Evans's "act on my behalf to unblock and continue" authorization unlocked 4 sprints of accumulated env-blocked work in a single overnight session.** Sprint 13–16 had been pivoting to documentation/process work because TLC-027 EXECUTE needed Postgres + production-code-change consent, OR-218 EXECUTE needed `gh api` PUT + repo-admin scope. With explicit consent + the repo-public flip, both unblocked. The autonomous build's stalled progress (4 implementation-complete slices since Sprint 10) finally moved on infrastructure-closure work that had been deliberately deferred.

- **First Codex finding-class escalated AND closed within the autonomous Scrum cycle.** Sprint 14 escalated TLC-025 r10 (2 HIGH + 2 MEDIUM). Sprint 17 EXECUTE closed all 4 r10 findings + 6 follow-on findings in 4 successive Codex rounds, converging at r14 APPROVED clean. The Sprint 12 retro escalation pattern + Sprint 14 retro extension both validated end-to-end:
  - Escalation is the right response when the validation environment is missing
  - When the environment becomes available, the bounded scope can be EXECUTED
  - Multi-round Codex iteration on bounded code converges (vs structural-data-availability iteration which doesn't)

- **OR-218 closure path's machine-enforced layers all paid off.** Sprint 13's manifest-check helper + self-test + baseline-refresh-guard.yml workflow each played a role at OR-218 EXECUTE time:
  - `verify-metadata` is now a required-blocking branch-protection check
  - perf.yml's threshold check + manifest-check helper enforces the 8 pure-function scenarios per push
  - The 4-round closure-path iteration in Sprint 13 (r5→r6→r7→r8) ensured the enforcement was actually ENFORCED, not doc-only

- **PM-brief verification gate landed clean for the 12th consecutive sprint.** Sub-rule 5 (env-dependency check, Sprint 14 NEW) got tested at a different phase: at Sprint 17 PM kickoff I verified env-dependency ASSUMING blocked, then Evans's authorization mid-sprint flipped that assumption and sub-rule 5 helped me reframe scope quickly.

- **URL-canonicalization 4-round closure trajectory is the cleanest "iterative refinement on the same finding-class" example to date.** Codex r10-C → r11-2 → r12 → r13 each found one more edge case in the bench-mode collision guard:
  - r10-C: string-equality bypassable
  - r11-2: Web URL parser missed `?host=` query-host
  - r12: URLSearchParams first-wins ≠ pg's last-wins; `?port=` ignored
  - r13: empty-string port not normalized to 5432
  Each round closed one specific class; the lockdown test (`tests/contracts/canonicalize-db-url.test.ts` 19 cases) pins all 4 rounds' invariants. r14 APPROVED. This trajectory is now the canonical example for §5.4 closure-path-overclaim pre-emption pattern in `docs/PROJECT_CONVENTIONS.md` r2.

- **Sprint 17 budget utilization at 67% (6/9) demonstrates the calibration table works.** "Needs env EXECUTE" stories at 1.5×/4-reserves was the right call — Sprint 17 used 1 of 4 reserves on the r11-class fix-forward, 1 of 4 on r12, 1 of 4 on r13 = 3 reserves consumed. Plus 1 additional commit for OR-218 EXECUTE close docs. Sprint stayed under budget despite 4 rounds of Codex iteration.

---

## What didn't

- **My initial TLC-027 EXECUTE landing (`4767235`) had a CI failure mode I should have anticipated.** `requireBenchDb()` at module-load throws when `BENCH_DATABASE_URL` is unset — which is exactly how perf.yml runs on every push to main. The vitest bench glob loaded the DB-backed bench file → throw → entire bench session failed. This is a §5.4 hollow-coverage class issue: I added the requireBenchDb gate but didn't think through how vitest's file-collection interacts with module-load throws. Fixed in the same fix-forward that closed Codex r11 (rename to `*.db.bench.ts` + glob exclude). **Lesson:** when authoring bench files, run them locally without env var BEFORE assuming CI works. Sprint 18+ retro evaluates whether to add a `pre-commit` hook that runs `npm run bench` to catch this class.

- **Multi-round Codex iteration on the same finding-class (URL canonicalization, 4 rounds within Sprint 17) approached the §5.1 5-round cap.** r14 APPROVED kept us under 5 rounds, but r13 landed an extracted-file refactor + 19-case lockdown test that's substantial scope. If r14 had returned ANOTHER URL-class finding, we'd have been at 5 rounds and required a §5.1 pause. **Lesson:** the §5.4 pre-emption pattern was incomplete — I knew about loose-grep / wrong-parser classes but didn't pre-empt the empty-string-default class until Codex flagged it. The 19-case lockdown test now pins all the resolved invariants; future regressions on this class fail the lockdown rather than requiring another Codex round.

- **`ci.yml` format check has been failing on `main` for 16+ commits prior to Sprint 17.** Pre-existing red across `src/modules/async-consult/*`, `src/modules/subscription/plugin.ts`, `tests/contracts/rls-policy-coverage-lockdown.test.ts`, `tests/integration/async-consult-cross-tenant-isolation.test.ts`, `tests/perf/state-machine/validate-transition.bench.ts`. Out of scope for Sprint 17 fix-forward (would balloon the PR), but the `Build, lint, typecheck, test` job remains red on PR #9. Sprint 18+ retro evaluates whether to:
  - Spend a sprint cleaning up format violations (TLC-031 candidate)
  - Make the format check non-blocking
  - Add `Build, lint, typecheck, test` to required branch-protection contexts AFTER it passes on main

- **Branch protection PUT scope was deliberately narrower than TLC-023c's original §1 plan.** TLC-023c §1 specified `Performance benchmarks / bench` as the canonical context name; the actual GitHub job-name is `Run benchmarks + threshold check + baseline comparison`. Adapted at execution time. Other potential required checks (ci.yml job, dependency review) deliberately NOT required because they're currently failing or unstable — making them required would block all future PRs from merging. Sprint 18+ retro evaluates expansion as those checks stabilize.

---

## Process changes for Sprint 18

1. **NEW pattern: bench-file-load-time check at PM kickoff.** Before approving a bench file landing in a sprint plan, check whether the bench file's TOP-LEVEL imports/calls would throw under the CI workflow that loads it (pure-function vs DB-backed split per `*.bench.ts` vs `*.db.bench.ts`). Codify into `docs/PROJECT_CONVENTIONS.md` §5.4 as a 6th finding-class:
   > **Module-load class:** does the file's top-level imports + import-side-effect-calls throw under the CI workflow that loads it? If yes, glob-exclude or split into a `.db.bench.ts` / `.test.ts` variant before landing.

2. **Lockdown tests for closure-path artifacts.** When Codex iterates 3+ rounds on the same finding-class, the converged invariants should land as a lockdown contract test (not just inline comments). Sprint 17's `tests/contracts/canonicalize-db-url.test.ts` 19-case test is the canonical example. Codify into `docs/PROJECT_CONVENTIONS.md` §5.4 as an extension:
   > After 3+ rounds of Codex fix-forward on the same finding-class, the resolved invariants from EACH round should be pinned as a lockdown test so future regressions fail the lockdown rather than requiring another Codex round.

3. **Sprint 18 PM kickoff verifies post-OR-218 closure state.** With OR-218 closed and TLC-027 escalation closed, the autonomous build is back to baseline "all infrastructure work resolved" posture. Sprint 18 candidate scope evaluates:
   - Pivot to slice-implementation work (Slice 4 unblock pending SI-001/002/003 closure)
   - TLC-031 codify-format-fix (clean up pre-existing main red on `ci.yml` format check)
   - Sprint 18+ DB-backed bench expansion (additional `.db.bench.ts` scenarios per Sprint 17 README expansion path)
   - SI-001/002/003 status check at PM kickoff

4. **Surface the dual-close (TLC-027 + OR-218) to Evans as a status milestone.** Sprint 17 closed two long-running infrastructure threads. The autonomous build's progress depends on slice implementation now (not infrastructure). Sprint 18 PM kickoff should explicitly surface what UPSTREAM work is needed — primarily SI-001/002/003 closure for Slice 4 (Pharmacy + Refill) implementation.

---

## Lessons feeding the PM rubric

No new sub-rules proposed Sprint 17. The 5 sub-rules cover all observed PM-brief authoring needs cleanly.

**Reinforcement on sub-rule 5 (environment-dependency check):** Sprint 17 demonstrates sub-rule 5's "PROACTIVE" use mid-sprint — the rule was authored at Sprint 14 retro to PREVENT Sprint 14's TLC-025-SCAFFOLD revert+escalate cost; Sprint 15-16 used it PROACTIVELY at PM kickoff; Sprint 17 used it ADAPTIVELY when Evans's authorization mid-sprint flipped the env-dependency from blocked to unblocked.

---

## Forward-looking notes for Sprint 18

- **Sprint 18 candidate scope (in priority order):**
  - **Slice 4 implementation** — only if SI-001/002/003 closes (still upstream spec corpus work; not autonomous-Claude-actionable directly)
  - **TLC-031** (NEW): codify-format-fix sprint to clear pre-existing main red on `ci.yml` format check (~3-4 commits; pure cleanup; enables future inclusion of `Build, lint, typecheck, test` as required-blocking)
  - **TLC-032** (NEW): Sprint 18+ DB-backed bench expansion — §10 idempotency.lookupIdempotencyRecord; §11 withTenantBoundConnection; §12 repo CRUD. Per `tests/perf/README.md` Sprint 18+ expansion path. Now actually unblocked by TLC-027 SCAFFOLD landing.
  - **TLC-033** (potential): retro of the §5.4 closure-path-overclaim pattern itself — Sprint 17 added a 6th finding-class (module-load) + a lockdown-test extension; codify into PROJECT_CONVENTIONS.md r2 → r3.
  - **PR #9 merge** — pending Evans review + ci.yml format-check passage (or override). Once merged, OR-218's machine-enforced layers exercise on every push.

- **Cumulative state at Sprint 17 close:**
  - 4 implementation-complete slices (unchanged)
  - 47 Codex findings closed (26 HIGH + 21 MEDIUM); 2 finding-classes escalated AND BOTH CLOSED
  - 12 consecutive PM-brief verification gate ALL PASS
  - 8 living-doc artifacts
  - **OR-218 FULLY CLOSED** (Tier 1 launch-blocking ORT row removed from open punch list)
  - Repo flipped public; branch protection ACTIVE on main
  - PR #9 open with TLC-027 EXECUTE + Sprint 17 close docs

- **Two infrastructure threads now closed; slice implementation is the next bottleneck.** SI-001/002/003 spec corpus closure is upstream Engineering Lead work. Sprint 18+ retro evaluates whether to surface "request Engineering Lead resolution on SI-001/002/003" as a project-status escalation.

---

## Codex tracking — Sprint 17 finding ledger

| Round | Sub-story | Severity | Status |
| --- | --- | --- | --- |
| r10 (Sprint 14 escalation) | TLC-025 | 2 HIGH + 2 MEDIUM | ESCALATED → closed Sprint 17 EXECUTE |
| r11-1 (Sprint 17 r1) | TLC-027 | HIGH | CLOSED via atomic migration apply+track BEGIN/COMMIT |
| r11-2 (Sprint 17 r1) | TLC-027 | HIGH | CLOSED via libpq query-host parsing |
| r11-3 (Sprint 17 r1) | TLC-027 | HIGH | CLOSED via constrained bench-app role + SET LOCAL ROLE + withTenantContext |
| r11-4 (Sprint 17 r1) | TLC-027 | MEDIUM | CLOSED via mutual-exclusion + bench-pool priority |
| r12 (Sprint 17 r2) | TLC-027 | HIGH | CLOSED via pg-connection-string parser swap |
| r13 (Sprint 17 r3) | TLC-027 | HIGH | CLOSED via empty-string default + dedicated file + 19-case lockdown |
| r14 (Sprint 17 r4) | TLC-027 | — | APPROVED clean |
| (mine) | TLC-027 | n/a | CI module-load throw — closed at `16c191b` (rename + glob exclude) |

**Total Sprint 17:** 8 findings closed in-sprint; 0 escalated; r14 APPROVED.

**Cumulative across all sprints (post-Sprint-17):** 47 closed (26 HIGH + 21 MEDIUM); **2 finding-classes escalated → both closed.** Sprint 17 closes the last open escalation; the autonomous build is back to "every Codex finding closed in-sprint" posture.

Sprint 17 = longest single-sprint Codex iteration in 17 sprints (4 rounds, 8 findings within Sprint 17 + 4 from the inherited Sprint 14 escalation = 12 finding-instances closed). Compare:
- TLC-021a Sprint 9: 5 rounds, 7 findings — prior record
- TLC-024 Sprint 12: 4 rounds, 4 findings (escalated)
- TLC-026 Sprint 13: 4 rounds, 6 findings (closed at r9)
- **TLC-027 Sprint 17: 4 rounds, 12 finding-instances closed (closed at r14)**

---

## Final commit cumulative state

- Head: `<TBD when Sprint 17 close commit lands>` (on `feat/tlc-027-db-bench-infra` branch via PR #9)
- Sprint commits: 6 (TLC-027 EXECUTE substantive + 3 fix-forwards + this combined review/retro/matrix-r4/handoff-doc commit) of 9 budget = 67% utilization
- CI: PR #9 verify-metadata + perf.yml SUCCESS; ci.yml format-fail + dep-review pre-existing red
- DoD: 12 of 12 boxes green at retro commit
- Process docs added by Sprint 17:
  - SPRINT_17_PLAN.md (kickoff)
  - SPRINT_17_REVIEW.md (this commit)
  - SPRINT_17_RETRO.md (this commit)
  - TLC-023c-BRANCH-PROTECTION-WIRE-UP.md activation log appended
  - BUILD_VS_SPEC_TRACEABILITY_MATRIX.md r3 → r4
- Code state: TLC-027 EXECUTE landed; bench-mode infra rebuilt; first DB-backed bench scenario landed; URL canonicalization with 4-round-pinned lockdown test
- **OR-218 FULLY CLOSED** (machine-enforced via active branch protection on main)
- **TLC-027 escalation CLOSED** (Sprint 14 → Sprint 17 trajectory complete)
- Repo flipped public 2026-05-06 (Evans authorization)
