# Sprint 15 Plan — Telecheck-app autonomous build

**Sprint:** 15
**Sprint goal:** Codify Sprint 13 + Sprint 14 retro patterns into `docs/PROJECT_CONVENTIONS.md` + `docs/SCRUM_OPERATING_MODEL.md`. Defer TLC-027 EXECUTE (DB-backed bench infra rebuild) and OR-218 EXECUTE (gh api PUT) to Sprint 16+ pending env availability + Evans signal. **Pivot rationale:** TLC-027 + OR-218 EXECUTE both require environment dependencies the autonomous shell doesn't have (Postgres, gh auth respectively); per Sprint 14 retro NEW PM rubric sub-rule 5, pivot to in-budget work that doesn't require those dependencies.
**Sprint start commit:** `a443e7e` (Sprint 14 PARTIAL ACCEPTANCE filed; TLC-027 escalation doc landed)
**Commit budget:** 5 (3 estimated × 1.4 slack + 2 fix-forward reserves; documentation work — moderate iteration expected since it touches load-bearing process docs)
**Codex strategy:** SKIP on pure docs work per §5.2 ("SKIP on pattern-mirror; SKIP on pure docs"). Sprint 15 is entirely doc-codification; one Codex sweep at end of sprint optional.

---

## PM-brief verification gate findings (Sprint 15 — 10th consecutive ALL PASS)

5 cited identifiers verified against source-of-truth:
- Latest 3 Promotion Ledger entries: P-008/P-009/P-010 — verified at `Telecheck Master Bundle FINAL US REGION BASELINE/Telecheck_Promotion_Ledger.md:40/100/176`. No new ledger entries since Sprint 13/14 began.
- OR-218 — verified at `Telecheck_Operational_Readiness_Todo_v1_5.md:129`
- `docs/PROJECT_CONVENTIONS.md:195-211` §5 Codex review discipline (the section being extended) — verified
- `docs/SPRINT_13_RETRO.md` §"Process changes for Sprint 14" (closure-path-overclaim pre-emption pattern) — verified at `fdb464a`
- `docs/SPRINT_14_RETRO.md` §"Process changes for Sprint 15" (NEW PM sub-rule 5 + extended escalation pattern + differentiated commit-budget calibration) — verified at `a443e7e`

---

## Promotion Ledger check + environment availability

**SI-001/002/003 still open** (15 sprints). **No Slice 4 pivot.**
**Postgres availability for autonomous shell:** still NOT available (same as Sprint 14).
**Evans signal on perf.yml run accumulation:** none received since Sprint 13 close.

Per Sprint 14 retro NEW PM rubric sub-rule 5 ("environment-dependency check at planning"):
- TLC-027 EXECUTE requires Postgres → BLOCKED
- OR-218 EXECUTE requires Evans-side `gh auth` PUT → BLOCKED
- PROJECT_CONVENTIONS.md update requires nothing not in the autonomous shell → AVAILABLE
- SCRUM_OPERATING_MODEL.md update requires nothing not in the autonomous shell → AVAILABLE

**Sprint 15 pivots to documentation codification.** This is exactly the case sub-rule 5 was authored for: when env-dependent stories are blocked, pivot to in-budget non-env-dependent work.

---

## Sub-stories committed

### TLC-028 — Codify Sprint 13 + Sprint 14 retro patterns into PROJECT_CONVENTIONS.md + SCRUM_OPERATING_MODEL.md

**Estimated commits:** 3 (PROJECT_CONVENTIONS.md update + SCRUM_OPERATING_MODEL.md update + revision-history bumps; +2 fix-forward reserves)
**Decision rule:** Pure docs; Codex SKIP per §5.2.
**Codex strategy:** SKIP. (Optional one-sweep at sprint end if doc length grows substantially.)

#### Acceptance criteria

- **`docs/PROJECT_CONVENTIONS.md` §5 Codex review discipline EXTENSION:**
  - Add §5.4 closure-path-overclaim pre-emption pattern (Sprint 13 retro deliverable):

    > When authoring a closure-path artifact (CI workflow, enforcement scaffold, gate-correctness self-test, etc.), pre-emptively check at authoring time:
    > - Hollow-coverage class: does the layer I'm building actually exercise the gate path it claims to protect, or only helper functions in isolation?
    > - Doc-only-discipline class: is the "enforcement" claim machine-enforced or just documented?
    > - Loose-grep class: are regex patterns anchored or substring-loose?
    > - Wrong-git-semantics class: is the diff semantic (two-dot vs triple-dot, BASE_SHA vs merge-base) correct for the trigger context?
    >
    > Sprint 13's r5/r6/r7/r8 chain demonstrates that every layer of "enforcement" is a candidate for the same overclaim class Codex has been hammering on. Pre-empting these classes at authoring time saves a Codex round each.

  - Add §5.5 structural-constraint-not-code-defect escalation pattern (Sprint 12 retro originally; Sprint 14 retro EXTENSION):

    > When a Codex finding class converges on "this requires data/environment we don't have yet" — either across 3+ fix-forward rounds (original Sprint 12 codification) OR at Codex round 1 if the findings all require an environment dependency the autonomous shell doesn't have (Sprint 14 extension) — escalate to a Sprint N+1 story rather than continuing iterative fix-forward. The Sprint N retro records this explicitly. Distinct from §5.1 5+ rounds = pause cap (which addresses scope inflation, not structural data/environment gaps).
    >
    > Closure precedents:
    > - TLC-024 r4 → Sprint 13 TLC-026 [closed Sprint 13 via 4-round fix-forward chain converging at r9 APPROVED]
    > - TLC-025 r10 → Sprint 15+ TLC-027 [pending; first HIGH-severity escalation; first sprint with zero in-sprint closures]

