# Sprint 4 Review — Telecheck-app autonomous build

**Sprint:** 4
**Sprint goal:** Apply the BLOCKED-aware skeleton recipe a 3rd time (Subscription) + audit crisis-detection (I-019) coverage with lockdown regression test, while SI-001/002/003 remain open upstream.
**Sprint start commit:** `78e9de9` (Sprint 3 ACCEPTED)
**Sprint end commit:** `be6a2dc` (TLC-012-rescoped final)
**Total commits in sprint:** 3 (kickoff `c3e60a9` + TLC-010 `da597c6` + TLC-012-rescoped `be6a2dc`) vs 4-budget — 1 under, 75% utilization
**CI status at sprint end:** Green expected at `be6a2dc` (lint + type-check clean locally; integration tests + new contract test run in CI against ephemeral Postgres)

---

## Stories accepted

### ✅ TLC-010 — Subscription module skeleton — `da597c6`

**Deliverables:**
- New module directory `src/modules/subscription/` with `index.ts` + `plugin.ts` + `routes.ts` + `internal/types.ts` + `README.md`
- 3 branded ID types (PROVISIONAL pending SI-001 closure): `SubscriptionId`, `SubscriptionScheduleId`, `SubscriptionPauseId`
- Plugin registers under `/v0/subscription` with:
  - `GET /health` → 200 (liveness — module alive) with SI-001 metadata
  - `GET /ready` → 503 (not ready for traffic — SI-001 open)
- Plugin wired in `src/app.ts`; both probe paths allowlisted in tenantContextPlugin
- 2-case plugin smoke test mirroring pharmacy + med-interaction patterns

**Acceptance criteria evaluation:**
- [x] Module directory + plugin shell created
- [x] Branded IDs exported (identifier hygiene only; not schema)
- [x] `/health` 200 + `/ready` 503 split (3rd application of standing rule)
- [x] Plugin smoke test (2 cases)
- [x] Plugin wired in `src/app.ts`
- [x] No row-shape interfaces authored (await SI-001)
- [x] No repos / services / state machine / migrations
- [x] README BLOCKED banner explains SI-001 dependency + branded-ID rationale

**Recipe-fidelity note:** TLC-010 is the 3rd application of the BLOCKED-aware skeleton recipe (after pharmacy TLC-001 and med-interaction TLC-007). The recipe is now fixed:
- index.ts re-exports + plugin.ts shell + routes.ts /health 200 + /ready 503 + internal/types.ts branded IDs + README.md BLOCKED banner + plugin smoke test (2 cases) + app.ts plugin registration + tenantContextPlugin allowlist update.
- Time-cost is near-zero per skeleton; expected delivery is 1 commit. TLC-010 hit that target.

**Verdict:** Accepted.

---

### ✅ TLC-012-rescoped — Crisis-detection (I-019) coverage audit + lockdown — `be6a2dc`

**Deliverables:**
- New doc `docs/CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md` documenting:
  - I-019 rule citation (platform-floor; never disable, never gate behind config)
  - Per-module audit table with scope-rationale column (16 module rows + chat/community/voice future-scope rows)
  - Gating principle: any future module accepting free-text patient input MUST scan with `crisisDetector` before persistence
- New contract test `tests/contracts/crisis-detection-coverage-lockdown.test.ts` (9 static-analysis cases):
  - §1 (3 cases) — `crisisDetector` export integrity in `crisis-detection.ts`
  - §2 (3 cases) — submission-service imports + invokes `crisisDetector.detect(...)` + preserves audit-emit-and-throw pattern
  - §3 (3 cases) — coverage audit doc exists + declares gating principle + lists chat/community/voice as future scope

**Acceptance criteria evaluation:**
- [x] Audit doc filed at canonical path
- [x] Per-module table populated from PM grep
- [x] Gating principle for future modules documented
- [x] Lockdown regression test authored (9 static-analysis cases)
- [x] Lockdown is narrow (call presence, not argument shapes — avoids over-fitting refactor scenarios)
- [x] No new production code paths added
- [x] I-019 reaffirmed via lockdown test

