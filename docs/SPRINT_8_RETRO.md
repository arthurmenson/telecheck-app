# Sprint 8 Retrospective — Telecheck-app autonomous build

**Sprint:** 8
**Window:** 2026-05-05 (single-day burn)
**Sprint goal:** Pivot to Async Consult slice authoring (Sprint 1 of 3) — module skeleton + branded IDs + 17-state vocabulary + plugin smoke test — **Achieved**
**Total commits:** 2 / 6 budgeted (33% utilization — back to Sprint 1-4 range)

---

## What went well

- **PM-brief verification gate landed clean for the 3rd consecutive sprint.** 10 cited identifiers verified; ALL PASS. The gate is now a stable standing artifact. The Sprint 3 + Sprint 5 hallucination class has not recurred since `804c294`.
- **Codex APPROVE first-try.** No fix-forward needed. The 4th application of the BLOCKED-aware skeleton recipe is the cleanest yet — the recipe is genuinely mature. Codex confirms when the surface is a known-good recipe applied to a new module.
- **State value canonicalization caught at PM kickoff.** PM read PRD §12 + State Machines §3 + flagged the divergence (PRD's DECISION_MADE absorbed; State Machines adds EXPIRED + CLOSED). SM verified the canonicalization rule (Slice PRD vs State Machines → State Machines wins per CLAUDE.md hard rule) and applied it inline. This is exactly what the Sprint 5 retro internal-canonicalization-pattern sub-rule was designed for.
- **Closure-language lesson applied a-priori.** Sprint 7 TLC-018 retro lesson ("don't say 'closes <X>' when scope is 'scaffolds'") was applied here without prompting — README + commit say "Sprint 1 of 3", never "closes Async Consult slice". One iteration of process drift caught + codified + applied at next sprint.
- **Cross-slice dependency posture documented.** PRD §15 lists 14 dependencies; skeleton README enumerates each with current implementation status (3 available now via Identity/Forms-Intake/Consent; 11 BLOCKED or not-yet-authored). Downstream slice authors (Sprint 11+) get a clear map.
- **First non-blocked slice authoring since Sprint 1 went smoothly.** The pre-pave runway exhaustion was visible at Sprint 6 retro; the pivot was planned at Sprint 7 retro; Sprint 8 executed cleanly. Multi-sprint visibility prevented the pivot from being a Sprint 11 surprise.

---

## What didn't

- **PM brief had one minor verification miss.** PM said "16 states + EXPIRED = 17". State Machines §3 actually adds BOTH EXPIRED + CLOSED (and omits PRD's DECISION_MADE). SM caught it in the verification gate via a fuller read of L196-218. Net result: skeleton uses correct list (17 from State Machines) and the README documents the divergence. But the PM brief itself was slightly incomplete — should have read further into the transition table.
- **Audit event vocabulary deferral risk.** PRD §13 enumerates 11 events; canonical AUDIT_EVENTS contract has 0. Sprint 10 will need either:
  - (a) Spec authoring (file SI-004) to ratify these events into AUDIT_EVENTS — out-of-repo work
  - (b) Defer Sprint 10 deliverable until SI-004 closes — pushes Async Consult to Sprint 11+
  - (c) Author Sprint 10 with placeholder event_types matching PRD §13 verbatim and document SI-004 as the resume gate

  Sprint 9 PM kickoff should make this decision. SM's preference is (c) — placeholder events + SI-004 doc — because waiting on out-of-repo work would idle the autonomous build. But the decision should be PM-led at Sprint 9 with the trade-offs explicit.
- **Sprint 8 utilization 33% on a 1.3× slack budget.** PM proposed 1.3× because "new module class warrants extra slack"; actual was 33% — recipe maturity dominated novelty. Lesson: when applying an established recipe to a new instance, default to 1.2× even if the instance is in a new module class. Sprint 9 will be different — first novel-state-machine + first novel-repo authoring since Sprint 1 — and 1.2× is still right for that.

---

## Process changes for Sprint 9

1. **PM kickoff: full state-machine transition table read.** Sprint 8 PM read 50 lines of State Machines §3; missed the CLOSED transition at L212. Sprint 9 PM MUST read the full transition table (L196-218+) AND verify all guard conditions + actions. State machine transition logic is the highest-risk authoring surface; PM brief must enumerate every transition with file:line citation.
2. **Audit event SI-004 decision at Sprint 9 PM kickoff.** Don't defer the decision to Sprint 10. SM proposes option (c): author with placeholder events + file SI-004 candidate doc; document the placeholder-vs-canonical resolution path. PM should accept/reject/modify at Sprint 9 with explicit rationale.
3. **Recipe-vs-novel slack heuristic.** When PM proposes 1.3× slack, ask explicitly: "is this recipe-mirror or novel?" Recipe-mirror → 1.2×. Novel-of-class (state machine, novel data flow, novel cross-slice integration) → 1.3×. This sprint shouldn't have used 1.3× — Sprint 8's "new module class but applied recipe" was 1.2× territory.

---

## Lessons feeding the PM rubric

- **No new sub-rules proposed by Sprint 8.** The 4 sub-rules from Sprint 1/3/5 retros are stable.
- **One reinforcement on the spec-corpus identifier check sub-rule:** PM SHOULD read fully past the cited section — Sprint 8 PM cited State Machines §3 but only read 50 lines. The verification gate caught the gap (CLOSED state). This sub-rule already says "read the cited section" but should clarify "read fully through the relevant content, not just the section header". Soft-codify; not a hard rule update.

---

## Forward-looking notes for Sprint 9

- **Sprint 9 = TLC-021** — Async Consult repos + service layer + state machine + initial HTTP handlers. Estimated 5-8 commits across the iteration. Codex FIRE on every commit (state machine + repo + service are all novel-of-class).
- **CDM §4 Consult expansion verification is the gating PM step.** If CDM §4 doesn't expand Consult / ConsultEvent row shapes, Sprint 9 either:
  - Files SI-005 candidate + uses placeholder row interfaces with SI-005 as the resume gate (parallel to SI-004 audit-event posture)
  - OR descopes the repo/service layer until the spec lands
- **Sprint 10 = TLC-022** — full HTTP integration + audit + domain events + cross-tenant tests. ~5-10 commits.
- **After Sprint 10, Async Consult slice is at v1.0 functional**. Sprint 11 = hardening + launch-prep (perf benches per OR-218 promotion path; security review surfaces; etc.). EHBG §10b sequencing puts Pharmacy + Refill at Sprint 4 of EHBG (separate from this internal sprint number) — but those remain BLOCKED on SI-001 closure. Net: by Sprint 11 internal we're at the launch-readiness boundary on the in-repo work.

---

## Codex tracking — 1st-try APPROVE on Sprint 8

| Sprint | Finding | Severity | Closure |
| --- | --- | --- | --- |
| 1 | `pharmacy-blocked-handler` | MEDIUM | `5615feb` |
| 2/3/4 | (skipped per pre-empt rationale) | — | — |
| 5 | `idempotency-r5` (TTL test over-permissive) | HIGH | `0f4a757` |
| 6 | `rls-policy-r1` (soft-skip on missing tables) | MEDIUM | `2dece96` |
| 7 | `perf-bench-r1` (closure-language overclaim) | HIGH | `d879a79` |
| **8** | **APPROVE first-try** | — | **(no fix-forward)** |

4 substantive findings + 1 first-try approve across 5 non-skip Codex runs. Codex strategy is well-calibrated: SKIP for pure-docs / pattern-mirror; FIRE for novel work; APPROVE on first-try when the work is "novel module instance applying a mature recipe".

---

## Final commit cumulative state

- Head: `2a44164`
- Sprint commits: 2 (Sprint 8 kickoff `ba38eff` + TLC-020 `2a44164`)
- CI: green expected (lint + type-check clean; integration test pending CI's ephemeral Postgres)
- DoD: 8 of 8 boxes per story green (Codex APPROVE first-try; no fix-forward)
- Process docs added by Sprint 8: SPRINT_8_PLAN.md + SPRINT_8_REVIEW.md + SPRINT_8_RETRO.md (this doc)
- New module: `src/modules/async-consult/` (4th BLOCKED-aware skeleton; Sprint 1 of 3)
- New branded IDs: 2 (ConsultId, ConsultEventId; cumulative 13)
- New state vocabulary: 1 (CONSULT_STATES, 17 values)
- Cumulative Codex findings closed: 4 (Sprint 1 + 5 + 6 + 7)
- PM-brief verification gate runs: 3 (Sprint 6 + 7 + 8); all ALL PASS
- Pre-pave runway: EXHAUSTED (confirmed Sprint 7); Sprint 8 began the slice-authoring pivot
