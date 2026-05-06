# Sprint 21 Review — Telecheck-app autonomous build

**Sprint:** 21
**Sprint goal:** TLC-040 close async-consult-cross-tenant-isolation §3a/§3b — **PARTIAL achievement.**
**Sprint start commit:** `d92c5dc` (Sprint 20 close).
**Sprint end commit:** `<this commit>` (Sprint 21 close on `feat/sprint-21-close` PR #17).
**Total commits in sprint:** 3 across 2 PRs (PR #16 substantive: `0744e98` + r2 fix-forward `9ea5cc9`; PR #17: this Sprint 21 close commit) of 5 budget = 60% utilization.
**CI status at sprint end:** PR #16 required CI PASS. ci.yml `Build, lint, typecheck, test`: 93/101 (vs 92/101 pre-Sprint-21 = +1 test file fixed). §3a PASSING; §3b still failing with `expected 400 to be 404` — investigation deferred to Sprint 22.

**ACCEPTANCE: PARTIAL.** TLC-040 §3a closed via JWT migration. §3b's continued 400-instead-of-404 has the SAME symptom as TLC-041's tenant-config-admin-write `expected 400 to be 503` failures — likely shared root cause (tenant-context plugin or auth-context plugin returning 400 on some upstream condition). Sprint 22 investigates the shared 400-precedence pattern across both finding-classes.

---

## PM-brief verification gate findings (Sprint 21 — 16th consecutive ALL PASS)

5 cited identifiers verified; 16 consecutive ALL PASS.

---

## Sub-stories accepted (1 of 1 — partial)

### ⚠️ TLC-040 — async-consult §3a/§3b JWT migration (PARTIAL)

**Final state:**
- ✅ §3a (GET /events) PASSING post-PR-16 (JWT migration applied; auth now succeeds; tenant-blind 404 from service layer's ConsultPatientOwnershipError)
- ❌ §3b (POST /abandon) STILL FAILING `expected 400 to be 404`
  - PR #16 attempted r1 (JWT migration) + r2 (POST body+content-type)
  - Both unsuccessful for §3b — points to the 400 source being upstream of handler
  - DEFERRED to Sprint 22 alongside TLC-041 (shared root-cause hypothesis)

**Codex strategy:** SKIP per §5.2 — test-only auth-pattern migration; no novel-of-class authoring; no Codex round.

---

## Definition of Done — Sprint 21

- [x] PM-brief verification gate ran (16/16 ALL PASS)
- [x] TLC-040 r1 fix landed (§3a JWT migration)
- [x] TLC-040 r2 fix-forward landed (§3b POST body+content-type)
- [x] PR #16 opened
- [⚠️] CI ci.yml: §3a PASS; §3b still failing (DEFERRED)
- [x] `docs/SPRINT_21_PLAN.md` filed
- [x] `docs/SPRINT_21_REVIEW.md` filed (this doc)
- [ ] `docs/SPRINT_21_RETRO.md` filed (next)

---

## Cumulative state at Sprint 21 end

- 4 implementation-complete slices (unchanged)
- 48 Codex findings closed (27 HIGH + 21 MEDIUM); 2 escalated → both closed
- 16 consecutive PM-brief verification gate ALL PASS
- 9 living-doc artifacts
- **OR-218 still FULLY CLOSED**
- ci.yml progress: 93/101 test files passing (vs 92/101 pre-Sprint-21)
- 7 remaining ci.yml failures (1 from §3b + 7 from TLC-041 + others) — Sprint 22 candidate scope