- **`docs/PROJECT_CONVENTIONS.md` §6 PM-brief verification gate EXTENSION:**
  - Add NEW PM rubric sub-rule 5 (Sprint 14 retro deliverable):

    > **Sub-rule 5: Environment-dependency check at planning.** For each proposed sub-story, explicitly check whether closure requires an environment dependency (Postgres, Redis, gh auth, secrets, CI access) the autonomous shell doesn't have. If YES, split into PLAN-ONLY (planning artifact + escalation conditions) and EXECUTE (env-available sprint). If NO, execute. Sprint 14 / TLC-025 cost demonstrates the rule's value: ~400 lines authored, full revert, escalation. Raises PM rubric from 4 sub-rules (Sprint 6 baseline) to 5 sub-rules.

- **`docs/PROJECT_CONVENTIONS.md` revision history:**
  - Add `r2 (2026-05-05, Sprint 15 / TLC-028): Sprint 13 + Sprint 14 retro patterns — §5.4 closure-path pre-emption; §5.5 escalation pattern; §6 sub-rule 5 environment-dependency check.`

- **`docs/SCRUM_OPERATING_MODEL.md` update:**
  - Differentiated commit-budget calibration (Sprint 14 retro deliverable):

    > **Three-way commit-budget calibration:**
    > - **"Executable here" stories** (full execution possible in autonomous shell): 1.2× slack + 2 fix-forward reserves (Sprint 5 baseline)
    > - **"Needs env" PLAN-ONLY stories** (planning artifact only; no code execution): 1.0× slack + 0 fix-forward reserves (no fix-forward expected on PLAN-ONLY; revisions are doc edits)
    > - **"Needs env" EXECUTE stories** (full execution; environment-available sprint): 1.5× slack + 4 fix-forward reserves (framework/perf calibration)

  - Reference the relevant Sprint retros where each calibration was empirically derived:
    - 1.2× / 2-reserves: Sprint 5 baseline; Sprint 11 retro confirmation
    - 1.5× / 4-reserves: Sprint 12 + Sprint 13 over-budget evidence; Sprint 13 retro proposal
    - 1.0× / 0-reserves: Sprint 14 retro NEW (PLAN-ONLY differentiation)

#### Codex anticipation

Pure docs work; no Codex anticipation. Codex SKIP per §5.2. Optional one-sweep at sprint end if doc length grows beyond ~50 lines added.

---

## Definition of Done — Sprint 15

- [ ] PM-brief verification gate ran + findings recorded (this doc — 10/10 ALL PASS expected)
- [ ] PROJECT_CONVENTIONS.md §5 Codex review discipline extended with §5.4 + §5.5
- [ ] PROJECT_CONVENTIONS.md §6 PM-brief verification gate extended with sub-rule 5
- [ ] PROJECT_CONVENTIONS.md revision history bumped to r2
- [ ] SCRUM_OPERATING_MODEL.md updated with differentiated commit-budget calibration
- [ ] Lint clean (no code changes; doc-only)
- [ ] No invariants relaxed
- [ ] No production-code changes
- [ ] `docs/SPRINT_15_REVIEW.md` filed
- [ ] `docs/SPRINT_15_RETRO.md` filed
- [ ] PM kickoff brief for Sprint 16 (re-check Postgres availability + Evans signal on perf.yml run accumulation)

---

## Sprint 16 hand-off (advance signal for Evans + autonomous Claude)

When Sprint 15 closes, Sprint 16 PM kickoff verifies:
1. Has Postgres become available in the autonomous shell environment? (If yes: TLC-027 EXECUTE per acceptance criteria.)
2. Has Evans confirmed `perf.yml` accumulated 3-5 stable runs on `main`? (If yes: OR-218 EXECUTE per `docs/TLC-023c-BRANCH-PROTECTION-WIRE-UP.md` §1.)
3. SI-001/002/003 status check.
4. If both env-dependent stories still BLOCKED + SI-001/002/003 still open: pivot to other in-budget non-env work. Candidates:
   - BUILD_VS_SPEC_TRACEABILITY_MATRIX.md amendment (post-Sprint-13/14 cumulative state)
   - Documentation hygiene on existing slices
   - PROJECT_CONVENTIONS.md additional codifications as patterns emerge
