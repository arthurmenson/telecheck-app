# Sprint 23 Retrospective — Telecheck-app autonomous build

**Sprint:** 23
**Window:** 2026-05-06 (single-day, post-Sprint-22 close).
**Sprint goal:** TLC-044 close `installTestAppRole tuple concurrently updated` shared-root-cause failure — **FULL ACCEPTANCE.**
**Total commits:** 2 / 5 budgeted (40% utilization).

---

## What went well

- **Pattern-mirror of Sprint 19 TLC-034 closed the ticket in ONE commit.** The investigation chain — error log shows `tuple concurrently updated` at GRANT/REVOKE call sites → recognize this is the same finding-class as the Sprint 19 migration concurrency race → apply the same `pg_advisory_lock(hashtext(...)::int)` serialization → done. Total elapsed: minutes. This is the value of building a pattern library: the second instance of a finding-class is ~10× cheaper to close than the first.
- **MILESTONE: 100% test-file-level green for the first time in the autonomous arc.** ci.yml progressed 95/101 → **101/101**. 1404/1404 active tests passing. Cumulative arc trajectory:
  - Sprint 19: 91 → 92 (+1)
  - Sprint 20: 92 → 92 (TLC-039 prevention)
  - Sprint 21: 92 → 93 (+1)
  - Sprint 22: 93 → 95 (+2 / shared root cause)
  - **Sprint 23: 95 → 101 (+6 / pattern mirror) — 100% green**
- **Two consecutive "investigate ONCE, close MANY" sprints** (Sprint 22: 8 cases / 2 files; Sprint 23: 30+ cases / 6 files). The shared-root-cause discipline + pattern-mirror discipline together account for 38+ test cases recovered in 4 commits across 2 sprints. This is the highest-leverage 2-sprint window in the autonomous arc.
- **PM-brief verification gate landed clean for the 18th consecutive sprint.**

---

## What didn't

- **1 unhandled `ERR_HTTP_HEADERS_SENT` error blocks ci.yml conclusion.** Even though all 101 test files pass and all 1404 tests pass, vitest exits 1 due to a single unhandled error from the Fastify onSend hook chain in the §3b POST /abandon path. This was a pre-existing latent issue (present in Sprint 22 PR #18 too) — not introduced by Sprint 23. But it means ci.yml is still red at the workflow level. **Sprint 24 priority 1 (TLC-045): fix this last barrier to fully green ci.yml.**
- **No Codex round this sprint.** SKIP-per-§5.2 is the right call for pattern-mirrors, but means no fresh adversarial-review evidence. Not a deficit per se — Sprint 22 + Sprint 23 are both pattern-mirror SKIP cases.

---

## Process changes for Sprint 24

1. **TLC-045 likely needs Codex round.** Unlike TLC-044 (pattern-mirror), TLC-045 is a Fastify-specific hook lifecycle issue. Hypothesis: idempotency onSend hook + Fastify error-path interaction. The fix may be novel (e.g., gating onSend on `reply.statusCode < 400`, or moving cache write to onResponse instead of onSend). Per §5.2 novel-of-class trigger, Codex round recommended.
2. **Sprint 24 candidate scope:**
   - **TLC-045** (priority 1, NEW): fix Fastify `ERR_HTTP_HEADERS_SENT` unhandled error in idempotency onSend chain → fully green ci.yml at workflow level
   - **TLC-042 + TLC-043** (priority 2): re-validate post-merges — likely already passing transitively now that ci.yml file-level is 101/101
   - **TLC-038** (priority 3): PROJECT_CONVENTIONS r3 → r4 codification — three proof-points now (Sprint 22 shared-root-cause cluster + Sprint 23 pattern-mirror SKIP + Sprint 17 dual-close milestone)

---

## Lessons feeding the PM rubric

**Promotion candidate (Sprint 24):** Two new sub-rules to PROJECT_CONVENTIONS §5.

> **§5.7 — Shared-root-cause cluster discipline.** When ≥2 tickets share a diagnostic shape (same expected-vs-actual pattern, same upstream-of-handler position, same test infra symptom), defer them as a cluster and investigate together. Single root-cause find closes all members. Proof points: Sprint 22 (TLC-040 §3b + TLC-041 §1-7 → 8 cases, 2 commits, 40% budget) + Sprint 23 (TLC-044 → 6 files, 1 commit). Pattern is high-leverage; codify.
>
> **§5.8 — Pattern-mirror SKIP discipline.** When the second instance of an already-closed finding-class appears (same fix shape applies), Codex round is OPTIONAL — pattern-mirror is novel-of-class-NEGATIVE per §5.2. Apply the prior fix; no Codex round. Proof points: Sprint 23 TLC-044 (mirrors Sprint 19 TLC-034 advisory-lock pattern). Cap fix-cost at ~1 commit; if the mirror doesn't close, escalate to fresh investigation.

---

## Codex tracking — Sprint 23 finding ledger

| Round | Sub-story | Severity | Status |
|---|---|---|---|
| (none) | TLC-044 | — | Codex SKIP per §5.2 (pattern-mirror of TLC-034) |

Total Sprint 23: 0 Codex rounds; 0 findings.

---

## Final commit cumulative state

- Sprint 23 head: `<TBD>` on `feat/sprint-23-close` (PR #21)
- Sprint commits: 2 (PR #20 substantive `f241e4d` + this Sprint 23 close on PR #21) of 5 budget = 40% utilization
- Process docs: SPRINT_23_PLAN.md + SPRINT_23_REVIEW.md + SPRINT_23_RETRO.md
- Code state: TLC-044 advisory-lock fix landed (`20c0cbf`)
- **ci.yml: 101/101 test files passing — 100% green at file level (milestone)**
- Sprint 24 hand-off: TLC-045 (last barrier — Fastify ERR_HTTP_HEADERS_SENT) → fully green ci.yml workflow conclusion
