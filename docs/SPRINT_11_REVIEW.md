# Sprint 11 Review — Telecheck-app autonomous build

**Sprint:** 11
**Sprint goal:** Close ORT row OR-218 (Tier-1 launch-blocking) — perf budget thresholds + CI workflow + baseline-comparison regression detection.
**Sprint start commit:** `e126eee` (Sprint 10 FULL ACCEPTANCE)
**Sprint end commit:** `2f1422a` (TLC-023b r1 fix-forward final; Codex APPROVE)
**Total commits in sprint:** 5 (kickoff `ec3051b` + TLC-023a `0c94cb6` + TLC-023a r1 `3dbf021` + TLC-023b `b67c6ac` + TLC-023b r1 `2f1422a`) vs 10-budget — 50% utilization
**CI status at sprint end:** Green expected at `2f1422a`

**ACCEPTANCE: PARTIAL.** TLC-023a + TLC-023b converged. TLC-023c (promote workflow to blocking) intentionally deferred to Sprint 12+ — needs 3-5 stable CI runs to characterize CI-runner variance distribution before tightening thresholds + flipping `continue-on-error` to `false` (per Sprint 11 plan + tests/perf/README.md gradual-promotion design).

---

## PM-brief verification gate findings (Sprint 11 — 6th consecutive ALL PASS)

5 cited identifiers verified at source-of-truth files. PM caught a real doc-drift defect via flag-as-unverified pattern: `tests/perf/README.md:9` and `:34` cited `vitest bench --baseline` (does not exist); actual flags are `--compare` + `--outputJson`. Sprint 10 retro lesson "flag-as-unverified instead of guess" delivered substantive value.

---

## Sub-stories accepted (2 of 3)

### ✅ TLC-023a — Per-scenario p95 thresholds + doc-drift fix — `0c94cb6` + r1 `3dbf021`

**Deliverables:**
- `tests/perf/check-thresholds.ts` — script reads vitest bench `--outputJson` output; asserts per-scenario p95 in microseconds; exit 1 on breach. 4 scenario thresholds (§1 short clean / §2 short crisis / §3 long clean 5KB / §4 long crisis at end).
- `tests/perf/README.md` — doc-drift correction (vitest bench `--compare` + `--outputJson` instead of nonexistent `--baseline`).
- Codex r1 closure: 1 HIGH (p75/p99 midpoint approximation underestimated true p95) + 1 MEDIUM (`.js` invocation in doc but source is `.ts`). Both fixed; Codex re-verify APPROVE.

### ✅ TLC-023b — Perf CI workflow + baseline.json + JSON-shape fix — `b67c6ac` + r1 `2f1422a`

**Deliverables:**
- `.github/workflows/perf.yml` — perf CI workflow:
  - Runs `vitest bench --outputJson tests/perf/bench-output.json`
  - Threshold check via `check-thresholds.ts`
  - Baseline comparison via `vitest bench --compare tests/perf/baseline.json`
  - Uploads bench output as artifact (30-day retention)
  - **NO `continue-on-error: true`** (Codex r1 HIGH closure: warn-only landing is achieved at branch-protection layer, NOT workflow level)
- `tests/perf/baseline.json` — initial baseline (128 lines; 4 scenarios; vitest 2.1 outputJson shape verified).
- `tests/perf/check-thresholds.ts` — JSON-shape fix: percentile fields are directly on the benchmark task object (NOT nested under `.result`).
- Codex r1 closure: 1 HIGH (continue-on-error makes check non-functional as gate) + 1 MEDIUM (`!== undefined` insufficient — null/NaN pass; need `Number.isFinite + >= 0`). Both fixed; Codex re-verify APPROVE.

**End-to-end local verification (DATABASE_URL stub):**
```
All 4 thresholds passed via p99 over-strict fallback (p95 not reported by vitest 2.1):
  §1 short clean      p99 0.40μs <= limit 2μs
  §2 short crisis     p99 0.30μs <= limit 1.5μs
  §3 long clean 5KB   p99 75.00μs <= limit 200μs
  §4 long crisis end  p99 44.20μs <= limit 300μs
```

### ⏸️ TLC-023c — Promote perf workflow to blocking — DEFERRED to Sprint 12+

**Reason:** per Sprint 11 plan + `tests/perf/README.md:24-30`, the v0.1 → blocking transition is gradual by design. Need 3-5 stable CI runs to characterize CI-runner variance distribution before flipping branch protection. Sprint 12 PM kickoff verifies CI-runner variance + decides on threshold tightening before promotion.

---

## Codex adversarial review

**Cumulative Sprint 11:** 4 fix-forward closures (2 HIGH + 2 MEDIUM):
- TLC-023a r1: HIGH (p75/p99 midpoint) + MEDIUM (`.js` doc-drift)
- TLC-023b r1: HIGH (continue-on-error contradiction) + MEDIUM (`!== undefined` insufficient validation)

Each finding represented a real defect class. Each round produced a structurally correct fix. Codex re-verify APPROVE on both sub-stories after fix-forward.

**Cumulative across all sprints:** 23 HIGH + 7 MEDIUM = 30 Codex findings closed.

---

## Cumulative platform metrics at sprint end

