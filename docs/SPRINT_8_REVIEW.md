# Sprint 8 Review — Telecheck-app autonomous build

**Sprint:** 8
**Sprint goal:** Pivot to Async Consult slice authoring; Sprint 1 of 3 — module skeleton + branded IDs + 17-state vocabulary + plugin smoke test.
**Sprint start commit:** `5cfa986` (Sprint 7 ACCEPTED)
**Sprint end commit:** `2a44164` (TLC-020 final; Codex APPROVE first-try)
**Total commits in sprint:** 2 (kickoff `ba38eff` + TLC-020 `2a44164`) vs 6-budget — 33% utilization (back to Sprint 1-4 range; recipe maturity reduced authoring cost)
**CI status at sprint end:** Green expected at `2a44164` (lint + type-check clean locally)

---

## PM-brief verification gate findings (Sprint 8 — 3rd consecutive ALL PASS)

| Identifier | Cited at (PM brief §) | Verified at (source-of-truth) | Match |
| --- | --- | --- | --- |
| Async Consult PRD §1 | §3 | `Telecheck_Async_Consult_Slice_PRD_v1_0.md:11` | ✓ |
| PRD §12 (states) | §3 | PRD:418 | ✓ |
| PRD §13 (audit) | §3 | PRD:441 | ✓ |
| PRD §15 (deps) | §3 | PRD:497 | ✓ |
| State Machines §3 | §3 | `Telecheck_State_Machines_v1_1.md:159` | ✓ |
| EXPIRED transition | §3 | State Machines:200 | ✓ |
| CDM Consult #15 | §3 | `Telecheck_Canonical_Data_Model_v1_2.md:84` | ✓ |
| CDM ConsultEvent #16 | §3 | CDM:85 | ✓ |
| Glob src/modules/async-consult/ | §4 | does NOT exist | ✓ |
| P-010 (no P-011/012/013) | §1 | confirmed | ✓ |

**Gate result: ALL PASS.** 3rd consecutive clean PM brief. The Sprint 3 + Sprint 5 hallucination class has not recurred.

**SM verification correction recorded inline:** PM brief §3 said "16 + EXPIRED = 17 states"; fuller read of State Machines §3 transition table at L196-218 shows 17 distinct states including BOTH EXPIRED + CLOSED (not just EXPIRED). PRD §12's `DECISION_MADE` is absorbed into UNDER_REVIEW branch points in §3 (not exposed as a separate state). Per CLAUDE.md hard rule "Slice PRD vs State Machines v1.1 → State Machines wins", skeleton uses State Machines list of 17 (omitting DECISION_MADE; including EXPIRED + CLOSED).

---

## Stories accepted

### ✅ TLC-020 — Async Consult slice skeleton — `2a44164`

