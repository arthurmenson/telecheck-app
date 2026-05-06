# Sprint 9 Retrospective — Telecheck-app autonomous build

**Sprint:** 9
**Window:** 2026-05-05 (single-day burn — but materially denser than prior sprints)
**Sprint goal:** Async Consult slice authoring continuation — Sprint 2 of 3 — **Partially achieved (3 of 6 sub-stories; budget hit; remainder deferred to Sprint 10)**
**Total commits:** 12 / 12 budgeted (100% utilization; budget hit at the cap)

---

## What went well

- **PM-brief verification gate landed clean for the 4th consecutive sprint.** 10 cited identifiers verified; ALL PASS. The Sprint 3 + Sprint 5 hallucination class has not recurred since the gate was instituted at `804c294`. Even on Sprint 9 — the highest-novelty schema-authoring sprint since Sprint 1 — the PM brief was structurally clean.
- **Codex earned its keep at unprecedented rate.** 8 fix-forward rounds across 3 sub-stories; 9 HIGH + 2 MEDIUM closed. Each finding represented a real defect class (cross-tenant binding via composite FK, in-place migration edit unsafe for upgraded DBs, partial-apply rollback hazards across DROP POLICY / DROP TRIGGER / ALTER, RLS-alone-insufficient on externalTx path, unconditional state machine guards, event/context mismatch in untyped runtime callers). None were taste/preference findings.
- **Each Codex round produced a structurally correct convergence step.** No regressions across the 8 rounds; each fix-forward landed the right fix. The discipline pattern (apply HIGH severity gating; document the closure inline in commit message; re-fire Codex; APPROVE on convergence) worked end-to-end.
- **Major patterns established and codified inline:**
  - Composite UNIQUE + composite FK pattern for tenant-bound parent-child tables
  - to_regclass guards on table-targeting rollback statements
  - Explicit tenant_id predicate on tenant-scoped repo queries (defense-in-depth alongside RLS)
  - Typed GuardContext discriminated union for state machine transitions
  - Event/context match enforcement at runtime for state machines
  Each pattern is now codified inline in code comments + commit messages; Sprint 10 retro will lift them to project conventions doc.
- **Budget cap held.** When commit count hit 12 of 12, the Sprint plan's "pause + fix-forward + surface" rule activated cleanly. TLC-021d/e/f deferred to Sprint 10 with a clear scope handoff.

---

## What didn't

- **Sprint 9 was the most scope-inflated sprint by Codex round count.** 8 rounds vs Sprint 1-8 cumulative 4 rounds (1 each in Sprints 1, 5, 6, 7). Each round was substantive, but the cumulative cost is real: 8 fix-forward commits beyond planned scope means 3 of 6 sub-stories shipped instead of 6. Net throughput: 50% of planned scope at 100% of budget.
- **Initial migration design didn't surface the composite-FK pattern at PM brief time.** The PM brief described the placeholder schema posture (SI-005) without specifying the cross-tenant-binding-prevention surface. Codex r1 caught it at review; with hindsight the PM brief should have enumerated cross-tenant defense layers (RLS + composite FK + explicit predicates) explicitly so the SM author was on notice from the start.
- **State machine guards weren't surfaced at PM brief time.** PRD §12 + State Machines §3 document the guards in plain text ("Form complete, consent blocks resolved" for `submit`); the PM brief's transition table summary at §4 didn't extract the guard column into a structural concern. SM author implemented as unconditional transitions; Codex r7 caught it. Same observation as the composite-FK case: PM brief could have surfaced the guard pattern as a structural concern.
- **The "5 Codex rounds on TLC-021a" pattern is an outlier vs Sprint 1-8 single-round closures.** Each round caught a real defect, but the pattern suggests the migration was too compositionally novel for single-round review. Lesson: for novel schema work, expect multi-round Codex iteration AND budget for it explicitly in the sprint plan (not as fix-forward reserve, but as expected baseline cost).
- **Service layer + handlers + tests deferred.** Sprint 9 was supposed to deliver the full slice from migration through handlers. Cap forced a 50%-scope partial. Sprint 10 inherits the remaining 50% — manageable but worth acknowledging as a Sprint 9 incomplete-delivery risk that materialized.

---

## Process changes for Sprint 10

