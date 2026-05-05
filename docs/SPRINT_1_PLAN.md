# Sprint 1 Plan — Telecheck-app autonomous build

**Sprint window:** 2026-05-05 (kickoff) → +1 week (review/retro)
**Sprint goal:** Pay down highest-value pre-Slice-4 hygiene + scaffold Pharmacy module skeleton so SI-001 closure unlocks immediate Slice 4 schema authoring.
**Committed stories:** TLC-001, TLC-002, TLC-003 (+ TLC-S1R sprint-review story)
**Total commit budget:** 12 (incl. 3 for sprint-review fix-forward room)

---

## Sprint backlog (in execution order)

1. **TLC-001 Pharmacy module skeleton** — 2 commits
2. **TLC-002 Identity cross-tenant isolation regression** — 1 commit
3. **TLC-003 Forms-intake remaining outbox-landing tests** — 2 commits
4. **TLC-S1R Sprint review + retro** — 3 commits (Codex review + fix-forward + retro doc)

Total: 8 commits committed budget; +4 spare for unknown-unknowns. If budget blows, escalate to PM mid-flight.

---

## Daily standup template

At the start of each implementation iteration (stored in TodoWrite, not a separate doc):

- **Yesterday:** what landed (story IDs + commits)
- **Today:** which story is in flight + which steps remain
- **Blockers:** anything that needs PM resequencing or human escalation

---

## Definition of Done — Sprint 1 specific

Beyond the global DoD in `SCRUM_OPERATING_MODEL.md`:

- [ ] Pharmacy directory exists with BLOCKED-banner README — clear that schema is paused on SI-001
- [ ] Identity cross-tenant test suite asserts cross-tenant denial for ALL 4 entities (no partial coverage)
- [ ] Forms-intake outbox-landing coverage reaches 12 of 12 wired events
- [ ] Codex sprint review shows 0 HIGH/CRITICAL findings on the sprint commit batch
- [ ] `SPRINT_1_REVIEW.md` + `SPRINT_1_RETRO.md` filed
- [ ] PM agent accepts via the next sprint's kickoff brief

---

## Risks identified at planning

- **Pharmacy skeleton over-scope risk:** Type stubs without schema is intentional. Stop at branded IDs + plugin shell; do NOT author repo / service / handler files.
- **Identity test surface duplication:** Cross-tenant isolation should test data-layer denial, NOT error-envelope shape (which existing I-025 regression covers).
- **Outbox-landing test setup complexity:** Forms-intake has heavyweight fixtures. Reuse existing helpers; don't introduce a new test pattern.
- **Codex finding density:** Sprint includes pharmacy skeleton (low-novelty) + 2 test files (low-novelty). Expect FEW findings. If more than 5 HIGH come back, pause + reassess scope.

---

## Stretch (only if budget permits after TLC-001/002/003)

- TLC-006 audit emit-site authoring for `forms_eligibility_logic_edited` + `forms_approval_governance_edited` (currently zero callers)
- Migration test for the rollback files landed at `e5a952c` (verify forward + rollback round-trip on a separate test database)
