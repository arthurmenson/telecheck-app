# Sprint 17 Plan — Telecheck-app autonomous build

**Sprint:** 17
**Sprint goal:** TLC-027 EXECUTE — rebuild bench-mode ephemeral Postgres infrastructure properly (closes all 4 Codex `perf-bench-r10` findings: 2 HIGH + 2 MEDIUM that escalated TLC-025-SCAFFOLD to Sprint 15+ in Sprint 14). Authorized by Evans 2026-05-06 via "act on my behalf to unblock and continue" + explicit TLC-027 EXECUTE consent.
**Sprint start commit:** `7ba2456` (Sprint 16 review/retro filed).
**Branch:** `feat/tlc-027-db-bench-infra` (feature branch; PR opens once `gh auth` completes).
**Commit budget:** 9 (7 estimated × 1.2 slack + 2 fix-forward reserves; "needs env EXECUTE" calibration per Sprint 15 / TLC-028 SCRUM_OPERATING_MODEL.md update).
**Codex strategy:** FIRE on TLC-027 EXECUTE commit.

---

## PM-brief verification gate findings (Sprint 17 — 12th consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — verified
- `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md` (acceptance criteria) — verified at `a443e7e`
- `src/lib/db.ts` setTestPool() pattern (target for new setBenchPool() helper) — verified
- `tests/perf/db/setup.ts` (reverted Sprint 14 file; rebuild target) — verified absent post-revert at `af193e7`

---

## Environment availability check (per PM rubric sub-rule 5)

