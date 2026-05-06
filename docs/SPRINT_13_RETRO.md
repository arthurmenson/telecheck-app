# Sprint 13 Retrospective — Telecheck-app autonomous build

**Sprint:** 13
**Window:** 2026-05-05 (single-day)
**Sprint goal:** Build closure-path infrastructure for Sprint 12 escalation (TLC-026) — **FULL achievement; r9 APPROVED clean.**
**Total commits:** 8 / 6 budgeted (133% utilization — matches Sprint 12 over-budget mark exactly)

---

## What went well

- **TLC-026 closure-path infrastructure CLOSED in-sprint via 4-round fix-forward chain.** Sprint 12 escalated TLC-024 r4 because the underlying constraint was structural (CI variance data not available). Sprint 13 took the bounded scope (closure-path infrastructure), landed it, and Codex iterated 4 times to a substantively-better enforcement scaffold. r9 APPROVE = converged. Each round produced legitimate technical defects in the immediately-prior fix-forward, not goalpost moving — distinction is sharper now: r5 was hollow-test class, r6 was prose-only-claim class, r7 was loose-grep + path-filter classes, r8 was wrong-git-semantics + unanchored-regex classes. Six distinct technical defects in successive iterations of the same artifact converged cleanly.

- **The escalation pattern's full payoff demonstrated.** Sprint 12 retro codified the "structural-constraint-not-code-defect" escalation pattern. Sprint 13 demonstrates its complementary case: **escalation does not eliminate the work; it shifts the work into a sprint where the work is BOUNDED**. TLC-024 r4 in Sprint 12 had no bounded scope (every fix-forward was data-not-yet-available). TLC-026 in Sprint 13 had a bounded scope (manifest-check helper + self-test + machine-enforced metadata guard). The 4-round Codex iteration on Sprint 13 was on bounded code, not unbounded data. Codex is excellent at iterative refinement of bounded code; less excellent at being the source of CI variance data.

- **PM-brief verification gate landed clean for the 8th consecutive sprint.** All 5 cited identifiers verified pre-execution. PM hallucination class remains eradicated since Sprint 6 spec-corpus identifier check sub-rule. 8 PM iterations / 8 clean briefs.

- **Codex r9 APPROVE on a 4-round fix-forward chain.** The TLC-026 enforcement scaffold is now technically correct: triple-dot merge-base diff + full-line anchored regex + GH API validation chain + always-run + early-exit. r9 explicitly verified each layer (`triple-dot detection addresses the stale-PR false positive`; `full-line anchored field regex rejects embedded substrings while allowing surrounding whitespace`; `post-match extraction cannot pick digits from unrelated text because the whole line is already constrained`; `documentation matches the implementation`). Multi-round adversarial review converging to APPROVE on a closure-path artifact is a stronger correctness guarantee than a single-round APPROVE on a smaller surface.

- **Sprint 12 retro's "1.2× slack + 2 fix-forward reserves" heuristic was right + insufficient.** Reserves intact for the bounded TLC-026 scope; consumed for the fix-forward chain. The right calibration for framework/perf work is "1.2× slack + 2 fix-forward reserves" — but in Sprint 13's case Codex found 6 distinct issues in 4 rounds, beyond the 2-fix-forward reserve. Sprint 13 over-budget is acceptable because every fix-forward closed legitimate technical defects, not goalpost-moving findings.

---

## What didn't

- **Two consecutive over-budget sprints (Sprint 12: 8/6; Sprint 13: 8/6).** Sprint 12's over-budget was 4 rounds of TLC-024 fix-forward + 1 escalation; Sprint 13's is 4 rounds of TLC-026 fix-forward + clean exit. Both at 133% utilization. **Pattern observation:** framework/perf work on enforcement scaffolds tends to attract iterative Codex findings because the scaffold itself is a candidate for the same control-weakness Codex is hammering on. Each layer of "enforcement" claim invites another adversarial pass. This is good (correctness-improving) but demands budget calibration. Sprint 14+ retro evaluates whether to bump the framework/perf reserve from 2 fix-forwards to 4.

