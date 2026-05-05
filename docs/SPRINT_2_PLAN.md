# Sprint 2 Plan — Telecheck-app autonomous build

**Sprint window:** 2026-05-05 → +1 week
**Sprint start commit:** `ee2be83`
**Sprint goal:** Pay down second-tier hygiene (admin read paths + forms-intake operator-edit coverage) while SI-001/002/003 remain open upstream. Pre-Slice-4 holding pattern.
**Stories:** TLC-004, TLC-006
**Commit budget:** 10 (8 estimated × 1.3 slack per Sprint 1 retro)

---

## Sprint backlog (in execution order)

1. **TLC-004 Tenant-config Admin Backend read handlers** — 5 commits
2. **TLC-006 Forms-intake operator-edit emit-site wiring** — 3 commits
3. **TLC-S2R Sprint review + retro** — 2 commits

Total committed: 10 commits.

---

## Process changes applied (per Sprint 1 retro)

1. **Current-state baseline pre-verified by PM** (carried in TLC-004 + TLC-006 acceptance criteria — see PRODUCT_BACKLOG.md updates by PM at kickoff)
2. **Codex review timeout:** 15 min OR 5 investigation rounds, whichever first; cancel + pre-empt the implied finding rather than block sprint
3. **Commit budget slack:** 1.3× (was 1.5×)
4. **Story sizing:** 1-3 commits each preferred; combine truly atomic scopes

---

## Daily standup (TodoWrite — yesterday/today/blockers)

- **Yesterday:** Sprint 1 closed; Codex MEDIUM fix-forward (liveness/readiness probe split) landed at `5615feb`; Sprint 1 ACCEPTED at `ee2be83`
- **Today:** TLC-004 admin read handlers (kicking off with current-state verification)
- **Blockers:** SI-001/002/003 still open upstream (no P-011/012/013 in Promotion Ledger); TLC-005 Pharmacy adapter abstraction deferred

---

## Risks identified at planning

- **TLC-004 scope ambiguity on adapter-configs:** PM verified country-profile-repo + tenant-brand-repo + ccr-config-repo exist; **adapter-config-repo does NOT exist**. TLC-004 acceptance allows either authoring the 4th repo OR documenting deferral to follow-up. Scrum master picks at execution time based on effort.
- **TLC-006 path ambiguity on consumer-vs-no-consumer:** the 2 emitters have ZERO callers. Wiring them requires authoring an operator-side mutation surface (eligibility logic editor + approval governance editor) which lacks spec backing for v1.0 visual builder. Acceptance criteria allows the alternative: "no consumer yet — add direct-call envelope-shape tests + parallel domain events" so the emitters are exercised end-to-end without a real call site. Scrum master picks the lighter path.
- **Codex review stuck-loop risk:** Sprint 1 hit 37min stalls in 2 separate Codex jobs. Apply the 15-min cap religiously this sprint.

---

## Definition of Done — Sprint 2 specific

Beyond global DoD in `SCRUM_OPERATING_MODEL.md`:

- [ ] All 4 admin GET routes return 200 with patient-blind body OR 401 without JWT (NOT 200 + empty when unauth)
- [ ] Cross-tenant test asserts US JWT can't read Ghana tenant's brand / ccr-config / adapter-config (I-025 tenant-blindness)
- [ ] TLC-006 closes the 2-emitter test gap with at least envelope-shape direct-call coverage
- [ ] Codex sprint review fires with the 15-min cap; HIGH/CRITICAL findings addressed
- [ ] `SPRINT_2_REVIEW.md` + `SPRINT_2_RETRO.md` filed
- [ ] PM agent accepts via Sprint 3 kickoff brief
