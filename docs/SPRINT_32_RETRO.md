# Sprint 32 — Retrospective

**Sprint:** 32
**Closed:** 2026-05-07
**Final commit:** `ec4a3ec` (Merge PR #42 — SI-006 PR-D concurrent-write tests + DELETE-purge fix)
**Sprint goal (recap):** Land SI-006 PR-A through PR-D — the core reserve-then-execute redesign per SI-006 v0.2: authoring the `withIdempotency` helper (PR-A), retrofitting Async-Consult (PR-B), retrofitting Consent + Delegations (PR-C), and landing concurrent-write integration tests + DELETE-purge fix (PR-D).
**Goal achieved:** ✅

---

## What went well

- **5 of the 9 SI-006-cycle PRs landed in this sprint.** PR-A `withIdempotency` helper (`9aa7e37`), PR-A r2 Codex retro hotfix (`e3b0f0f`), PR-B Async-Consult retrofit (`70c9b38` + r2-r5 fix-forwards), PR-C Consent + Delegations retrofit (`47af16e`), PR-D concurrent-write tests + DELETE-purge fix (`d8fe1a3` + r2). The cycle's foundational work — helper authoring + first two slice retrofits + the integration-test surface that pins the contract — all landed in one sprint window.
- **Cross-cutting concurrency authoring discipline held.** PR-A r2 closed 4 Codex findings (2 HIGH + 2 MEDIUM) in a single retro hotfix; PR-B converged through 5 fix-forward rounds (r2 mark-managed-by-handler MEDIUM, r3 TLC-048 cross-actor test update for SI-006 success-path semantics, r4 accounts seeding for FK satisfaction, r5 skip TLC-048 integration test as durable source-grep lockdown pin). The §5.12 asymptotic-convergence expectation (drafted from this sprint's experience; codified Sprint 33-34) applied: each round closed real new findings rather than oscillating on litigated ones.
- **PR-D split DELETE-purge from INSERT.** Codex review on PR-A r3 had identified that the original WITH-CTE design suffered Postgres CTE snapshot-isolation issues; PR-D r2 (`66aa8d0`) split the DELETE-purge into a separate statement immediately preceding the INSERT. This closed a subtle correctness gap that wasn't visible until the concurrent-write integration tests in PR-D exercised the path.
- **`withIdempotency` + `withIdempotentExecution` helper API converged on the v0.2 design.** Reserve-then-execute owns the atomic INSERT (pending) → body callback → UPDATE (completed) sequence inside the caller's transaction; `IdempotencyReplayError` / `IdempotencyInFlightError` / `IdempotencyBodyMismatchError` discriminate the three retry outcomes per IDEMPOTENCY v5.1.
- **Async-Consult + Consent retrofits closed the "past-the-line" patient-visible state-mutating slices** that Sprint 30 SME advisory had flagged as needing the redesign. By Sprint 32 close, both slices were operating on the new reserve-then-execute path.

## What didn't go well

- **PR-B converged at 5 rounds (`70c9b38` + r2 + r3 + r4 + r5).** Per §5.1, 5+ rounds = pause + reassess. PR-B sat exactly at the cap. The rounds were productive (each closed a real new finding, not litigation), which is the §5.12 distinguishing fingerprint, but the close-to-cap convergence is a signal that Async-Consult's retrofit surface was the densest of the four PR-A→PR-D batch. Subsequent slice retrofits in Sprint 33 (PR-F2 forms-intake, PR-F3 identity) actually exceeded 5 rounds — see Sprint 33 retro.
- **PR-A r2 retro hotfix size (4 findings).** The original PR-A landed cleanly per Codex r1 review at filing, but a retrospective Codex round one commit later surfaced 4 findings that should have been caught at r1 review. The PR-A review boundary was narrower than the retro boundary — Sprint 33 PRs ran per-PR Codex review at multiple iteration boundaries to catch this earlier.
- **TLC-048 cross-actor integration test was migrated to source-grep lockdown.** PR-B r5 (`2289e47`) skipped the runtime integration test in favor of the existing Group F source-grep lockdown. This was the right call (lockdown is durable; runtime test was fragile against SI-006 success-path semantics) but the migration narrowed runtime-verification coverage of the JWT actor-scoping invariant — the source-grep lockdown carries the load instead.
- **No `SPRINT_32_PLAN.md` exists in the docs tree.** `[NEEDS VERIFICATION FROM EVANS]` — the Sprint 32 scope is reconstructed from the commit messages + the SI-006 closure doc; a formal sprint-plan artifact does not exist for this sprint window.

## Process changes adopted

- **Per-PR Codex review cadence drafted.** PR-A's retro hotfix revealed that single-final-review Codex rounds miss findings that multiple-per-PR rounds would catch. Sprint 33's SI-006 PR-F1 / PR-F2 / PR-F3 sequence adopted per-iteration Codex review explicitly — codified Sprint 33-34 in PROJECT_CONVENTIONS r5 §5.12 ("mitigation: per-PR Codex review, not just final-PR review").
- **`§5.12 asymptotic-convergence expectation`** drafted from this sprint's experience. PR-A through PR-D collectively closed 4 HIGH + 6 MEDIUM across ~10 fix-forward rounds, matching the v1.10.1 hygiene cycle's asymptote pattern. Final codification landed Sprint 33-34 alongside the full cycle closure.
- **No premature ratification of the r5 proposal in `docs/drafts/`.** Sprint 30's proposal stayed in drafts/ through Sprint 32. The eventual PROJECT_CONVENTIONS r5 promotion at Sprint 33-34 contained different content (SI-006 closure patterns) than the Sprint 30 drafted proposal — validating the propose-vs-promote separation.

## Codex review findings closed

| PR | Finding | Severity | Round | Closure commit |
|---|---|---|---|---|
| #38 / PR-A | `withIdempotency` reserve-then-execute correctness | (initial review) | r1 APPROVE | `9aa7e37` |
| #39 / PR-A r2 | 4 retro findings (2 HIGH + 2 MEDIUM) | HIGH (2) + MEDIUM (2) | retro r1 | `e3b0f0f` |
| #40 / PR-B | mark-managed-by-handler missing on Async-Consult handlers | MEDIUM | r2 | `d21bd4a` |
| #40 / PR-B | TLC-048 cross-actor test SI-006 success-path semantics | (test-side) | r3 | `ebd50b5` |
| #40 / PR-B | accounts FK seeding for initiate path | (test-side) | r4 | `eb58ae8` |
| #40 / PR-B | TLC-048 integration test → source-grep lockdown migration | (test-side) | r5 | `2289e47` |
| #41 / PR-C | Consent + Delegations retrofit | (initial review) | r1 APPROVE | `47af16e` |
| #42 / PR-D | DELETE-purge split from INSERT (PR-A r3 follow-up) | (correctness) | r2 | `66aa8d0` |

Sprint 32 substantive Codex closures: 4 HIGH + 4 MEDIUM (per matrix r5 cumulative table; Sprint 33-34 cumulative includes Sprint 32's batch within the "18 substantive Codex closures across 11 PR iterations" framing — Sprint 32 contributed ~8 of those 18 across 5 of the 11 iterations).

## Carry-forward to next sprint

- **PR-F1 — per-endpoint TTL overrides** for auth-flow caches (auth tokens cached for retry per IDEMPOTENCY v5.1 § retry contract; TTL must be JWT-aligned).
- **PR-F2 — forms-intake handler migration** (largest single slice retrofit by handler count).
- **PR-F3 — identity handler migration.**
- **PR-F4 — tenant-config admin-write 503-stub markers** (lightest of the F batch).
- **PR-E — legacy onSend cache-write removal + Group F source-grep lockdown** (cleanup of the v0 split that the F batch replaces).
- **PROJECT_CONVENTIONS r5 promotion** — to be sequenced after the F batch closes so the codified patterns reflect the full cycle's experience.

## Sprint reference / cross-links

- `SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` v0.2 → v0.3 transition begins
- `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r4 → r5 transition begins (final r5 lands Sprint 34)
- `PROJECT_CONVENTIONS.md` r4 → r5 transition begins (final r5 lands Sprint 33-34)
- `SPRINT_30_RETRO.md` carry-forward (SI-006 v0.2 implementation sequencing) — closed here for PR-A through PR-D
- `SPRINT_33_RETRO.md` (next; PR-F1 / F2 / F3 / F4 + PR-E batch)
