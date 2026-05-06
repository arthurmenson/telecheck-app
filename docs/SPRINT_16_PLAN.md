# Sprint 16 Plan — Telecheck-app autonomous build

**Sprint:** 16
**Sprint goal:** TLC-029 BUILD_VS_SPEC_TRACEABILITY_MATRIX.md amendment to reflect Sprint 13/14/15 cumulative state (OR-218 closure path BUILT; TLC-027 escalated; PROJECT_CONVENTIONS.md r2). Continued env-blocked-pivot per Sprint 14 retro NEW PM rubric sub-rule 5.
**Sprint start commit:** `24507fa` (Sprint 15 review/retro filed)
**Commit budget:** 4 (2 estimated × 1.4 slack + 2 fix-forward reserves; pure docs).
**Codex strategy:** SKIP per §5.2 pure-docs rule.

---

## PM-brief verification gate findings (Sprint 16 — 11th consecutive ALL PASS)

5 cited identifiers verified:
- P-008/P-009/P-010 latest 3 ledger entries — verified
- OR-216 + OR-218 in `Telecheck_Operational_Readiness_Todo_v1_5.md:127/129` — verified
- `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r2 (the doc being amended) — verified
- `docs/SPRINT_15_REVIEW.md` + `docs/SPRINT_15_RETRO.md` (cumulative-state source) — verified at `24507fa`
- `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md` — verified at `a443e7e`

---

## Environment availability check (per PM rubric sub-rule 5)

- Postgres in autonomous shell: **NO** (4th consecutive sprint blocked)
- Evans signal on `perf.yml` run accumulation: **NO**
- SI-001/002/003: **OPEN** (16 sprints)

All 3 env-dependent stories BLOCKED. Sprint 16 pivots to in-budget non-env work: **TLC-029 traceability matrix amendment.**

---

## Sub-stories committed

### TLC-029 — BUILD_VS_SPEC_TRACEABILITY_MATRIX.md r2 → r3 amendment

**Estimated commits:** 2 (matrix amendment + review/retro)
**Codex strategy:** SKIP per §5.2.

#### Acceptance criteria

- Bump revision history r2 → r3 with Sprint 13/14/15 entry
- Update OR-218 entry from "OPEN; scaffolded" to "OPEN; closure path BUILT (manifest helper + self-test + baseline-refresh-guard.yml); execution awaits Evans-side gh api PUT + 3-5 stable perf.yml main runs"
- Add reference to `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md` §1 + §2.1
- Add reference to `docs/TLC-027-DB-BENCH-INFRA-ESCALATION.md` (Sprint 15+ pending; 2nd Codex finding-class escalation)
- Update PROJECT_CONVENTIONS.md cross-reference to r2 (was r1)
- Cumulative Codex finding count: bump from prior matrix's count to "39 closed (23 HIGH + 16 MEDIUM); 2 finding-classes escalated"

---

## Definition of Done — Sprint 16

- [ ] PM-brief verification gate ran (this doc)
- [ ] BUILD_VS_SPEC_TRACEABILITY_MATRIX.md r3 landed
- [ ] No invariants relaxed
- [ ] No production-code changes
- [ ] `docs/SPRINT_16_REVIEW.md` filed
- [ ] `docs/SPRINT_16_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 17 (re-check 3 env-availability questions)

---

## Sprint 17 hand-off

Sprint 17 PM kickoff verifies:
1. Postgres available in autonomous shell? → TLC-027 EXECUTE if YES
2. Evans signal received? → OR-218 EXECUTE if YES
3. SI-001/002/003 closed? → Slice 4 if YES
4. If all NO: 5th consecutive env-blocked sprint; surface to Evans the cumulative env-blocked pattern via project status doc
