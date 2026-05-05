# Sprint 4 Retrospective — Telecheck-app autonomous build

**Sprint:** 4
**Window:** 2026-05-05 (single-day burn — same calendar window as Sprint 1/2/3)
**Sprint goal:** Apply BLOCKED-aware skeleton recipe a 3rd time + audit crisis-detection coverage with lockdown — **Achieved**
**Total commits:** 3 / 4 budgeted (1 commit under budget — 75% utilization, the highest yet)

---

## What went well

- **PM rubric updates landed with the kickoff commit.** Sprint 3 retro deliverables (verify-before-authoring sub-rule + wire-protocol vocabulary check sub-rule) are now formal PM rubric text. The retro→rubric→next-sprint loop is closing fast: lessons from Sprint N show up as binding rules in Sprint N+1.
- **TLC-012 rescope was the right call.** PM grep produced a definitive clean bill of health — every module either invokes `crisisDetector` (forms-intake) OR is structurally out of I-019 scope (no free-text patient input). Story shifted from "fix gap" to "document + lockdown" without losing the original intent (preventing future regression). Net effect: same protective coverage, less wasted authoring.
- **TLC-011 descope on existing-coverage grounds.** Sprint 1 retro lesson "verify before authoring" applied cleanly: PM read the existing audit-chain tests, identified comprehensive coverage (1199 LOC across 2 files; HIGH-1 + HIGH-2 closures all asserted), descoped at kickoff. No commits wasted.
- **Static-analysis lockdown pattern.** TLC-012-rescoped's lockdown test sits as a sibling to the existing `canonical-glossary.test.ts` static-analysis test. Runs without DB; catches source-level regressions; complements (doesn't duplicate) functional tests. The pattern is reusable: any future "this wiring must exist" assertion can use it.
- **3rd skeleton application proved the recipe.** TLC-010 took 1 commit (same as TLC-007 in Sprint 3). The recipe — index.ts + plugin.ts + routes.ts (with /health 200 + /ready 503) + internal/types.ts (branded IDs) + README.md (BLOCKED banner) + plugin smoke test (2 cases) + app.ts plugin registration + tenantContextPlugin allowlist update — is now fixed. Sprint 5+ skeletons (Payment? Lab Order? Adverse Event?) can follow it without re-deriving.
- **SM override on PM brief specifics, take 2.** Sprint 3's override was on canonical error code; Sprint 4's override was on test pattern (static-analysis vs runtime spy). Both overrides were on engineering-detail decisions where the SM's implementation context outweighs the PM's research-step context. The pattern is healthy.

---

## What didn't

- **Sprint 4 was the smallest sprint by raw count (3 commits) but the highest by utilization (75%).** That's because both descopes happened at PM kickoff before any commit was budgeted. The budget calculation should normalize: estimated-commits-after-PM-research × 1.2 slack, not estimated-commits-before-PM-research × 1.2. Otherwise the PM's verify-before-authoring discipline penalizes its own utilization signal.
- **Coverage-audit doc filename is date-stamped.** `CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md` ties the doc to a specific date. If the audit is re-run in 6 months and a chat module has been authored, do we author a new dated doc or update this one? Sprint 5 should resolve this: either rename to non-dated `CRISIS_DETECTION_COVERAGE_AUDIT.md` (single living doc) OR establish a docs/audits/ folder with dated artifacts. Defer to Sprint 5 PM kickoff.
- **PM brief proposed a runtime-spy test that wouldn't have caught the regression class the static-analysis test catches.** A runtime spy test only fires on the call paths the test exercises; a removal of the call from a code path the test doesn't exercise wouldn't fail. Static analysis catches it everywhere. PM should learn this pattern: "lockdown" tests prefer static analysis; "behavior" tests prefer runtime. Add to PM rubric? Maybe — but the call is engineering-shaped, so SM override is fine.
- **No PM agent registered at session start (recurring issue).** Same as Sprint 3 retro. Fresh Claude Code session would auto-load the PM agent; mid-session route through general-purpose with rubric inlined still works but loses agent isolation. Defer until cross-session PM agent persistence is solved.

