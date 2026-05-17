# Per-Track SI Navigation — 2026-05-17

**Authored:** 2026-05-17 (Claude autonomous run; Addendum 32 next-entry-point identification)
**Audience:** Evans (workstream lead) + Engineering Lead + per-Track engineering leads (Tracks 1-5) + Track 6 spec-corpus ratifier
**Purpose:** Fourth cross-SI navigation artifact. The first three artifacts answer different questions: PR #165's audit-failure injection harness ("how do we test combined operational + safety-floor audit emission paths"); PR #167's Ratifier Ceremony Agenda ("what ceremonies in what order"); PR #168's Implementation State Audit ("what implementation state does each ratification unlock"). This doc answers a fourth question: **"which Tracks does each SI unblock, and what is each Track waiting on?"** Per Master Completion Plan v1.0 §6-track decomposition + the 12 pending SIs (post Ratifier Ceremony Agenda Patch 2026-05-17).
**Status:** Reference doc, not normative. The authoritative source for Track structure remains `Telecheck_Master_Completion_Plan_v1_0.md` (spec corpus, sibling repo). The authoritative source for each SI's content remains its `docs/SI-<NNN>-*.md` file. This doc is purely a SI → Track → Cluster cross-reference map.

---

## TL;DR

- **6 Tracks** per Master Completion Plan v1.0: Track 1 Clinical Care · Track 2 AI Service · Track 3 Consent + Forms-Intake · Track 4 Mobile + UI · Track 5 Infra & Ops · Track 6 Spec-corpus ratification.
- **Plan-vs-current-state baseline note (Codex R2 H1 closure 2026-05-17):** Master Completion Plan v1.0 was authored 2026-05-15 and frames Phase A's ratifier ceremony scope as "**7 pending SIs** (SI-003/004/005/008/009/010/011) + CDM §4 MarketingCopy + FORMS_ENGINE §I-030 detection rules" + explicitly carves Track 2 Mode 1 out as "**Buildable now without ratification gates**" (Plan §"Status pointer" item 4). Since the Plan was authored, **5 more SIs were filed** (SI-002 + SI-007 rediscovered as OPEN per Implementation State Audit 2026-05-17 cross-doc-drift surfacing; SI-012 + SI-013 + SI-014 filed during the autonomous run 2026-05-16). The current ratifier queue is **12 SIs**, not 7. **This doc is a POST-PLAN refinement** that surfaces the evolved queue + recommends a Plan patch (see §5 + §6); it does NOT unilaterally redefine the Plan's Phase A scope or its Track 2 Buildable-now carveout.
- **3 Tracks have OPEN SIs gating their advancement: Tracks 1, 2, 3.** Track 4 (Mobile + UI) and Track 5 (Infra & Ops) have no OPEN SI dependencies and can advance fully in parallel with the ratifier work. Track 6 is the ratifier track itself — it gates the other Tracks rather than being gated by them. **Note on Track 2**: per the Plan's explicit Track 2 carveout, the Mode 1 chat handler **shipped today (the 21-test-case surface per Implementation State Audit §1)** does NOT wait on any SI ratification. The SI-013 + SI-014 gates apply to the FUTURE Telecheck-Ghana **patient-localization upgrade** of Mode 1 — not the current clinician-test-accessible surface.
- **Track 1 (Clinical Care) is gated by 3 OPEN SIs** (SI-005 Async-Consult, SI-007 Pharmacy refill/dispense/shipment, SI-012 Med-Interaction) — the highest count of any Track. **Track 1 is the Telecheck-Ghana revenue anchor** per the Plan; the 3 SIs together unblock ~3200-4400 LOC of Clinical Care impl per Implementation State Audit 2026-05-17 §2 LOC-leverage analysis.
- **Track 6 ratifier ceremony at the post-Plan 12-SI / 8-sub-ceremony scope unblocks Tracks 1 + 3 IMPL surfaces simultaneously** (per Plan §"Status pointer" item 1) **+ unlocks the Track 2 patient-localization upgrade pathway** (which the Plan did not separately enumerate because SI-013/014 didn't exist when it was authored). Tracks 4 + 5 can already fan out today (no SI dependency).
- **One SI (SI-008) spans Tracks 2 AND 3** — it gates Track 2's Mode 2 case-prep scaffolding AND it is an IMPL-readiness gate for Track 3's SI-011d (Mode 2 input contract conformance). Cross-Track ratification leverage.

---

## 1. Track inventory with OPEN SI gates

For each Track: which SIs gate its advancement, which slices the Track owns, and pointers to the per-SI texts + Cluster assignments per the Ratifier Ceremony Agenda.

### Track 1 — Clinical Care (Ghana revenue anchor)

**Plan owner:** 2 backend eng + 1 clinical SME advisor.
**Slices owned:** Async-Consult, Pharmacy + Refill, Med-Interaction.
**Phase A gates this Track until Track 6 ratifies:**

| Slice             | Gating OPEN SI(s)                                                                                                                                                                                      | Cluster                             | Severity | Impact on advancement                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Async-Consult     | **SI-005** Consult/ConsultEvent CDM (depends on SI-008 + SI-009 deferred FKs)                                                                                                                          | B (HARD ratification-correctness)   | MEDIUM   | Sprint 10 handlers (claim/prescribe/advise/notify/follow-up/complete) blocked; ~400-600 LOC unlocked per Implementation State Audit 2026-05-17 §2 |
| Pharmacy + Refill | **SI-007** Refill + Dispensing + Shipment CDM (pharmacy refill/dispense/shipment surface; prescribe surface already implemented post-SI-001 ratification per Implementation State Audit 2026-05-17 §1) | E (Pilot-launch standalone blocker) | HIGH     | ~800-1200 LOC of pharmacy refill HTTP surface + dispensing handlers + shipment lifecycle unlocked                                                 |
| Med-Interaction   | **SI-012** Med Interaction Engine CDM expansion (3 entity row shapes)                                                                                                                                  | E (Pilot-launch standalone blocker) | HIGH     | ~2000-3000 LOC of interaction-engine impl unlocked (entire slice currently sits behind SKELETON 503 surface)                                      |

**Total Track 1 LOC unlocked by Phase A ratification:** ~3200-4800 LOC. **Highest-leverage Track per ratification cycle.**

**Independent of OPEN SI gates (already advanceable):** pharmacy MedicationRequest/prescribe surface (post-SI-001 P-011 2026-05-12, per Implementation State Audit §1 — pharmacy module reclassified SKELETON → SUBSTANTIAL).

### Track 2 — AI Service

**Plan owner:** 2 eng.
**Slices owned:** AI Service core (Mode 1 + Mode 2 scaffold) + multi-provider abstraction.

**Plan §"Status pointer" item 4 explicitly says:** Track 2 Mode 1 chat handler wire-up is "Buildable now without ratification gates." The current 21-test-case Mode 1 chat handler surface (per Implementation State Audit §1 IN-PROGRESS classification) is the realization of that buildable-now scope. The SIs below gate POST-current-surface advancement, not the current surface itself:

| Slice / surface                                                                                        | Gating OPEN SI(s)                                                                | Cluster                                                  | Severity                    | Impact on advancement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mode 1 chat handler current surface (clinician-test access; 21 test cases per Impl State Audit §1)** | (none — Plan §"Status pointer" item 4 carveout)                                  | —                                                        | —                           | **Already shipped + advanceable today.** No SI ratification gates this surface — it already serves clinician-test patient JWTs end-to-end with the regex-stub crisis-detection floor + null-escalation_destination crisis gate.                                                                                                                                                                                                                                                                                                                                                                                                             |
| Mode 1 patient-localization upgrade (Telecheck-Ghana patient launch)                                   | **SI-013** CCR crisis-helpline keys + **SI-014** Crisis-detection NLP classifier | D (RECOMMENDED batching — runCrisisGate callsite shared) | SI-013 MEDIUM + SI-014 HIGH | SI-013 unlocks ~150-250 LOC (typed resolvers + Cat B emitter + sentinel localization); SI-014 unlocks ~150-400 LOC per Option A/B/C OR ~20 LOC (gate-only) per Option D. **Telecheck-Ghana Mode 1 patient launch is BLOCKED** by SI-014 Rule 6 (multi-language coverage). NOT a blocker on the Plan's "Buildable now" Track 2 scope — only on the FUTURE patient-localization upgrade. The SI-013/SI-014 SIs were filed AFTER the Plan was authored 2026-05-15 (per the Plan-vs-current-state baseline note in the TL;DR), so the Plan's Track 2 framing doesn't separately enumerate them — that's the post-Plan refinement this doc adds. |
| Mode 2 case-prep scaffolding                                                                           | **SI-008** AiWorkflowExecution CDM                                               | B (Cluster B leaf; parallel to SI-009 + SI-005)          | MEDIUM                      | ~200-300 LOC of Mode 2 case-prep handler scaffolding + protocol-execution audit chain binding unlocked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Multi-provider abstraction                                                                             | (none — already canonical per ADR-020)                                           | —                                                        | —                           | Advanceable today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Total Track 2 LOC unlocked by Phase A ratification (POST-current-surface):** ~500-950 LOC.

**Independent of OPEN SI gates (already advanceable per Plan §"Status pointer" item 4):** Mode 1 chat handler current 21-test-case surface (already shipped; serves clinician-test access; SI-014 patient-localization SIs do not gate this scope per the Plan's explicit Buildable-now carveout).

### Track 3 — Consent + Forms-Intake Completion

**Plan owner:** 1 backend eng + 1 spec-corpus liaison.
**Slices owned:** Consent + Delegated Access (already COMPLETE per Implementation State Audit §1), Forms-Intake publish-gate sub-SIs (SI-011a/b/c/d).
**Phase A gates this Track until Track 6 ratifies:**

| Slice                          | Gating OPEN SI(s)                                                                                      | Cluster                                                                | Severity | Impact on advancement                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forms-Intake publish-gate IMPL | **SI-011** (HIGH; 4 IMPL-readiness gates: SI-010 + SI-008 + MarketingCopy CDM + I-030 detection rules) | C (IMPLEMENTATION-readiness gates, NOT ratification-order constraints) | HIGH     | ~600-1000 LOC of Forms-Intake publish-gate impl + production-deploy gate replacement (replaces `FORMS_PUBLISH_GATES_BYPASS='unsafe-test-only'` sentinel — production-deploy blocker per Implementation State Audit §1 forms-intake row) |
| Consent + Delegated Access     | (none — already COMPLETE per Implementation State Audit §1)                                            | —                                                                      | —        | Advanceable today                                                                                                                                                                                                                       |

**Total Track 3 LOC unlocked by Phase A ratification:** ~600-1000 LOC.

**Cross-Track note:** SI-011's IMPL-readiness gate on **SI-008** (Mode 2 input contract for L2 gate) creates a SHARED-DEPENDENCY across Tracks 2 + 3 — SI-008 ratification unblocks both Track 2's Mode 2 case-prep scaffolding AND Track 3's Forms-Intake SI-011d gate. Two Tracks advance from a single MEDIUM-severity ratification. **Highest cross-Track ratification leverage in the queue.**

### Track 4 — Mobile + Clinician UI

**Plan owner:** 2 mobile eng + 1 frontend eng + 1 designer.
**Slices owned:** Patient mobile app (React Native), Clinician console (React desktop).
**Phase A gates this Track:** **NONE.**

Mobile starts on OpenAPI v0.2 mocks per Plan §Track-4. Design System v1.1 + Patient mock v7 are already canonical (per DIC v1.1). Track 4 can advance fully in parallel with the Track 6 ratifier ceremony — no SI ratification blocks any deliverable.

**Out-of-scope:** Pharmacy portal (Plan §Track-4 notes design system v1.1 doesn't cover it; either parallel pharmacy-portal design track in Phase B OR accept pharmacists use clinician console for v1).

### Track 5 — Infra & Ops (operates AHEAD of code)

**Plan owner:** 1 SRE/DevOps + 1 SecOps.
**Slices owned:** AWS us-east-1 + us-west-2 cold DR, per-tenant KMS, LiveKit self-hosted, SIEM, F-4 deploy runbook, Ghana SMS + payment processor, US payment processor + SMS provider.
**Phase A gates this Track:** **NONE.**

Per Plan §Track-5 "Why ahead": "When code is ready, infra cannot be the critical-path blocker. Infra has its own cycle time that doesn't compress." Track 5 runs from day 1 in parallel with everything else. No SI ratification gates any deliverable.

### Track 6 — Spec-corpus ratification (continuous, dedicated)

**Plan owner:** 1 dedicated ratifier (Evans-style single named owner per artifact).
**Slices owned:** the ratification ceremonies themselves.
**Phase A scope — Plan-original (authored 2026-05-15):** 7 pending SIs (SI-003/004/005/008/009/010/011) + CDM §4 MarketingCopy + FORMS_ENGINE §I-030 detection rules.

**Post-Plan recommended ratifier-queue scope (surfaced by this doc; pending Plan patch per §5 Drift 1):** all 12 OPEN SIs + CDM §4 MarketingCopy + FORMS_ENGINE §I-030 detection rules. The 5 post-Plan additions are SI-002 (rediscovered as OPEN per Implementation State Audit), SI-007 (rediscovered as OPEN), SI-012 + SI-013 + SI-014 (filed during autonomous run 2026-05-16). **A Track 6 lead working from the Plan directly will see the 7-SI scope; a Track 6 lead working from this doc + the Ratifier Ceremony Agenda will see the 12-SI scope. Until the Plan is patched (separate PR per §5), both scopes are legitimately referenced by different artifacts in the spec corpus.** Codex R3 M1 closure 2026-05-17 patched this Track 6 row from "Phase A scope: ratify all 12 OPEN SIs..." (which read as Plan-mandate) to the Plan-vs-post-Plan split above (matching the TL;DR + §3 wording).

| Cluster (per Agenda §2)                 | SIs in cluster                    | Sub-ceremony (per Agenda §3)                                                                                      | Track(s) unblocked                                                                                                                                                                           |
| --------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Independent platform infrastructure | SI-002 + SI-003 + SI-004 + SI-010 | 3 (placeholder-namespace sibling pair: SI-002 + SI-003) + 2 (SI-010) + 5 (SI-004)                                 | Tracks 1 + 2 + 3 (SI-002/003 unblock all audit-emitting slices; SI-004 unblocks Async-Consult Sprint 9 audit ratifications; SI-010 unblocks SI-005/008/011 SECURITY DEFINER procedure IMPLs) |
| B — Async Consult schema family         | SI-008 + SI-009 + SI-005          | 4 (Cluster B batch — HARD ratification-correctness: SI-008+009 before SI-005)                                     | Track 1 (Async-Consult) + Track 2 (Mode 2 via SI-008) + Track 3 (SI-011 IMPL-readiness via SI-008)                                                                                           |
| C — Forms-Intake governance             | SI-011 (+ 4 IMPL-readiness gates) | 6 (SI-011 with prerequisite confirmation; chair option (a) in-scope or (b) sibling SIs for MarketingCopy + I-030) | Track 3 (Forms-Intake publish gates)                                                                                                                                                         |
| D — Mode 1 chat crisis surface          | SI-013 + SI-014                   | 7 (Cluster D batch — RECOMMENDED pairing; runCrisisGate shared callsite)                                          | Track 2 (Mode 1 patient surface localization + classifier upgrade)                                                                                                                           |
| E — Pilot-launch standalone blockers    | SI-007 + SI-012                   | 1 (Cluster E batch — independent of all other SIs)                                                                | Track 1 (pharmacy refill/dispense/shipment via SI-007; med-interaction via SI-012)                                                                                                           |

**Total ratifier-time budget per Ratifier Ceremony Agenda §3 (post-2026-05-17 patch):** 8-12 hours across 8 sub-ceremonies — see PR #167 / PR #169 + Implementation State Audit 2026-05-17 §5.

---

## 2. Per-SI Track allocation (reverse index)

Mirror of §1 in SI-keyed form, so a reader who knows the SI but not the Track can navigate. For each OPEN SI: which Track owns the slice the SI unblocks, which Cluster the SI belongs to per the Ratifier Ceremony Agenda, and the severity.

| SI                                                    | Severity | Cluster                                                                                 | Primary Track                                                    | Secondary Track(s) (IMPL-gating)                                            |
| ----------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **SI-002** AUDIT_EVENTS placeholders                  | MEDIUM   | A                                                                                       | Track 6 (ratification surface)                                   | Tracks 1 + 2 + 3 (all audit-emitting slices benefit)                        |
| **SI-003** DOMAIN_EVENTS placeholders                 | MEDIUM   | A                                                                                       | Track 6                                                          | Tracks 1 + 2 + 3 (sibling of SI-002 across DOMAIN_EVENTS contract)          |
| **SI-004** Async-Consult audit events (4-of-11 scope) | MEDIUM   | A                                                                                       | Track 1 (Async-Consult Sprint 9 audit emission canonicalization) | —                                                                           |
| **SI-005** Consult/ConsultEvent CDM                   | MEDIUM   | B (depends on SI-008 + SI-009 deferred FKs)                                             | Track 1 (Async-Consult Sprint 10 handlers)                       | —                                                                           |
| **SI-007** Refill + Dispensing + Shipment CDM         | HIGH     | E                                                                                       | Track 1 (Pharmacy refill/dispense/shipment surface)              | —                                                                           |
| **SI-008** AiWorkflowExecution CDM                    | MEDIUM   | B (leaf; parallel to SI-009; SI-005 deferred FK 6)                                      | Track 2 (Mode 2 case-prep scaffolding)                           | Track 3 (SI-011d Mode 2 input contract conformance — **shared dependency**) |
| **SI-009** SyncSession CDM                            | MEDIUM   | B (leaf; parallel to SI-008; SI-005 deferred FK 7)                                      | Track 1 (Async→sync conversion path for Async-Consult)           | —                                                                           |
| **SI-010** Session Actor Context DB Binding           | MEDIUM   | A                                                                                       | Track 6 (Identity slice extension)                               | Tracks 1 + 3 (SECURITY DEFINER procedure IMPLs for SI-005 + SI-011)         |
| **SI-011** Forms-Intake publish-time governance gates | HIGH     | C (4 IMPL-readiness gates: SI-010 + SI-008 + MarketingCopy CDM + I-030 detection rules) | Track 3 (Forms-Intake)                                           | —                                                                           |
| **SI-012** Med Interaction Engine CDM expansion       | HIGH     | E                                                                                       | Track 1 (Med-Interaction)                                        | —                                                                           |
| **SI-013** CCR crisis-helpline keys                   | MEDIUM   | D (paired with SI-014; runCrisisGate shared callsite)                                   | Track 2 (Mode 1 chat crisis sentinel localization)               | —                                                                           |
| **SI-014** Crisis-detection clinical NLP classifier   | HIGH     | D                                                                                       | Track 2 (Mode 1 chat classifier upgrade)                         | —                                                                           |

**Shared-dependency observations (cross-Track ratification leverage):**

- **SI-008 spans Track 2 + Track 3** — highest cross-Track leverage SI; one MEDIUM-severity ratification unblocks both Mode 2 scaffolding AND Forms-Intake SI-011d gate
- **SI-010 spans Tracks 1 + 3** via downstream SECURITY DEFINER procedure IMPLs (SI-005 + SI-011); not a ratification dependency for either, but an IMPL-readiness gate per Implementation State Audit §1 SI-010 row
- **SI-002 + SI-003 span Tracks 1 + 2 + 3** as audit/domain-event canonicalization underlying every emitter — purely additive; no ratification-order constraint on either

---

## 3. Phase A critical path

Per Master Completion Plan v1.0 §"NO PARALLELIZATION YET" rule, Tracks 1 + 3 cannot fan out until Phase A's batched ratification ceremony closes. **Track 2 has a Plan-explicit Buildable-now carveout for Mode 1 chat handler wire-up** (Plan §"Status pointer" item 4) — that work was already underway pre-Plan and shipped as the current 21-test-case surface per Implementation State Audit §1. SI-013 + SI-014 gate the FUTURE Telecheck-Ghana patient-localization upgrade, NOT the Plan's Track 2 Buildable-now scope. Track 4 + Track 5 already fan out today.

**Plan §"Phase A scope" (authored 2026-05-15):** 4 deliverables — (1) authContextPlugin wiring for SI-010, (2) Identity slice routes, (3) Tenant-Config CCR resolver completion, (4) ratifier ceremony for **7 pending SIs** (SI-003/004/005/008/009/010/011) + CDM §4 MarketingCopy + FORMS_ENGINE §I-030 detection rules.

**Post-Plan refinement (this doc + Implementation State Audit 2026-05-17 + Ratifier Ceremony Agenda Patch 2026-05-17):** the ratifier ceremony scope expanded to **12 OPEN SIs** because 5 more SIs surfaced since the Plan was authored (SI-002 + SI-007 rediscovered as OPEN per cross-doc-drift audit; SI-012 + SI-013 + SI-014 filed during the autonomous run 2026-05-16). **The Plan should be patched in a future cycle to reflect the 12-SI scope** (see §5 Plan-patch recommendation below). Pending that patch, this doc treats the 12-SI / 8-sub-ceremony model as a POST-PLAN refinement, not a Plan mandate — a Track lead working from the Plan directly will see 7 SIs; a Track lead working from this doc + the Ratifier Ceremony Agenda will see 12.

**Phase A ratification deliverables (Track 6 ceremony, post-Plan scope):** all 12 OPEN SIs + CDM §4 MarketingCopy + FORMS_ENGINE §I-030 detection rules. (Plan-original scope was 7 SIs + the same 2 non-SI ratifications; SI-002 + SI-007 + SI-012 + SI-013 + SI-014 are the 5 post-Plan additions.)

**Critical-path sequencing within the ceremony** (per Ratifier Ceremony Agenda §3 sub-ceremony order):

1. **Sub-ceremony 1 (Cluster E: SI-012 + SI-007)** — unblocks Track 1's Med-Interaction + Pharmacy refill/dispense/shipment surfaces. Highest LOC-leverage at ~2800-4200 LOC unlocked. Recommend FIRST.
2. **Sub-ceremony 2 (SI-010)** — unblocks SI-005/008/011 SECURITY DEFINER procedure IMPLs across Tracks 1 + 3. Largest downstream-IMPL surface among MEDIUMs.
3. **Sub-ceremony 3 (Placeholder-namespace sibling pair: SI-002 + SI-003)** — unblocks Track 1/2/3 audit + domain-event canonicalization. Smallest single decision; can run in parallel with 1 or 2 if signatories differ.
4. **Sub-ceremony 4 (Cluster B: SI-008 + SI-009 + SI-005, HARD order)** — unblocks Track 1's Async-Consult Sprint 10 + Track 2's Mode 2 scaffolding (via SI-008 cross-Track shared dependency) + Track 3's SI-011d IMPL-readiness (via SI-008 cross-Track shared dependency).
5. **Sub-ceremony 5 (SI-004)** — unblocks Track 1's Async-Consult Sprint 9 audit emission canonicalization. Pairs naturally with Cluster B.
6. **Sub-ceremony 6 (SI-011 + IMPL-readiness gate scoping decision)** — unblocks Track 3's Forms-Intake publish-gate IMPL. Chair decides MarketingCopy CDM + I-030 in-scope or sibling SIs.
7. **Sub-ceremony 7 (Cluster D: SI-013 + SI-014)** — unblocks Track 2's Mode 1 patient surface (Telecheck-Ghana). Largest single ratifier-time block at 120-180 min; SI-014 requires new ADR-030.
8. **Sub-ceremony 8 (P-022 Promotion Ledger entry)** — ceremony close.

**Total Phase A budget:** 8-12 hours of ratifier time (Implementation State Audit 2026-05-17 §5).

**Track-by-Track Phase-A-completion unblocking** (assuming Phase A closes all 8 sub-ceremonies in one cycle):

- **Track 1 advanceable post-Phase-A:** ~3200-4800 LOC across Async-Consult + Pharmacy refill/dispense/shipment + Med-Interaction
- **Track 2 advanceable post-Phase-A:** ~500-950 LOC across Mode 1 patient-surface **localization upgrade** (the FUTURE Telecheck-Ghana scope, NOT the Plan's Buildable-now current surface which already shipped) + Mode 2 scaffolding (or 20 LOC under Option D defer + Mode 2 scaffolding only). **Plan's Buildable-now Track 2 scope is already advanced — NOT part of "post-Phase-A" LOC accounting.**
- **Track 3 advanceable post-Phase-A:** ~600-1000 LOC of Forms-Intake publish-gate IMPL + production-deploy gate replacement
- **Track 4 already advanceable** today (no SI dependency)
- **Track 5 already advanceable** today (no SI dependency)
- **Track 6 transitions from "Phase A ceremony" to "continuous ratification" mode** (Plan §Track-6 "continuous" deliverable)

**Aggregate post-Phase-A IMPL surface:** ~4300-6750 LOC across Tracks 1 + 2 + 3, plus Track 4 + Track 5 work that is already underway. Matches Implementation State Audit 2026-05-17 §2 "~4800-7700 LOC across 5 modules" within rounding (audit counts module-LOC; this doc counts Track-LOC; the same modules show up in different per-Track aggregations).

---

## 4. Per-sub-ceremony IMPL-surface-readiness matrix

**IMPORTANT distinction (Codex R1 M1 closure 2026-05-17):** this matrix shows which **IMPL surfaces become RATIFICATION-READY** per sub-ceremony — it does NOT show which Tracks may fan out. **Per Master Completion Plan v1.0 §"NO PARALLELIZATION YET" rule, Tracks 1-3 cannot fan out until the FULL Phase A ceremony closes (all 8 sub-ceremonies complete + P-022 entry).** A previous version of this matrix used the phrase "Track X unblocks" per row, which contradicted the no-fan-out rule and could mislead a Track lead into premature implementation work before Phase A close.

The two concepts are different:

- **IMPL-surface ratification readiness** (this matrix): per the Codex R3 H1 closure on PR #168's Implementation State Audit, individual IMPL surfaces (Async-Consult Sprint 10 handlers, Pharmacy refill/dispense/shipment, Med-Interaction slice, etc.) become spec-ratified for impl when their gating SI(s) ratify. The spec contract for that surface is now stable; a future impl PR can land against it without forcing deferred-FK placeholder semantics.
- **Track fan-out authorization** (Plan §Track-1/2/3 NOT-YET-PARALLELIZED rule): per the Plan, the FULL Phase A ceremony must close before ANY of Tracks 1-3 begin parallel implementation. This is a discipline rule to prevent shared-audit/shared-domain-event ratifications (Sub 3 + Sub 5) from landing AFTER IMPL work that emits those events has already shipped — which would force backfill against an unratified canonical surface.

Tracks 4 + 5 are NOT subject to the Phase A no-fan-out rule (they have no SI dependency per §1 + §3).

| Sub-ceremonies ratified                                                                                    | IMPL surfaces NOW ratification-ready (Tracks 1-3 fan-out still gated on FULL Phase A close)                                                                                                                                                                      | Track 4 fan-out                                                                                    | Track 5 fan-out                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| (none — pre-ceremony)                                                                                      | none. Pharmacy MedicationRequest/prescribe surface already ratification-ready post-SI-001 P-011 (per Implementation State Audit §1 — already SUBSTANTIAL); Mode 1 chat handler 21-test surface already ratification-ready for clinician-test access              | Fan out (mocks)                                                                                    | Fan out (infra cycle)                                                             |
| Sub 1 (Cluster E: SI-012 + SI-007)                                                                         | + Med-Interaction slice (~2000-3000 LOC) + Pharmacy refill/dispense/shipment (~800-1200 LOC) become ratification-ready                                                                                                                                           | (no change)                                                                                        | (no change)                                                                       |
| Sub 1 + Sub 2 (SI-010)                                                                                     | + SI-005/008/011 SECURITY DEFINER procedures gain their IMPL-readiness foundation (these procedures' IMPLs additionally gate on SI-005/008/011 ratifying in Sub 4 + Sub 6)                                                                                       | (no change)                                                                                        | (no change)                                                                       |
| Sub 1 + Sub 4 (Cluster B: SI-008+009+005)                                                                  | + Async-Consult Sprint 10 handlers (~400-600 LOC) + Mode 2 case-prep scaffolding (~200-300 LOC) become ratification-ready. **SI-008 cross-Track shared dependency** also lifts SI-011d's IMPL-readiness gate (Forms-Intake L2 Mode 2 input contract conformance) | (no change)                                                                                        | (no change)                                                                       |
| Sub 1 + Sub 4 + Sub 6 (SI-011 + IMPL-readiness gate chair decision)                                        | + Forms-Intake publish-gate IMPL surface (~600-1000 LOC) becomes ratification-ready (assuming SI-010 + MarketingCopy CDM + I-030 detection rules also ratified per Sub 6 chair option (a) in-scope OR (b) sibling SIs schedule)                                  | (no change)                                                                                        | (no change)                                                                       |
| Sub 1 + Sub 4 + Sub 6 + Sub 7 under SI-014 **Closure path A** (Options A/B/C ship classifier)              | + Mode 1 patient surface for Telecheck-Ghana (~150-650 LOC across crisis sentinel + classifier upgrade) becomes ratification-ready                                                                                                                               | (no change)                                                                                        | (no change)                                                                       |
| Sub 1 + Sub 4 + Sub 6 + Sub 7 under SI-014 **Closure path B** (Option D defers — SI-014 stays open per §5) | + Mode 1 patient-access gate IMPL (~20 LOC) becomes ratification-ready. Mode 1 patient surface itself does NOT become ratification-ready — SI-014 stays open; successor SI-014.1 required for full Mode 1 patient surface                                        | (no change)                                                                                        | (no change)                                                                       |
| **ALL 8 sub-ceremonies + P-022 entry**                                                                     | **Phase A CLOSED.** Tracks 1-3 fan-out authorization granted per Plan §Phase-B transition. All ratification-ready IMPL surfaces above can now have IMPL PRs land. **Tracks 1-3 transition from Phase A blocked to Phase B parallel-execution.**                  | (continues — Phase B fan-out unchanged; mobile work continues against finalized OpenAPI contracts) | (continues — Phase B fan-out unchanged; infra continues to operate ahead of code) |

**Note on Sub 3 + Sub 5 placement:** sub-ceremonies 3 (SI-002 + SI-003 placeholder-namespace sibling pair) + 5 (SI-004) do not appear in the matrix's per-row delta column above because they ratify placeholder-namespace canonicalizations that are PURELY ADDITIVE to existing audit/domain-event emissions. They do NOT unlock new IMPL surfaces. **But they DO need to close in Phase A** — without them, the Phase A ceremony has not fully closed, and Tracks 1-3 fan-out authorization is NOT granted. This is exactly why the Plan's "NO PARALLELIZATION YET" rule exists: even sub-ceremonies that don't unlock new IMPL surfaces gate the discipline boundary between Phase A and Phase B.

**Pattern reinforcement (extends Addendum 29 + Addendum 32 constraint-gradation pattern):** the matrix's two concepts (IMPL-surface ratification readiness vs Track fan-out authorization) are DIFFERENT constraint classes. Collapsing them into a single "Track unblocks" framing — as the previous version of this matrix did — is the same regression class Addendum 29 documented for HARD/IMPLEMENTATION-readiness/RECOMMENDED constraint gradations. Pattern: when a matrix has rows that describe ratification state, the column semantics must distinguish "spec contract is now ratification-ready for this IMPL surface" from "Track may begin parallel implementation work" — these are independent gating axes.

---

## 5. Recommended Plan patch (cross-doc-drift surfacing)

Per Codex R2 H1 closure 2026-05-17, this doc's analysis surfaced **two source-of-truth drifts** between Master Completion Plan v1.0 (authored 2026-05-15) and the current ratifier-queue state (post the 2026-05-16/17 autonomous-run SI filings + cross-doc audit). These drifts should be patched in a future Plan revision; pending that, this doc treats them as documented-and-flagged rather than silently overriding the Plan.

**Drift 1 — Phase A ratifier scope count: 7 SIs (Plan) vs 12 SIs (current state):** Plan §"Phase A scope" item 4 lists 7 pending SIs (SI-003/004/005/008/009/010/011). Five more SIs have been filed or surfaced since:

- **SI-002** (rediscovered as OPEN per Implementation State Audit 2026-05-17 cross-doc-drift surfacing — Plan was authored before the audit caught the stale "SI-002 closed earlier" framing in the previous Ratifier Ceremony Agenda; SI-002 source file still says OPEN v0.5 DRAFT target P-014)
- **SI-007** (rediscovered as OPEN — same surfacing; SI-007 source file says OPEN v0.19 DRAFT target P-013)
- **SI-012** (filed during autonomous run 2026-05-16; Med Interaction Engine CDM expansion; pilot-launch blocker per the Plan's own §Track-1 "Med-Interaction first" critical-path positioning)
- **SI-013** (filed 2026-05-16; CCR crisis-helpline keys; Mode 1 chat patient-localization upgrade scope)
- **SI-014** (filed 2026-05-16; Crisis-detection clinical-grade NLP classifier upgrade; Mode 1 chat patient-localization upgrade scope; requires new ADR-030)

**Recommended Plan patch (Drift 1):** update Plan §"Phase A scope" item 4 + §"Status pointer" item 1 to reflect the 12-SI scope. The 4 Plan structural deliverables (authContext wiring + Identity slice + CCR resolver + ratifier ceremony) remain unchanged; only the ratifier ceremony's SI inventory expands.

**Drift 2 — Track 2 ratifier-blocking framing:** Plan §"Status pointer" item 4 says Track 2 Mode 1 chat handler wire-up is "Buildable now without ratification gates." This was accurate at Plan-authoring time (2026-05-15) and remains accurate for the **CURRENT** Mode 1 chat handler surface — that work shipped as the 21-test-case surface per Implementation State Audit §1 IN-PROGRESS classification. However, SI-013 + SI-014 (both filed 2026-05-16) gate a FUTURE patient-localization upgrade of Mode 1 that the Plan doesn't separately enumerate.

**Recommended Plan patch (Drift 2):** add a Plan §Track-2 sub-bullet distinguishing "Mode 1 chat handler wire-up — Buildable now (per current §Status-pointer item 4)" from "Mode 1 patient-localization upgrade for Telecheck-Ghana — ratifier-gated on SI-013 + SI-014 (post-Plan SIs)." This preserves the original Plan's accurate framing of the buildable-now scope while documenting the post-Plan SI gates on the future upgrade.

**This Plan patch is documentary work, not ratifier-ceremony work.** It can land independently of the Phase A ratifier ceremony. Estimated effort: 1 small PR against the spec-corpus repo (`arthurmenson/telecheckONE`); ~20 LOC of Plan edits + a Plan revision-history bump.

**Scoping note:** this doc cannot unilaterally patch the Plan — the Plan is a spec-corpus artifact requiring ratifier sign-off per Promotion Ledger discipline. This §5 surfaces the drift + recommends the patch path; actual Plan editing happens via a separate PR cycle with appropriate ratifier sign-off.

---

## 6. What this doc is NOT

- **Not a re-derivation of `Telecheck_Master_Completion_Plan_v1_0.md`**: the Plan remains the authoritative source for Track structure, team sizes, deliverable lists, and timeline. This doc is a SI → Track cross-reference, not a re-statement of the Plan.
- **Not a binding sprint plan**: the LOC estimates per Track in §1 + §4 are bounded-volume estimates for sequencing visibility, not Sprint commitments. Actual Sprint planning happens at Sprint kickoff per `docs/SCRUM_OPERATING_MODEL.md`.
- **Not a recommendation on SI-014's Option A/B/C/D**: see SI-014's own §3 ratifier-decision options and the Ratifier Ceremony Agenda §4 SI-014 judgment dimensions. Classifier choice is a CRITICAL clinical-safety judgment per the autonomous-work STOP conditions; this doc preserves that neutrality. The §4 matrix splits Closure path A vs B effects on Track 2 readiness without recommending either.
- **Not a Promotion Ledger entry**: this is a navigation doc. The ceremony itself produces P-022, an append-only entry recording the ratified decisions. This doc helps plan ceremony-Track-impact awareness; the ledger entry records what was decided.
- **Not a replacement for the Implementation State Audit + Ratifier Ceremony Agenda**: those two docs answer "what implementation state does each ratification unlock?" and "what ceremonies in what order?" respectively. This doc answers "which Tracks does each ratification feed into?" — a different question that complements without replacing.
- **Not exhaustive on Track dependencies beyond OPEN SIs**: each Track also has dependencies on Phase A platform-foundation work (Identity, Tenant-Config CCR) that this doc treats as already-ratified per their CLOSED SI status (SI-001 P-011 for Pharmacy MedicationRequest; SI-006 RESOLVED for Idempotency; earlier closed SIs for Identity + Consent + Tenant-Config slices).

---

## 7. Cross-references

- Master Completion Plan v1.0 (authoritative Track structure): `Telecheck_Master_Completion_Plan_v1_0.md` (spec corpus, sibling repo at `arthurmenson/telecheckONE`)
- Ratifier Ceremony Agenda Q2 2026 (authoritative sub-ceremony order): `docs/Ratifier-Ceremony-Agenda-Q2-2026.md` (post 2026-05-17 patch per PR #169)
- Implementation State Audit 2026-05-17 (authoritative per-module + per-SI LOC-leverage analysis): `docs/Implementation-State-Audit-2026-05-17.md`
- Per-SI texts (authoritative per-SI content): `docs/SI-<NNN>-*.md`
- Audit-failure injection harness (test infrastructure for SI-013 / SI-014 downstream impl): `tests/helpers/audit-failure-injection.ts` + `tests/helpers/mode-1-chat-audit-injection.ts` + `tests/helpers/audit-placeholder-injection.ts`
- Parallel-injection integration test (HTTP-boundary proof of closure-per-instance isolation): `tests/integration/audit-failure-injection-parallel.test.ts`
- Cycle Addendum trail (cross-session continuity for the autonomous run that filed these SIs + authored these navigation artifacts): `Telecheck_v1_10_PRD_Update/AI_Service_Rollout_24h_Status_2026-05-14.md` Addenda 21–32

---

— Claude (Opus 4.7, 1M context), 2026-05-17 autonomous run; Addendum 32 next-entry-point identification
