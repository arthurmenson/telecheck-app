# Scrum Operating Model — Telecheck-app autonomous build

**Adopted:** 2026-05-05 per Evans's directive.
**Cadence:** 1-week sprints. Sprint kickoff = Monday-equivalent (autonomous-turn boundary). Sprint review = Friday-equivalent.
**Status:** Sprint 1 in progress.

---

## Why Scrum here

The user authorized 1 week of fully-autonomous build with emergency-only human availability. Without explicit ceremonies, autonomous agent loops drift toward yak-shaving: incremental hardening that never converges on launch readiness. Scrum imposes:

- Time-boxed sprints with a sprint goal, so progress is measurable
- A prioritized backlog the PM agent maintains, so each iteration starts from "what's most valuable now"
- Definition of Done so quality bars don't erode
- Sprint review (Codex adversarial) so design intent is challenged before lock-in
- Sprint retrospective so process drift gets corrected within the autonomous run

When the user reviews progress at the end of the week, they see N completed sprints with N retrospectives — not 70+ commits to spelunk.

---

## Roles

| Role                 | Filled by                                                                                                                                           | Responsibility                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Product Owner**    | `project-manager` agent                                                                                                                             | Maintains backlog, prioritizes, accepts sprint deliverables, defines acceptance criteria         |
| **Scrum Master**     | This Claude Code main turn (implementing agent)                                                                                                     | Enforces DoD, runs the cadence, removes blockers, surfaces escalations to user only on emergency |
| **Development Team** | Implementing agent + sub-agents on demand (database-integration-expert, appsec-expert, test-qa-engineer, frontend-dev-expert, documentation-expert) | Builds the code, writes tests, ships docs                                                        |
| **Sprint Reviewer**  | Codex (`codex-companion.mjs adversarial-review`)                                                                                                    | Independent adversarial review at sprint end; HIGH/CRITICAL findings gate sprint acceptance      |
| **Stakeholder**      | Evans                                                                                                                                               | Emergency-only — only invoked when access/connections are required                               |

---

## Sprint cadence (1-week sprints)

```
┌─ Sprint kickoff ─────────────────────────────────────────────┐
│ 1. PM call: confirm/update sprint goal + commit backlog     │
│ 2. Scrum Master writes SPRINT_<N>_PLAN.md                   │
└─ ↓                                                           │
┌─ Iteration loop (4-8 per sprint) ─────────────────────────────┐
│ 3. Daily standup (TodoWrite update — yesterday/today/blockers)│
│ 4. Pick top backlog story → execute → test → commit + push   │
│ 5. Verify CI green                                           │
│ 6. Loop                                                       │
└─ ↓                                                           │
┌─ Sprint review (Codex) ───────────────────────────────────────┐
│ 7. Trigger Codex adversarial review on sprint commit batch   │
│ 8. Address HIGH/CRITICAL findings → fix-forward commits      │
│ 9. PM accepts (or rejects) sprint deliverables               │
└─ ↓                                                           │
┌─ Sprint retrospective ────────────────────────────────────────┐
│ 10. Write SPRINT_<N>_RETRO.md (what went well / what didn't  │
│     / process changes for next sprint)                       │
│ 11. Loop to next sprint kickoff                              │
└──────────────────────────────────────────────────────────────┘
```

**Sprint duration:** 1 week of autonomous wall-clock. Within a 24-hr autonomous-turn window, expect 2-4 iterations + 1 review + 1 retro for short sprints; longer features may consume the full week.

---

## Definition of Done (DoD)

Every story completes ALL of:

- [ ] **Code quality:** `npm run typecheck && npm run lint && npm run format:check` all pass at sprint head
- [ ] **Tests:** every new code path covered by integration / unit / regression tests; coverage does not regress
- [ ] **CI:** green at story-completion HEAD on `main` (gh API verified)
- [ ] **Documentation:** status doc updated; deferred-work table flipped if applicable; commit message references story ID (`TLC-XXX`)
- [ ] **Spec compliance:** no canonical schema authored without spec-corpus backing (EHBG §7); SIs raised when schema gaps blocked
- [ ] **Tenant safety:** I-023 / I-024 / I-025 / I-027 invariants preserved; cross-tenant tests where the surface is tenant-scoped
- [ ] **Codex review:** at sprint end, adversarial review fires on the sprint's commit batch; HIGH/CRITICAL findings addressed; LOW/MEDIUM deferred with rationale
- [ ] **Working tree clean:** no untracked files remaining; no `.env` or secrets committed

