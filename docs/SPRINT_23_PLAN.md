# Sprint 23 Plan — Telecheck-app autonomous build

**Sprint:** 23
**Sprint goal:** TLC-044 close 6-test-file `installTestAppRole tuple concurrently updated` shared-root-cause failure — apply same advisory-lock pattern as Sprint 19 TLC-034 to serialize role install across vitest forks.
**Sprint start commit:** `0e56d4f` (Sprint 22 close; PR #19 merged).
**Branch posture:** feature-branch + PR.
**Commit budget:** 5 (1 fix + 1 sprint close + 3 reserves; "executable here" 1.2× / 2-reserves with extra reserve given new finding-class hypothesis).
**Codex strategy:** SKIP per §5.2 — pattern-mirror of Sprint 19 TLC-034; same finding-class.

---

## PM-brief verification gate findings (Sprint 23 — 18th consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — FULLY CLOSED at `Telecheck_Operational_Readiness_Todo_v1_5.md:129`
- Sprint 22 retro Sprint 23 candidate scope (TLC-044 priority 1) — verified
- `tests/setup.ts:installTestAppRole:255` (GRANT EXECUTE failure site) — verified at file
- `tests/setup.ts:installTestAppRole:273` (REVOKE failure site) — verified at file

18 consecutive PM-brief gate ALL PASS.

---

## Sub-stories committed

### TLC-044 — `installTestAppRole` parallel-fork race (FULL ACCEPTANCE)

**Estimated commits:** 1 (single fix; pattern-mirror of TLC-034).

#### Investigation finding

**Root cause: PostgreSQL `tuple concurrently updated` error on catalog rows.** vitest `pool: 'forks'` runs each test file in a separate child process. Each fork's `beforeAll` calls `installTestAppRole`, which executes:
- `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ...` (line 255)
- `REVOKE UPDATE, DELETE ON audit_records FROM ...` (line 273)

These DDL statements update Postgres catalog rows (`pg_class`, `pg_proc`, `pg_attribute`), and concurrent updaters trip the multi-version concurrency-control conflict detection.

#### Fix applied

`tests/setup.ts:installTestAppRole` body wrapped in `pg_advisory_lock(hashtext('telecheck_test_install_role')::int)` / `pg_advisory_unlock` with try/finally — same serialization pattern as Sprint 19 TLC-034 `applyMigrations`. Distinct lock-key domain (`telecheck_test_install_role` vs `telecheck_test_migrations`) so the two locks don't share a queue.

#### Acceptance criteria

- ✅ TLC-044 §1 — `tests/integration/forms-intake-admin.test.ts` passing
- ✅ TLC-044 §2 — `tests/integration/forms-intake-submission.test.ts` passing
- ✅ TLC-044 §3 — `tests/integration/forms-intake-submissions-http.test.ts` passing
- ✅ TLC-044 §4 — `tests/integration/forms-intake-variants-http.test.ts` passing
- ✅ TLC-044 §5 — `tests/integration/identity-session-repo.test.ts` passing
- ✅ TLC-044 §6 — `tests/integration/tenant-context-http.test.ts` passing
- ✅ ci.yml `Build, lint, typecheck, test`: 95/101 → **101/101 test files passing** (+6)
- ✅ All 1404 tests passing (+30+ test cases recovered)
- ✅ PR #20 opened + merged (`20c0cbf`)

### Out-of-scope (Sprint 24 candidate — NEW)

**TLC-045** — 1 unhandled `ERR_HTTP_HEADERS_SENT` error from Fastify onSend hook chain. Originates from `tests/integration/async-consult-cross-tenant-isolation.test.ts §3b` test path. ALL TESTS PASS but the unhandled error causes vitest to exit 1 → ci.yml red.

**Hypothesis:** the idempotency-plugin's onSend hook (registered in `src/lib/idempotency.ts:277`) attempts to call `storeIdempotencyRecord()` which writes to the DB. When the §3b handler returns 404 via thrown `ConsultPatientOwnershipError`, Fastify's error-handling path may invoke `safeWriteHead` after the onSend hook chain has already started, producing `Cannot write headers after they are sent`. This is a pre-existing latent issue — the unhandled error appeared first in Sprint 22 PR #18 once §3b started reaching the handler depth.

**Codex SKIP decision** for TLC-045: TBD at Sprint 24 kickoff (Fastify hook redesign may be novel-of-class; potentially requires Codex round).

---

## Definition of Done — Sprint 23

- [x] PM-brief verification gate ran (18/18 ALL PASS)
- [x] Investigation produced root cause (Postgres catalog race)
- [x] Fix-forward landed (PR #20 — `f241e4d`)
- [x] PR #20 merged (`20c0cbf`)
- [x] ci.yml: 101/101 test files passing (+6 from sprint start)
- [x] `docs/SPRINT_23_PLAN.md` filed (this doc)
- [ ] `docs/SPRINT_23_REVIEW.md` filed (next)
- [ ] `docs/SPRINT_23_RETRO.md` filed (next)

---

## Sprint 24 hand-off

When Sprint 23 closes:
1. **TLC-045** (priority 1, NEW): fix Fastify `ERR_HTTP_HEADERS_SENT` unhandled error — investigate idempotency onSend hook + error-path interaction.
2. **TLC-042** (priority 2): forms-intake + identity emitAudit deadlock — re-validate post-Sprint-19/20/21/22/23 merges (now that ci.yml is 101/101 file-level, this may already be resolved transitively).
3. **TLC-043** (priority 3): delegations-migration test — re-validate post-Sprint-19/20/21/22/23 merges.
4. **TLC-038** (priority 4): PROJECT_CONVENTIONS r3 → r4 codification — now has 3 proof-points (Sprint 21+22 shared-root-cause cluster pattern + Sprint 23 pattern-mirror SKIP discipline) — promote to §5.7 + §5.8.
