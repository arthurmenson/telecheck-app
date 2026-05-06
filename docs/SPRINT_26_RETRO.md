# Sprint 26 Retrospective — Telecheck-app autonomous build

**Sprint:** 26
**Window:** 2026-05-06 (single-day, post-Sprint-25 close).
**Sprint goal:** Codex retrospective adversarial review + fold findings — **FULL ACCEPTANCE.**
**Total commits:** 2 / 5 budgeted (40% utilization).

---

## What went well

- **Retrospective Codex round paid off.** The Codex retrospective on cumulative Sprint 19→24 changes surfaced a real HIGH severity finding (TLC-048: JWT actors collapsing to `'anonymous'` in idempotency cache) that 4 consecutive SKIP-per-§5.2 sprints (22+23+24+25) missed. The §5.2 SKIP discipline was defensible per individual sprint (each was pattern-mirror or narrow stop-gap), but the residual surface — the cross-cutting interaction between Sprint 21's JWT migration and the pre-existing `x-actor-id` stub-fallback — slipped through. Periodic retrospective rounds catch this class.
- **HIGH finding closed cleanly within sprint cap.** Codex finding → fix in `src/lib/idempotency.ts` + new cross-actor isolation test in `tests/integration/idempotency-http.test.ts` → PR #26 merged. 2 commits / 40% budget.
- **Audit-trail backfill discipline formally validated.** Sprint 24 retro committed to running this Codex retro; Sprint 25 retro deferred it to Sprint 26; Sprint 26 ran it. This is the right cadence — every 4-5 SKIP sprints, run a retrospective Codex round to catch residual cross-cutting findings.
- **PM-brief verification gate landed clean for the 21st consecutive sprint.**
- **First HIGH closure since Sprint 17 dual-close** (~9 sprints ago). The Codex retrospective discipline is now demonstrably value-additive for the autonomous-arc maintenance phase.

---

## What didn't

- **Codex retrospective scope was vague at sprint planning.** "Cumulative Sprint 19→24 changes" is broad — Codex narrowed to the most recent surface (Sprint 21's JWT migration interaction with idempotency.ts), but a tighter scope (e.g., "specifically check actor_id population across the JWT migration") would have surfaced the finding faster. Future retrospective rounds should articulate concrete suspicion-areas in the prompt, not just file paths.

---

## Process changes for Sprint 27

1. **Articulate concrete suspicion-areas in retrospective Codex prompts.** Phrase: "Look for X-class issues that could have been missed by Y class of SKIPs." For the next retrospective round, explicit suspicion-areas: handler-pattern compliance after Sprint 24 fix; lock-key collision risk for the multiple advisory-locks added in Sprints 19+23; FK constraint integrity in idempotency_keys post-fix.
2. **Promote retrospective-Codex cadence to PROJECT_CONVENTIONS r5 (Sprint 28+).** Every 4-5 SKIP sprints, run a retrospective Codex round on cumulative changes. Sprint 26's outcome is the proof point: 4 SKIPs missed 1 cross-cutting HIGH; retro caught it; fix landed in 2 commits.
3. **Sprint 27 candidate scope:**
   - **TLC-046** (priority 1): file `idempotency-redesign-reserve-then-execute` per EHBG §12 SI/DSI escalation
   - **TLC-047** (priority 2): audit `src/lib/error-envelope.ts:217,230` void-reply patterns (different lifecycle than handler patterns; investigation if symptom appears)
   - **TLC-049** (priority 3, NEW): CI-level lockdown pin for `actor_id != 'anonymous'` invariant
   - **TLC-042 + TLC-043** (priority 4): re-validate transitively-resolved
   - **TLC-044 lock-key audit** (priority 5)

---

## Lessons feeding the PM rubric

**Promotion candidate (Sprint 27 / r5 codification):**

> **§5.11 — Retrospective-Codex cadence.** Every 4-5 SKIP-per-§5.2 sprints, run a retrospective Codex adversarial round on cumulative changes. The §5.2 SKIP discipline is correct per-sprint but accumulates residual surface for cross-cutting findings (interactions between fixes from different sprints). Retrospective rounds catch this. Articulate concrete suspicion-areas in the prompt, not just file paths.
>
> Proof point: Sprint 26 retrospective on Sprint 19→24 cumulative scope surfaced 1 HIGH (JWT actor collapse to `'anonymous'`) that 4 individual SKIPs missed. First HIGH closure since Sprint 17 dual-close (~9 sprints).

---

## Codex tracking — Sprint 26 finding ledger

| Round | Sub-story | Severity | Status |
|---|---|---|---|
| Retrospective r1 | TLC-048 (idempotency JWT actor scoping) | HIGH | Closed via PR #26 (`391e346`) |

Total Sprint 26: 1 Codex round (retrospective); 1 HIGH finding; closed in same sprint.

Cumulative Codex SKIPs reset by retrospective round: SKIP-streak counter resets at Sprint 26. Sprint 27+ accumulates fresh SKIP count toward next retrospective trigger (~Sprint 30-31 if cadence holds).

---

## Final commit cumulative state

- Sprint 26 head: `<TBD>` on `feat/sprint-26-close` (PR #27)
- Sprint commits: 2 (PR #26 substantive `f239737` + this Sprint 26 close on PR #27) of 5 budget = 40% utilization
- Process docs: SPRINT_26_PLAN.md + SPRINT_26_REVIEW.md + SPRINT_26_RETRO.md
- Code state: TLC-048 JWT actor scoping fix + cross-actor test landed (`391e346`)
- **ci.yml: fully green continues (1405 tests; +1 new test from TLC-048)**
- Sprint 27 hand-off: TLC-046 (slice escalation file) + TLC-047/049 (lockdown audit) + TLC-042/043 re-validate
