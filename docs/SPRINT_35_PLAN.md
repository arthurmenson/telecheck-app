# Sprint 35 Plan — Telecheck-app autonomous build

**Sprint:** 35
**Sprint goal:** Sprint 28-34 retro chain backfill + dependabot triage (pino 9→10, eslint stack) + repo-admin Step 2A follow-up (dependency-review.yml advisory removal once Dependency Graph enabled by Evans); conditional pharmacy + refill v2.1 slice implementation if SI-001 ratifies before kickoff.
**Sprint start commit:** TBD (set at kickoff; current main is post-Sprint-34 close 2026-05-08 + 2026-05-11 in-flight increment).
**Branch posture:** feature-branch + PR (one PR per story; one PR per sprint-28-34 retro doc set is also acceptable per existing per-PR Codex review discipline).
**Codex strategy:** SKIP on retro backfill + repo-admin follow-up + dependabot triage (§5.2 — pure docs / pattern-mirror); FIRE per-iteration on conditional slice work (§5.12 asymptotic-convergence budget).

---

## PM-brief verification gate (Sprint 35)

| Identifier cited in brief | Source-of-truth file | Verification result |
| --- | --- | --- |
| TLC-046 / TLC-049 (Sprint 27 close) | git log + `SPRINT_27_PLAN.md` | ✅ PASS |
| TLC-050 (audit-emit flake) | `docs/TLC-050-Audit-Emit-Platform-Genesis-Flake.md` | ✅ PASS |
| SI-001 / SI-002 / SI-003 / SI-004 / SI-005 | `docs/SI-00{1-5}-*.md` | ✅ PASS (all 5 status = open per `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5; DRAFT closure proposals authored 2026-05-11) |
| PR #82 (5afb458 actions/checkout v6 / setup-node v6) | git log | ✅ PASS |
| PR #90 (pino 9→10) | dependabot queue (per kickoff brief) | ⚠️ NOT YET VERIFIED — Scrum Master will read the dependabot PR before authoring TLC-053 acceptance criteria |
| PR #92 (eslint 8→10 chained w/ @typescript-eslint v7→v8) | dependabot queue (per kickoff brief) | ⚠️ NOT YET VERIFIED — same |
| Pharmacy + Refill v2.1 PRD §refs | `Telecheck Master Bundle FINAL US REGION BASELINE/Telecheck_Pharmacy_Refill_Slice_PRD_v2_1.md` | ⚠️ NOT YET RE-VERIFIED at sprint kickoff — Scrum Master MUST re-run before authoring TLC-055 |

**Verification result:** 4/4 fully verified pre-execution; 3/3 ⚠️ items will be re-verified at story kickoff per §5.2 + §6 sub-rule 5 (PR #90/#92 + Pharmacy PRD section refs). This counts as ~28th consecutive ALL PASS pending the kickoff verifications.

---

## Stories committed

### TLC-051 — Sprint 28-34 retro chain backfill (7 retros) — ✅ DONE (pulled forward to 2026-05-11)

**Status:** ✅ **DONE — pulled forward into the 2026-05-11 autonomous run** via PR #97 (branch `docs/sprint-28-34-retro-chain-backfill`). 7 retro docs authored (~405 lines total) by background agent following the SPRINT_27_RETRO.md template strictly. 2 `[NEEDS VERIFICATION FROM EVANS]` markers — both about absent SPRINT_NN_PLAN docs (Sprint 29 + Sprint 31); PLAN docs explicitly OUT-OF-SCOPE per the acceptance criteria; retros anchored via per-PR commit messages.
**Sprint:** ~~Sprint 35 anchor~~ — DELIVERED EARLY; Sprint 35 budget freed (~8 commits) for slice work + dependabot stack.
**Class:** "executable here" PLAN-ONLY-shaped — pure docs authoring; no Postgres / CI dependency
**Estimated commits:** 8 (7 retro docs + 1 close commit) — **Actual: 2 commits across 7 files; 405 LoC**
**Decision rule applied:** 3 (diminishing-returns hygiene) / sprint-retro process discipline
**Delivery PR:** #97 merged 2026-05-11. See `docs/SPRINT_28_RETRO.md` through `docs/SPRINT_34_RETRO.md`.

**Sprint shapes per the delivered retros (informational):**
- Sprint 28 (48 lines) — audit-only outcome (clean audit; pattern-mirror SKIP)
- Sprint 29 (47 lines) — verification-only (TLC-042/043 transitive closure; zero substantive commits)
- Sprint 30 (56 lines) — external SME advisory triggered corrective work (SI-006 v0.1 → v0.2; PRs #33-#35)
- Sprint 31 (48 lines) — single-PR filler scope (TLC-019 / OR-208 status doc; PR #36)
- Sprint 32 (62 lines) — SI-006 PR-A/B/C/D batch (PRs #38-#42; ~8 substantive Codex closures)
- Sprint 33 (71 lines) — SI-006 PR-F1/F2/F3/F4 + PR-E (PRs #43-#47; 12 substantive Codex closures, 11 fix-forward rounds)
- Sprint 34 (70 lines) — cleanup-sweep + audit-dedupe SI + async-consult HTTP tests + docs r5 codification (PRs #48-#57)

#### Acceptance criteria

- `docs/SPRINT_28_RETRO.md` filed; cites TLC-047 (PR #30 close) + TLC-044 lock-key audit no-fixes-needed (commit `a74912f`)
- `docs/SPRINT_29_RETRO.md` filed; cites TLC-042/043 transitively-resolved re-validation (commit `aec2ee7`)
- `docs/SPRINT_30_RETRO.md` filed; cites the Sprint 30 corrective items 2+4 banner work + TLC-050 defensive fix (commit `8c7efd5` / PR #33)
- `docs/SPRINT_31_RETRO.md` filed (pre-SI-006 cycle: PRs leading into #43)
- `docs/SPRINT_32_RETRO.md` filed; cites PR #42 idempotency-helper Group F lockdown initial landing
- `docs/SPRINT_33_RETRO.md` filed; cites SI-006 cycle PRs #43-#48 (TTL overrides + onSend removal + cleanup-sweep)
- `docs/SPRINT_34_RETRO.md` filed; cites PR #49 (audit_dedupe_markers) + #51 (async-consult HTTP coverage); aligns with `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 cumulative-state lines
- Each retro follows the existing format (what-went-well / what-didn't / process-changes; 5-15 bullets) per `SCRUM_OPERATING_MODEL.md` §"Sprint retrospective protocol"
- Each retro authored from authoritative source-of-truth: `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` r5 + per-PR commit messages + `PROJECT_CONVENTIONS.md` r5 + `AUTONOMOUS_TURN_SUMMARY_2026-05-08.md`
- NO new TLC IDs invented; NO retroactive sprint-goal-change claims

#### Dependencies

- None — purely additive doc authoring; no upstream blockers

#### Notes

- This story is independent and is the sprint's anchor deliverable (commits even if all other stories defer to Sprint 36).
- Codex SKIP per §5.2 — pure docs.
- One commit per retro is acceptable; batched commits (e.g., "Sprint 28-30 retros backfill") also acceptable if retro contents are short.
- Sprint plans for 28-34 are explicitly OUT-OF-SCOPE for this story — plans are pre-execution forecasts; backfilling them retroactively misrepresents the planning-vs-execution trace. Only retros are within scope.

---

### TLC-052 — Repo-admin Step 2A follow-up (dependency-review.yml advisory removal)

**Status:** blocked-on-Evans (acceptance gates on Dependency Graph enablement in repo settings)
**Sprint:** Sprint 35 (if unblocks) / Sprint 36+ (if not)
**Class:** "executable here" (5-LOC config edit; verifiable via gh PR check)
**Estimated commits:** 2 (1 edit + 1 close; 1.2× slack; 2 fix-forward reserves)
**Decision rule applied:** 6 (UAT / launch-readiness — CI gate hardening)

#### Acceptance criteria

- Evans confirms Dependency Graph enabled at `arthurmenson/telecheck-app` Settings → Code security → Dependency graph (PRECONDITION; Scrum Master verifies via `gh api repos/arthurmenson/telecheck-app | jq .has_dependency_graph` or equivalent)
- `.github/workflows/dependency-review.yml` `continue-on-error: true` line removed (per PR #50 follow-up commitment; cited in `AUTONOMOUS_TURN_SUMMARY_2026-05-08.md` line 95)
- One subsequent PR demonstrates the gate fires as REQUIRED-check (not advisory) — a passing dependency-review run on a known-safe PR is sufficient evidence
- Commit message references TLC-052 + PR #50 antecedent

#### Dependencies

- **Evans-side action:** Dependency Graph flip in repo Settings. Surface to Evans at sprint kickoff if not done.

#### Notes

- This is the explicit follow-up Evans was asked to enable per `AUTONOMOUS_TURN_SUMMARY_2026-05-08.md` line 95 + matrix r5 line 11.
- Codex SKIP — single-line config edit; no novel-of-class authoring.

---

### TLC-053 — pino 9→10 dependabot triage (PR #90)

**Status:** todo
**Sprint:** Sprint 35
**Class:** "executable here" (npm + typecheck + lint + tests verifiable in-shell; CI signal verifiable via gh)
**Estimated commits:** 3 (1 review + 1 fix-forward reserve if breaking-change-surface + 1 merge; 1.2× slack; 2 reserves)
**Decision rule applied:** 6 (dependency hygiene)

#### Acceptance criteria

- Scrum Master reads PR #90 diff + pino 10.0.0 release notes (breaking-change inventory)
- Identifies whether any breaking changes affect `src/lib/logger.ts` (most likely candidate) or any caller of the logger surface
- If no breaking impact: merge PR #90 as-is (Codex SKIP per §5.2 pattern-mirror dep bump); update `package-lock.json` if needed
- If breaking impact: file fix-forward commit closing the API drift + update relevant tests; one Codex round on the fix-forward shape (§5.2 — novel-of-class is the logger-surface migration, not the dep bump itself)
- ci.yml green at merge; no regression in audit-emit / forms-intake log paths

#### Dependencies

- PR #90 from dependabot queue must exist (assumed per kickoff brief; verify at kickoff)

#### Notes

- Pino 10's known breaking changes (per upstream release notes — confirm at kickoff): bindings property handling, transport API shape, stream-finish semantics. Likely-affected files: `src/lib/logger.ts`, any test that asserts log-record shape.

---

### TLC-054 — eslint stack upgrade (PR #92 + chained @typescript-eslint v7→v8)

**Status:** todo
**Sprint:** Sprint 35
**Class:** "executable here" (npm + lint verifiable in-shell)
**Estimated commits:** 5 (1 review + 1 lint-config update + 2 fix-forward reserves for eslint rule churn + 1 merge; 1.2× slack; 2 reserves)
**Decision rule applied:** 6 (dependency hygiene)

#### Acceptance criteria

- Scrum Master reviews PR #92 (eslint 8→10) and the chained @typescript-eslint v7→v8 upgrade together (per kickoff brief; they share lint-config surface)
- `eslint.config.js` (or `.eslintrc.*`) updated for eslint 10 + @typescript-eslint v8 idioms (flat-config required at eslint 9+; `parserOptions.project` semantics changed at typescript-eslint v8)
- `npm run lint` passes at sprint head with NO `--fix`-introduced semantic changes (verify diff is structural-only)
- Any newly-flagged rules either (a) closed in-sprint if scope ≤10 files, (b) suppressed with rationale comment + tracking ticket if >10 files, or (c) downgraded to warn with rationale comment if the rule is opinion-grade
- ci.yml green at merge

#### Dependencies

- TLC-053 (pino) ideally merges first to keep dep-PR queue clean; not strictly required

#### Notes

- This is a higher-risk dep bump than TLC-053 because eslint 9's flat-config migration + @typescript-eslint v8's project-service mode are both substantial behavior changes. Budget reserves are weighted toward this story.
- Codex SKIP per §5.2 (pure lint-config; no runtime behavior change) UNLESS the migration uncovers application-code defects that the new rules surface — in that case, fix-forward per finding-class.

---

### TLC-055 — Pharmacy + Refill v2.1 slice implementation (Sprint 1 of 2-3)

**Status:** CONDITIONAL — gated on SI-001 ratification landing in Promotion Ledger P-011 BEFORE Sprint 35 mid-point (~3 days into the sprint week). Verify at kickoff + at the mid-sprint checkpoint.
**Sprint:** Sprint 35 (Sprint 1 of slice authoring; full slice spans 2-3 sprints per Forms-Intake / Async-Consult precedent)
**Class:** "executable here" (Postgres + CI available in current shell per Sprint 17 OR-218 closure)
**Estimated commits:** 12-15 for Sprint 1 of 2-3 (1.2× slack × ~10 substantive commits + 2 reserves)
- Sub-story breakdown for Sprint 1 of 2-3:
  - TLC-055a: Migration `migrations/023_pharmacy_refill.sql` per CDM §4 MedicationRequest expansion (post-SI-001 ratification) — composite UNIQUE + composite FK + RLS policy per PROJECT_CONVENTIONS §1.1-§1.3 (~3 commits including rollback)
  - TLC-055b: Branded-ID type widening + Zod schemas (currently stubs in `src/modules/pharmacy/internal/types.ts`) (~2 commits)
  - TLC-055c: Repos — `medication-request-repo.ts` + `refill-repo.ts` + `dispensing-repo.ts` per §2.1-§2.2 patterns (~3-4 commits)
  - TLC-055d: State machine wiring per State Machines v1.1 + AUDIT_EVENTS v5.2 action IDs per §4 patterns (~2-3 commits)
  - TLC-055e: Cross-tenant isolation test mirroring `consent-cross-tenant-isolation.test.ts` shape (~1-2 commits)
- **Total estimate:** 12-15 commits for Sprint 1; **40-50 commits total** across Sprint 35 + 36 (+37 if needed) for the full slice per the matrix r5 estimate.

**Decision rule applied:** 4 (new unblocked slice work — once SI-001 closes, this becomes the priority path per Sprint 11+ pivot-paths line in current PRODUCT_BACKLOG.md Path (a))

#### Acceptance criteria (Sprint 35 Sprint 1 of 2-3)

- SI-001 verified ratified at Promotion Ledger P-011 before any schema authoring begins (PRECONDITION; failure to ratify = TLC-055 rolls to Sprint 36)
- `migrations/023_pharmacy_refill.sql` + matched rollback land per PROJECT_CONVENTIONS §1.1-§1.4 (composite UNIQUE + composite FK + named constraints + to_regclass-guarded rollback + RLS coverage lockdown updated in same commit)
- Branded-ID stubs in `src/modules/pharmacy/internal/types.ts` widened to row-shape interfaces backed by the ratified schema
- Repos authored per §2 patterns (externalTx + explicit tenant predicate)
- State-machine transitions authored per State Machines v1.1 §3 MedicationRequest + Refill states; I-012 reject-unless three-clause rule asserted via state-machine test (`tests/state-machines/i012-prescribing.test.ts` already exists; widens from gate-only to functional)
- Cross-tenant isolation test passing
- Codex FIRE per-PR per §5.12 asymptotic-convergence (budget 4-5 rounds per cross-cutting PR; this slice touches §3 audit + §3 domain-event + §4 state-machine + §3.3 defense-in-depth ownership simultaneously)
- ci.yml green at sprint head
- `docs/PHARMACY_SLICE_STATUS_2026-05-05.md` updated with Sprint 35 Sprint-1-of-slice landing notes

#### Dependencies

- **SI-001 ratification** (HARD; Promotion Ledger P-011). DRAFT closure proposal authored 2026-05-11 in `Telecheck_SI_Closure_Cycle_2026-05-11/Telecheck_SI_001_MedicationRequest_Schema_DRAFT.md`.
- TLC-051 (retro backfill) ideally lands first so the Sprint 35 retro can cite the matrix r6 update cleanly. Not strictly blocking.

#### Notes

- Pre-staging pharmacy slice scaffold is in flight per the 2026-05-11 turn brief; if that work lands, TLC-055 may inherit some files from it. Sprint 35 PM at kickoff MUST verify what scaffold work was committed and adjust the TLC-055 acceptance criteria accordingly.
- If SI-001 ratifies AND TLC-055 fits in Sprint 35: TLC-056 (Subscription slice) candidate per below.
- If SI-001 doesn't ratify: TLC-055 + TLC-056 both roll to Sprint 36; Sprint 35 becomes a smaller sprint focused on TLC-051+TLC-052+TLC-053+TLC-054 (~18 commits, ~50% utilization).

---

### TLC-056 — Subscription slice implementation (Sprint 1 of 1-2)

**Status:** CONDITIONAL — gated on (a) SI-001 ratification AND (b) TLC-055 substantially landing in Sprint 35 (Sprint 1 of 2-3 done; medication_request_id column exists for subscription FK binding)
**Sprint:** Sprint 35 (only if both gates pass) / Sprint 36 (likely)
**Class:** "executable here"
**Estimated commits:** 8-10 for the slice (smaller surface than pharmacy — subscription model is simpler; one state machine; FK-binds to medication_request_id created by TLC-055)
**Decision rule applied:** 4 (new unblocked slice work)

#### Acceptance criteria

- SI-001 ratification verified (same as TLC-055)
- TLC-055 medication_request schema landed (FK target exists)
- `migrations/024_subscription.sql` + rollback per PROJECT_CONVENTIONS §1 patterns
- `src/modules/subscription/internal/types.ts` widened from current branded-ID stubs
- Repos + service + initial HTTP handlers + cross-tenant isolation test
- Codex FIRE per §5.12 (cross-cutting; budget 3-4 rounds)
- `docs/SUBSCRIPTION_SLICE_STATUS_*.md` doc authored (currently no status doc exists)

#### Dependencies

- TLC-055 (HARD — schema FK target)
- SI-001 ratification (HARD)

#### Notes

- Very likely defers to Sprint 36 in practice — even if SI-001 ratifies at kickoff, TLC-055 alone is 12-15 commits; layering TLC-056 on top would inflate Sprint 35 to 30+ commits which exceeds the 30-commit-budget heuristic per `SCRUM_OPERATING_MODEL.md` §"Sprint planning protocol".

---

### TLC-057 — TLC-050 audit-emit flake recurrence investigation — ✅ READY-TO-FIRE

**Status:** ✅ **READY-TO-FIRE at Sprint 35 kickoff** — 4× recurrence across 2 flake-variants observed in the 2026-05-11 autonomous run (3× TLC-050 audit-emit deadlock at PRs #71/#81/#99 + 2× sibling i003 REVOKE flake at PR #82 merge / PR #101; one timeline overlap). Recurrence threshold exceeded — story fires automatically at Sprint 35 kickoff. See `docs/TLC-050-Audit-Emit-Platform-Genesis-Flake.md` §"2026-05-11 recurrence log" for full evidence + per-PR citations.
**Sprint:** Sprint 35 (fires at kickoff; no waiting for additional recurrence)
**Class:** "needs env EXECUTE" — root-cause investigation requires Postgres + ability to stress-test in CI (1.5× slack; 4 reserves)
**Estimated commits:** 5-8 (both flake variants in scope as a single investigation; hypothesis is they share a pg-test-setup race-condition root cause around schema_migrations replay + role REVOKE ordering)
**Decision rule applied:** 1 (CI flake recurrence — threshold met)

#### Acceptance criteria (only if fires)

- TLC-050 doc updated with new occurrence evidence
- Investigation step from `docs/TLC-050-Audit-Emit-Platform-Genesis-Flake.md` §"Investigation steps when picked up" run + findings recorded
- Either: (a) root cause identified + structural fix landed, OR (b) confirmed as not-recurring-after-Sprint-30-defensive-fix and TLC-050 marked CLOSED in the matrix

#### Dependencies

- A new occurrence of the flake during Sprint 35

#### Notes

- Defensive fix landed Sprint 30 per TLC-050 doc; recurrence rate has been low. This story stays in the plan as a contingent reserve so the budget accounts for it if it fires. Otherwise it carries over.

---

## Sprint 35 commit-budget summary

| Story | Class | Estimate (with slack + reserves) | Conditional? |
| --- | --- | --- | --- |
| TLC-051 — Sprint 28-34 retro backfill | "executable here" PLAN-ONLY-shaped | 8 | No |
| TLC-052 — dependency-review advisory removal | "executable here" | 2 (gated on Evans flip) | Yes |
| TLC-053 — pino 9→10 triage | "executable here" | 3 | No |
| TLC-054 — eslint + ts-eslint upgrade | "executable here" | 5 | No |
| TLC-055 — Pharmacy + Refill slice Sprint 1 of 2-3 | "executable here" | 12-15 | Yes (SI-001 ratification) |
| TLC-056 — Subscription slice | "executable here" | 8-10 | Yes (SI-001 + TLC-055 partially done) |
| TLC-057 — TLC-050 flake recurrence | "needs env EXECUTE" | 0-8 (contingent) | Yes (CI recurrence) |

**Sprint 35 commit-budget range (post-TLC-051-pull-forward):**

TLC-051 was pulled forward into the 2026-05-11 autonomous run (PR #97 merged 2026-05-11). The ~8 commits originally allocated to it are FREED from the Sprint 35 budget.

- **Floor (SI-001 still open; no flake recurrence; Evans hasn't flipped Dep-Graph):** ~8 commits (TLC-053 + TLC-054 only)
- **Ceiling (SI-001 ratifies + TLC-055 starts + TLC-052 unblocks):** ~25 commits (TLC-052 + TLC-053 + TLC-054 + TLC-055)
- **Most likely (SI-001 still open at kickoff):** ~10-12 commits (TLC-053 + TLC-054 + maybe TLC-052)

The floor is now well-under the 30-commit heuristic, leaving ~15-20 commits of headroom for TLC-055 + TLC-056 slice work if SI-001 ratifies before mid-sprint. The freed TLC-051 budget gives Sprint 35 substantially more room for the value-driving slice work.

---

## Dependencies + sequencing

```
TLC-051 (retros) ──┐
                   ├── independent; can ship first as anchor
TLC-052 ──────────┘  (gated on Evans flip; independent dep-PR shape)

TLC-053 (pino)     independent dep bumps; either order
TLC-054 (eslint)   (TLC-053 ideally first to keep queue clean)

TLC-055 (pharmacy) ←── SI-001 ratification (HARD)
        ↓
TLC-056 (subscription) ←── TLC-055 medication_request schema landed

TLC-057 (TLC-050)  contingent; fires only on recurrence
```

**Suggested execution order if all gates open:**
1. TLC-051 (anchor; lands regardless of other gates)
2. TLC-052 (if Evans flips Dep-Graph — 2-commit quick win)
3. TLC-053 + TLC-054 (dep-PR queue clean-up; pino first)
4. TLC-055 (the value-driver; the bulk of sprint substance if SI-001 ratifies)
5. TLC-056 (only if TLC-055 lands with budget room)
6. TLC-057 (only if flake recurs)

---

## Definition of Done — Sprint 35

- [ ] PM-brief verification gate ran (all cited identifiers verified pre-execution; ~28th consecutive ALL PASS)
- [ ] All committed stories DoD-complete per `SCRUM_OPERATING_MODEL.md` §"Definition of Done"
- [ ] Codex FIRE per-PR on novel-of-class work (TLC-055 if it lands); SKIP on retros + dep bumps + config edits
- [ ] ci.yml green at sprint head
- [ ] `docs/SPRINT_35_PLAN.md` filed (this doc)
- [ ] `docs/SPRINT_35_REVIEW.md` filed at sprint close
- [ ] `docs/SPRINT_35_RETRO.md` filed at sprint close
- [ ] `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` bumped r5 → r6 if TLC-055 or TLC-056 land
- [ ] `PRODUCT_BACKLOG.md` updated at sprint close (TLC-051 → done; conditional stories status-updated)

---

## Notes on judgment calls flagged in this plan

1. **TLC-051 retro backfill scope:** authored 7 retros as ONE story rather than 7 stories. Each retro is a short doc (5-15 bullets per `SCRUM_OPERATING_MODEL.md`); collectively ~8 commits including a close commit. Splitting into 7 stories would inflate PM overhead without adding value.
2. **TLC-055 sprint sequencing:** sized as "Sprint 1 of 2-3" not the full slice. Forms-Intake slice took 3 sprints (Sprints 6-8 per `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md`); Async-Consult took 3 (Sprints 8-10). Pharmacy is comparable scope — 2-3 sprints is realistic.
3. **TLC-057 inclusion:** TLC-050 flake has not recurred since Sprint 30 defensive fix per the tracker doc. Included as a contingent reserve so the sprint budget accounts for it if it fires; otherwise carries over.
4. **No Med Interaction Engine slice story:** the skeleton exists but the slice PRD has never been ratified (per Sprint 3 / TLC-007 notes — "PROVISIONAL pending slice ratification"). Adding it to Sprint 35 would violate §6 sub-rule 1 (verify before authoring). Flagged as a Sprint 36+ candidate IF the slice PRD ratifies upstream.
5. **2026-05-11 in-flight work:** the SI closure proposals + pharmacy scaffold pre-staging are NOT assumed-landed in this plan. PM at Sprint 35 kickoff MUST verify what landed and adjust acceptance criteria accordingly.

---

**Authored:** 2026-05-11 by Plan agent in plan-mode (autonomous-turn boundary)
**Next planning artifact:** `docs/SPRINT_35_REVIEW.md` at sprint close + `docs/SPRINT_35_RETRO.md` after.
