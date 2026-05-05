# Sprint 1 Retrospective — Telecheck-app autonomous build

**Sprint:** 1
**Window:** 2026-05-05
**Sprint goal:** Pay down highest-value pre-Slice-4 hygiene + scaffold Pharmacy module skeleton — **Achieved**
**Total commits:** 4 / 12 budgeted (8 commits under budget)

---

## What went well

- **Clean scope on TLC-001.** Pharmacy skeleton stayed tight: branded IDs + plugin shell + `/health` BLOCKED probe + module README. Zero schema authored. Prevents future re-litigation about the SI-001 boundary.
- **TLC-002 mirrored a known-good template.** `consent-cross-tenant-isolation.test.ts` was a clean reference; `identity-cross-tenant-isolation.test.ts` matched its shape with no novel design decisions. Low-risk delivery.
- **Mid-sprint course correction on TLC-003.** Scrum Master verified ground truth (the 4 events PM listed already had tests in `forms-intake-events.test.ts`) before authoring redundant assertions. Re-scoped to the 2 genuinely-missing events instead of skipping the story or shipping no-op tests.
- **Sprint kickoff docs ROI was high.** SCRUM_OPERATING_MODEL.md + PRODUCT_BACKLOG.md + SPRINT_1_PLAN.md took ~15 minutes; the discipline they imposed (DoD checklist on every commit, story-ID references) saved more time than they cost.
- **DoD checklist in commit messages.** Each commit ended with a checklist showing which DoD boxes were satisfied vs. pending. Made the Sprint Review easier to file.
- **Explicit BLOCKED state on `/v0/pharmacy/health`.** Monitoring distinguishes "module up" from "module production-ready". This is the kind of detail that gets discovered during Sprint 11 launch-prep otherwise.

---

## What didn't

- **PM premise on TLC-003 was incorrect.** PM cited 4 forms-intake events as lacking explicit outbox tests; ground truth was that all 4 already had explicit tests. Scrum Master had to re-scope mid-flight. Cost: ~10 min of grep + read time before pivoting. Cause: PM's research step didn't grep for `event_type = 'forms_template.created'` etc. directly across `tests/integration/`.
- **TLC-003 pre-research not part of acceptance criteria.** PM's brief listed events to test but didn't say "verify these don't already have tests". Acceptance criteria for test-coverage stories need a "current coverage state" baseline check.
- **Codex review timing risk.** Codex review fires in background at sprint end. If it returns HIGH/CRITICAL findings AFTER the SPRINT_1_REVIEW.md is filed, the doc has to be amended. Process: hold review-doc finalization until Codex returns OR write findings-pending and update.
- **Sprint plan budgeted 12 commits; used only 4.** Either (a) Sprint 1 was under-scoped or (b) the budget had too much slack. For Sprint 2, drop the slack to a 1.3x multiplier on estimated story commits.

---

## Process changes for Sprint 2

1. **PM acceptance-criteria pattern for test-coverage stories:** require an explicit "current coverage state" line that the PM agent's research step has to populate by greping the test directory. Update PM agent definition.
2. **Sprint review filing protocol:** SPRINT_N_REVIEW.md authored with a "Codex findings: pending" placeholder; updated in a follow-up commit when Codex returns. This prevents the review getting blocked on an async Codex run.
3. **Commit budget calibration:** Sprint 2 budget = sum(story estimates) × 1.3 (was 1.5 in Sprint 1). Smaller slack reflects how few unknown-unknowns the tested patterns produce.
4. **Story sizing:** keep stories at 1-3 commits each. TLC-001 was 2 (skeleton + status doc) and felt too small to warrant 2 separate commits in retrospect; consider combining when scope is genuinely atomic.

---

## Lessons feeding the PM rubric

- **Decision rule 3 ("diminishing-returns hygiene") needs a sub-rule:** before authoring more tests for a slice, verify the ALLEGED gap by greping the existing test directory. Add as decision-rule "3.5 — verify before authoring".
- **PM should propose stories in EXECUTION order** not priority order. Stories with no inter-dependencies can run in any sprint slot; stories that build on each other should be flagged. (Sprint 1 had no deps; future sprints might.)

---

## Forward-looking notes for Sprint 2

- If SI-001 closed upstream (Promotion Ledger P-011 landed), Sprint 2 becomes Slice 4 schema + module build-out. Estimated 30-40 commits. **PM checks Promotion Ledger at kickoff.**
- If SI-001 still open, Sprint 2 backlog: TLC-004 admin handlers (read-only), TLC-006 forms-intake operator-edit emit sites, possibly TLC-005 pharmacy adapter abstraction.
- Codex review on this sprint surfaces process improvement: do reviews FIRE on a per-commit branch instead of waiting until sprint end? Defer answer until Codex returns; if it ran efficiently, no change needed.

---

## Final commit cumulative state

- Head: `d87a6ba`
- Sprint commits: 4 (Scrum framework + 3 stories)
- CI: green
- All 8 DoD checkboxes on every story: pending Codex sprint-review return for full-green
