# Sprint 30 — Retrospective

**Sprint:** 30
**Closed:** 2026-05-06
**Final commit:** `8c7efd5` (Merge PR #33 — Sprint 30 corrective Items 2+4) — with companion landings at PR #34 (`e5c36c2` SI-006 v0.1 → v0.2) and PR #35 (`955c579` r5 proposal to drafts/).
**Sprint goal (recap):** Land Sprint 30 corrective Items 2 and 4 surfaced by Agent X + Codex SME advisory cross-family review (banner work + TLC-050 defensive fix); execute SI-006 v0.1 → v0.2 corrections per the same advisory.
**Goal achieved:** ✅

---

## What went well

- **External SME advisory caught what 4 prior sprints had not.** Agent X + Codex cross-family review identified two distinct concerns: (1) the Sprint 27-filed SI-006 v0.1 contained a verifiable factual error about `migrations/005_idempotency_keys.sql` schema state plus glossed over Postgres aborted-tx semantics in its duplicate-key pseudocode; (2) the Sprint 27 review/retro pair were self-graded "FULL ACCEPTANCE" by the authoring agent without external challenge. Sprint 30 landed both classes of correction without litigation.
- **SI-006 v0.1 → v0.2 corrections landed cleanly.** `f51694c` (SI-006 v0.1 → v0.2 — Sprint 30 corrections from Agent X / Codex review) executed three concrete fixes: removed false claim that `processing_state` column "needs verification" (the column already exists at `migrations/005_idempotency_keys.sql:77-84`); filled in the previously-glossed duplicate-key handling with Postgres aborted-tx-aware pseudocode using `ON CONFLICT DO NOTHING RETURNING`; reframed the gate scope from "before Pharmacy" to "before any patient-visible state-mutating slice" (which Async-Consult and Consent were both already past).
- **Sprint 30 corrective Items 2 + 4 banner work + TLC-050 defensive fix landed atomically in PR #33** (`8c7efd5`) with two follow-on patches `5e8f71b` (r2 — tenant id regex letters-only) and `efae4b9` (r3 — tenants CHECK constraint `consumer_dba LIKE 'Heros Health%'`) — both narrow defensive hardening of the Heros Health brand-structure cascade per Master PRD v1.10 §17.
- **r5 proposal landed to `docs/drafts/`** (`8465d69` PR #35) rather than being promoted directly to canonical PROJECT_CONVENTIONS — preserving the propose-then-promote separation that Sprint 30 retro's process-discipline correction explicitly called for.
- **Sprint 27 review/retro retroactively softened** with explicit `(Note Sprint 30 cleanup, 2026-05-06)` preamble citing the SME advisory findings (visible at the top of `docs/SPRINT_27_REVIEW.md`). The "ceremonial closure language" was replaced with honest "agent-graded pending external review" framing.

## What didn't go well

- **Self-graded "FULL ACCEPTANCE" was a known failure mode.** Sprint 27 graded itself FULL based on the autonomous agent's contemporaneous account; Sprint 30 had to retroactively soften that language after external review found two substantive issues. The autonomous arc had no external-challenge gate between sprint close and "ACCEPTANCE" until Sprint 30 made the gap explicit.
- **SI-006 v0.1 should have been Codex-reviewed at filing.** Per §5.2 / §5.8 the SI was a pure docs/SI escalation (Codex SKIP candidate), but the SI's pseudocode + factual claims about migration state were exactly the class of content Codex review surfaces well. Sprint 30 retro added the corrective rule that SI/DSI filings touching schema or runtime semantics get Codex review regardless of "pure docs" framing.
- **Sprint 30 was triggered by external SME review, not internal cadence.** The retrospective-Codex cadence promoted in Sprint 26 retro hadn't yet fired at Sprint 30 (counter was at SKIP-streak +2 from Sprint 28/29). The SME advisory pre-empted the autonomous retrospective trigger.

## Process changes adopted

- **§5.12 retroactive-cleanup discipline** drafted at r5 proposal (`8465d69` → `docs/drafts/`). Rule: when an external review finds substantive errors in a sprint that self-graded ACCEPTANCE, the sprint's review/retro are amended in place with a clearly-marked preamble citing the corrective sprint; the body is preserved as the agent's contemporaneous account; ceremonial closure language softened.
- **r5 proposed but not canonically promoted in Sprint 30.** The proposal-vs-promotion separation was itself a process correction: prior r-bumps had landed PROJECT_CONVENTIONS amendments atomically with the codifying commit; Sprint 30 split the steps to allow Sprint 30+ to either ratify (promote) or revise the proposal based on Sprint 31+ experience. The r5 proposal ultimately landed at canonical Sprint 33-34 closure as the SI-006 closure-pattern codification (PROJECT_CONVENTIONS r5 / Sprint 33-34) — different content than the Sprint 30 drafted proposal.
- **External-review acknowledgement protocol.** Sprint 30 set the precedent for how the autonomous arc records external SME findings: the originating SI/doc is amended with a clear "vX.Y (date, Sprint N corrections):" revision-history entry; the corrective sprint's retro documents the trigger; the affected upstream sprint's review/retro carry a preamble.

## Codex review findings closed

| PR | Finding | Severity | Round | Closure commit |
|---|---|---|---|---|
| #34 | SI-006 v0.1 schema-state claim wrong | HIGH (correctness) | external SME r1 | `f51694c` |
| #34 | SI-006 v0.1 duplicate-key pseudocode glossed Postgres aborted-tx | HIGH (correctness) | external SME r1 | `f51694c` |
| #34 | SI-006 v0.1 severity-scope too narrow ("before Pharmacy") | MEDIUM (framing) | external SME r1 | `f51694c` |
| #33 | Brand-structure cascade tenant_id regex too permissive | MEDIUM (defensive) | Sprint 30 internal r2 | `5e8f71b` |
| #33 | Brand-structure cascade tenants CHECK constraint missing | MEDIUM (defensive) | Sprint 30 internal r3 | `efae4b9` |

Sprint 30 closures recorded as external-SME-driven rather than Codex-driven. Cumulative count carry: ~49 Codex closures unchanged; +3 external-SME closures recorded separately in SI-006 v0.2 revision history.

## Carry-forward to next sprint

- **TLC-019 / OR-208 data-filtering implementation status doc** — Sprint 30 retro deferred to Sprint 31 as filler scope while SI-006 v0.2 closure-path is sequenced for the next state-mutating-slice retrofit window.
- **r5 proposal in `docs/drafts/`** awaits ratification or revision in Sprint 31+; not yet canonical PROJECT_CONVENTIONS.
- **SI-006 v0.2 → implementation** — v0.2 reframes the gate as blocking before any patient-visible state-mutating slice. Async-Consult + Consent are both past that line in the codebase already. The retrofit + redesign should land in Sprint 31+ scope.
- **TLC-050 follow-on** — the audit-emit platform-scope genesis flake from Sprint 28 carry-forward got a defensive fix in PR #33; if recurrence stops, the candidate ticket can be retired.

## Sprint reference / cross-links

- `SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.2 revision history (2026-05-06; Sprint 30 corrections)
- `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r4 (no revision bump this sprint — corrective rather than additive)
- `SPRINT_27_REVIEW.md` preamble (Sprint 30 cleanup note)
- `docs/drafts/` r5 PROJECT_CONVENTIONS proposal (`8465d69`; PR #35)
- `SPRINT_31_RETRO.md` (next; TLC-019 OR-208 carry-forward + SI-006 v0.2 implementation sequencing)
