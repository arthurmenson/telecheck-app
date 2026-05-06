# Sprint 13 Plan — Telecheck-app autonomous build

**Sprint:** 13
**Sprint goal:** Build the closure path for Sprint 12 escalation (TLC-026): manifest-check helper that fails gate when expected scenarios lack baseline entries + CI-calibration runbook extension. Sprint 14+ executes (Evans-side `gh api` + CI baseline capture).
**Sprint start commit:** `d22d107` (Sprint 12 PARTIAL ACCEPTANCE)
**Commit budget:** 6 (4 estimated × 1.2 slack + 2 fix-forward reserves; framework/perf heuristic)
**Codex strategy:** FIRE on manifest helper commit; SKIP on doc-only updates

---

## PM-brief verification gate findings (Sprint 13 — 8th consecutive ALL PASS)

5 cited identifiers verified:
- P-008/P-009/P-010 latest 3 entries; no P-011/012/013 — confirmed at `Telecheck_Promotion_Ledger.md:40/100/176`
- OR-218 — verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:129` (Sprint 11+ verified)
- `vitest.bench.config.ts:36` `setupFiles: []` — verified
- `tests/perf/check-thresholds.ts:67-117` THRESHOLDS array integration point — verified
- `tests/perf/README.md` Sprint 13 TLC-026 escalation reference — verified

---

## Promotion Ledger check

SI-001/002/003 still open (13 sprints). **No Slice 4 pivot.** Continue closure-path infrastructure track.

---

## Critical constraint (Evans Option A; 2026-05-05)

Evans selected Option A on the OR-218 branch-protection wire-up: defer `gh api` execution until autonomous Claude surfaces a "ready to flip" message after TLC-026 lands + 3-5 stable `perf.yml` runs accumulate. Sprint 13 builds the **infrastructure** for closure; Sprint 14+ executes when CI variance data is in hand AND Evans is reachable.

**Sprint 13 work CANNOT include:**
- Actual baseline capture from CI artifacts (autonomous Claude has no `gh` auth)
- Threshold tightening based on CI variance (no data yet)
- Branch-protection wire-up (Evans Option A defers)

**Sprint 13 work CAN include:**
- Manifest-check helper code (no auth needed)
- Documentation extensions
- Sprint 14+ runbook + ready-to-flip checklist

---

## Sub-stories committed

### TLC-026 — Manifest-check helper + CI-calibration runbook

**Estimated commits:** 3 (helper + runbook ext + README update; +2 fix-forward reserves)
**Decision rule:** Sprint 12 retro escalation pattern (closure-path-infrastructure-now; execution-Sprint-14+)
**Codex strategy:** FIRE on helper commit; SKIP on doc-only commits

#### Acceptance criteria

- **Manifest-check helper** in `tests/perf/check-thresholds.ts`:
  - Define explicit `EXPECTED_SCENARIOS` constant (or refactor `THRESHOLDS` to expose the manifest as a derived view)
  - Helper function `verifyManifestCoverage(tasks, expected)` that iterates expected scenarios + checks each has a corresponding bench task in the output JSON
  - Failure mode: any expected scenario missing → exit 1 with explicit "missing scenario: <name>" error message
  - Manifest itself becomes the "what bench scenarios MUST exist for the gate to pass" source of truth
  - Reuse `THRESHOLDS[].taskNameMatch` field as the scenario identifier; no duplication
- **CI-calibration runbook extension** in `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md`:
  - New §"CI baseline capture procedure" with concrete `gh run download <run-id> --name bench-output-<id>` flow
  - Prerequisite: 3-5 stable `perf.yml` main runs (gh CLI command to verify count)
  - Post-capture: commit baseline.json with `[scope=baseline-refresh]` tag in commit message + manifest-check verification before commit
- **`tests/perf/README.md` update**:
  - Flip "deferred to Sprint 13 TLC-026" language at lines 60-78 to "Sprint 13 built closure path; Sprint 14+ executes when CI variance data + Evans access converge"
  - Document the new manifest-check behavior + how it integrates with `--compare baseline.json`

#### Codex anticipation (per PM brief §7)

Likely findings to expect:
- Symbolic-constant naming vs duplication-with-THRESHOLDS (pre-emptive: derive manifest from THRESHOLDS)
- "Missing scenario" severity (HIGH vs MEDIUM at gate-failure)
- Test coverage for the helper itself (a missing-scenario detector with no unit test is its own anti-pattern; consider adding a lightweight unit test)

---

## Definition of Done — Sprint 13

- [ ] PM-brief verification gate ran + findings recorded
- [ ] TLC-026 manifest-check helper authored
- [ ] CI-calibration runbook extension to TLC-023c handoff doc
- [ ] `tests/perf/README.md` updated to reflect new state
- [ ] Codex FIRE on helper commit; HIGH/CRITICAL closed in-sprint
- [ ] Lint + type-check clean
- [ ] No invariants relaxed
- [ ] No production-code changes
- [ ] `docs/SPRINT_13_REVIEW.md` filed
- [ ] `docs/SPRINT_13_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 14 (CI variance + Evans surface check)

---

## Risks

- **Codex may flag manifest helper as missing-its-own-test.** Mitigation: include a lightweight unit-test that asserts the helper detects a synthetic missing-scenario case. If Codex still flags after that, fix-forward inline.
- **TLC-025 (DB-backed bench infra) deferred to Sprint 14+ alongside execution.** Sprint 13 retro confirms whether Sprint 14 should bundle TLC-025 + TLC-026 execution + Sprint 14 CI-variance-derived threshold tightening into one sprint OR split. Current recommendation: Sprint 14 = TLC-026 execution alone; Sprint 15+ = TLC-025 DB-backed infra.

---

## Sprint 14 hand-off (advance signal for Evans + autonomous Claude)

When Sprint 13 closes, Sprint 14 PM kickoff verifies:
1. `perf.yml` accumulated 3-5 stable runs on `main` (via `gh run list --workflow=perf.yml --branch=main --limit=10` — autonomous Claude likely still has no auth; surface as a "request Evans verifies" item)
2. Manifest-check helper passes locally on current bench output
3. If both: Sprint 14 surfaces a "ready to flip" message to Evans with the specific `gh api` command (preserving all existing required-status-check contexts)
4. Evans executes; Sprint 14 verifies via post-execution `gh api ... GET`
5. ORT row OR-218 status flips from "scaffolded" to "FULLY CLOSED" in `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r3 amend
