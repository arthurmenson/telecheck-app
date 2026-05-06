# Sprint 26 Plan — Telecheck-app autonomous build

**Sprint:** 26
**Sprint goal:** Run the Codex retrospective adversarial review on cumulative Sprint 19→24 changes (deferred from Sprint 24 retro / scoped in Sprint 25 retro). Audit-trail backfill for 4 SKIP-per-§5.2 sprints (22+23+24+25). Fold any HIGH findings into Sprint 26 fix-forward.
**Sprint start commit:** `d2972ad` (Sprint 25 close; PR #25 merged).
**Branch posture:** feature-branch + PR.
**Commit budget:** 5 (1 Codex retro + 1 fix-forward if findings + 1 sprint close + 2 reserves; "executable here" 1.2× / 2-reserves).
**Codex strategy:** ACTIVE — retrospective adversarial review on cumulative scope.

---

## PM-brief verification gate findings (Sprint 26 — 21st consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — FULLY CLOSED at `Telecheck_Operational_Readiness_Todo_v1_5.md:129`
- Sprint 25 retro Sprint 26 candidate scope (Codex retro priority 1) — verified
- `tests/setup.ts:installTestAppRole` advisory-lock (TLC-044 scope) — verified at file
- `src/lib/idempotency.ts:226` actor-id stub — verified at file

21 consecutive PM-brief gate ALL PASS.

---

## Sub-stories committed

### Codex retrospective adversarial review (FULL ACCEPTANCE)

**Estimated commits:** 1 (run + capture findings).

**Scope:**
- `tests/setup.ts` advisory-lock additions for migrations + `installTestAppRole` (TLC-034 + TLC-044)
- `src/lib/idempotency.ts` catch+log defense-in-depth (TLC-045 r1)
- `src/modules/async-consult/internal/handlers/consults.ts` return-reply Fastify-idiom (TLC-045 r2)
- `tests/integration/async-consult-cross-tenant-isolation.test.ts` + `tests/integration/tenant-config-admin-write-blocked.test.ts` Idempotency-Key header additions (TLC-040+TLC-041)

**Result:** **1 HIGH finding** surfaced. Codex caught a real cross-actor isolation issue that 4 SKIP-per-§5.2 sprints missed:

> **HIGH-1: JWT-authenticated requests share the anonymous idempotency actor bucket** (`src/lib/idempotency.ts:226`). Sprint 21+ JWT migration left `actorId` reading from `x-actor-id` header → fallback to `'anonymous'` for all JWT requests. Two distinct authenticated patients in the same tenant + same Idempotency-Key + same endpoint either get false 409 (different bodies) or replay each other's cached response (same body). Violates IDEMPOTENCY v5.1 §1 actor-scoping + I-023 tenant isolation.

**Validation outcome:** the §5.2 SKIP discipline was defensible across Sprint 22+23+24+25 — every SKIP was either pattern-mirror or narrow stop-gap. BUT periodic retrospective Codex rounds catch the residual surface that pattern-mirror / narrow-stop-gap SKIPs miss. The retrospective discipline is now formally validated as correct.

### TLC-048 — JWT actor scoping in idempotency cache (FULL ACCEPTANCE)

**Estimated commits:** 1 (fix + test).

**Fix applied:** `src/lib/idempotency.ts:226` now reads from `request.actorContext?.accountId` first, falls back to `x-actor-id` for legacy paths, falls back to `'anonymous'` as final default for pre-auth state-changing endpoints.

**Test added:** NEW §NEW (TLC-048) test in `tests/integration/idempotency-http.test.ts` — two JWT bearer tokens for distinct accounts in TENANT_US, same Idempotency-Key, same endpoint (`POST /v0/async-consult/:id/abandon`), distinct consult IDs (handler runs both times with 404). Asserts:
- Both responses are 404 (NOT 409 body-mismatch — would prove actor collapse)
- `idempotency_keys` table has 2 rows for `(tenant_id, key, endpoint LIKE '/v0/async-consult/%/abandon')`
- `actor_id` values match the JWT account_ids — neither is `'anonymous'`

#### Acceptance criteria

- ✅ Codex retrospective ran + 1 HIGH finding surfaced
- ✅ HIGH finding folded into Sprint 26 fix-forward (TLC-048)
- ✅ Fix applied + test added
- ✅ ci.yml: 1404 → 1405 tests passing (1 new test); fully green continues
- ✅ PR #26 opened + merged (`391e346`)

---

## Definition of Done — Sprint 26

- [x] PM-brief verification gate ran (21/21 ALL PASS)
- [x] Codex retrospective ran on Sprint 19→24 cumulative scope
- [x] HIGH finding closed via fix + test (TLC-048)
- [x] PR #26 merged (`391e346`)
- [x] ci.yml: fully green continues (1405 tests)
- [x] `docs/SPRINT_26_PLAN.md` filed (this doc)
- [ ] `docs/SPRINT_26_REVIEW.md` filed (next)
- [ ] `docs/SPRINT_26_RETRO.md` filed (next)

---

## Sprint 27 hand-off

When Sprint 26 closes:

1. **TLC-046** (priority 1, NEW): file `idempotency-redesign-reserve-then-execute` per EHBG §12 SI/DSI escalation. The v0 onSend cache pattern is best-effort by design and not transactionally-safe per IDEMPOTENCY v5.1 §1 exactly-once guarantee. SLICE-implementation concern; hand off to first slice with serious concurrent-write semantics.
2. **TLC-047** (priority 2): audit other void-reply patterns in `src/lib/error-envelope.ts:217,230` (Fastify error/not-found handlers — different lifecycle; investigation if symptom appears).
3. **TLC-049** (priority 3, NEW): consider a CI-level lockdown pin for the `actor_id != 'anonymous'` invariant (verify all JWT-authenticated requests resolve to a non-'anonymous' actor_id in the idempotency_keys table).
4. **TLC-042 + TLC-043** (priority 4): re-validate transitively-resolved.
5. **TLC-044 lock-key audit** (priority 5): verify no other test-setup operations have parallel-fork races.
