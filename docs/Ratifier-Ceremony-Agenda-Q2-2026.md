# Ratifier Ceremony Agenda — Q2 2026 (10 pending SIs)

**Authored:** 2026-05-16 (Claude autonomous run; Addendum 28 next-entry-point identification)
**Audience:** Evans (workstream lead + spec-corpus ratifier) + Engineering Lead + CDM v1.2 owner + Contracts Pack v5.2 owners (AUDIT_EVENTS, DOMAIN_EVENTS, CCR_RUNTIME, FORMS_ENGINE, INVARIANTS) + Platform Clinical Governance + Platform AI Safety + Platform Privacy Officer
**Purpose:** Single decision-matrix doc for the Q2 2026 ratification ceremony. Surfaces the 10 pending Spec Issues filed during the autonomous run, their cross-SI dependencies, recommended ratification order (dependency-aware), and per-SI judgment dimensions so the ratifier ceremony agenda can be planned and chaired without re-deriving the dependency graph from each SI's full text.
**Status:** Reference doc, not normative. The authoritative SI texts at `docs/SI-<NNN>-*.md` remain the source of truth for any ratification decision. This doc is purely a navigation + dependency map.

---

## TL;DR

- **10 pending SIs** sit in the ratifier queue (target Promotion Ledger entry P-022). Filed during the post-v1.10 autonomous build run.
- **3 are Track 1 / pilot-launch blockers** (SI-011 HIGH, SI-012 HIGH, SI-014 HIGH). The rest are platform-infrastructure or contract-amendment SIs that block Sprint resume on already-started slices.
- **Dependency depth is 3 levels**: SI-010 → SI-005/SI-008/SI-009/SI-011 → SI-012/SI-013/SI-014 are roughly independent of the dependency chain. Two SIs are tightly paired (SI-013 + SI-014 share the `runCrisisGate` callsite).
- **Recommended ratification order** (8 ceremonies of varying weight; estimated 4-6 hours total ratifier time if batched well; see §3 for details). The order is NOT a strict sequence — several SIs can be batched in parallel sub-ceremonies; the only hard sequencing constraints are the deferred-FK chain (SI-008+SI-009 must ratify before SI-005; SI-010 must ratify before SI-011's L3 dual-control plumbing can land).

---

## 1. SI inventory at a glance

The full SI texts are at `docs/SI-<NNN>-*.md`. This table is the one-screen overview — see each SI for the full Resolution path, regression-test obligations, and ratifier-judgment dimensions.

| #          | Title (file)                                           | Severity | Target spec doc(s)                                                                                                                          | New ADR?                                                                    | Net new audit events / CCR keys / entities                                                                                                        | Parallel / depends-on                                                    |
| ---------- | ------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **SI-003** | DOMAIN_EVENTS v5.2 placeholder event-type strings      | MEDIUM   | DOMAIN_EVENTS v5.2                                                                                                                          | no                                                                          | event-type strings ratified (no new fields; placeholder strings become canonical)                                                                 | independent (SI-002 closed earlier)                                      |
| **SI-004** | Async Consult audit events ratification                | MEDIUM   | AUDIT_EVENTS v5.2                                                                                                                           | no                                                                          | 11 audit action IDs ratify under the canonical Category C surface                                                                                 | independent of other open SIs                                            |
| **SI-005** | Consult / ConsultEvent CDM schema gap                  | MEDIUM   | CDM v1.2 §4                                                                                                                                 | no                                                                          | 2 entity row-shape ratifications (Consult + ConsultEvent)                                                                                         | depends on SI-008 (FK 6) + SI-009 (FK 7)                                 |
| **SI-008** | AiWorkflowExecution CDM schema gap                     | MEDIUM   | CDM v1.2 §4                                                                                                                                 | no                                                                          | 1 entity row-shape ratification (AiWorkflowExecution)                                                                                             | parallel to SI-005, SI-009                                               |
| **SI-009** | SyncSession CDM schema gap                             | MEDIUM   | CDM v1.2 §4                                                                                                                                 | no                                                                          | 1 entity row-shape ratification (SyncSession)                                                                                                     | parallel to SI-005, SI-008                                               |
| **SI-010** | Session Actor Context DB Binding (F-3 successor)       | MEDIUM   | Identity Spec v1.0 §new OR new Identity-RBAC slice expansion                                                                                | possibly (Identity slice expansion)                                         | DB infrastructure (`current_actor_id()`, `current_actor_role()` helpers) — no new audit events                                                    | **prerequisite** for SI-005/008/009/011 SECURITY DEFINER procedure impls |
| **SI-011** | Forms-Intake publish-time governance gates             | HIGH     | Forms-Intake Slice PRD v2.1 + FORMS_ENGINE v5.2 + INVARIANTS (I-013, I-015, I-030)                                                          | no                                                                          | 4 audit events for the 4 publish gates                                                                                                            | depends on SI-010 + SI-008                                               |
| **SI-012** | Med Interaction Engine CDM expansion                   | HIGH     | CDM v1.2 §4 + Interaction Engine Slice PRD v1.0                                                                                             | no                                                                          | 3 entity row-shape ratifications (InteractionSignal + InteractionOverride + InteractionRuleset)                                                   | independent — **Track 1 pilot blocker**                                  |
| **SI-013** | CCR crisis-helpline key ratification                   | MEDIUM   | CCR_RUNTIME v5.2 + AUDIT_EVENTS v5.2 + AI Clinical Assistant Slice PRD v1.0 §6.2                                                            | no                                                                          | 3 CCR keys (helpline_e164, helpline_label, emergency_number) + 1 new Cat B audit (`crisis.escalation_destination_resolved`)                       | paired with SI-014 (shared callsite — ratify together)                   |
| **SI-014** | Crisis-detection clinical-grade NLP classifier upgrade | HIGH     | Master PRD v1.10 §16 + AI Clinical Assistant Slice PRD v1.0 §6 + AI_LAYERING v5.2 §6 + INVARIANTS I-019/I-022 + WORKLOAD_TAXONOMY v5.2 §2.1 | **YES — ADR-030** (one of four postures: Claude / on-prem / hybrid / defer) | 2 audit-surface amendments (Cat A `crisis_detection_trigger` extended; NEW Cat B `crisis.classifier_invocation`) + (option-conditional) I-022 row | paired with SI-013 (shared callsite)                                     |

**Severity distribution:** 3 HIGH (SI-011, SI-012, SI-014) + 7 MEDIUM. The three HIGHs are pilot-launch blockers; the seven MEDIUMs are platform-correctness blockers for already-started slices that have shipped with TODO-deferred or placeholder gates.

---

## 2. Dependency clusters

The 10 SIs decompose into **5 clusters** based on inter-SI dependencies. Within a cluster, the SIs must be ratified together or in a fixed order; across clusters they are independent.

### Cluster A — Independent platform infrastructure (3 SIs)

- **SI-003** DOMAIN_EVENTS placeholders — purely a string-namespace ratification; no entity / audit / CCR changes
- **SI-004** Async Consult audit events — 11 Category C events under the canonical envelope (already-published shape)
- **SI-010** Session Actor Context DB Binding — Identity Spec extension OR new Identity-RBAC slice; introduces `current_actor_*()` DB helpers

These three are NOT inter-dependent on each other. They can be ratified in any order and in any combination of sub-ceremonies. **SI-010 has the largest downstream impact** — it unblocks SI-005/008/009/011's SECURITY DEFINER procedure impls — so ratifying it first reduces work-in-flight elsewhere.

### Cluster B — Async Consult schema family (3 SIs, fixed order)

- **SI-008** AiWorkflowExecution — leaf
- **SI-009** SyncSession — leaf
- **SI-005** Consult / ConsultEvent — depends on SI-008 (FK 6: `ai_workflow_execution_id`) AND SI-009 (FK 7: `escalation_target_sync_session_id`)

**Ratification order constraint:** SI-008 + SI-009 must ratify BEFORE SI-005 because SI-005's row shape names the FKs that point at SI-008/009 row shapes. The two leaf SIs (008, 009) can ratify in parallel; SI-005 follows.

Strictly speaking SI-005 could ratify with "DEFERRED FK to-be-added-when-SI-008/009-ratify" placeholder semantics — that's what the SIs currently document. But the cleanest closure is to batch all three in the same sub-ceremony so the FKs land immediately and SI-005's impl can use the final FK shapes from day one.

### Cluster C — Forms-Intake governance (1 SI with 2 prerequisites)

- **SI-011** Forms-Intake publish-time governance gates — depends on SI-010 (`current_actor_role()` for L3 dual-control) AND SI-008 (Mode 2 contract ratification for FX validation in L3)

**Ratification order constraint:** SI-010 + SI-008 must ratify BEFORE SI-011's impl can land. SI-011 itself can ratify independently (its 4 audit events + the FORMS_ENGINE amendment don't require the prerequisites to be ratified first), but its impl needs the prereqs. If the ceremony chair wants to batch all three together, that's cleanest; if SI-010 + SI-008 ratify in earlier sub-ceremonies, SI-011 can ratify whenever.

