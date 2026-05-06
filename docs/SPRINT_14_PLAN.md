# Sprint 14 Plan — Telecheck-app autonomous build

**Sprint:** 14
**Sprint goal:** TLC-025 DB-backed bench infrastructure investment (bench-mode ephemeral Postgres setup + 1 example DB-backed bench scenario). Defer OR-218 execution path to Sprint 15+ pending Evans-side signal on `perf.yml` run accumulation.
**Sprint start commit:** `fdb464a` (Sprint 13 review/retro filed; TLC-026 closure-path FULLY landed)
**Commit budget:** 7 (5 estimated × 1.2 slack + 2 fix-forward reserves; framework/perf heuristic per Sprint 13 retro proposed bump from 1.2× / 2-reserves to 1.5× / 4-reserves — going halfway: 1.4× / 2-reserves for this sprint, re-evaluate at Sprint 14 retro)
**Codex strategy:** FIRE on bench-mode setup landing + 1st DB-backed bench landing; SKIP on doc-only updates. Anticipate iterative findings on schema/connection/teardown patterns per Sprint 13 r5/r6/r7/r8 chain — pre-empt with explicit "is this enforceable code or doc-only-discipline?" check at authoring time.

---

## PM-brief verification gate findings (Sprint 14 — 9th consecutive ALL PASS)