A story that misses ANY checkbox stays in the sprint and rolls over.

---

## Acceptance criteria (per story)

Stories cite acceptance criteria in `PRODUCT_BACKLOG.md`. PM agent writes them; implementing agent meets them. Examples:

- `TLC-001` Pharmacy module skeleton: Plugin registers; module is BLOCKED-banner-clear; types stubs compile clean; zero migration files added.
- `TLC-002` Identity cross-tenant isolation regression: 4 entities (account/session/otp/device) tested against cross-tenant denial; mirror of `consent-cross-tenant-isolation.test.ts` shape.

---

## Codex review protocol

**Trigger:** Sprint review boundary, OR mid-sprint on a high-risk story (e.g., schema migration, security-sensitive change).

**Command:** `node "C:/Users/menso/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" adversarial-review "--background --base main <scope-paths>"`

**Severity gating:**

- **CRITICAL** — sprint NOT accepted; fix-forward before sprint review closes
- **HIGH** — fix-forward in same sprint
- **MEDIUM** — defer to next sprint backlog with rationale
- **LOW** — log + ignore unless cumulative drift threatens DoD

**Convergence:** Codex re-runs after fix-forward until 0 HIGH/CRITICAL findings remain or sprint review closes (whichever first). Cap at 3 rounds per sprint review to prevent infinite-loop on adversarial taste differences.

---

## Backlog management

`PRODUCT_BACKLOG.md` is the single source of truth. PM agent updates it at every sprint kickoff. Entries:

```markdown
## TLC-NNN — <story title>

**Status:** todo / in-progress / done / blocked
**Sprint:** Sprint N (or "blocked" / "next-sprint")
**Estimated commits:** <int>
**Decision rule applied:** <1-6 from PM rubric>

### Acceptance criteria

- ...

### Dependencies

- ...

### Notes

<rationale, links to SIs, etc.>
```

Done stories move to `SPRINT_<N>_REVIEW.md` and are removed from the active backlog.

---

## Sprint planning protocol

1. PM agent reads current state per its rubric
2. PM proposes sprint goal + 3-7 stories (sized so total commit budget < 30)
3. Scrum Master commits sprint plan to `docs/SPRINT_<N>_PLAN.md`
4. Iteration loop begins

---

## Sprint review protocol

1. Codex adversarial-review fires on sprint commit batch (`--base <sprint-start-commit>`)
2. Findings classified by severity
3. HIGH/CRITICAL fixed in same sprint; PM accepts the deliverable
4. `docs/SPRINT_<N>_REVIEW.md` written: goal, stories accepted/rolled-over, findings, fixes, next-sprint impact

---

## Sprint retrospective protocol

`docs/SPRINT_<N>_RETRO.md` answers:

- What went well? (e.g., "Codex caught the consent-repo ULID tiebreaker issue cleanly")
- What didn't? (e.g., "uniquePhone helper drift across 11 test files — should have extracted earlier")
- Process changes for next sprint? (e.g., "extract shared test helpers into `tests/helpers/` on first duplicate, not third")

Retros are short — 5-15 bullet points. They feed back into PM's rubric on the next sprint planning call.

---

## Escalation: human-in-the-loop

Reserve emergency invocation of Evans for:

- AWS / KMS / Secrets Manager credential rotation
- GitHub repository settings changes (branch protection, secrets, etc.)
- Spec corpus changes (Promotion Ledger entries P-011/012/013 to close SI-001/002/003)
- Vendor account provisioning (Truepill, Stripe, Twilio, Hubtel, etc.)
- Production deployment cutover decisions
- Anything explicitly not in the autonomous agent's allowed scope per Auto Mode

Other blockers: Scrum Master logs in `docs/BLOCKERS.md` and works around them within the sprint.

---

## Definition of Done for the WHOLE BUILD

The autonomous build is complete when:

1. EHBG §10b Sprints 1-11 deliverables all implemented + tested + status-doc'd
2. Operational Readiness Tracker v1.5 launch-readiness items passing
3. Final security audit (Codex adversarial-review on full repo) shows 0 HIGH/CRITICAL findings open
4. CI green; coverage meets the threshold floor in `vitest.config.ts`
5. `MASTER_BUILD_STATUS.md` written with launch-readiness summary
6. No outstanding SIs blocking launch (or all blocking SIs documented as deferred to post-launch with explicit acceptance)

Until that point, sprints continue.