### Cluster D — Mode 1 chat crisis surface (2 SIs, paired)

- **SI-013** CCR crisis-helpline keys
- **SI-014** Crisis-detection NLP classifier upgrade

**Ratification order constraint:** Per SI-014's own header — these two SIs touch the same `runCrisisGate` callsite in `src/modules/ai-service/internal/handlers/chat.ts`. Ratifying them together avoids a second re-test cycle on the crisis-bypass branch. They CAN ratify independently (neither references the other's ratified artifacts), but the engineering cost-of-impl is lower when batched.

**Special note:** SI-014 is the only SI in the queue that requires a NEW ADR (ADR-030). The classifier-choice decision (Option A/B/C/D) is the CRITICAL clinical-safety + regulatory + cost judgment that distinguishes this from the other SIs — see §4 for the ratifier-evaluation framework.

### Cluster E — Pilot-launch standalone blocker (1 SI)

- **SI-012** Med Interaction Engine CDM expansion — independent of all other SIs

**No dependency constraints.** Can ratify in any sub-ceremony. SI-012 is the highest-leverage independent ratification because the Med Interaction Engine is the only SKELETON slice among pilot-required slices per the 2026-05-15 Implementation State Audit, and the platform-floor "interaction engine runs BEFORE clinician commits prescription" rule (Master PRD v1.10 §7) cannot be enforced without it. Recommend ratifying EARLY in the ceremony to unblock Track 1 implementation.

