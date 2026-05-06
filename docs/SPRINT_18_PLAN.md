# Sprint 18 Plan — Telecheck-app autonomous build

**Sprint:** 18
**Sprint goal:** TLC-031 prettier-fix (clear pre-existing main red on ci.yml format check) + TLC-033 PROJECT_CONVENTIONS r2 → r3 (codify Sprint 17 retro patterns: §5.4 module-load class + lockdown-test pinning rule + §5.6 dual-close milestone pattern). Two small in-budget non-env stories executed in parallel post-PR-9 merge.
**Sprint start commit:** `8335b6e` (PR #9 merged 2026-05-06; main post-Sprint-17 dual-close).
**Branch posture:** feature-branch + PR (per Evans's accepted Option 1 going forward).
**Commit budget:** 4 (2 stories × 1.2 slack + 1 fix-forward reserve + 1 review/retro commit).
**Codex strategy:** SKIP per §5.2 (TLC-031 is pure formatting; TLC-033 is pure docs).

---

## PM-brief verification gate findings (Sprint 18 — 13th consecutive ALL PASS)

5 cited identifiers verified pre-execution:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-218 — verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:129` (now FULLY CLOSED post-Sprint-17)
- `docs/PROJECT_CONVENTIONS.md` r2 (the doc TLC-033 extends) — verified at `8335b6e`
- `docs/SPRINT_17_RETRO.md` "Process changes for Sprint 18" — verified
- `.github/workflows/ci.yml` Format check (prettier) step — verified

13 consecutive PM-brief gate ALL PASS.

---

## Environment availability check (per PM rubric sub-rule 5)

- Postgres in autonomous shell: NO (Docker Desktop did not boot during Sprint 17)
- gh auth: YES (Evans completed device-flow at code 53E0-D421 during Sprint 17)
- Repo public: YES (Evans flipped 2026-05-06)
- Branch protection: ACTIVE on main (Sprint 17 OR-218 EXECUTE)
- SI-001/002/003: still OPEN (upstream)

Both Sprint 18 stories are in-budget non-env work. No env dependency required.

---

## Sub-stories committed

### TLC-031 — prettier-fix pre-existing main red on ci.yml format check

**Estimated commits:** 1 (just `npm run format` apply + commit; no fix-forward expected on pure-formatting work).
**Codex strategy:** SKIP per §5.2.

#### Acceptance criteria

- `npm run format` applied across CI-scope files (`src/**/*.{ts,tsx,json}` + `tests/**/*.{ts,tsx}` + root `*.{json,md}`)
- `npm run format:check` clean post-fix
- `npm run lint` + `npx tsc --noEmit` + `tests/perf/check-thresholds.ts --self-test` clean post-fix
- Diff is whitespace-only (no functional changes)
- PR opened; CI's `Build, lint, typecheck, test` Format check (prettier) step now PASS

### TLC-033 — PROJECT_CONVENTIONS.md r2 → r3 codification

**Estimated commits:** 1 (single doc-edit commit).
**Codex strategy:** SKIP per §5.2.

#### Acceptance criteria

- §5.4 6th finding-class added: **module-load class** (Sprint 17 first-EXECUTE landing pattern: `requireBenchDb()` at module-load + `*.db.bench.ts` glob-exclude fix)
- §5.4 lockdown-test pinning rule extension (after 3+ Codex rounds on same finding-class, pin invariants as a lockdown contract test)
- NEW §5.6 dual-close milestone pattern (Sprint 17 = first-ever; TLC-027 + OR-218)
- Revision history bumped r2 → r3 with Sprint 17 retro citations

---

## Definition of Done — Sprint 18

- [ ] PM-brief verification gate ran (this doc)
- [ ] TLC-031 PR opened + CI required checks PASS
- [ ] TLC-033 PR opened + CI required checks PASS
- [ ] `docs/SPRINT_18_REVIEW.md` filed
- [ ] `docs/SPRINT_18_RETRO.md` filed

---

## Sprint 19 hand-off

When Sprint 18 closes:
1. **TLC-032 DB-backed bench expansion** — needs Postgres validation; same risk class as Sprint 14 TLC-025 attempt; Sprint 19 candidate (defer until env available)
2. **TLC-034 (NEW)** — fix migration-concurrency flake on parallel test workers (`tuple concurrently updated` errors on migrations 003/018); pre-existing across main; Sprint 19 candidate
3. **SI-001/002/003 status check** at PM kickoff
