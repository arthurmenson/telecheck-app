# Sprint 20 Retrospective — Telecheck-app autonomous build

**Sprint:** 20
**Window:** 2026-05-06 (single-day, post-Sprint-19 close).
**Sprint goal:** TLC-039 §E close + 8-test triage — **FULL achievement.**
**Total commits:** 2 / 4 budgeted (50% utilization — clean small fix + triage doc).

---

## What went well

- **§E close was a 5-line fix** (regex scheme-prefix check). Reproduction in node REPL caught the bug instantly: `pg-connection-string.parse('this is not a url')` returned a partial config rather than throwing. Fix at the canonicalizeDbUrl entry point cleanly excludes non-postgres URLs.

- **8-test triage produced 4 named Sprint 21+ candidates** (TLC-040/041/042/043) with clear root-cause hypotheses. Future sprints can pick one candidate, scope it, fix, merge — sized correctly per "executable here" calibration.

- **Triage-and-defer pattern (Sprint 19 retro NEW) used correctly.** 8 remaining test failures are slice-specific and need slice-context to fix correctly. Sprint 20 PRESERVED them as Sprint 21+ work rather than expanding scope to fix them in this sprint with insufficient context.

- **Sprint 20 came in well under budget** (50% utilization vs Sprint 19's 100%). Confirms the "executable here" 1.2× / 2-reserves calibration is appropriate ceiling — under-utilization happens when the work is genuinely small.

- **PM-brief verification gate landed clean for the 15th consecutive sprint.** Sub-rule 5 (env-dependency check) used at PM kickoff: TLC-039 is a pure code change requiring no env beyond what the autonomous shell has.

---

## What didn't

- **§E bug shipped in PR #11 because `pg-connection-string.parse()`'s permissiveness wasn't tested with non-URL inputs at authoring time.** I assumed parsePgConnectionString would throw on malformed input; it doesn't — it gracefully degrades. The 19-case lockdown test PR #11 added DID include the §E "not-a-url" case, which CAUGHT the bug at the FIRST CI run after merge. The lockdown-test pattern paid for itself within one sprint of authoring. Lesson: when wrapping a third-party parser, characterize its permissiveness BEFORE relying on it.

- **8-test triage required reading + categorizing slice-specific test code.** This added scope to Sprint 20's "small fix sprint" plan. Mitigation: triage was bounded — categorized into 4 named candidates with hypotheses; didn't attempt fixes. Total triage time: ~10 minutes of investigation. Sprint 20 budget held.

---

## Process changes for Sprint 21

1. **Sprint 21 priority order:**
   - TLC-040 first (async-consult-cross-tenant §3 — handler precedence; 2 tests; likely 1-2 commit fix)
   - TLC-041 second (tenant-config-admin-write §1-7 — route-ordering; 7 tests; likely 1 commit)
   - TLC-042 + TLC-043 third (re-validate first to see if Sprint 19 TLC-034 already resolved them)
   - Each candidate is its own PR

2. **NEW pattern proposal (lower priority, Sprint 22+ codification):** **third-party-parser permissiveness characterization.** When wrapping a third-party parser as a validation entry point, document its known permissiveness modes (graceful-degrade vs strict-throw) inline. Helps future authors avoid the §E class bug.

---

## Lessons feeding the PM rubric

No new sub-rules promoted Sprint 20. Sprint 19's "triage-and-defer" pattern (proposed for §5.3 extension) was used in this sprint — successful. Sprint 21+ retro decides whether to formally promote.

---

## Forward-looking notes for Sprint 21

- **Sprint 21 candidate scope:**
  - TLC-040 async-consult §3 handler precedence (priority 1)
  - TLC-041 tenant-config-admin-write §1-7 route ordering (priority 2)
  - TLC-042 + TLC-043 re-validate-first (priority 3; may be auto-closed by TLC-034)
  - TLC-038 PROJECT_CONVENTIONS r3 → r4 codification (priority 4; documentation)
  - SI-001/002/003 status check at PM kickoff

- **Cumulative state at Sprint 20 close:**
  - 4 implementation-complete slices (unchanged)
  - 48 Codex findings closed; 2 escalated → both closed; 6 NEW Sprint 21+ candidates triaged
  - 15 consecutive PM-brief gate ALL PASS
  - 9 living-doc artifacts
  - **OR-218 FULLY CLOSED**
  - **Migration-concurrency + EOL drift CLOSED** (Sprint 19)
  - **§E lockdown restored** (Sprint 20)

---

## Codex tracking — Sprint 20 finding ledger

| Round | Sub-story | Severity | Status |
|---|---|---|---|
| (none) | TLC-039 | — | Codex SKIP per §5.2 (5-line regex fix; pure validation) |

**Total Sprint 20:** 0 Codex rounds; 0 findings.

**Cumulative:** 27 HIGH + 21 MEDIUM closed; 2 escalated → both closed; 6 NEW Sprint 21+ candidates queued.

---

## Final commit cumulative state

- Sprint 20 head: `<TBD when this commit lands>` on `feat/tlc-039-close-pre-existing-ci-red` (PR #15)
- Sprint commits: 2 (TLC-039 §E fix + this combined plan/review/retro commit) of 4 budget = 50% utilization
- Process docs added: SPRINT_20_PLAN.md + SPRINT_20_REVIEW.md + SPRINT_20_RETRO.md
- Code state: §E scheme-prefix check added to canonicalizeDbUrl
- 8 named Sprint 21+ candidates for remaining ci.yml red
