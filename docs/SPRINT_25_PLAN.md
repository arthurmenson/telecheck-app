# Sprint 25 Plan — Telecheck-app autonomous build

**Sprint:** 25
**Sprint goal:** TLC-038 PROJECT_CONVENTIONS r3 → r4 codification — promote four Sprint 19→24 retro patterns (§5.7 shared-root-cause cluster + §5.8 pattern-mirror SKIP + §5.9 Fastify-idiom-mismatch + §5.10 r1-r2 hypothesis iteration). Hand-off priority items into Sprint 26 candidate scope.
**Sprint start commit:** `f807c11` (Sprint 24 close; PR #23 merged).
**Branch posture:** feature-branch + PR.
**Commit budget:** 5 (1 codification + 1 sprint close + 3 reserves; "executable here" 1.2× / 2-reserves with extra reserve for Codex retrospective if budget allows).
**Codex strategy:** SKIP per §5.2 — pure docs codification of demonstrated proof points. Codex retrospective on cumulative Sprint 19→24 changes was committed in Sprint 24 retro but DEFERRED to Sprint 26 (see "Sprint 26 hand-off" below).

---

## PM-brief verification gate findings (Sprint 25 — 20th consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — FULLY CLOSED at `Telecheck_Operational_Readiness_Todo_v1_5.md:129`
- Sprint 24 retro Sprint 25 candidate scope (TLC-038 priority 1) — verified
- `docs/PROJECT_CONVENTIONS.md` r3 revision-history block — verified at `r3 (2026-05-06, Sprint 18 / TLC-033)`
- Sprint 22/23/24 review docs (proof points for §5.7/§5.8/§5.9/§5.10) — verified at filesystem

20 consecutive PM-brief gate ALL PASS.

---

## Sub-stories committed

### TLC-038 — PROJECT_CONVENTIONS r3 → r4 codification (FULL ACCEPTANCE)

**Estimated commits:** 1 (single docs change).

**Codification:** four new sub-rules under §5 with 1+ proof point each from Sprints 19→24:

- **§5.7 Shared-root-cause cluster discipline** (Sprint 22 canonical: TLC-040 §3b + TLC-041 §1-7 → 8 cases / 1 commit / 40% budget). Investigate clusters of same-diagnostic-shape tickets ONCE; close all members.
- **§5.8 Pattern-mirror SKIP discipline** (Sprint 23 canonical: TLC-044 mirrors TLC-034 advisory-lock). Codex SKIP per §5.2; cap fix at 1 commit; escalate if mirror doesn't close.
- **§5.9 Fastify-idiom-mismatch finding-class** (Sprint 24 canonical: TLC-045 r2). Cue: TEST PASSED + UNHANDLED ERROR; framework integration is wrong, app logic is fine.
- **§5.10 r1-r2 hypothesis-iteration discipline** (Sprint 24 canonical: TLC-045 r1 wrong → r2 right). Cap iteration at r1-r2 inside sprint; defer to investigation sprint if r2 misses.

#### Acceptance criteria

- ✅ r3 → r4 revision history bumped at top of `docs/PROJECT_CONVENTIONS.md`
- ✅ Four sub-rules added with proof points
- ✅ PR #24 opened + merged (`3656ee6`)
- ✅ Lint/typecheck/format clean

---

## Definition of Done — Sprint 25

- [x] PM-brief verification gate ran (20/20 ALL PASS)
- [x] r4 codification committed
- [x] PR #24 merged (`3656ee6`)
- [x] `docs/SPRINT_25_PLAN.md` filed (this doc)
- [ ] `docs/SPRINT_25_REVIEW.md` filed (next)
- [ ] `docs/SPRINT_25_RETRO.md` filed (next)

---

## Sprint 26 hand-off

When Sprint 25 closes, the autonomous arc is in **post-CI-green steady state with codified playbook**. Sprint 26 candidate scope:

1. **Codex retrospective adversarial review** (priority 1, DEFERRED FROM SPRINT 24 RETRO): adversarial review on cumulative Sprint 19→24 changes (`tests/setup.ts` advisory-lock additions, `src/lib/idempotency.ts` catch+log, `src/modules/async-consult/internal/handlers/consults.ts` return-reply pattern). Backfills the audit trail for 4 SKIP-per-§5.2 sprints.
2. **TLC-046** (priority 2, NEW): file `idempotency-redesign-reserve-then-execute` per EHBG §12 SI/DSI escalation. The v0 onSend cache pattern is best-effort by design and not transactionally-safe per IDEMPOTENCY v5.1 §1 exactly-once guarantee. The proper fix is reserve-then-execute inside the business transaction. SLICE-implementation concern; hand off to first slice with serious concurrent-write semantics.
3. **TLC-047** (priority 3, NEW candidate): audit other handlers for the `void reply.send(); return;` pattern outside `src/modules/async-consult/internal/handlers/consults.ts` (Sprint 24 grep showed none, but verify systematically). Lockdown-test pin candidate per §5.4 lockdown-rule (TLC-045 was 1-round so doesn't trigger 3+ pin yet, but a regression-fence test in `tests/contracts/` could pre-empt re-introduction).
4. **TLC-042 + TLC-043** (priority 4): re-validate transitively-resolved post-Sprint-24 (likely already passing given fully green ci.yml).
5. **TLC-044 lock-key audit** (priority 5): verify no other test-setup operations have parallel-fork races.
