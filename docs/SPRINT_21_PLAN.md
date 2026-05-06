# Sprint 21 Plan — Telecheck-app autonomous build

**Sprint:** 21
**Sprint goal:** TLC-040 close async-consult-cross-tenant-isolation §3a/§3b (auth-stub → JWT migration) + initial investigation of TLC-041 (tenant-config-admin-write-blocked §1-7).
**Sprint start commit:** `d92c5dc` (Sprint 20 close; PR #15 merged).
**Branch posture:** feature-branch + PR.
**Commit budget:** 5 (1 fix + 1 fix-forward + 1 sprint close + 2 reserves; "executable here" 1.2× / 2-reserves).
**Codex strategy:** SKIP per §5.2 — TLC-040 is test-only auth-pattern migration; no novel-of-class authoring.

---

## PM-brief verification gate findings (Sprint 21 — 16th consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:129`
- Sprint 20 retro Sprint 21 candidate scope (TLC-040 priority 1) — verified
- `src/lib/jwt.ts:issueAccessToken` (target helper for the JWT migration) — verified
- `src/lib/auth-context.ts:requireActorContext` (the auth gate that's failing) — verified

16 consecutive PM-brief gate ALL PASS.

---

## Sub-stories committed

### TLC-040 — async-consult §3a/§3b auth-stub → JWT migration (PARTIAL)

**Estimated commits:** 2 (initial fix + r2 POST body fix-forward).

#### Final state

- ✅ §3a (GET /events) PASSING post-PR-16 (JWT migration applied)
- ❌ §3b (POST /abandon) STILL FAILING with `expected 400 to be 404`
  - r1 fix: JWT migration (matched §3a)
  - r2 fix: added `payload: {}` + `'content-type': 'application/json'` — did NOT resolve
  - Hypothesis: 400 source is upstream (tenant-context plugin or auth-context plugin) not the body-parser
  - DEFERRED to Sprint 22 alongside TLC-041 (which has the same `expected 400 to be ___` symptom — likely shared root cause)
- ci.yml progress: 92/101 → 93/101 test files passing post-merge

#### Acceptance criteria

- §3a JWT migration landed ✅
- §3b r2 fix attempted; investigation defers to Sprint 22 ⚠️
- NEW `mintTokenForAccount(tenantId, accountId)` helper using `issueAccessToken()` directly ✅
- ci.yml `Build, lint, typecheck, test`: §3a PASS; §3b still failing ⚠️

### TLC-041 — tenant-config-admin-write-blocked §1-7 — DEFERRED to Sprint 22

**Investigation result:** Sprint 21 PM kickoff time-boxed exploration found the failure mode is `expected 400 to be 503`. Test sends valid payload + JWT via loginToken. Handler (`patchTenantBrandHandler`) doesn't validate body — just calls `requireActorContext()` then throws 503.

**Hypothesis:** 400 comes from somewhere BEFORE the handler:
- Maybe `loginToken` returns invalid token (failure in OTP/login chain partly resolved by Sprint 19 TLC-034 schema_migrations)
- Maybe an upstream middleware (auth-context, tenant-context) returns 400 on some condition
- Maybe Fastify's default error handler converts a thrown error into 400 instead of 503

**Defer rationale:** TLC-041 needs deeper investigation than Sprint 21's commit budget allows; better to drop into Sprint 22 with focused scope.

---

## Definition of Done — Sprint 21

- [ ] PM-brief verification gate ran (16/16 ALL PASS)
- [ ] TLC-040 initial fix landed (§3a JWT migration)
- [ ] TLC-040 r2 fix-forward landed (§3b POST body+content-type)
- [ ] PR #16 opened + CI passes (required + ci.yml §3 tests)
- [ ] `docs/SPRINT_21_PLAN.md` filed
- [ ] `docs/SPRINT_21_REVIEW.md` filed
- [ ] `docs/SPRINT_21_RETRO.md` filed

---

## Sprint 22 hand-off

When Sprint 21 closes:
1. **TLC-041** (priority 1): tenant-config-admin-write-blocked §1-7 — investigation focus
2. **TLC-042** (priority 2): forms-intake + identity emitAudit deadlock — re-validate post-Sprint-19-merge
3. **TLC-043** (priority 3): delegations-migration test — re-validate post-Sprint-19-merge
4. **TLC-038** (priority 4): PROJECT_CONVENTIONS r3 → r4 codification