5 cited identifiers verified against source-of-truth:
- Latest 3 Promotion Ledger entries: P-008/P-009/P-010 — verified at `Telecheck Master Bundle FINAL US REGION BASELINE/Telecheck_Promotion_Ledger.md:40/100/176`. No new ledger entries since Sprint 13 began (P-010 still latest).
- OR-218 — verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:129` (Sprint 11+ verified)
- `tests/perf/README.md:106` reference for "Bench-mode DB-backed corpus is NOT yet provided at v0.1 ... deferred to Sprint 13+ pending bench-mode ephemeral-DB setup investment" — verified
- `vitest.bench.config.ts:13-18` reference for "When future benches need DB-backed surfaces (e.g., emitAudit hash chain, idempotency lookup), author a separate setup file dedicated to bench-mode that constructs a fresh ephemeral DB without the per-test SAVEPOINT wrapper" — verified
- Sprint 13 review + retro at `docs/SPRINT_13_REVIEW.md` + `docs/SPRINT_13_RETRO.md` — landed at `fdb464a`

---

## Promotion Ledger check

SI-001/002/003 still open (14 sprints, no movement). **No Slice 4 pivot.** Continue infrastructure-investment track with TLC-025.

P-010 (latest ledger entry; CDM §4.1 SPEC ISSUE resolution from 2026-05-02) is still latest — no upstream changes affecting telecheck-app build during Sprint 13 window.

---

## Critical constraint (Evans Option A continuation; 2026-05-05)

Sprint 13 fully landed the OR-218 closure-path infrastructure (manifest-check helper + self-test + machine-enforced baseline-refresh metadata guard via `baseline-refresh-guard.yml`). **OR-218 execution is BLOCKED on:**
1. `perf.yml` accumulating 3-5 stable main runs (autonomous Claude has no `gh` auth to verify run count; depends on Evans-side signal)
2. Evans being reachable to execute the `gh api` PUT for branch-protection wire-up

**Sprint 14 work cannot include:**
- Direct verification of `perf.yml` run-count via `gh run list` (no auth)
- Branch-protection PUT execution (Evans Option A defers)
- Threshold tightening based on CI variance data (no data accessible without auth)

**Sprint 14 work can include:**
- TLC-025 DB-backed bench infrastructure investment (no auth needed; pure code work)
- Documentation extensions
- Sprint 15+ runbook + ready-to-flip checklist refinement

OR-218 execution is therefore deferred to Sprint 15+ (or whenever Evans is reachable + run accumulation is verified).

---

## Sub-stories committed

### TLC-025 — DB-backed bench infrastructure (bench-mode ephemeral Postgres + 1 example bench)

**Estimated commits:** 5 (bench-mode setup + ephemeral DB factory + 1st DB-backed bench scenario + threshold integration + README update; +2 fix-forward reserves)
**Decision rule:** Sprint 13 retro pre-emption pattern — at authoring time, check each layer for hollow-coverage / doc-only-discipline / loose-grep / wrong-git-semantics class issues
**Codex strategy:** FIRE on bench-mode setup landing AND 1st DB-backed bench landing; SKIP on README updates

#### Acceptance criteria

- **Bench-mode ephemeral Postgres setup file** at `tests/perf/setup.bench.ts` (or `tests/perf/db/setup.ts`):
  - Constructs a fresh ephemeral Postgres instance per bench session (NOT per-iteration — bench's many-iteration model is incompatible with per-iteration teardown)
  - Applies all forward migrations from `migrations/`
  - Seeds minimum required tenant/audit schema state for bench targets
  - Provides a connection pool that bench files can import
  - Tears down cleanly on session end (afterAll equivalent)
  - Wires into `vitest.bench.config.ts` via `setupFiles: ['./tests/perf/db/setup.ts']` (currently `[]` per `vitest.bench.config.ts:36`)

- **1 example DB-backed bench scenario** at `tests/perf/audit/emit-audit.bench.ts`:
  - Targets `emitAudit` hash chain (I-019/I-027 hot path)
  - Measures full append-cycle latency under representative load: tenant set, audit row insert, hash chain extend, FOR UPDATE serialization
  - Per-scenario: §1 first-row-in-empty-table (cold path; hash chain bootstrap); §2 N-th row append with prior chain (warm path; canonical); §3 concurrent-tenant separation (sanity check that tenant boundary doesn't serialize cross-tenant)
  - Threshold integration: add to `THRESHOLDS[]` in `tests/perf/check-thresholds.ts` with conservative initial p95 ceilings (e.g., §1 < 5ms, §2 < 1ms, §3 < 1ms — local Postgres dev-laptop measurements; CI tightening at Sprint 15+)

- **`tests/perf/check-thresholds.ts` THRESHOLDS expansion**:
  - Add §9-§11 entries for emit-audit scenarios
  - Re-verify `selfTest()` PASS with expanded scenarios (good case: §A goodTasks now expects 11 scenarios; missing-scenario case §B uses the new emit-audit scenario as the dropped one to prove manifest-check still fires)
  - Re-verify end-to-end gate against fresh bench output covers 11/11 scenarios

- **`tests/perf/README.md` update**:
  - Bench corpus table: add `tests/perf/audit/emit-audit.bench.ts | 14 / TLC-025 | emitAudit hash chain | §9-§11 (3 scenarios)`
  - Bench-able-now matrix: flip `emitAudit (hash chain)` from ⚠️ partial to ✅ yes (with note on bench-mode ephemeral-DB setup)
  - Note v0.1 trade-off update if needed: 11 scenarios under threshold gate, 4 under baseline (still crisis-detect-only); validate-transition + emit-audit relative-regression coverage pending Sprint 15+ CI baseline regen

- **`vitest.bench.config.ts` modifications**:
  - Set `setupFiles: ['./tests/perf/db/setup.ts']` (was `[]`)
  - Inline comment block updated to reflect "bench-mode setup landed Sprint 14 / TLC-025"

#### Codex anticipation (per Sprint 13 retro pre-emption pattern)

Anticipated finding classes — pre-empt at authoring time:

1. **Hollow-coverage class** (Sprint 13 r5): does the DB-backed bench actually exercise the `emitAudit` hash chain, or just measure connection-pool overhead? Pre-empt: bench scenario asserts the hash chain extends correctly via post-bench query before reporting timing.
2. **Doc-only-discipline class** (Sprint 13 r6): claims "ephemeral DB" but uses shared dev DB — pre-empt: setup file fails fast if DATABASE_URL points at non-test instance (check for `_test` suffix or explicit `BENCH_DB` env var).
3. **Loose-grep class** (Sprint 13 r7-A): scenario name regex matching could conflict with crisis-detect/validate-transition existing patterns — pre-empt: use scenario names with explicit `emitAudit:` prefix that doesn't substring-match any existing THRESHOLDS entry.
4. **Wrong-git-semantics class** (Sprint 13 r8-A): N/A for code authoring; only relevant to CI workflow changes.
5. **Resource leak class** (NEW, anticipated): bench-mode many-iteration model could leak Postgres connections if pool not properly bounded. Pre-empt: explicit pool size (e.g., 5) + `process.exit` afterAll cleanup.
6. **Schema drift class** (NEW, anticipated): if migrations apply takes > 30s on each bench session, bench DX degrades. Pre-empt: cache migration application via DB template (Postgres `CREATE DATABASE ... TEMPLATE` pattern) if full apply is slow.
7. **Threshold-tightening class** (Sprint 13 r3+): committed local-laptop thresholds for emit-audit could be wrong CI-variance — pre-empt: thresholds explicitly flagged "tentative; tighten Sprint 15+ post-CI variance" in code comment.

#### Risks

- **DB-backed bench harness adds ~30-60s to bench-session startup** (migrations apply). Acceptable for a session-scoped setup; would not be acceptable per-iteration. Risk if migrations grow further: Sprint 15+ retro evaluates Postgres template-DB caching pattern.
- **TLC-025 may surface schema migration ordering issues** that integration tests don't catch (bench mode runs all migrations clean; integration tests run incrementally). Mitigation: TLC-025 setup catches drift early; if any migration fails apply, fail-fast with explicit error.
- **Sprint 14 commit budget calibration is mid-trial.** Sprint 13 retro proposed 1.5× / 4-reserves; Sprint 14 trials 1.4× / 2-reserves halfway between current and proposed. Sprint 14 retro evaluates whether 1.4× is enough or 1.5× is needed.

---

## Definition of Done — Sprint 14

- [ ] PM-brief verification gate ran + findings recorded (this doc — 9/9 ALL PASS expected)
- [ ] TLC-025 bench-mode ephemeral Postgres setup landed
- [ ] 1 DB-backed bench scenario (emit-audit) landed
- [ ] THRESHOLDS expanded; selfTest() PASS for 11 scenarios
- [ ] `tests/perf/README.md` updated to reflect new state
- [ ] `vitest.bench.config.ts` `setupFiles` wired
- [ ] Codex FIRE on bench-mode setup commit + 1st DB-backed bench commit; HIGH/CRITICAL closed in-sprint
- [ ] Lint + type-check clean at every fix-forward
- [ ] No invariants relaxed
- [ ] No production-code changes (only `tests/` + `docs/` + `vitest.bench.config.ts` + new bench setup files)
- [ ] `docs/SPRINT_14_REVIEW.md` filed
- [ ] `docs/SPRINT_14_RETRO.md` filed
- [ ] Sprint 15 PM kickoff brief (re-check Evans signal on perf.yml run accumulation; re-evaluate OR-218 execution readiness)

---

## Sprint 15 hand-off (advance signal for Evans + autonomous Claude)

When Sprint 14 closes, Sprint 15 PM kickoff verifies:
1. Has Evans confirmed `perf.yml` accumulated 3-5 stable runs on `main`? (Surface as a "request Evans verifies via `gh run list --workflow=perf.yml --branch=main --limit=10`" item if not.)
2. Has any flake surfaced in perf.yml or baseline-refresh-guard.yml since Sprint 13 close?
3. If both clean: Sprint 15 surfaces "ready to flip" message to Evans with the specific `gh api` command (preserving all existing required-status-check contexts). If not: Sprint 15 pivots to TLC-025 follow-on (additional DB-backed scenarios) OR Sprint 15+ blocked-pivot to whatever next-priority work is available.
4. SI-001/002/003 status check: if any closed → pivot to Slice 4.
