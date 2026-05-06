# Sprint 11 Plan — Telecheck-app autonomous build

**Sprint:** 11
**Sprint goal:** Close ORT row OR-218 (Tier-1 launch-blocking) — perf budget thresholds + CI workflow + baseline-comparison regression detection.
**Sprint start commit:** `e126eee` (Sprint 10 FULL ACCEPTANCE)
**Commit budget:** 10 (5 estimated × 1.3 slack + 3 fix-forward reserves)
**Codex strategy:** FIRE on TLC-023a (threshold tightness defect class) + TLC-023b (workflow YAML + baseline file location); SKIP on TLC-023c (mechanical promotion to blocking)

---

## PM-brief verification gate findings (Sprint 11 — 6th consecutive)

| Identifier | PM cited | Verified | Match |
| --- | --- | --- | --- |
| OR-218 | §3 | `Telecheck_Operational_Readiness_Todo_v1_5.md:129` | ✓ |
| OR-218 3-condition closure | §3 | `tests/perf/README.md:5-11` | ✓ |
| P-010 latest; no P-011/012/013 | §1 | confirmed | ✓ |
| `vitest bench --baseline` doc-drift | §5 | confirmed: actual flags are `--compare` + `--outputJson` (NOT `--baseline`); `tests/perf/README.md:9` and `:34` need correction | ✓ (drift confirmed) |
| `.github/workflows/{ci.yml, dependency-review.yml, spec-pointer-validation.yml}` exist; no perf.yml | §4 | confirmed via ls | ✓ |

**Gate result: ALL PASS.** PM's flag-as-unverified on `vitest bench --baseline` caught a real doc-drift defect — Sprint 10 retro lesson "flag-as-unverified instead of guess" working as designed. TLC-023a authoring corrects the doc-drift.

---

## Promotion Ledger check

SI-001/002/003 still open; Path (a) Slice 4 schema blocked. Path (b) OR-218 hardening is the right Sprint 11 pivot. Path (c) (escalate SI-001 to Evans) deferred per Sprint 10 retro recommendation.

---

## Sprint 11 sub-stories

### TLC-023a — Per-scenario p95 thresholds + doc-drift fix

**Estimated commits:** 2 (initial thresholds + 1 fix-forward reserve for tightening)
**Decision rule:** 6 (UAT / launch-readiness)

#### Acceptance criteria

- Update `tests/perf/audit/crisis-detect.bench.ts` with per-scenario p95 assertion. Vitest `bench()` doesn't natively support assertions; the pattern is to capture results via `--outputJson` and run a separate threshold-check script (or a vitest test that reads the JSON output and asserts).
- Author `tests/perf/check-thresholds.ts` (or equivalent) that reads `bench-output.json` produced by `vitest bench --outputJson` and asserts p95 < threshold per scenario.
- Per-scenario thresholds (starting proposals; SM tunes empirically against CI-runner variance):
  - §1 short clean: p95 < **2μs** (≈11× local mean)
  - §2 short crisis: p95 < **1.5μs** (≈14× local mean)
  - §3 long clean (5KB): p95 < **200μs** (≈7× local mean)
  - §4 long crisis at end: p95 < **300μs** (≈17× local mean)
- **Fix doc-drift in `tests/perf/README.md:9` and `:34`** — `vitest bench --baseline` does NOT exist; replace with `--compare` + `--outputJson`.

### TLC-023b — Perf CI workflow + baseline comparison

**Estimated commits:** 2 (initial workflow + 1 fix-forward reserve for baseline file location)
**Decision rule:** 6
**Codex strategy:** FIRE (workflow YAML + baseline file handling are novel)

#### Acceptance criteria

- New file `.github/workflows/perf.yml`:
  - Triggers on push to main + pull_request
  - Runs `npm install` + `npm run bench -- --outputJson bench-output.json`
  - Compares against `tests/perf/baseline.json` (committed-to-repo per PM Risk #1 recommendation: simplest, regenerable, defection visible in PR diff)
  - Runs `node tests/perf/check-thresholds.ts bench-output.json` — fails if p95 thresholds breached
  - `continue-on-error: true` for the FIRST landing (warn-only); promote to blocking in TLC-023c after observing stability
- New file `tests/perf/baseline.json` — initial baseline captured locally; auto-update strategy deferred to TLC-023c (manual update via PR for now)
- `tests/perf/README.md` updated with the actual flag names (`--compare`, `--outputJson`) and the workflow path.

### TLC-023c — Promote perf workflow to required check

**Estimated commits:** 1
**Decision rule:** 6
**Codex strategy:** SKIP (mechanical: flip `continue-on-error` from `true` to `false`)

#### Acceptance criteria

- After 3-5 stable runs of TLC-023b workflow on main, flip `perf.yml` to blocking
- Update repo branch protection (manual via gh CLI or surface to Evans for emergency-only access)
- May CARRY-OVER to Sprint 12 if CI-runner variance hasn't stabilized (per PM Risk #2 — flagged acceptable)

---

## Definition of Done — Sprint 11

- [ ] TLC-023a thresholds authored + check-thresholds script + doc-drift fix
- [ ] TLC-023b perf.yml workflow + baseline.json + README update
- [ ] TLC-023c promote to blocking (or carry-over to Sprint 12 with rationale)
- [ ] Codex FIRE on TLC-023a + TLC-023b; HIGH/CRITICAL closed in-sprint
- [ ] Lint + type-check clean
- [ ] No invariants relaxed
- [ ] No production-code changes (TLC-023 = test infra + workflow + docs)
- [ ] `docs/SPRINT_11_REVIEW.md` filed
- [ ] `docs/SPRINT_11_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 12 (next pivot decision)

---

## Risks

- **PM Risk 1: Baseline file location** — committed-to-repo recommended for v0.1 simplicity; SM verifies at execution.
- **PM Risk 2: CI-runner variance unknown** — thresholds may need 2-3 retunes; TLC-023c may carry-over to Sprint 12. Acceptable per OR-218 closure-is-gradual design (per `tests/perf/README.md:24-30`).

---

## Next pivot (Sprint 12+)

Once OR-218 closes, Sprint 12 pivot decision: SI-001 status (probable: still open); SI-006 + SI-007 status (filed in Sprint 10; status unknown); other ORT items from TLC-015 audit. PM at Sprint 12 kickoff.