---

## 3. Recommended ratification order

The 10 SIs decompose into **8 logical sub-ceremonies**. The order below is dependency-aware (no SI ratifies before its prerequisites) and pilot-impact-weighted (HIGH-severity SIs early). Each sub-ceremony has an estimated ratifier time + the minimum-quorum signatories needed.

| Order | Sub-ceremony                     | SIs                             | Quorum                                                                                                                                    | Est. ratifier time | Rationale                                                                                                                                                                                                                                                                                                             |
| ----- | -------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **SI-012 ratification**          | SI-012                          | Evans + Engineering Lead + CDM v1.2 owner                                                                                                 | 30-45 min          | Unblocks Track 1 (Med Interaction Engine) immediately. Smallest decision (3 entity row shapes; no new ADR; no new audit events). Highest impact on pilot launch timeline.                                                                                                                                             |
| 2     | **SI-010 ratification**          | SI-010                          | Evans + Engineering Lead + Identity Spec owner + Platform Privacy Officer                                                                 | 60-90 min          | Unblocks SI-005/008/009/011's SECURITY DEFINER procedure impls. Largest downstream impact among the medium-severity SIs. Identity-RBAC slice expansion decision is non-trivial — needs Privacy Officer alignment on the actor-identity DB-side derivation.                                                            |
| 3     | **SI-003 ratification**          | SI-003                          | Evans + Engineering Lead + DOMAIN_EVENTS owner                                                                                            | 20-30 min          | Independent; smallest decision in the queue; closes a long-standing placeholder gap. Can run in parallel with 1 or 2 if separate signatories.                                                                                                                                                                         |
| 4     | **Cluster B batch**              | SI-008 + SI-009 + SI-005        | Evans + Engineering Lead + CDM v1.2 owner                                                                                                 | 60-90 min          | The Async Consult schema family ratifies together as a 3-entity decision (AiWorkflowExecution + SyncSession + Consult/ConsultEvent with FK 6 + 7 wired). The FK-shape decisions are tightly coupled — ratifying separately would force placeholder-FK semantics that just delay closure.                              |
| 5     | **SI-004 ratification**          | SI-004                          | Evans + Engineering Lead + AUDIT_EVENTS v5.2 owner                                                                                        | 30-45 min          | The 11 Async Consult audit action IDs ratify under the canonical Category C envelope. Independent of Cluster B's CDM work, but pairs naturally with the Async Consult slice resume so the Sprint 9 work has both schema + audit on the same day.                                                                      |
| 6     | **SI-011 ratification**          | SI-011                          | Evans + Engineering Lead + FORMS_ENGINE v5.2 owner + Platform Privacy Officer + Platform Clinical Governance                              | 60-90 min          | Forms publish-time governance gates touch four contracts (FORMS_ENGINE + INVARIANTS I-013, I-015, I-030 + Forms Slice PRD v2.1). Needs cross-discipline alignment. The HIGH severity reflects that the current sentinel-gated bypass is a production-deploy blocker.                                                  |
| 7     | **Cluster D batch**              | SI-013 + SI-014                 | Evans + Engineering Lead + Contracts Pack v5.2 CCR_RUNTIME owner + AUDIT_EVENTS owner + Platform Clinical Governance + Platform AI Safety | **120-180 min**    | The largest sub-ceremony by ratifier-time. SI-014 alone requires a new ADR (ADR-030) with four options demanding clinical + regulatory + cost evaluation — see §4 for the dimensional framework. SI-013's CCR keys + new Cat B audit are smaller but paired with SI-014 to avoid double re-test on the same callsite. |
| 8     | **Promotion Ledger entry P-022** | n/a — ceremony-closing artifact | Evans + Engineering Lead                                                                                                                  | 15-20 min          | Single ledger entry recording all ratification decisions from the ceremony. Append-only per the Promotion Ledger discipline.                                                                                                                                                                                          |