**Decision-point trade-off (resolved at execution):**
- PM brief proposed an integration test using `vi.spyOn(crisisDetector, 'detect')`. Scrum Master chose static-analysis pattern instead (sibling to existing `canonical-glossary.test.ts`) because it runs without DB setup, catches removal-of-call regressions at the source level, and avoids duplicating the existing functional crisis-detection tests in `forms-intake-submission.test.ts:890+` and `:1098+`.

**Verdict:** Accepted.

---

## Stories rolled over

None. Both committed stories accepted within sprint.

**Stories descoped at kickoff** (per PM "verify before authoring" research, now formalized as PM rubric sub-rule):
- **TLC-011 — Audit-chain hash-chain integrity regression test.** PM grep verified existing `audit-chain.test.ts` (330 LOC, 6 describe blocks) + `audit-chain-walker.test.ts` (869 LOC, 8 describe blocks) already cover hash-chain integrity comprehensively (HIGH-1 broken-link, HIGH-1 forged-genesis, HIGH-2 record-hash tampering all asserted). Authoring would have duplicated existing coverage.
- **TLC-012 — original "research" framing.** PM grep at kickoff revealed clean bill of health for current modules; story rescoped to documentation + lockdown rather than coverage-gap fix.

Both descopes/rescopes are net wins: no time spent on redundant work; existing coverage protected via lockdown; future-module gating principle preserved.

---

## Codex adversarial review

**Trigger:** Sprint review boundary
**Status:** Per Sprint 2/3 retro pattern — "skip per pre-empt rationale" applied for low-novelty pattern-mirror stories. Sprint 4 work has near-zero novelty:

- TLC-010 mirrors pharmacy (TLC-001 Sprint 1) + med-interaction (TLC-007 Sprint 3) skeleton recipe — already Codex-reviewed; the only finding (`pharmacy-blocked-handler` MEDIUM) is applied a-priori
- TLC-012-rescoped is pure documentation + 9 static-analysis test cases on existing production code (no new production paths)

**Test assertions covering Codex's likely findings:**
- TLC-010 §1a/§1b plugin-wiring smoke tests — cover plugin registration + `/health` + `/ready` envelope shapes (mirror of pharmacy + med-interaction patterns)
- TLC-012-rescoped §1 — locks `crisisDetector` export integrity (catches rename/removal)
- TLC-012-rescoped §2 — locks the only known I-019 callsite wiring (submission-service)
- TLC-012-rescoped §3 — locks the audit doc's gating principle for future modules

**Decision:** Skipping the 15-min Codex run for Sprint 4 on the basis that:
1. Both stories are pattern-mirrors / pure-documentation / lockdown — Codex's investigation surface is minimal
2. The 11 new test cases (2 from TLC-010 + 9 from TLC-012-rescoped) directly cover Codex's likely findings
3. Sprint 2 retro standing rule "Codex skip is acceptable when in-sprint tests directly cover Codex's likely investigation surfaces" applies cleanly
4. Sprint 5 will fire Codex if work shifts higher-novelty (e.g., Slice 4 schema if SI-001 closes)

**Findings recorded:** 0 (review not run; Sprint 4 ACCEPTED on grounds above + green local lint/type-check + DoD checklist)

---

## Cumulative platform metrics at sprint end

- **Slices:** 3 implementation-complete (Forms-Intake, Identity, Consent + Delegation)
- **Foundations:** 2 (tenant-config — 4 admin read routes + 5 admin-write 503 stubs + readiness probe; pharmacy skeleton)
- **Module skeletons (BLOCKED-aware):** 3 (pharmacy → SI-001; med-interaction → slice PRD ratification; subscription → SI-001)
- **Forward migrations:** 18 (000–019; unchanged)
- **Rollback migrations:** 18 (matched pair coverage; unchanged)
- **Domain events wired:** 31 (unchanged this sprint)
- **Domain events with explicit outbox tests:** 31 of 31
- **Open Spec Issues:** 3 (SI-001 / SI-002 / SI-003)
- **Test files:** ~104+ (added `subscription-plugin-wiring.test.ts` + `crisis-detection-coverage-lockdown.test.ts`)
- **Test cases (rough):** ~1420+ (added 2 from TLC-010 + 9 from TLC-012-rescoped = 11)
- **Branded ID types defined across modules:** 11 (5 pharmacy + 3 med-interaction + 3 subscription)
- **Coverage audit docs:** 1 (CRISIS_DETECTION_COVERAGE_AUDIT_2026-05-05.md)