- **r5 was a hollow-coverage class finding inside a scaffold built to prevent hollow coverage.** This is the meta-irony of Sprint 13's first round: TLC-026 was specifically designed to close the closure-path-overclaim class Codex r2/r3/r4 had been hammering on. r5 caught that the closure-path infrastructure ITSELF was hollow (selfTest called helper functions in isolation, not the gate semantics). The lesson: **every layer of enforcement is itself a candidate for the overclaim class until verified by exercise of the actual gate path**. r5 closure (`runGate()` extraction so selfTest drives same code main() does) is now the canonical pattern for this class.

- **Multi-round closure trajectory documentation hygiene was tedious but necessary.** Each fix-forward updated the §2.1 closure trajectory list (r3 → r6 → r7-A → r7-B → r8-A → r8-B). Without the trajectory documentation, future operators reading the workflow comment block would lose the "why is the regex anchored to full lines, not just labeled?" rationale and could quietly relax the constraint. Sprint 14+ retro evaluates whether to extract the trajectory into a single "Codex closure ledger" doc rather than inline-trajectory in every modified file.

---

## Process changes for Sprint 14

1. **NEW pattern: closure-path-overclaim recurrence is expected; pre-empt at authoring time.** Codify into `docs/PROJECT_CONVENTIONS.md` §"Codex review discipline":

   > When authoring a closure-path artifact (CI workflow, enforcement scaffold, gate-correctness self-test, etc.), pre-emptively check: does the layer I'm building have a hollow-coverage failure mode? Is the "enforcement" claim machine-enforced or doc-only? Are regex patterns anchored or substring-loose? Is the diff semantic (two-dot vs triple-dot) correct for the trigger context? Sprint 13's r5/r6/r7/r8 chain demonstrates that every layer of "enforcement" is a candidate for the same overclaim class Codex has been hammering on. Pre-empting these classes at authoring time saves a Codex round each.

2. **Framework/perf work commit-budget calibration.** Bump from "1.2× slack + 2 fix-forward reserves" to "1.5× slack + 4 fix-forward reserves" for closure-path / enforcement-scaffold stories. Sprint 12 + 13 both hit 133% utilization; this calibration matches actual observed iteration cost.

3. **Sprint 14 PM kickoff verifies `perf.yml` accumulated 3-5 stable runs on main.** Sprint 13 introduced perf.yml self-test step + baseline-refresh-guard.yml; Sprint 14 PM kickoff confirms whether either workflow has surfaced flakes in real CI runs. If Evans is reachable + 3-5 stable runs are in: surface "ready to flip" message for the `gh api` PUT execution. If not: track perf.yml run accumulation as Sprint 14 background signal; defer execution to Sprint 15+ as needed.

4. **Living-doc convention extended for multi-round Codex closure trajectories.** Sprint 13's TLC-023c §2.1 grew significantly across the r6/r7/r8 fix-forward rounds. The doc remains a single artifact (per Sprint 11 retro convention) but the trajectory list (r3 → r6 → r7-A → r7-B → r8-A → r8-B) now exceeds 6 entries inline. Future closure-path docs should consider extracting the trajectory into a separate ledger if it exceeds 8 entries.

---

## Lessons feeding the PM rubric

No new sub-rules proposed. The 4 PM rubric sub-rules + 2 Sprint 9/10 retro extensions remain stable across 8 PM iterations.

**One reinforcement on the spec-corpus identifier check sub-rule:** Sprint 13 PM brief was the cleanest in 13 sprints — 5 cited identifiers, 5 verified, 0 corrections needed. The verification gate is the load-bearing safety net; PM rubric sub-rules are the upstream filter that keeps gate-verification load to manageable.

---

## Forward-looking notes for Sprint 14

