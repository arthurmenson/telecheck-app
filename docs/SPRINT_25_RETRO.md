# Sprint 25 Retrospective — Telecheck-app autonomous build

**Sprint:** 25
**Window:** 2026-05-06 (single-day, post-Sprint-24 close).
**Sprint goal:** TLC-038 PROJECT_CONVENTIONS r3 → r4 codification — **FULL ACCEPTANCE.**
**Total commits:** 2 / 5 budgeted (40% utilization).

---

## What went well

- **r4 codification landed cleanly.** Four new sub-rules (§5.7-§5.10) with 1+ proof point each. Each rule's mechanics + diagnostic cues + canonical example documented in-line. Future sprints inherit a substantially deeper playbook for diagnosing CI-recovery scenarios — total §5 sub-rule count is now 10 (was 6 at r3).
- **Sprint 19→25 arc closed cleanly.** 6 consecutive sprints, 12 PRs merged, ci.yml went 91/101 → fully green workflow conclusion. The original "Sprint 19 ci.yml red trajectory" is closed with a documented playbook. Autonomous arc enters post-arc steady state.
- **40% commit-budget utilization** preserved 3 reserves for Sprint 26 — useful given the deferred Codex retrospective scope.
- **PM-brief verification gate landed clean for the 20th consecutive sprint.**

---

## What didn't

- **Codex retrospective deferred.** Sprint 24 retro committed to running a retrospective adversarial review on cumulative Sprint 19→24 changes to backfill the audit trail. Sprint 25 didn't run it — single-day cycle was concentrated on the codification PR. Deferred to Sprint 26 priority 1. The deferral is acceptable per §5.5 (deferring vs forcing-in-budget) but the audit-trail thinness on the Sprint 22+23+24 SKIP-per-§5.2 sequence is a real gap.

---

## Process changes for Sprint 26

1. **Run Codex retrospective adversarial review FIRST in Sprint 26.** Use the codex-companion script per CLAUDE.md (project-level, not the v1.10 directive). Scope:
   - `tests/setup.ts` advisory-lock additions (TLC-034 + TLC-044)
   - `src/lib/idempotency.ts` catch+log addition (TLC-045 r1)
   - `src/modules/async-consult/internal/handlers/consults.ts` return-reply pattern (TLC-045 r2)
   - `tests/integration/async-consult-cross-tenant-isolation.test.ts` and `tests/integration/tenant-config-admin-write-blocked.test.ts` idempotency-key headers (TLC-040+TLC-041 / Sprint 22)
   If Codex surfaces findings, fold into Sprint 26 fix-forward; document SKIP-per-§5.2 if no findings.
2. **Sprint 26 candidate scope:**
   - **Codex retro** (priority 1): adversarial review on cumulative Sprint 19→24 changes
   - **TLC-046** (priority 2, NEW): file `idempotency-redesign-reserve-then-execute` per EHBG §12 SI/DSI escalation (slice-implementation hand-off; not in scope for autonomous arc)
   - **TLC-047** (priority 3): audit other handlers for `void reply.send(); return;` pattern outside async-consult (Sprint 24 grep showed none, verify systematically; consider lockdown-test pin)
   - **TLC-042 + TLC-043** (priority 4): re-validate transitively-resolved (likely already passing)
   - **TLC-044 lock-key audit** (priority 5): verify no other test-setup operations have parallel-fork races

---

## Lessons feeding the PM rubric

No new sub-rule promotions this sprint — Sprint 25 was the codification sprint for Sprint 22-24 patterns. The 4 new sub-rules (§5.7-§5.10) are the codification.

**Process discipline note:** Sprint 19→25 demonstrated the pattern of "investigate-and-defer triage" working at multi-sprint scale. The Sprint 21 retro deferral of §3b to Sprint 22 (with the shared-root-cause hypothesis) was the highest-leverage decision in the arc — it converted what could have been 4-5 isolated fixes into 1 cluster fix at 40% budget. The §5.7 codification is the formal capture of that pattern; future Claude sessions should look for it.

---

## Codex tracking — Sprint 25 finding ledger

| Round | Sub-story | Severity | Status |
|---|---|---|---|
| (none) | TLC-038 | — | Codex SKIP per §5.2 (pure docs codification) |

Total Sprint 25: 0 Codex rounds; 0 findings. **Sprint 26 retrospective Codex round on cumulative Sprint 19→24 scope is queued (deferred from Sprint 24 retro).**

Cumulative Codex SKIPs: 4 consecutive sprints (Sprint 22 + 23 + 24 + 25). Per §5.2, every SKIP was defensible (pattern-mirror or pure-docs or narrow stop-gap). The retrospective round in Sprint 26 will validate the SKIP discipline by surfacing any findings the SKIPs missed.

---

## Final commit cumulative state

- Sprint 25 head: `<TBD>` on `feat/sprint-25-close` (PR #25)
- Sprint commits: 2 (PR #24 substantive `e6c1f6b` + this Sprint 25 close on PR #25) of 5 budget = 40% utilization
- Process docs: SPRINT_25_PLAN.md + SPRINT_25_REVIEW.md + SPRINT_25_RETRO.md
- Code state: PROJECT_CONVENTIONS r4 codified (`3656ee6`)
- **ci.yml: fully green continues**
- Sprint 26 hand-off: Codex retro (priority 1) + TLC-046 file (slice hand-off) + TLC-047 lockdown audit + low-priority hygiene