**Total estimated ratifier time:** 5-9 hours across all 8 sub-ceremonies. Realistic to batch into 2-3 calendar days if the signatories' availability aligns; can stretch across 1-2 weeks if signatories are part-time on this.

**Parallel scheduling possibilities:**

- Sub-ceremonies 1 + 2 + 3 can run in parallel (different signatories; no inter-dependencies)
- Sub-ceremony 4 (Cluster B) blocks behind 1+2+3 only in the sense that the Promotion Ledger entry order should reflect dependency order — the ratification meetings themselves are independent
- Sub-ceremony 5 (SI-004) can run alongside 4 if AUDIT_EVENTS owner is separate from CDM v1.2 owner
- Sub-ceremony 6 (SI-011) blocks behind 2 + 4 conceptually but the ratification meeting can run in parallel with 7
- Sub-ceremony 7 (Cluster D) is the largest single block — recommend dedicating an uninterrupted afternoon

---

## 4. Per-SI ratifier-judgment dimensions

For each SI, the ratifier brings a specific set of judgment-dimensions. This section enumerates them so the ceremony chair can pre-stage the right signatories and pre-read the right context per SI.

### SI-003 (DOMAIN_EVENTS placeholders) — judgment dimensions

- **Naming convention adherence**: do the proposed event-type strings match the v5.2 envelope naming pattern? (Engineering Lead)
- **Privacy / PII bleed**: do any event-type strings encode tenant-specific or PHI-shape information that would leak across outbox subscribers? (Privacy Officer)
- **Forward-compat**: are the strings future-proof against the same event shape extending into new domains? (DOMAIN_EVENTS owner)

### SI-004 (Async Consult audit events) — judgment dimensions

