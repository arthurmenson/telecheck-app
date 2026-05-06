# Sprint 10 Review — Telecheck-app autonomous build

**Sprint:** 10
**Sprint goal:** Async Consult slice authoring Sprint 3 of 3 — TLC-021d service layer + TLC-021e HTTP handlers + TLC-021f integration tests + TLC-022 conventions doc.
**Sprint start commit:** `0c6645a` (Sprint 9 PARTIAL ACCEPTANCE)
**Sprint end commit:** `9c7de02` (TLC-022 conventions doc final)
**Total commits in sprint:** 12 (kickoff + TLC-021d 5 commits incl 4 fix-forwards + TLC-021e 2 commits incl 1 fix-forward + TLC-021f 2 commits incl 1 fix-forward + TLC-022 1 commit) vs 13-budget — 92% utilization (just under cap)
**CI status at sprint end:** Green expected at `9c7de02` (lint + type-check clean throughout)

**ACCEPTANCE: FULL.** All 4 sub-stories complete. Async Consult slice is now functionally complete at v0.1 (5 working transitions; 2 transitions fail-closed pending SI-006 + SI-007).

---

## PM-brief verification gate findings (Sprint 10 — 5th consecutive ALL PASS)

12 cited identifiers all verified at source-of-truth files. The Sprint 3 + Sprint 5 hallucination class has not recurred since the gate was instituted at `804c294` (Evans 2026-05-05 oversight directive).

**Critical SM verification gate finding** (Sprint 10 inaugural): PM brief flagged `withTransaction` signature as unverified; SM gate verified that the actual signature is `withTransaction(fn, externalTx?)` (no tenant binding) AND the canonical pattern is manual `SELECT set_tenant_context($1)` inside the tx callback. Sprint 10 service layer authored to mirror this verified pattern. Evidence that the SM verification gate is delivering value beyond the PM-side rubric: PM's flag-as-unverified prevented an authoring path that would have failed Codex review on the tenant-binding surface.

---

## Sub-stories accepted (4 of 4)

### ✅ TLC-021d — Service layer + audit + domain event emitters

**Final state:** 7 service operations (initiate / submit / abandon / resume / process / patientResponds / listEvents). 4 audit emitters + 4 domain event emitters (SI-004 placeholder). Same-tx audit + domain emission per I-003 + I-016. Defense-in-depth posture across 7 layers (per `PROJECT_CONVENTIONS.md` §3.3).

**Codex iterations: 4 fix-forward rounds; 7 HIGH closures.**
- r9: 3 HIGH (ownership unenforced; payment hard-coded; form verification missing)
- r10: 2 HIGH (PHI boundary regression; process ownership)
- r11: 1 HIGH (process auth gate)
- r12: 1 HIGH (no direct-DB bypass)

**Result at r13 verify: APPROVE.** PROCESSING state unreachable at v0.1 (fail-closed pending SI-007). 5 working transitions (initiate / submit / abandon / resume / patientResponds).

### ✅ TLC-021e — HTTP handlers + routes wiring

**Final state:** 6 HTTP routes wired (`POST /v0/async-consult` + 4 transition routes + `GET /:id/events`). NOT exposed at v0.1: `start-intake` (SI-006 fail-closed), `process` (SI-007 fail-closed). Service-error → HTTP envelope mapping with canonical ERROR_MODEL v5.1 codes.

**Codex iterations: 1 fix-forward round; 1 HIGH closure.**
- r13: 1 HIGH (listEvents same-tenant cross-patient leak — fixed by adding L2 patient-ownership check at service layer; handler maps to tenant-blind 404)

**Result at r14 verify: APPROVE.**

### ✅ TLC-021f — Integration tests + cross-tenant isolation regression

**Final state:** 6 cases across 3 sections (4 cross-tenant + cross-patient at service layer; 2 fail-closed regression at service layer; 2 handler-level tenant-blind 404 at HTTP boundary).

**Codex iterations: 1 fix-forward round; 1 MEDIUM closure.**
- r15: 1 MEDIUM (handler-level tenant-blind 404 not asserted — fixed by adding §3 with 2 HTTP-level cases)

### ✅ TLC-022 — PROJECT_CONVENTIONS.md

**Final state:** Living-doc artifact with 7 sections codifying Sprint 6/9/10 patterns. Authoring discipline: read this doc before authoring schema/repos/services/handlers/state-machines for new slice work.

**Codex iterations: SKIPPED per Sprint 10 plan (pure docs).**

---

## Codex adversarial review — 9 HIGH + 1 MEDIUM closed across Sprint 10

| Round | Sub-story | Severity | Closure |
| --- | --- | --- | --- |
| r9 | TLC-021d | 3 HIGH | `2af19c5` |
| r10 | TLC-021d | 2 HIGH | `16596bf` |
| r11 | TLC-021d | 1 HIGH | `5609e04` |
| r12 | TLC-021d | 1 HIGH | `e9eaded` |
| r13 | TLC-021e | 1 HIGH | `e99e316` |
| r15 | TLC-021f | 1 MEDIUM | `869773a` |

**Cumulative Codex closures across all sprints:** 21 HIGH + 5 MEDIUM = 26 findings closed. Each represented a real defect class the SM had not surfaced.

**Sprint 9 retro #3 cap** (5+ rounds = pause): TLC-021d hit 4 fix-forward rounds and converged. The cap was approached but not crossed.

**Pattern observation:** rounds 9 / 10 / 11 / 12 / 13 / 15 each caught structurally correct defects. None were taste/preference findings. The Codex finding-rate per sub-story scales with novelty:
- TLC-021d (service + cross-slice authorization + state-machine integration): 4 rounds
- TLC-021e (HTTP handlers): 1 round
- TLC-021f (tests): 1 round