- **Slices:** 4 implementation-complete (Forms-Intake, Identity, Consent + Delegation, Async Consult)
- **Forward migrations:** 21 + paired rollbacks
- **Domain events wired:** 35 of 35 (with same-tx outbox tests)
- **Open Spec Issues:** 5 (SI-001..005); SI-006 + SI-007 from Sprint 10 still informal until ratification
- **Tenant-scoped tables:** 23
- **Test files:** ~110
- **Bench scenarios:** 4 (with p95 thresholds — Sprint 11 NEW)
- **CI workflows:** 4 (`ci.yml`, `dependency-review.yml`, `spec-pointer-validation.yml`, `perf.yml` — Sprint 11 NEW)
- **Living-doc artifacts:** 4 (CRISIS_DETECTION_COVERAGE_AUDIT, ORT_V1_5_TESTABLE_ITEMS_AUDIT, BUILD_VS_SPEC_TRACEABILITY_MATRIX, PROJECT_CONVENTIONS)
- **Cumulative Codex findings closed:** 30 (23 HIGH + 7 MEDIUM)
- **PM-brief verification gate runs:** 6 (Sprints 6/7/8/9/10/11); ALL PASS
- **OR-218 closure conditions:** 2 of 3 closed (thresholds + CI workflow); 3rd condition (required-blocking) deferred to TLC-023c

---

## Decisions made this sprint

1. **Doc-drift catch via flag-as-unverified.** PM Sprint 11 brief flagged `vitest bench --baseline` as unverified; SM gate verification confirmed actual flags are `--compare` + `--outputJson`. TLC-023a authoring corrected `tests/perf/README.md:9` + `:34`.
2. **JSON-shape gotcha fixed at execution.** vitest 2.1 outputJson reports percentiles directly on the benchmark task (NOT nested under `.result`). My initial interface assumed nested; local end-to-end verification at TLC-023b authoring caught it before commit.
3. **Warn-only landing achieved at branch-protection layer, NOT workflow level.** Codex r1 HIGH closure on TLC-023b: `continue-on-error: true` makes threshold breaches invisible to CI even when branch protection makes the check required. Right design: workflow fails on breach; branch protection decides whether the failure blocks merges.
4. **TLC-023c intentionally deferred.** Promotion-to-blocking needs CI-runner variance data first. 3-5 runs on main after Sprint 11 lands; tighten thresholds; then flip to required-blocking. Sprint 12 PM kickoff coordinates.
5. **p99 over-strict fallback when p95 absent.** Codex r1 HIGH closure on TLC-023a: midpoint approximation `(p75 + p99) / 2` was mathematically wrong. p99 fallback is over-strict but correct (p99 ≥ true p95 always, so over-flagging is the safe direction).

---

## Definition of Done — Sprint 11 closeout

- [x] PM-brief verification gate ran + findings recorded (Sprint 11 plan §"PM-brief verification gate findings")
- [x] TLC-023a thresholds + check-thresholds.ts + doc-drift fix
- [x] TLC-023b perf.yml + baseline.json + JSON-shape fix
- [x] All Sprint 11 Codex findings closed in-sprint via fix-forward
- [x] Lint + type-check clean throughout
- [x] No invariants relaxed
- [x] No production-code changes (TLC-023 = test infra + workflow + docs)
- [x] `SPRINT_11_REVIEW.md` filed (this doc — PARTIAL acceptance)
- [ ] `SPRINT_11_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 12 (TLC-023c promotion + next pivot)

---

## Sprint 12 kickoff — pending PM brief

Sprint 11 utilization 50% (5/10 — half of budget). The HIGHs converged in 1 round each (vs Sprint 10 TLC-021d's 4 rounds); novelty was lower than Sprint 9/10 schema/state-machine work because the perf surface is largely framework-mechanics not security-relevant business logic.

**Sprint 12 candidate scope:**
1. **TLC-023c** — promote perf.yml to required-blocking after 3-5 stable runs (mechanical 1-line flip to `continue-on-error: false` if it had been there; actually it's already removed at workflow level; what's needed at TLC-023c is the branch-protection wire-up via `gh api repos/.../branches/main/protection`). Evans coordinates emergency-only-access for branch protection.
2. **TLC-024** — next ORT row from TLC-015 audit. Candidates: OR-216 (build-vs-spec traceability matrix — actually already done at TLC-017 r2), OR-208 (data-filtering implementation status — TLC-019 descoped), so the next candidate is **per-slice perf scenarios** added to the bench harness. E.g., bench for `withTenantBoundConnection` open + close (Sprint 5+6 tenant-scoping hot path); for `emitAudit` hash chain compute (Sprint 1+ audit hot path); for state-machine validateTransition (Sprint 9+10 hot path).
3. **OR-217 pen test scope** — Counsel-side; partly out-of-repo; PM checks at kickoff.
4. **SI-001/002/003 status check** — re-check Promotion Ledger; if any closed, pivot to Slice 4.

**Recommended Sprint 12 path:** TLC-023c branch-protection wire-up (1-2 commits incl gh api wiring + retro on CI variance data) + TLC-024 second-bench-target authoring (e.g., `withTenantBoundConnection` perf scenario; ~3-4 commits) = ~6 commits total at 1.3× slack = ~8 commit budget.
