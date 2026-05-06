# Sprint 22 Review — Telecheck-app autonomous build

**Sprint:** 22
**Sprint goal:** TLC-040 §3b + TLC-041 §1-7 + §7a — investigate shared `expected 400 to be ___` symptom and land single fix-forward — **FULL ACCEPTANCE.**
**Sprint start commit:** `f3cb207` (Sprint 21 close).
**Sprint end commit:** `<this commit>` (Sprint 22 close on `feat/sprint-22-close` PR #19).
**Total commits in sprint:** 2 across 2 PRs (PR #18: `2a748ad` idempotency-header fix; PR #19: this Sprint 22 close commit) of 5 budget = 40% utilization.
**CI status at sprint end:** PR #18 required CI PASS (verify-metadata + Performance benchmarks). ci.yml `Build, lint, typecheck, test`: 95/101 (vs 93/101 pre-Sprint-22 = **+2 test files**, +8 test cases). All target tests passing.

**ACCEPTANCE: FULL.** Sprint 21's "shared root-cause" hypothesis confirmed: TLC-040 §3b and TLC-041 §1-7 both blocked by the same idempotency middleware returning 400 `internal.idempotency.missing_key` for state-changing requests without `Idempotency-Key` header per IDEMPOTENCY v5.1 contract. ONE investigation + ONE fix closed 8 test cases across 2 files.

---

## PM-brief verification gate findings (Sprint 22 — 17th consecutive ALL PASS)

5 cited identifiers verified; 17 consecutive ALL PASS.

---

## Sub-stories accepted (1 of 1 — FULL)

### ✅ TLC-040 §3b + TLC-041 §1-7 + §7a — shared idempotency-header root cause (FULL)

**Final state:**
- ✅ TLC-040 §3b (POST /abandon) PASSING
- ✅ TLC-041 §1a (PATCH /v0/admin/tenant-brand) PASSING
- ✅ TLC-041 §2a (PATCH /v0/admin/ccr-configs/:configKey) PASSING
- ✅ TLC-041 §3a (POST /v0/admin/adapter-configs) PASSING
- ✅ TLC-041 §4a (PATCH /v0/admin/adapter-configs/:adapterId) PASSING
- ✅ TLC-041 §5a (DELETE /v0/admin/adapter-configs/:adapterId) PASSING
- ✅ TLC-041 §6a (GET /v0/admin/ready) PASSING (was already passing — GET-exempt from idempotency)
- ✅ TLC-041 §7a (PATCH without JWT → 401) PASSING (idempotency middleware orders AFTER auth, so 401 still fires first as designed)

**Investigation chain:**
1. Sprint 21 retro: hypothesized shared 400 source upstream of handler
2. Sprint 22 PM kickoff: enumerated middleware order (host → auth-context → tenant-context → idempotency → handler)
3. Comparison pattern: scanned passing tests with same request shape (POST/PATCH/DELETE + JWT) for what they include that failing tests don't → `Idempotency-Key` header
4. Confirmed in `src/lib/idempotency.ts` — middleware returns 400 envelope for state-changing requests without the header

**Fix:** add `'idempotency-key': ulid()` to 7 inject calls across 2 test files (`async-consult-cross-tenant-isolation.test.ts` + `tenant-config-admin-write-blocked.test.ts`).

**Codex strategy:** SKIP per §5.2 — test-only auth-pattern migration; no novel-of-class authoring; no Codex round.

---

## Definition of Done — Sprint 22

- [x] PM-brief verification gate ran (17/17 ALL PASS)
- [x] Investigation phase produced root cause
- [x] Fix-forward landed (PR #18)
- [x] PR #18 opened + CI passes (required)
- [x] PR #18 merged (`055b0bd`)
- [x] ci.yml: target 8 tests PASS (95/101 = +2 test files)
- [x] `docs/SPRINT_22_PLAN.md` filed
- [x] `docs/SPRINT_22_REVIEW.md` filed (this doc)
- [ ] `docs/SPRINT_22_RETRO.md` filed (next)

---

## Cumulative state at Sprint 22 end

- 4 implementation-complete slices (unchanged)
- 48 Codex findings closed (27 HIGH + 21 MEDIUM); 2 escalated → both closed
- 17 consecutive PM-brief verification gate ALL PASS
- 9 living-doc artifacts
- **OR-218 still FULLY CLOSED**
- ci.yml progress: 95/101 test files passing (vs 93/101 pre-Sprint-22 = +2 files / +8 test cases)
- 6 remaining ci.yml failing files (TLC-044 candidate scope) — NOT regressions; pre-existing `installTestAppRole pg connection` flake/race in test infrastructure
- Sprint 22 demonstrates shared-root-cause "investigate ONCE, close MANY" pattern (codification candidate for PROJECT_CONVENTIONS r4 §5.7 in Sprint 23/24)
