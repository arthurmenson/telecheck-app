# Sprint 22 Plan — Telecheck-app autonomous build

**Sprint:** 22
**Sprint goal:** Close TLC-040 §3b + TLC-041 §1-7 + §7a — investigate the shared `expected 400 to be ___` symptom hypothesized in Sprint 21 retro to share a root cause across both finding-classes; land single fix-forward closing all 8 tests.
**Sprint start commit:** `f3cb207` (Sprint 21 close; PR #17 merged).
**Branch posture:** feature-branch + PR.
**Commit budget:** 5 (1 investigation + 1 fix + 1 sprint close + 2 reserves; "executable here" 1.2× / 2-reserves).
**Codex strategy:** SKIP per §5.2 — test-only header migration; no novel-of-class authoring; no Codex round.

---

## PM-brief verification gate findings (Sprint 22 — 17th consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — FULLY CLOSED at `Telecheck_Operational_Readiness_Todo_v1_5.md:129`
- Sprint 21 retro Sprint 22 candidate scope (TLC-040 §3b + TLC-041 priority 1, shared root-cause hypothesis) — verified
- `tests/integration/async-consult-cross-tenant-isolation.test.ts:§3b` — verified at file
- `tests/integration/tenant-config-admin-write-blocked.test.ts:§1-7` — verified at file

17 consecutive PM-brief gate ALL PASS.

---

## Sub-stories committed

### TLC-040 §3b + TLC-041 §1-7 + §7a — shared idempotency-header root cause (FULL ACCEPTANCE)

**Estimated commits:** 2 (1 investigation/fix + 1 sprint close).

#### Hypothesis going in (Sprint 21 retro)

Both TLC-040 §3b (POST `/v0/consults/:id/abandon`) and TLC-041 §1-7 (PATCH/POST/DELETE under `/v0/admin/*`) failed with `expected 400 to be ___`. Both were non-GET requests. Both had valid auth (JWT for §3b post-Sprint-21; loginToken JWT for TLC-041). Pattern: `400 fires before reaching handler`. Sprint 22 investigates ONCE and closes BOTH if shared.

#### Investigation finding

**Root cause: `src/lib/idempotency.ts` returns 400 `internal.idempotency.missing_key` for state-changing requests (POST/PATCH/DELETE) without `Idempotency-Key` header per IDEMPOTENCY contract v5.1.**

Confirmation pattern: passing tests with similar shape (e.g., `tests/integration/idempotency-http.test.ts`, `tests/integration/identity-login-http.test.ts`) include the header; failing tests do not. Idempotency middleware fires BEFORE the auth/handler precedence is reachable, so the test never gets to its target failure mode (404 ConsultPatientOwnershipError for §3b; 503 Admin Backend slice v1.1 stub for TLC-041).

#### Fix applied

Added `'idempotency-key': ulid()` header to 7 inject calls across 2 test files:
- `tests/integration/async-consult-cross-tenant-isolation.test.ts` §3b (1 inject)
- `tests/integration/tenant-config-admin-write-blocked.test.ts` §1a, §2a, §3a, §4a, §5a, §7a (6 injects)

§6a (GET /v0/admin/ready) intentionally NOT modified — GET requests are exempt from idempotency requirements.

#### Acceptance criteria

- ✅ TLC-040 §3b passing
- ✅ TLC-041 §1-7 passing (all 7 sections under PATCH/POST/DELETE)
- ✅ TLC-041 §7a (PATCH without JWT → 401, not 400) passing — shared fix
- ✅ ci.yml `Build, lint, typecheck, test`: 93/101 → 95/101 (+2 test files)
- ✅ PR #18 opened + merged

### Out-of-scope (Sprint 23 candidate)

**6 remaining ci.yml failing test files** (unrelated to TLC-040/041, NOT regressions):
- `forms-intake-admin.test.ts`
- `tenant-context-http.test.ts`
- `forms-intake-submission.test.ts`
- `forms-intake-submissions-http.test.ts`
- `forms-intake-variants-http.test.ts`
- `identity-session-repo.test.ts`

All fail with `installTestAppRole pg/lib/client.js:631` connection error — different finding-class than TLC-040/041's idempotency-header. Hypothesis: pre-existing pg connection / setup race in test infrastructure. New ticket: **TLC-044** (Sprint 23 priority 1).

---

## Definition of Done — Sprint 22

- [x] PM-brief verification gate ran (17/17 ALL PASS)
- [x] Investigation produced shared root cause (idempotency middleware)
- [x] Fix-forward landed (PR #18 — `055b0bd`)
- [x] PR #18 merged
- [x] ci.yml progress: +2 test files (93/101 → 95/101)
- [x] `docs/SPRINT_22_PLAN.md` filed (this doc)
- [ ] `docs/SPRINT_22_REVIEW.md` filed (next)
- [ ] `docs/SPRINT_22_RETRO.md` filed (next)

---

## Sprint 23 hand-off

When Sprint 22 closes:
1. **TLC-044** (priority 1, NEW): investigate 6-test-file `installTestAppRole pg connection error` — looks like flake/race in setup; likely shared root cause. Time-box 1 sprint, single-fix closes 6 files.
2. **TLC-042** (priority 2): forms-intake + identity emitAudit deadlock — re-validate post-Sprint-19-merge.
3. **TLC-043** (priority 3): delegations-migration test — re-validate post-Sprint-19-merge.
4. **TLC-038** (priority 4): PROJECT_CONVENTIONS r3 → r4 codification (now demonstrably valuable: shared-root-cause "investigate ONCE, close MANY" pattern proven on TLC-040+TLC-041 — codify §5.7).