- Postgres in autonomous shell: **NO** (Docker Desktop launched but daemon didn't come up within 5 min; Windows quirk). Code-level validation via lint + tsc + selfTest only; full Postgres validation deferred to CI / Evans-side env post-PR.
- Evans authorization: **YES** — TLC-027 EXECUTE consent + production-code-change consent (setBenchPool in src/lib/db.ts).
- gh auth status: **PENDING** — Evans driving `gh auth login --web` device flow at code 53E0-D421; PR creation blocked until that completes. Branch lands locally + pushes via SSH.

Sprint 17 EXECUTES TLC-027 acceptance criteria with code-level validation; CI / Evans-side picks up Postgres validation at PR review.

---

## Sub-stories committed

### TLC-027 EXECUTE — DB-backed bench infrastructure rebuild

**Estimated commits:** 7 (setBenchPool + setup file rebuild + bench config wiring + emit-audit bench + THRESHOLDS expansion + README update + Sprint 17 plan/review/retro). +2 fix-forward reserves.
**Decision rule:** Sprint 13 retro pre-emption pattern + Codex r10 findings as explicit checklist.
**Codex strategy:** FIRE on the substantive EXECUTE commit.

#### Acceptance criteria

All 4 Codex `perf-bench-r10` findings closed:

- **r10-A HIGH (setupFiles fail-open):**
  - `vitest.bench.config.ts` setupFiles is now ALWAYS-ON (`['./tests/perf/db/setup.ts']`)
  - Setup file's `beforeAll` fast-exits with success when `BENCH_DATABASE_URL` is unset (pure-function benches still run)
  - DB-backed bench files explicitly `import { requireBenchDb } from '../db/setup.ts'` and call it at module load — throws clear actionable error when env unset

- **r10-B HIGH (savepoint translation breaks pg_advisory_xact_lock lifetime):**
  - NEW `setBenchPool()` exported from `src/lib/db.ts` — installs a REAL `pg.Pool` (not savepoint-translation override)
  - NEW `clearBenchPool()` for afterAll cleanup
  - `getPool()` priority: testPool > benchPool > production pool
  - Bench iterations get fresh connections per call; real BEGIN/COMMIT/ROLLBACK; advisory locks held for real per-iteration lifetime
  - State accumulation across iterations is acceptable (constant-time hash-chain extend); afterAll TRUNCATEs accumulated rows

- **r10-C MEDIUM (URL collision check string-equality):**
  - Setup file canonicalizes URLs via `URL` parser before comparison
  - Compares `host:port/dbname` triples (lowercase host; default port 5432; lowercase dbname)
  - Auth credentials, query strings, host aliases normalized out
  - Returns `null` for unparseable URLs; callers fail-closed (treat unparseable as collision-suspect)

- **r10-D MEDIUM (migration replay full-file skip):**
  - NEW `schema_migrations_bench` tracking table (idempotent CREATE)
  - Each migration applied at most once (filename-keyed)
  - On apply failure: throw with filename + SQL error; tracking row NOT inserted; next session re-attempts
  - NO "already exists" substring matching that would mask non-idempotent DDL skips

#### First DB-backed bench scenario (validates the scaffold end-to-end)

- **§9 emit-audit happy-path single-row append** at `tests/perf/audit/emit-audit.bench.ts`:
  - Targets `emitAudit` hash chain (I-019/I-027 hot path)
  - Uses canonical `withTransaction` → real BEGIN/COMMIT (per r10-B closure)
  - Iterates against a single shared partition (steady-state hash-chain append cost)
  - 50 iterations + 5 warmup
  - Threshold §9 added to `THRESHOLDS[]`: 50ms initial (generous; tighten Sprint 18+ post-CI variance)

#### Doc updates

- `tests/perf/README.md`:
  - Bench corpus table: §9 emit-audit row added (9 scenarios total)
  - NEW `Running DB-backed benches` section
  - Fail-closed canonicalized URL collision check documented (r10-C)
  - Tracked migration apply documented (r10-D)
  - Sprint 18+ DB-backed bench expansion path
  - Bench-able-now matrix: emitAudit flipped to ✅ yes
- `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md` — referenced by acceptance criteria

#### Codex anticipation (per Sprint 13 retro pre-emption pattern)

Anticipated finding classes — pre-empted at authoring time:

1. **Hollow-coverage class:** does the bench actually exercise emitAudit, or just connection-pool overhead? Pre-empt: bench scenario builds a full canonical AuditEnvelopeInput per iteration; uses production code path withTransaction → emitAudit → trigger fires.
2. **Doc-only-discipline class:** "ephemeral DB" claim — pre-empt: setup file fail-closes via canonicalized URL collision check (r10-C).
3. **Loose-grep class:** scenario name regex matching — pre-empt: §9 task name has explicit `emit-audit` prefix; doesn't substring-match any existing THRESHOLDS entry.
4. **Resource leak class:** bench-mode many-iteration model could leak Postgres connections — pre-empt: explicit `max: 5` pool size; `clearBenchPool()` afterAll closes the pool cleanly.
5. **Schema drift class:** migrations apply takes time on each session — accepted at v0.1 (one-time per session; bench session is long-lived). Sprint 18+ retro evaluates Postgres template-DB caching if measured a problem.
6. **Threshold tightening class:** 50ms ceiling is generous — pre-empt: explicit "Sprint 18+ tightens after CI variance observed" comment in code.
7. **Validation gap:** can't run end-to-end without local Postgres — pre-empt: rely on lint + tsc + selfTest pure-function checks + CI Postgres service for end-to-end validation post-push.

---

## Definition of Done — Sprint 17

- [ ] PM-brief verification gate ran (this doc)
- [ ] `setBenchPool()` + `clearBenchPool()` in `src/lib/db.ts`
- [ ] `tests/perf/db/setup.ts` rebuilt with all 4 r10 closures
- [ ] `vitest.bench.config.ts` setupFiles always-on
- [ ] `tests/perf/audit/emit-audit.bench.ts` §9 scenario landed
- [ ] THRESHOLDS expanded to 9 scenarios; selfTest PASS
- [ ] `tests/perf/README.md` updated
- [ ] Lint clean
- [ ] tsc clean
- [ ] Codex FIRE on TLC-027 EXECUTE commit; closures recorded
- [ ] Branch pushed via SSH; PR opened post-`gh auth` completion
- [ ] `docs/SPRINT_17_REVIEW.md` filed
- [ ] `docs/SPRINT_17_RETRO.md` filed

---

## Sprint 18 hand-off

When Sprint 17 closes (and PR merges to main after Postgres CI validation):
1. Verify `perf.yml` ran §9 emit-audit successfully on main
2. Capture observed p95 for §9; tighten ceiling per TLC-023c §3 worksheet
3. Add §10/§11/§12 scenarios per `Sprint 18+ DB-backed bench expansion path` in README
4. OR-218 EXECUTE if `perf.yml` has 3-5 stable runs + `gh auth` available
5. SI-001/002/003 status check