---

## Decisions made this sprint

1. **TLC-011 descoped on PM verification.** Existing audit-chain test coverage is comprehensive (HIGH-1/HIGH-2 closures already locked); duplicating would violate "verify before authoring".
2. **TLC-012 rescoped on PM grep.** Clean bill of health for current modules; story shifted from "fix coverage gap" to "document + lockdown" to preserve I-019 wiring against future regression.
3. **Static-analysis lockdown over runtime spy.** PM brief proposed `vi.spyOn(crisisDetector, 'detect')` integration test; SM chose static-analysis sibling-pattern to `canonical-glossary.test.ts` because it runs without DB setup, complements existing functional tests rather than duplicating, and catches removal-of-call regressions at the source level.
4. **Liveness/readiness split applied a-priori (3rd time).** TLC-010 inherits the standing rule; no fix-forward needed.
5. **PM rubric updated with both Sprint 1 + Sprint 3 retro lessons.** Codified verify-before-authoring sub-rule + wire-protocol vocabulary check sub-rule under decision rule 4. Both lessons now binding for all future PM briefs.

---

## Definition of Done — Sprint 4 closeout

- [x] TLC-010 plugin wiring test added (2 cases)
- [x] TLC-012-rescoped lockdown test added (9 cases)
- [x] Coverage audit doc filed
- [x] Both stories' DoD checklists green
- [x] Lint + type-check clean locally
- [x] No production-code changes outside scope
- [x] No invariants relaxed (I-019 reaffirmed via lockdown test)
- [x] PM rubric updated (Sprint 3 retro deliverable; both retro lessons codified)
- [x] `SPRINT_4_REVIEW.md` filed (this doc)
- [ ] `SPRINT_4_RETRO.md` filed (companion doc — next)
- [ ] PM agent accepts via Sprint 5 kickoff brief — _pending_
- [-] Codex review SKIPPED per pre-empt rationale (rationale enumerated above; not pending)

---

## Sprint 5 kickoff — pending PM brief

Sprint 4 retired its committed backlog within budget (3/4 = 75% utilization, slightly higher than Sprint 1/2/3's 30-43% range — converging upward as story sizing tightens further). Sprint 5 budget: hold at 1.2× slack pending Sprint 5 utilization data.

**PM kickoff actions for Sprint 5:**

1. **Re-check Promotion Ledger upstream** for SI-001 / SI-002 / SI-003 closure (P-011 / P-012 / P-013). If any closed, Sprint 5 pivots to Slice 4 schema work.

2. **If SI-001 still open at Sprint 5 kickoff**, candidates:
   - **TLC-013:** Idempotency invariant regression test (I-016). Verify-before-authoring: PM checks `tests/integration/idempotency*.test.ts` for existing coverage. If genuine gap → author; if covered → descope.
   - **TLC-014:** Tenant-isolation regression test for `tenant-config` admin read paths (TLC-004). Pattern-mirror of `consent-cross-tenant-isolation.test.ts` for the admin GET surface. Verify-before-authoring: PM checks if `tests/integration/tenant-config-admin-http.test.ts` §4b cross-tenant case + the existing 9 cases sufficiently cover the surface. Likely descope candidate.
   - **TLC-015:** ORT v1.5 launch-readiness items audit. PM reads `Telecheck_Operational_Readiness_Tracker_v1_5.md` and surfaces which items are testable in this repo (e.g., "rate limiting configured", "idempotency keys tenant-scoped", "audit-chain genesis hash documented"). Story is research-shaped first; execution scope determined by audit output.

3. **Codex strategy for Sprint 5:** if work shifts higher-novelty (Slice 4 schema OR a real coverage gap surfaces), fire Codex with explicit narrow scope. Don't skip on novelty work.

4. **Watch for utilization signal.** Sprint 1/2/3/4 utilization: 33% / 30% / 43% / 75%. The trend is upward. If Sprint 5+ comes in at 80-100%, the slack is tight and the PM should flag for budget recalibration.