---

## Process changes for Sprint 5

1. **Budget calculation normalization.** Sprint 5 budget = sum(estimated commits AFTER PM research-step descopes) × 1.2 slack, not sum(candidate-list estimates) × 1.2. The PM's research output is part of the budget, not before it. (Concretely: if PM lists 3 candidates → 1 descopes at kickoff → budget should be based on 2 stories, not 3.)
2. **PM should suggest a docs/audits/ folder convention OR a non-dated single doc.** Audit docs (like the crisis-detection coverage audit) need a long-term home strategy. Defer the choice to PM at Sprint 5 kickoff — but make it an explicit kickoff item.
3. **Lockdown tests sit under tests/contracts/, not tests/integration/.** TLC-012-rescoped placed its lockdown there and that was correct (sibling to `canonical-glossary.test.ts`). Codify: "wiring assertions on existing code" go to tests/contracts/; "behavioral assertions on data flow" stay in tests/integration/. Add to project conventions doc next time it's touched.

---

## Lessons feeding the PM rubric

- **PM should not propose a specific test mechanism (runtime spy vs static analysis) — propose only the assertion intent.** Sprint 4 PM brief said "1 light regression test asserting submission-service still calls crisisDetector". That's the intent. The mechanism (static-analysis source grep) is engineering-shaped, picked at execution. Add to PM "What you do NOT do" section: do not propose specific test mechanisms; propose the assertion intent and let SM pick the mechanism.
- **PM should distinguish "audit doc" from "coverage doc" from "policy doc".** TLC-012-rescoped's deliverable was simultaneously all three: documents what was audited, declares coverage state, sets a forward gating principle. PM rubric could cleanly distinguish these as separate brief output types — but this might be over-formalization. Defer.

---

## Forward-looking notes for Sprint 5

- **Utilization trend (33% / 30% / 43% / 75%) is upward.** Hold 1.2× slack for Sprint 5; revisit at Sprint 6.
- **Sprint 5 candidates** (PM verifies at kickoff per "verify before authoring" sub-rule):
  - **TLC-013:** Idempotency invariant regression test (I-016) — pre-verify existing `tests/integration/idempotency*.test.ts` coverage
  - **TLC-014:** Tenant-isolation regression for tenant-config admin read paths — pre-verify §4b cross-tenant case at `tenant-config-admin-http.test.ts` doesn't already cover this
  - **TLC-015:** ORT v1.5 launch-readiness items audit — research story; output determines Sprint 6+ stories
- **Codex strategy:** Sprint 4 was 4th consecutive Codex-skip sprint. Sprint 5 should fire Codex IF a real coverage gap or Slice 4 schema work emerges. Otherwise the Codex-skip pattern continues.
- **Pre-pave runway is shortening.** 4 sprints in, 11 stories committed (8 complete + 3 descoped at kickoff). At this rate, the pre-pave backlog (high-leverage hygiene work that doesn't depend on SI-001 closure) may exhaust by Sprint 6-7. If that happens, Sprint 7+ should pivot to ORT v1.5 launch-readiness items OR await SI-001 closure as the bottleneck.

---

## Final commit cumulative state

- Head: `be6a2dc`
- Sprint commits: 3 (Sprint 4 kickoff + PM rubric update + TLC-010 + TLC-012-rescoped)
- CI: green expected (lint + type-check clean locally; integration + new contract test runs in CI)
- DoD: 8 of 8 checkboxes per story green (Codex SKIPPED per pre-empt rationale)
- Process docs added by Sprint 4: SPRINT_4_PLAN.md + CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md + SPRINT_4_REVIEW.md + SPRINT_4_RETRO.md (this doc)
- Module skeletons (BLOCKED-aware): 3 (pharmacy + med-interaction + subscription)
- Branded ID types: 11 (5 pharmacy + 3 med-interaction + 3 subscription)
- New static-analysis lockdown pattern: 1 (sibling to canonical-glossary.test.ts)
