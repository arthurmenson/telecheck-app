# Sprint 27 Plan — Telecheck-app autonomous build

**Sprint:** 27
**Sprint goal:** TLC-046 file SI-006 idempotency reserve-then-execute redesign per EHBG §12 + TLC-049 source-level lockdown contract pin for JWT actor scoping per §5.4. Two narrow sub-stories executed in parallel.
**Sprint start commit:** `6deb5c8` (Sprint 26 close).
**Branch posture:** feature-branch + PR.
**Commit budget:** 5 (1 substantive + 1 r2 fix + 1 close + 2 reserves; "executable here" 1.2× / 2-reserves).
**Codex strategy:** SKIP per §5.2 — TLC-046 is pure docs (SI/DSI escalation file); TLC-049 is pure-function source-grep lockdown.

---

## PM-brief verification gate findings (Sprint 27 — 22nd consecutive ALL PASS)

5 cited identifiers verified pre-execution; 22 consecutive ALL PASS.

---

## Sub-stories committed

### TLC-046 — file SI-006 idempotency redesign (FULL ACCEPTANCE)

**Result:** `docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` filed per EHBG §12 SI/DSI escalation procedure. Documents the v0 onSend cache pattern's ARCHITECTURAL LIMITATION + specifies the proper reserve-then-execute design + marks the redesign as BLOCKING before the first slice with serious concurrent-write semantics (Pharmacy + Refill v2.1 per EHBG §10).

### TLC-049 — actor-scoping lockdown contract pin (FULL ACCEPTANCE)

**r1 fix:** `tests/contracts/idempotency-actor-scoping-lockdown.test.ts` with 4 cases pinning the JWT-actorContext-first resolution chain.
**r2 fix-forward:** §1c regex anchored on the actual nullish-coalescing chain (initial `indexOf("'anonymous'")` matched comment text first; regex anchors on resolution-shape). Demonstrates §5.10 r1-r2 hypothesis-iteration discipline.

**Final state:**
- ✅ 4 cases pass: §1a (actorContext lookup present), §1b (actorContext precedes header), §1c (chain ends with 'anonymous'), §2a (closure-context comment preserved)
- ✅ ci.yml: 1405 → 1409 tests passing (+4 new lockdown cases)

#### Acceptance criteria

- ✅ SI-006 filed with full design proposal + helper API sketch + testing strategy
- ✅ Lockdown contract test pins JWT-first resolution
- ✅ PR #28 merged (`496f446`)

---

## Definition of Done — Sprint 27

- [x] PM-brief verification gate ran (22/22 ALL PASS)
- [x] Both sub-stories landed
- [x] PR #28 merged
- [x] ci.yml: fully green continues (1409 tests)
- [x] `docs/SPRINT_27_PLAN.md` filed (this doc)
- [ ] `docs/SPRINT_27_REVIEW.md` filed (next)
- [ ] `docs/SPRINT_27_RETRO.md` filed (next)
