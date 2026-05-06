# Sprint 21 Retrospective — Telecheck-app autonomous build

**Sprint:** 21
**Window:** 2026-05-06 (single-day, post-Sprint-20 close).
**Sprint goal:** TLC-040 — **PARTIAL achievement.** §3a fixed; §3b deferred to Sprint 22 alongside TLC-041 (shared root-cause hypothesis).
**Total commits:** 3 / 5 budgeted (60% utilization).

---

## What went well

- **§3a closed cleanly via JWT migration.** Auth-context plugin's migration from `x-actor-id` header stub to JWT-based auth was correctly identified as the root cause. `mintTokenForAccount()` helper using `issueAccessToken()` directly (no OTP/login roundtrip) is the right test-helper shape — minimal, focused on the test's actual goal (authenticate as a known patient for handler-precedence test).
- **Investigation surfaced shared root-cause hypothesis between §3b and TLC-041.** Both fail with `expected 400 to be ___` (404 vs 503). Both are non-GET requests (POST/PATCH/DELETE). Both have valid auth (JWT for §3b; loginToken JWT for TLC-041). The shared pattern is "400 fires before reaching handler" — likely tenant-context plugin or another middleware. Sprint 22 investigates ONCE and closes BOTH (saves duplicate investigation).
- **Time-boxed correctly.** Sprint 21 budget was 5 commits; used 3. The §3b investigation could have stretched indefinitely; deferring to Sprint 22 is the right call when the symptom matches a separate triaged candidate.
- **PM-brief verification gate landed clean for the 16th consecutive sprint.**

---

## What didn't

- **§3b r2 fix didn't land — payload+content-type wasn't the right hypothesis.** The 400 isn't from Fastify's body-parser. Need to look at upstream middleware (tenant-context plugin or auth-context). Sprint 22 will need to enable verbose logging or step through the request path to find where 400 originates.
- **Net Sprint 21 progress on ci.yml red is just +1 test file (92 → 93).** Sprint 22 needs to close §3b + TLC-041 (8 tests) to make a meaningful dent in the remaining 7-8 failures.

---

## Process changes for Sprint 22

1. **Combine §3b investigation with TLC-041.** Same `expected 400` symptom; same non-GET pattern; likely shared root cause. ONE sprint that finds the upstream 400 source closes 1 + 7 = 8 tests at once. Time-box: 4-5 commits across both fixes.
2. **Sprint 22 candidate scope:**
   - **TLC-040 §3b + TLC-041** combined: investigate 400-source middleware → 1 fix-forward closes both
   - **TLC-042 + TLC-043**: re-validate post-Sprint-19-merge to see if TLC-034 schema_migrations changes resolved them
   - **TLC-038**: PROJECT_CONVENTIONS r3 → r4 codification (lower priority; pure docs)

---

## Lessons feeding the PM rubric

No new sub-rules promoted. Sprint 19's "triage-and-defer" pattern continues to demonstrate value — Sprint 21 deferred TLC-041 deep-dive to Sprint 22 cleanly.

---

## Codex tracking — Sprint 21 finding ledger

| Round | Sub-story | Severity | Status |
|---|---|---|---|
| (none) | TLC-040 | — | Codex SKIP per §5.2 (pattern-mirror auth migration) |

Total Sprint 21: 0 Codex rounds; 0 findings.

---

## Final commit cumulative state

- Sprint 21 head: `<TBD>` on `feat/sprint-21-close` (PR #17)
- Sprint commits: 3 (PR #16 substantive `0744e98` + r2 `9ea5cc9` + this Sprint 21 close on PR #17) of 5 budget = 60% utilization
- Process docs: SPRINT_21_PLAN.md + SPRINT_21_REVIEW.md + SPRINT_21_RETRO.md
- Code state: §3a JWT migration; §3b r2 fix attempted (deferred)
- ci.yml: 93/101 test files passing
- Sprint 22 hand-off: combine §3b + TLC-041 investigation