- **Sprint 14 candidate scope:**
  - **Sprint 14 default:** PM kickoff verifies perf.yml + baseline-refresh-guard.yml have accumulated stable main runs (3-5+ each); if both clean: surface "ready to flip" to Evans for the `gh api` PUT. If perf.yml flake has emerged: investigate before flipping.
  - **TLC-025** (potential; new): DB-backed bench infra investment (`emitAudit` / `withTenantBoundConnection` perf scenarios). Requires bench-mode ephemeral-Postgres setup. ~5-6 commits. Pre-empted from Sprint 13 due to TLC-026's 4-round Codex iteration consuming the budget.
  - **SI-001/002/003 status check** at PM kickoff. If any closed → pivot to Slice 4.
- **Cumulative state at Sprint 13 close:**
  - 4 implementation-complete slices
  - 21 forward migrations + paired rollbacks
  - 35 of 35 domain events with same-tx outbox tests
  - 39 Codex findings closed (23 HIGH + 16 MEDIUM); 1 MEDIUM finding-class structural execution still pending Sprint 14+
  - 8 PM-brief verification gate runs ALL PASS
  - 5 living-doc artifacts (TLC-023c handoff doc significantly extended; no new artifacts)
  - 2 NEW workflows in Sprint 13: pre-bench self-test step in perf.yml (closure path); baseline-refresh-guard.yml (machine-enforced metadata gate)
- **OR-218 closure path:** 2 of 3 conditions fully satisfied; 3rd condition (required-blocking gate) has machine-enforced closure path; Sprint 14+ executes the `gh api` PUT when 3-5 stable runs accumulate + Evans reachable. Probable closure: Sprint 14-15 timeframe.

---

## Codex tracking — Sprint 13 finding ledger

| Round | Sub-story | Severity | Status | Closure |
| --- | --- | --- | --- | --- |
| r5 | TLC-026 | MEDIUM | CLOSED | self-test bypasses main gate path — `36b477c` (extract `runGate()` pure function) |
| r6 | TLC-026 | MEDIUM | CLOSED | §2.1 commit-tag enforcement is doc-only-discipline — `6c9c244` (NEW `baseline-refresh-guard.yml` workflow) |
| r7-A | TLC-026 | MEDIUM | CLOSED | loose grep accepts incidental matches — `8308dfb` (labeled fields + GH API validation) |
| r7-B | TLC-026 | MEDIUM | CLOSED | path-filtered required-check blocks unrelated PRs — `8308dfb` (always-run + early-exit) |
| r8-A | TLC-026 | MEDIUM | CLOSED | two-dot diff misclassifies after main updates baseline — `a8e6319` (triple-dot merge-base) |
| r8-B | TLC-026 | MEDIUM | CLOSED | labeled-field regex not actually anchored — `a8e6319` (full-line anchor `^...$`) |
| r9 | TLC-026 | — | APPROVED | (verification round; no material findings) |

**Total Sprint 13:** 6 MEDIUM closed via fix-forward; 0 escalated; r9 APPROVED clean.

**Cumulative across all sprints:** 23 HIGH + 16 MEDIUM closed; 1 MEDIUM finding-class (TLC-024 r4 → TLC-026 closure-path scope) escalated then closed in Sprint 13; underlying CI-baseline-capture execution still pending Sprint 14+. **Sprint 13 = longest single-story Codex iteration in 13 sprints**, and the longest converging-rather-than-escalating chain.

---

## Final commit cumulative state

- Head: `<TBD when retro commit lands; expected Sprint 13 final at retro+review commit ~2026-05-05>`
- Sprint commits: 8 (kickoff + closure path + 4 fix-forward rounds + review + retro)
- CI: green expected
- DoD: 11 of 11 boxes green at retro commit
- Process docs added by Sprint 13: SPRINT_13_PLAN.md (existing kickoff) + SPRINT_13_REVIEW.md + SPRINT_13_RETRO.md (this doc); TLC-023c handoff doc significantly extended with §2.1 (3 closure-path-trajectory revisions)
- 2 NEW CI workflow gates: pre-bench self-test step in perf.yml (closure path); baseline-refresh-guard.yml (machine-enforced metadata gate covering Sprint 14+ baseline-refresh PR)
- OR-218 closure progress: 2 of 3 conditions fully satisfied; 3rd condition has machine-enforced closure path BUILT in-sprint; full closure pending Sprint 14+ Evans-side `gh api` PUT execution