1. **PM brief for novel schema/state-machine work MUST surface defense-in-depth structure as a checklist.** Specifically:
   - For schema authoring: enumerate cross-tenant defense layers (RLS + composite FK + explicit predicates) at brief time so the SM author is on notice.
   - For state machine authoring: extract the guard column from the transition table into a structural concern; require the brief to identify which transitions are guarded vs unguarded.
   - This lifts Sprint 9 retro lessons into PM rubric scope without adding a new sub-rule (it's a reinforcement of the existing internal-canonicalization-pattern check).
2. **Sprint plan budget for novel schema sprints should explicitly reserve N fix-forward rounds.** Sprint 9 had 1.3× slack on top of planned commit count; that wasn't enough. For Sprint 10, plan: estimated commits + 1.3× slack + N fix-forward reserves (where N = expected Codex rounds = ~3 for novel-of-class work, ~1 for recipe-mirror work). Sprint 10 service layer + handlers are recipe-mirror-with-novel-data; budget 1-2 fix-forward rounds.
3. **Codex novelty heuristic: 5+ rounds means stop and reassess scope.** If a single sub-story hits 5 fix-forward rounds (TLC-021a precedent), pause and either: (a) descope the sub-story to next sprint, (b) re-author from scratch with the convergence pattern in hand, or (c) surface to Evans for scope-inflation decision. Codify in SCRUM_OPERATING_MODEL §"Codex review protocol".
4. **Codify the established patterns into project conventions doc at Sprint 10.** TLC-022 (Sprint 9 retro process change deliverable) lifts the 4 patterns established this sprint (composite FK, to_regclass rollback, explicit tenant predicates, typed guards) into a single conventions doc that future migrations + repos + state machines reference.

---

## Lessons feeding the PM rubric

- **Sub-rule reinforcement (no new rule):** internal-canonicalization-pattern check should explicitly include "cross-cutting structural concerns" — defense layers, guards, etc. — for novel-class authoring work. Soft-codify.
- **Sub-rule reinforcement (no new rule):** spec-corpus identifier check should include reading guard columns + transition guards explicitly when proposing state-machine work. Sprint 9 PM brief read the transition table but didn't extract guard column as structural.

---

## Forward-looking notes for Sprint 10

- **Sprint 10 scope:** TLC-021d (service layer) + TLC-021e (HTTP handlers) + TLC-021f (integration tests) + TLC-022 (project conventions doc lifting Sprint 9 patterns). Estimated 8-10 commits with 1-2 fix-forward reserves.
- **Codex strategy for Sprint 10:** FIRE on every sub-story. Service layer is novel-of-class (first cross-slice integration with Identity + Forms-Intake + Consent at the service-orchestration level); handlers are pattern-mirror of existing handler shape with novel state-machine integration; integration tests are pattern-mirror.
- **After Sprint 10 closes the Async Consult slice**, pre-pave runway is again exhausted. Sprint 11 = either Slice 4 (if SI-001 closes; probability unknown — has been open for 9 sprints), another available slice PRD (PM scouts), or emergency-access surfacing.
- **Cumulative Codex stats** (post-Sprint 9): 12 HIGH + 4 MEDIUM closed across all sprints. Codex is now the most-impactful single discipline mechanism on the project (more than PM verification gate, more than DoD checklist). The 15-min hard cap + severity-gated fix-forward pattern + re-verify-on-fix discipline are all working as designed.
- **Pre-pave runway exhaustion ratio:** Async Consult slice will be ~40 commits across Sprints 8-10 when complete. EHBG §10b sequencing has 6 more slice PRDs unauthored; if pre-pave runway exhausts again at Sprint 11+, the project pivots to either upstream-spec dependence OR aggressive emergency-access vendor integration with Evans's involvement.

---

## Codex tracking — Sprint 9 finding ledger

| Round | Sub-story | Severity | Finding | Closure commit |
| --- | --- | --- | --- | --- |
| r1 | TLC-021a | 2× HIGH + 1× MEDIUM | Composite FK gap (cross-tenant binding); patient ownership unenforced; intake ownership unenforced | `c065adf` |
| r2 | TLC-021a | 1× HIGH | In-place migration edit unsafe for upgraded DBs | `469c98b` |
| r3 | TLC-021a | 1× HIGH | Constraint name mismatch breaks rollback ordering | `cb961d3` |
| r4 | TLC-021a | 1× HIGH | ALTER + DROP TRIGGER abort on missing-table partial-apply | `1c291d3` |
| r5 | TLC-021a | 1× HIGH | DROP POLICY abort on missing-table partial-apply | `8586f48` |
| r6 | TLC-021b | 1× HIGH + 1× MEDIUM | Explicit tenant predicates needed (RLS alone insufficient on externalTx) | `ba93644` |
| r7 | TLC-021c | 1× HIGH | State machine guards modeled as unconditional | `265b787` |
| r8 | TLC-021c | 1× HIGH | Guard context event trusted independently of requested transition | `d5d8a3d` |

**Total:** 9 HIGH + 2 MEDIUM closed across 8 fix-forward rounds.

---

## Final commit cumulative state

- Head: `d5d8a3d`
- Sprint commits: 12 (kickoff + 11 substantive — 7 on TLC-021a, 2 on TLC-021b, 2 on TLC-021c)
- CI: green expected (lint + type-check clean; integration tests deferred TLC-021f)
- DoD: 8 of 11 boxes green; 3 deferred to Sprint 10 (TLC-021d/e/f)
- Process docs added by Sprint 9: SPRINT_9_PLAN.md + SI-004 + SI-005 + SPRINT_9_REVIEW.md + SPRINT_9_RETRO.md (this doc)
- New SQL: migrations 020 + 021 + paired rollbacks (4 SQL files)
- New TypeScript: 4 files (types.ts updates + 2 repos + state-machine.ts)
- Cumulative Codex findings closed: 16 (12 HIGH + 4 MEDIUM)
- PM-brief verification gate runs: 4 (Sprint 6 + 7 + 8 + 9); ALL PASS
- Pre-pave runway: still exhausted; Async Consult slice now 67% complete (Sprint 8 + Sprint 9 partial; Sprint 10 closes)