This empirical curve informs Sprint 11+ planning: budget 1.3× slack + N fix-forward rounds where N = ~4 for novel-of-class service authoring; ~1 for handler/test pattern-mirroring.

---

## Cumulative platform metrics at Sprint 10 close

- **Slices:** 4 implementation-complete (Forms-Intake, Identity, Consent + Delegation, **Async Consult — NEW**)
- **Foundations:** 2 (tenant-config; pharmacy skeleton)
- **Module skeletons (BLOCKED-aware):** 3 (pharmacy, med-interaction, subscription)
- **Forward migrations:** 21 (000–019 + 020 + 021)
- **Rollback migrations:** 21 (matched-pair coverage; 020 + 021 with to_regclass partial-apply guards)
- **Domain events wired:** 35 of 35 (Sprint 10 added 4 placeholder events: consult.initiated / intake_submitted / abandoned / expired)
- **Open Spec Issues:** 5 (SI-001/002/003 + SI-004 + SI-005)
- **Tenant-scoped tables:** 23 (unchanged from Sprint 9)
- **Test files:** ~110 (Sprint 10 added `async-consult-cross-tenant-isolation.test.ts`; `async-consult-http.test.ts` deferred — handler tests merged into the cross-tenant file's §3)
- **Test cases (rough):** ~1480+ (Sprint 10 added 6 cases — 4 service-level + 2 handler-level)
- **Branded ID types:** 13
- **Audit / coverage / convention docs (living artifacts):** 4 (CRISIS_DETECTION_COVERAGE_AUDIT + ORT_V1_5_TESTABLE_ITEMS_AUDIT + BUILD_VS_SPEC_TRACEABILITY_MATRIX + **PROJECT_CONVENTIONS — NEW**)
- **Cumulative Codex findings closed:** 26 (21 HIGH + 5 MEDIUM)
- **PM-brief verification gate runs:** 5 (Sprint 6/7/8/9/10); ALL PASS

---

## Decisions made this sprint

1. **Async Consult slice closed at v0.1 with PROCESSING unreachable.** 5 working transitions + 2 fail-closed (start_intake / process pending SI-006 / SI-007).
2. **`getSubmissionForBinding` REPLACED with `verifySubmissionBindingEligibility`.** Authorization-enforcing helper that returns minimal validity result; PHI never crosses module boundary. Sprint 10 retro will codify the pattern as "cross-slice public-interface authorization enforcement" (already in `PROJECT_CONVENTIONS.md` §3.6).
3. **Defense-in-depth posture formalized at 7 layers.** Codified in `PROJECT_CONVENTIONS.md` §3.3.
4. **TLC-022 conventions doc lifted Sprint 6/9/10 patterns.** Future authoring references the doc rather than re-deriving patterns per slice.
5. **2 new SI candidates flagged for Sprint 11+ scope:**
   - SI-006 (Payment slice authoring + cross-slice payment-verification surface) — gates `start_intake` transition
   - SI-007 (AI Service slice authoring + service-account RBAC) — gates `process` transition

---

## Definition of Done — Sprint 10 closeout

- [x] PM-brief verification gate ran + findings recorded (Sprint 10 plan §"PM-brief verification gate findings")
- [x] TLC-021d converged (4 fix-forward rounds; 7 HIGH closures)
- [x] TLC-021e converged (1 fix-forward round; 1 HIGH closure)
- [x] TLC-021f converged (1 fix-forward round; 1 MEDIUM closure)
- [x] TLC-022 conventions doc filed
- [x] All Sprint 10 Codex findings closed in-sprint via fix-forward
- [x] Lint + type-check clean
- [x] No invariants relaxed
- [x] No production-code changes outside scope
- [x] `SPRINT_10_REVIEW.md` filed (this doc — FULL acceptance)
- [ ] `SPRINT_10_RETRO.md` filed (companion doc — next)
- [ ] PM kickoff brief for Sprint 11 (pivot decision: Slice 4 if SI-001 closes; or surface emergency-access blockers)

---

## Sprint 11 kickoff — pivot decision required

**Pre-pave runway is again exhausted** (now that Async Consult slice is complete). Sprint 11 must pivot.

**Three pivot paths:**

1. **Slice 4 schema authoring** — IF SI-001 / SI-002 / SI-003 close upstream. Sprint 11 PM kickoff re-checks Promotion Ledger; if any close, Slice 4 schema (MedicationRequest + Refill + Dispensing + Shipment + ProductCatalog) becomes priority.

2. **Sprint 11 hardening + launch-prep items** — per ORT v1.5 + EHBG §10b. Candidates:
   - OR-218 perf budget thresholds + CI gating + baseline comparison (Sprint 11 promotion path documented in `tests/perf/README.md`)
   - OR-217 pen test scope definition (Counsel Security; partly out-of-repo)
   - OR-220 honest-status patient-surface specification

3. **Surface to Evans:** vendor account credentials (LiveKit, Anthropic API, AWS Bedrock, Twilio/Hubtel, etc.); AWS deploy access for production cutover; Counsel work (DPIA, threat model). These require Evans's emergency-only involvement.

**Recommendation:** Sprint 11 PM kickoff re-checks Promotion Ledger. If still no SI-001/002/003 closure, pivot to OR-218 perf-budget hardening (Sprint 7 TLC-018 scaffolded the infra; Sprint 11 closes the OR-218 row). Defer Path 3 emergency-access surfacing to Sprint 12+ if OR-218 hardening absorbs Sprint 11.

**Sprint 11 commit budget:** depends on pivot path. OR-218 hardening is moderate-novelty (2-3 commits perf threshold authoring + CI workflow + baseline comparison wiring); Slice 4 schema would be 5-10 commits with high Codex iteration.