- **Category-C envelope conformance**: do all 11 events fit Category C operational semantics (not Cat A safety-floor, not Cat B governance/follow-up)? (AUDIT_EVENTS owner)
- **Detail-field minimization**: does each event's detail field omit raw PHI per I-027 + audit-policy? (Privacy Officer + Engineering Lead)
- **Action-ID stability**: are the 11 action IDs stable identifiers downstream consumers can pin to? (Engineering Lead)

### SI-005 (Consult/ConsultEvent CDM) — judgment dimensions

- **Row-shape minimality**: are the proposed columns the minimum needed by the slice PRD? (CDM v1.2 owner)
- **FK 6 / FK 7 deferred resolution**: confirm SI-008 + SI-009 will ratify in the same ceremony so the FKs land at the same time (CDM owner)
- **State-machine row mapping**: do the row shapes support the State Machines v1.1 transitions for ConsultEvent? (Engineering Lead + CDM owner)

### SI-008 (AiWorkflowExecution CDM) — judgment dimensions

- **Mode 2 contract alignment**: does the row shape support the protocol-execution audit chain per ADR-002 + ADR-029? (Engineering Lead)
- **AI-workload taxonomy fields**: does the row carry `ai_workload_type` per WORKLOAD_TAXONOMY v5.2? (CDM owner)
- **Composite-FK semantics**: how does the row participate in the deferred-FK pattern with SI-005? (CDM owner)

### SI-009 (SyncSession CDM) — judgment dimensions

- **ADR-021 / LiveKit binding**: does the row shape correctly bind to the sync-video infrastructure decision? (Engineering Lead)
- **Async→sync conversion**: does the row support the ADR-012 async-to-sync conversion path with SI-005's `escalation_target_sync_session_id` FK? (CDM owner)
- **Session-lifecycle audit**: do the lifecycle transitions emit the right Cat C events? (AUDIT_EVENTS owner)

### SI-010 (Session Actor Context DB Binding) — judgment dimensions

- **Identity slice scope**: is this an extension to the existing Identity Spec v1.0 or a new Identity-RBAC slice? (Identity Spec owner + Engineering Lead)
- **Privacy posture**: does server-derived actor identity (vs caller-supplied) materially tighten the PHI access surface? (Privacy Officer — high engagement)
- **SECURITY DEFINER ergonomics**: does the DB-helper API match what SI-005/008/009/011 procedures need? (Engineering Lead)
- **Backward-compat**: do existing procedures continue to work, or is this a migration the spec MUST coordinate? (Identity Spec owner)

### SI-011 (Forms-Intake publish-time governance gates) — judgment dimensions

- **I-013 / I-015 / I-030 invariant interaction**: do the four publish gates correctly enforce each invariant without over- or under-enforcement? (FORMS_ENGINE owner + Engineering Lead)
- **L3 dual-control RBAC**: does the L3 gate's dual-actor requirement correctly bind to the RBAC matrix v1.1? (Engineering Lead + Privacy Officer)
- **L4 marketing copy governance**: does the L4 gate correctly route patient-facing marketing language through the marketing-copy review chain? (Clinical Governance)
- **Six-category I-030 static analysis**: are the six static-analysis categories the right set, and is the per-category fail-closed posture correct? (Engineering Lead + Clinical Governance)

### SI-012 (Med Interaction Engine CDM expansion) — judgment dimensions

- **Three entity row shapes**: are InteractionSignal + InteractionOverride + InteractionRuleset the right entity decomposition for the five check classes? (CDM v1.2 owner)
- **Pre-commit invariant enforcement**: does the row shape support the "interaction engine runs BEFORE clinician commits prescription" rule? (Engineering Lead)
- **Knowledge-base sourcing**: is the InteractionRuleset row shape compatible with the knowledge-base options the Slice PRD §9 enumerates? (CDM owner + Engineering Lead)

### SI-013 (CCR crisis-helpline keys) — judgment dimensions

- **3 CCR key shapes**: are the proposed key types (E.164 / display string / dialable string) correct? (CCR_RUNTIME owner)
- **Country-profile defaults**: which countries' defaults populate at ratification (US 988, Ghana Mental Health Helpline, etc.)? (Clinical Governance + ops team)
- **NEW Cat B audit event**: ratify `crisis.escalation_destination_resolved` action ID + 4-state `resolution_status` enum + fail-soft policy (AUDIT_EVENTS owner)
- **Surface integration semantics**: confirm the four Rules (gate-first, fail-soft CCR, typed resolvers, paired Cat B forensic audit) are correct (Engineering Lead + Clinical Governance)

