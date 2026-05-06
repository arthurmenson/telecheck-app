# Sprint 12 Plan — Telecheck-app autonomous build

**Sprint:** 12
**Sprint goal:** TLC-023c branch-protection wire-up doc + TLC-024 second perf bench target (`validateTransition`).
**Sprint start commit:** `75825b8` (Sprint 11 PARTIAL ACCEPTANCE)
**Commit budget:** 6 (4 estimated × 1.2 slack + 2 fix-forward reserves; per Sprint 11 retro #1 framework/perf/test-infra heuristic)
**Codex strategy:** SKIP on TLC-023c (doc only); FIRE on TLC-024 (novel bench scenarios)

---

## PM-brief verification gate findings (Sprint 12 — 7th consecutive ALL PASS)

| Identifier | PM cited | Verified | Match |
| --- | --- | --- | --- |
| `validateTransition` | `state-machine.ts:319` | confirmed | ✓ |
| Not in public barrel | `index.ts` grep | confirmed | ✓ |
| `vitest.bench.config.ts:36` `setupFiles: []` | confirmed | ✓ |
| `tests/perf/state-machine/` | does NOT exist | ✓ |
| `withTenantBoundConnection` DB-backed | `db.ts:297` (Sprint 10 verified) | ✓ |
| `emitAudit` DB-backed | `audit.ts:594` (Sprint 7 verified) | ✓ |
| P-010 latest, no P-011/012/013 | Sprint 11 verified; trust | ✓ |
| OR-218 | `ORT.md:129` (Sprint 11 verified) | ✓ |

**SM correction recorded inline:** PM brief §3 example used fictitious state names (`patient_started → patient_drafting`). Real Async Consult states per State Machines v1.1 §3 + `state-machine.ts:CONSULT_STATES`: `INITIATED / INTAKE / SUBMITTED / PROCESSING / etc.` TLC-024 authoring uses real state names.

---

## Promotion Ledger check

SI-001/002/003 still open (12 sprints). No Slice 4 pivot. Continuing residual hygiene + perf-coverage track.

---

## Sub-stories committed

### TLC-023c — Branch-protection wire-up doc (Sprint 12 close-out for OR-218)

**Estimated commits:** 1
**Decision rule:** 6 (UAT / launch-readiness)
**Codex strategy:** SKIP

#### Acceptance criteria

- New doc `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md` containing:
  - Exact `gh api repos/:owner/:repo/branches/main/protection` PUT payload
  - Required-status-check name (`Performance benchmarks / bench` from `perf.yml:34`)
  - CI-runner variance characterization plan (3-5 main-runs to capture variance distribution before tightening thresholds)
  - Threshold-tightening worksheet (where to update `tests/perf/check-thresholds.ts:THRESHOLDS` after measurement)
  - Verification steps post-execution (Sprint 13+ confirms via `gh api` GET)
  - Rationale: Evans (emergency-only access) executes when available; this doc unblocks Sprint 12 without waiting

### TLC-024 — `validateTransition` perf bench (second pure-function bench target)

**Estimated commits:** 3 (bench file + threshold script extension + baseline.json regen + fix-forward reserve)
**Decision rule:** 6
**Codex strategy:** FIRE

#### Acceptance criteria

- New bench file `tests/perf/state-machine/validate-transition.bench.ts` with 4 scenarios:
  - **§1 happy path** — `INITIATED + start_intake + valid GuardContext → INTAKE` (no throw)
  - **§2 InvalidTransitionError** — wrong from-state for event (e.g., `SUBMITTED + start_intake` — expecting `INITIATED`)
  - **§3 GuardNotSatisfiedError** — runtime guard violation (e.g., `submit + form_complete: false`)
  - **§4 UnsupportedTransitionError** — Sprint-10-deferred event (e.g., `claim`)
- Update `tests/perf/check-thresholds.ts` `THRESHOLDS` array with 4 new entries:
  - §1 happy path: `<2μs` p99 (pure logic; tight)
  - §2 InvalidTransitionError: `<10μs` p99 (loose; throw-cost dominates)
  - §3 GuardNotSatisfiedError: `<10μs` p99 (same)
  - §4 UnsupportedTransitionError: `<10μs` p99 (same)
- Regenerate `tests/perf/baseline.json` from local run with all 8 scenarios (4 crisis + 4 validate-transition)
- Update `tests/perf/README.md` with the new scenarios documented

#### Bench-author discipline (PM Risk #1)

Throw scenarios (§2/§3/§4) include V8 stack-capture overhead in the measurement. Document this in the bench file comments + check-thresholds.ts so SM doesn't over-tighten thresholds and chase stack-capture variance instead of validation logic regressions.

---

## Definition of Done — Sprint 12

- [ ] PM-brief verification gate ran + findings recorded (this doc §"PM-brief verification gate findings")
- [ ] TLC-023c doc filed
- [ ] TLC-024 bench + threshold updates + baseline regen
- [ ] Codex FIRE on TLC-024; HIGH/CRITICAL closed in-sprint
- [ ] Lint + type-check clean
- [ ] No invariants relaxed
- [ ] No production-code changes (TLC-024 = test infra; TLC-023c = pure docs)
- [ ] `docs/SPRINT_12_REVIEW.md` filed
- [ ] `docs/SPRINT_12_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 13 (next pivot — likely DB-backed bench infra OR Slice 4 if SI-001 closes)

---

## Risks (PM-flagged + SM additions)

- **PM Risk 1: Throw-cost dominance in §2/§3/§4 scenarios.** V8 stack-capture overhead per throw + catch can be 1-10μs depending on stack depth. Threshold for reject-path scenarios deliberately loose (<10μs p99). Document in bench file comments.
- **PM Risk 2: Pure-function bench coverage exhausting.** After TLC-024, the next bench targets are DB-backed (emitAudit, withTenantBoundConnection, idempotency lookup, repo CRUD). Sprint 13+ likely needs bench-mode ephemeral-Postgres infra investment. Sprint 12 retro should flag whether pure-function corpus is exhausted at TLC-024.
- **SM addition: ESLint may flag bench file imports from `internal/`.** `tests/` is allowed to reach into `internal/` per project conventions; verify lint passes after authoring.

---

## Codex strategy detail

**TLC-024 — FIRE.** Narrow scope:
```
node ".../codex-companion.mjs" adversarial-review "--background --base 75825b8 tests/perf/state-machine/ tests/perf/check-thresholds.ts tests/perf/baseline.json"
```

Likely Codex defect classes:
- Threshold tightness (Sprint 11 r1 precedent)
- p95 fallback math (Sprint 11 r1 closure already addressed but may resurface in new context)
- Bench scenario fidelity (does the bench measure validateTransition, not setup overhead?)