**Deliverables:**
- `src/modules/async-consult/` directory: `index.ts` + `plugin.ts` + `routes.ts` + `internal/types.ts` + `README.md`
- 2 branded ID types: `ConsultId`, `ConsultEventId` (CDM v1.2 §3 #15-16)
- State value const enum `CONSULT_STATES` (17 canonical states from State Machines v1.1 §3)
- `/v0/async-consult/health` (200) + `/v0/async-consult/ready` (503) — 4th application of the BLOCKED-aware skeleton recipe
- Plugin wired in `src/app.ts`; tenantContextPlugin allowlist updated
- 2-case plugin smoke test
- README with Sprint 8/9/10 sequencing + on-resume notes for Sprint 9 kickoff
- Cross-slice dependency posture table (14 PRD §15 deps vs current implementation status)

**Acceptance criteria evaluation:**
- [x] Module directory + plugin shell created (recipe 4th application)
- [x] Branded IDs + state vocabulary exported
- [x] Liveness/readiness split applied (standing rule)
- [x] Plugin smoke test (2 cases)
- [x] Plugin wired in app.ts
- [x] No row-shape interfaces / repos / services / handlers (Sprint 9 + 10 scope)
- [x] No audit / domain event emitters (Sprint 10 scope; AUDIT_EVENTS contract grep showed 0 PRD §13 events — SI-004 candidate)
- [x] No schema migrations (Sprint 9 scope)
- [x] State value canonicalization correct (State Machines wins over PRD)

**Codex round-trip:**
- Round 1 (against `5cfa986`): **approve / ship**. No material findings.
- 0 fix-forward iterations needed. Cleanest Codex run yet.

**Verdict:** Accepted.

---

## Stories rolled over

None. Single committed story accepted within sprint.

---

## Codex adversarial review

**Trigger:** Sprint 8 plan called for FIRE on TLC-020 (first new slice authoring since Sprint 1; novel module class — Care Delivery group, first instance; state-machine-bearing skeleton).

**Round 1 (against `5cfa986`):** Verdict **approve**. No material findings on auth, tenant-isolation, data integrity, retry, or state-transition surfaces.

**Cumulative Codex stats across all sprints:**
- Sprint 1: 1 MEDIUM (`pharmacy-blocked-handler`) — closed at `5615feb`
- Sprint 2/3/4: SKIPPED per pre-empt rationale
- Sprint 5: 1 HIGH (`idempotency-r5`) — closed at `0f4a757`
- Sprint 6: 1 MEDIUM (`rls-policy-r1`) — closed at `2dece96`
- Sprint 7: 1 HIGH (`perf-bench-r1`) — closed at `d879a79`
- Sprint 8: APPROVE (no findings) — first-try clean

4 substantive findings + 1 first-try approve across 5 non-skip Codex runs. The recipe-mirror discipline (4th skeleton application; identical shape to pharmacy / med-interaction / subscription) appears to drive Codex's no-findings outcome — when the surface is genuinely novel-by-pattern, Codex finds gaps; when it's a known-good recipe applied to a new module, Codex confirms.

**Lesson reinforced:** Codex FIRE on novel work is correct strategy; SKIP on pattern-mirror work continues to validate; FIRE on novel-but-recipe-applied work returns clean (signal that the recipe is mature).

---

## Cumulative platform metrics at sprint end

- **Slices:** 3 implementation-complete + 1 skeleton-Sprint-1-of-3 (Async Consult) = 4 slice modules touched
- **Foundations:** 2 (tenant-config; pharmacy skeleton)
- **Module skeletons (BLOCKED-aware OR multi-sprint):** 4 (pharmacy, med-interaction, subscription, async-consult)
- **Forward migrations:** 18 (000-019; unchanged)
- **Rollback migrations:** 18 (matched-pair coverage)
- **Domain events wired:** 31 of 31 (unchanged)
- **Open Spec Issues:** 3 (SI-001/002/003); SI-004 candidate flagged (Async Consult §13 audit events not in canonical AUDIT_EVENTS contract)
- **Test files:** ~108 (added `async-consult-plugin-wiring.test.ts`)
- **Bench scenarios:** 4 (unchanged from Sprint 7)
- **Test cases (rough):** ~1472+ (Sprint 8 added 2 wiring cases)
- **Branded ID types:** 13 (Sprint 7: 11 → Sprint 8: +2 ConsultId/ConsultEventId)
- **State value vocabularies exported:** 1 (Sprint 8 NEW: `CONSULT_STATES` 17-value enum)
- **Audit / coverage docs (living artifacts):** 3 (unchanged)
- **Cumulative Codex findings closed:** 4 (unchanged; Sprint 8 was first-try APPROVE)
- **PM-brief verification gate runs:** 3 (Sprint 6 + 7 + 8); ALL PASS

---

## Decisions made this sprint

1. **State value canonicalization: State Machines wins.** PRD §12 has 16 states (incl. DECISION_MADE); State Machines §3 has 17 states (omits DECISION_MADE, adds EXPIRED + CLOSED). Per CLAUDE.md hard rule, skeleton uses State Machines list. Documented inline in `internal/types.ts` + README.
2. **Audit event vocabulary deferred to Sprint 10.** PRD §13 enumerates 11 events; AUDIT_EVENTS canonical contract grep returned 0 matches. SI-004 candidate flagged. Skeleton ships without emitters (no handlers to emit from). Sprint 7 TLC-018 closure-language lesson applied a-priori — README + commit say "Sprint 1 of 3", not "closes Async Consult slice".
3. **Cross-slice dependencies enumerated but not wired.** PRD §15 lists 14 deps; skeleton ships branded IDs + state vocab so dependent slices can typed-import. Sprint 9 wires available deps (Identity, Forms-Intake, Consent); Sprint 10+ wires the rest as they ship.
4. **4th recipe application validated.** TLC-020 took 1 commit; Codex APPROVE first-try; no surprises during authoring. The reproducible skeleton recipe is now genuinely mature.

---

## Definition of Done — Sprint 8 closeout

- [x] PM-brief verification gate ran + findings recorded
- [x] TLC-020 module skeleton authored
- [x] Branded IDs + state vocabulary exported
- [x] Plugin smoke test (2 cases)
- [x] Plugin wired in app.ts
- [x] Codex FIRE on TLC-020; APPROVE first-try
- [x] Lint + type-check clean
- [x] No invariants relaxed
- [x] No production-code changes outside scope
- [x] `SPRINT_8_REVIEW.md` filed (this doc)
- [ ] `SPRINT_8_RETRO.md` filed (companion doc — next)
- [ ] PM kickoff brief for Sprint 9 (verification gate runs again; Sprint 9 = repos + services + initial handlers)

---

## Sprint 9 kickoff — pending PM brief

Sprint 8 utilization 33% (2/6) — back to Sprint 1-4 range. The 1.3× slack proposed for Sprint 8 was generous; recipe maturity reduced actual cost. **Sprint 9 budget**: hold 1.2× slack (Sprint 9 work is meaningfully different — repos + service layer + state machine + handlers; not a recipe mirror).

**PM kickoff actions for Sprint 9:**

1. **Re-check Promotion Ledger** for SI-001 closure (P-011). If P-011 lands, reconsider Sprint 9 = Slice 4 schema authoring vs Async Consult continuation.
2. **Verify CDM §4 Consult / ConsultEvent expansion** at `Telecheck_Canonical_Data_Model_v1_2.md` — if §4 row-level expansion exists, Sprint 9 implements per-spec; if not, SI-005 candidate.
3. **Read State Machines §3 transition table FULLY** (`Telecheck_State_Machines_v1_1.md:196-218+`) — all ~30 transitions with guards + actions.
4. **Verify Identity / Forms-Intake / Consent public interfaces** for cross-slice integration:
   - Identity: `requireActorContext` from `src/lib/auth-context.ts`
   - Forms-Intake: `src/modules/forms-intake/index.ts` exports
   - Consent: `src/modules/consent/index.ts` exports
5. **Sprint 9 candidate stories:**
   - **TLC-021a:** Migration `migrations/020_async_consult.sql` (only if CDM §4 expansion verified)
   - **TLC-021b:** Repos (`internal/repositories/consult-repo.ts` + `internal/repositories/consult-event-repo.ts`)
   - **TLC-021c:** State machine transition logic (`internal/state-machine.ts`)
   - **TLC-021d:** Service layer (`internal/services/consult-service.ts` — initiate / submit / abandon / read)
   - **TLC-021e:** Initial HTTP handlers (POST /v0/async-consult, GET /v0/async-consult/:id)
   - **TLC-021f:** Per-handler integration tests (initiate / submit / abandon / read happy paths + 1-2 error paths)
6. **Codex strategy for Sprint 9:** FIRE on every authoring iteration. State machine logic + repo logic + service logic are all genuinely novel surfaces; precedent (Sprint 5 + 6 + 7) shows Codex finds real bugs in novel surfaces.