### SI-014 (Crisis-detection clinical NLP classifier) — judgment dimensions [LARGEST]

This is the largest single judgment in the queue. See SI-014's own text for the full decision framework; high-level dimensions:

- **Option A/B/C/D selection** — the central judgment. Each option ratifies a different ADR-030 + a different downstream-impl scope (~150 LOC for A, ~400 for B, ~250 for C, ~20 for D)
- **Fail-closed posture** (under A/B/C) — which of Rule 2's three postures ratifies: (a)+(b) coverage-scoped split, or (c) uniform hard-fail
- **Multi-language coverage commitment** (Rule 6) — confirm Twi (or alternative non-EN language) is in-scope at first launch
- **PHI processing posture** (Rule 3) — the I-022 amendment row depends on the chosen option's deployment location (Anthropic API per existing BAA / AWS VPC per ADR-024 / hybrid both)
- **Latency floor** (Rule 4) — the chosen option's deployment posture must be sub-500ms P95
- **Two AUDIT_EVENTS surface amendments** (Rule 5) — Cat A `crisis_detection_trigger` extended with 4 provenance fields + NEW Cat B `crisis.classifier_invocation` always-emitted surface
- **Tier 1 vs Tier 2 test split** — confirm the deterministic-CI vs clinical-promotion-gate boundary
- **(If Option D)** Successor SI-014.1 filing + patient-Mode-1 access gate + governance-block-on-gate-removal — the three Closure path B conditions

**Quorum** for SI-014 is the largest in the queue: Evans + Engineering Lead + Platform Clinical Governance + Platform AI Safety + Privacy Officer (for the PHI posture decision) + CCR_RUNTIME owner (for the SI-013 paired ceremony) + AUDIT_EVENTS owner (for the two surface amendments).

---

## 5. What this doc is NOT

- **Not a Promotion Ledger entry**: this is a pre-ceremony briefing. The ceremony itself produces P-022, an append-only entry recording the ratified decisions. This doc helps plan the ceremony; the ledger entry records what was decided.
- **Not a re-derivation of the SI texts**: this doc summarizes the dependency graph + judgment dimensions. The authoritative content for any ratification decision is the SI's own text at `docs/SI-<NNN>-*.md`.
- **Not a recommendation for SI-014's classifier choice**: SI-014's four options are deliberately presented WITHOUT a recommendation (the classifier choice is a CRITICAL clinical-safety judgment per the autonomous-work STOP conditions). This briefing doc preserves that neutrality — it surfaces the dimensions to weigh, not which way to weigh them.
- **Not a forcing function for parallel ratification**: the recommended order in §3 is a maximally-efficient sequence given dependency constraints. The ceremony chair may choose to serialize sub-ceremonies, batch differently, or defer some SIs to a later cycle entirely. The dependency constraints (Cluster B order; SI-010 before SI-011 impl) are the only hard rules.

## 6. Cross-references

- All SI texts: `docs/SI-<NNN>-*.md`
- Promotion Ledger (where P-022 will be appended on ceremony close): `Telecheck_Promotion_Ledger.md` in the spec bundle
- Master Completion Plan v1.0 Phase B exit gate (which depends on SI-014 resolution per option-scoped semantics): `Telecheck_Master_Completion_Plan_v1_0.md`
- Implementation State Audit (which surfaced the Track 1 Med Interaction Engine SKELETON status driving SI-012's HIGH severity): 2026-05-15 audit (referenced in SI-012's "Why this matters" section)
- Cycle Addendum trail (cross-session continuity for the autonomous run that filed these SIs): `Telecheck_v1_10_PRD_Update/AI_Service_Rollout_24h_Status_2026-05-14.md` Addenda 21–28

---

— Claude (Opus 4.7, 1M context), 2026-05-16 autonomous run; Addendum 28 next-entry-point identification
