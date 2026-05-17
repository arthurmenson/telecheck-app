# Sibling-Doc Cross-Validation Audit — Round 3

**Date:** 2026-05-17 (Sprint 38, autonomous turn)
**Author:** Claude (Opus 4.7, 1M context), autonomous run under CLAUDE.md §"Autonomous-work authorization"
**Scope:** Extend the PR #168 + PR #172 sibling-doc cross-validation pattern to:
- `docs/AUTONOMOUS_TURN_SUMMARY_2026-05-05.md`
- `docs/AUTONOMOUS_TURN_SUMMARY_2026-05-08.md`
- `docs/AUTONOMOUS_TURN_SUMMARY_2026-05-11.md`
- `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` (r6 dated 2026-05-12)

**Method:** Grep-the-actual-code + read-the-actual-SI-source-files. The same precision discipline Codex applied across PRs #163 / #168 / #172 / #173 — `git`-tracked artifacts and the SI source files in `docs/SI-*.md` are the ground truth; any sibling-doc summary that disagrees with them is the artifact at fault.

**Disposition:** This audit is a **findings doc + recommended-patches table** only. Per the established R3-class pattern (PR #168 + PR #172), follow-on patch work is staged into a separate PR that touches the drifted artifacts in place. The drifted artifacts themselves are NOT edited in this PR.

---

## TL;DR

| Target doc | Lines | Drift severity | Drift count |
| --- | --- | --- | --- |
| `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` (r6 2026-05-12) | 224 | **HIGH** | 6 (3 HIGH + 3 MEDIUM) |
| `AUTONOMOUS_TURN_SUMMARY_2026-05-05.md` | 149 | LOW | 5 (all historical-record framing) |
| `AUTONOMOUS_TURN_SUMMARY_2026-05-08.md` | 114 | LOW | 4 (all historical-record framing) |
| `AUTONOMOUS_TURN_SUMMARY_2026-05-11.md` | 300 | LOW | 4 (all historical-record framing) |

**Total drift items: 19.**

**Largest drift surface: BUILD_VS_SPEC_TRACEABILITY_MATRIX.md r6 §3 + §4.** The matrix §4 OPEN-Spec-Issues table is **flat-out wrong** about the current SI inventory: it lists only SI-002 + SI-003 as OPEN when the SI source files show **12 SIs currently OPEN** (SI-002, SI-003, SI-004, SI-005, SI-007, SI-008, SI-009, SI-010, SI-011, SI-012, SI-013, SI-014). The §4 CLOSED table incorrectly lists **SI-004 + SI-005** as closed — both source files are clearly OPEN, with no `## Status: CLOSED` block, and explicit "When SI-XXX closes:" forward-looking resolution paths. §3 has clearly wrong SI citations for the Async Consult row (cites SI-006 as "Payment" and SI-007 as "AI Service" — both miscited).

The 3 AUTONOMOUS_TURN_SUMMARY docs are explicitly dated historical artifacts; their stale claims are LOW-severity but still worth flagging with the historical-vs-current banner pattern that PR #173 established for the Pharmacy + Forms-Intake STATUS docs (R4/R5 finding lineage).

---

## §1 — `BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` (r6 2026-05-12) — HIGH

This is the largest drift surface in the repo. The matrix's revision-history block at the top documents **r6 as the most-recent amendment (dated 2026-05-12)**. Between 2026-05-12 and 2026-05-17, the following events landed which the matrix has not absorbed:

1. **SI-007 filed** 2026-05-14 (refill / dispensing / shipment schema gap).
2. **SI-008 filed** 2026-05-15 (autonomous run; AiWorkflowExecutions schema gap).
3. **SI-009 filed** 2026-05-15 (autonomous run; SyncSessions schema gap).
4. **SI-010 filed** 2026-05-15 (autonomous run; Session actor-context DB binding).
5. **SI-011 filed** 2026-05-15 (autonomous run; Forms publish governance gates).
6. **SI-012 filed** 2026-05-16 (autonomous run; Med Interaction CDM expansion).
7. **SI-013 filed** 2026-05-16 (autonomous run; CCR crisis-helpline keys).
8. **SI-014 filed** 2026-05-16 (autonomous run; crisis-detection clinical NLP classifier).
9. **Pharmacy module substantially-implemented** (SI-001 ratification P-011 unblocked it; 12 routes registered in `src/modules/pharmacy/routes.ts`; full internal handler / repository / service / state-machine implementations grep-confirmed 2026-05-17 via PR #173 STATUS doc refresh).

The matrix's claims about the SI inventory + Pharmacy state pre-date all of this and are now factually incorrect.

### §1.1 — HIGH-1: §4 OPEN-list is missing 10 OPEN SIs (8 newly-filed + 2 misclassified-as-CLOSED)

**Matrix r6 §4 OPEN list (lines 150-154):**

```
| Spec Issue | What it blocks | Status |
| --- | --- | --- |
| **SI-002** | AUDIT_EVENTS placeholder ratification | OPEN — pending P-012 |
| **SI-003** | DOMAIN_EVENTS placeholder ratification | OPEN — pending P-013 |
```

**Actual OPEN SIs per source files in `docs/SI-*.md`:** SI-002, SI-003, SI-004, SI-005, SI-007, SI-008, SI-009, SI-010, SI-011, SI-012, SI-013, SI-014 — **12 OPEN SIs**, not 2.

This finding subsumes **two distinct drift surfaces**:
- **8 newly-filed SIs absent entirely from §4** (SI-007/008/009/010/011/012/013/014, all filed 2026-05-14 through 2026-05-16 — after matrix r6 was written 2026-05-12).
- **2 pre-existing OPEN SIs (SI-004 + SI-005) misclassified as CLOSED** in §4 (audited as HIGH-2 below).

Net rows missing from the §4 OPEN table: **10**.

**Cross-reference:** PR #171 (Per-Track SI Navigation doc, merged `cbb8a16`) explicitly enumerates the 12-OPEN-SI inventory in its §0 inventory table. PR #169 Ratifier Agenda 3-patch (merged `cc2d41d`) lists 14 SIs filed / 2 effectively closed / 12 OPEN.

**P-NUM targets are also miscited:**
- Matrix r6 says SI-002 → P-012. **Actual:** SI-002 source file line 300 says **P-014** (P-012 deferred; P-013 claimed by SI-007 v0.19).
- Matrix r6 says SI-003 → P-013. **Actual:** SI-003 source file line 141 still says P-013, but **SI-007 source file line 424 has already claimed P-013** (2026-05-14), so SI-003 effectively re-routes to a later P-NUM.

**Severity rationale:** HIGH because the matrix is the canonical "what's open / what blocks what" reference doc, and its §4 is the artifact ratifier agendas + Track-6 SI inventories ought to be able to lean on. Right now it would mislead a ratifier into thinking only 2 SIs need attention.

### §1.2 — HIGH-2: §4 CLOSED-list incorrectly lists SI-004 + SI-005 as closed

**Matrix r6 §4 CLOSED list (lines 159-164):**

```
| **SI-004** | Async Consult audit-events ratification | (resolved during async-consult slice authoring; Sprint 9-10) |
| **SI-005** | Consult / ConsultEvent schema gap | (resolved during async-consult slice authoring; Sprint 9-10) |
```

**Actual source-file state:**
- `docs/SI-004-Async-Consult-Audit-Events-Ratification.md` line 54: "When SI-004 closes:" (still forward-looking — i.e., SI-004 is OPEN). The file enumerates 4 placeholder event names emitted at Sprint 9, with a `Resolution path` block describing what closure would entail. No `## Status: CLOSED` block.
- `docs/SI-005-Consult-ConsultEvent-Schema-Gap.md` line 63: "When SI-005 closes:" (still forward-looking — i.e., SI-005 is OPEN). Same shape as SI-004: placeholder schema + resume-gate doc + forward-looking resolution path. No `## Status: CLOSED` block.

The matrix r6's "resolved during async-consult slice authoring; Sprint 9-10" claim is an **outright fabrication relative to the source files** — slice authoring was when SI-004 + SI-005 were FILED (Sprint 9 / TLC-021a), not resolved. They are explicit placeholder-and-resume-gate SIs, not closed.

**Cross-reference:** PR #171's §0 inventory table also lists SI-004 + SI-005 as OPEN. PR #169 ratifier agenda includes SI-004 + SI-005 in the 12-OPEN-SI count. The Closed-list claim in matrix r6 directly contradicts these.

**Severity rationale:** HIGH because mis-labeling open SIs as closed creates a false "we're further along on Track 6 than we are" picture, and any ratifier reading just the matrix would not pull SI-004 + SI-005 into a ratification ceremony.

### §1.3 — HIGH-3: §3 Async Consult row miscites SI-006 + SI-007 with wrong subject

**Matrix r6 §3 line 137:**

> "Async Consult lifecycle (initiate / submit / abandon / resume / patient-responds; State Machines v1.1 §3 transitions 1-6 + 16) | tests/integration/async-consult-{cross-tenant-isolation,plugin-wiring,http} | ✅ HTTP surface covered Sprint 34 / PR #51; deeper lifecycle paths (**start-intake gated on Payment SI-006, process gated on AI Service SI-007**) remain fail-closed at v0.1 by design"

**Source-file ground truth:**
- `docs/SI-006-Idempotency-Reserve-Then-Execute-Redesign.md` — title says "Idempotency Reserve-Then-Execute Redesign". Status section says **CLOSED Sprint 33-34**. SI-006 is **NOT** about Payment. The matrix miscites it.
- `docs/SI-007-Refill-Dispensing-Shipment-Schema-Gap.md` — title says "Refill / Dispensing / Shipment Schema Gap". SI-007 is the **pharmacy fulfillment** schema gap, NOT the AI Service. The matrix miscites it.

The Async Consult state-machine's "start-intake" and "process" branches do depend on Payment + AI Service surfaces, but those are **NOT** SI-006 and SI-007. The actual Payment-side blocker (if one were to be filed) and AI-Service-side blocker (also not currently filed as an Async-Consult-blocking SI) would have separate IDs. This row is fabricated.

**Severity rationale:** HIGH because the row attributes blockers to SIs that don't actually carry those blockers, and SI-006 is in fact CLOSED — so a reader looking at the matrix would conclude the Async Consult Payment-side surface is gated on something that's already done.

### §1.4 — MEDIUM-1: §2 Pharmacy + Subscription "BLOCKED on SI-001" entries stale (Pharmacy only)

**Matrix r6 §2 lines 97-101:**

```
| **Pharmacy** | `src/modules/pharmacy/plugin.ts` | SI-001 (MedicationRequest schema) | pharmacy-plugin-wiring.test.ts |
| **Med Interaction** | `src/modules/med-interaction/index.ts` | Med Interaction Engine slice PRD ratification | med-interaction-plugin-wiring.test.ts |
| **Subscription** | `src/modules/subscription/index.ts` | SI-001 (Subscription binds to MedicationRequest) | subscription-plugin-wiring.test.ts |
```

**Actual current state (grep-confirmed 2026-05-17):**

- **Pharmacy:** **No longer a BLOCKED-aware skeleton.** SI-001 ratified P-011 2026-05-11. `src/modules/pharmacy/` now has `audit.ts`, `domain-events.ts`, `index.ts`, `internal/handlers/prescriptions.ts`, `internal/repositories/medication-request-repo.ts`, `internal/services/medication-request-service.ts`, `internal/state-machine.ts`, `internal/types.ts`, `plugin.ts`, `routes.ts`. `routes.ts` registers **12 substantive routes** (grep `fastify.` returns 12 matches). PR #173 (merged `61a02cd` 2026-05-17) reclassified the Pharmacy module status doc from SKELETON → SUBSTANTIAL on this basis.
- **Subscription:** **Still a BLOCKED-aware skeleton.** `src/modules/subscription/routes.ts` head comment explicitly says "Status at v0.1: BLOCKED on SI-001" and registers only `/health` + `/ready`. The matrix's claim here is accurate.
- **Med Interaction:** Unchanged; still skeleton. The matrix claim accurate.

**Severity rationale:** MEDIUM — the Pharmacy entry is stale but the table-row drift is bounded (one column needs an update to "PARTIALLY UNBLOCKED post-P-011; refill/dispense/shipment scope still gated on SI-007"), not fabricated. Subscription + Med Interaction rows remain accurate.

### §1.5 — MEDIUM-2: §3 Pharmacy state-machine row + I-012 row stale on Pharmacy implementation state

**Matrix r6 §3 lines 138-140:**

```
| **I-012 prescribing reject-unless gate** | tests/state-machines/i012-prescribing | ✅ gate; functional BLOCKED on SI-001 |
| ...
| Pharmacy MedicationRequest / Refill / Dispensing / Shipment | — (skeleton only) | BLOCKED on SI-001 |
```

**Actual state:**
- I-012 prescribing gate is **no longer functional-BLOCKED on SI-001**. SI-001 ratified P-011; the gate is now exercised by `src/modules/pharmacy/internal/state-machine.ts` which State Machines v1.2 §19 implements with the discriminated-union I-012 guard + PendingTransitionContext bound-row attestations + canonical AUDIT_EVENTS v5.3 action IDs (per matrix r6 line 8 itself). The matrix correctly identified the closure in r6's history block but failed to propagate it into §1's I-012 row and §3's Pharmacy row.
- Pharmacy state-machine row should split: **MedicationRequest** state machine is IMPLEMENTED (State Machines v1.2 §19). **Refill / Dispensing / Shipment** state machines remain BLOCKED, but on **SI-007** (the refill/dispensing/shipment SI filed 2026-05-14), not SI-001.

**Severity rationale:** MEDIUM — internal self-contradiction. Matrix r6's history block correctly documents the SI-001 closure but its §1 + §3 rows weren't propagated. This is a known r6-incomplete-edit pattern (the r6 author updated the revision history but didn't sweep the body).

### §1.6 — MEDIUM-3: §6 "Closed Spec Issues" cumulative-metrics claim contradicts §4

**Matrix r6 §6 line 216:**

> "Closed Spec Issues: SI-004 + SI-005 (Async Consult slice closure; Sprint 9-10) + SI-006 (idempotency reserve-then-execute redesign; Sprint 33-34)"

This restates the §4 Closed-list claim (audited HIGH-2 above). Same drift; downstream of HIGH-2.

**Severity rationale:** MEDIUM (downstream of HIGH-2). Fixing HIGH-2 in a follow-on patch fixes this metric line in the same diff.

---

## §2 — `AUTONOMOUS_TURN_SUMMARY_2026-05-05.md` — LOW (historical-record framing)

This is an explicitly dated historical artifact. The file's own framing ("2026-05-05 autonomous turn") signals it captures state-at-time-of-writing. The findings below are LOW-severity stale claims that would benefit from a top-of-doc historical-vs-current banner mirroring the pattern PR #173 established for the Pharmacy + Forms-Intake STATUS docs (R4/R5 finding lineage):

| Line | Stale claim | Current ground truth |
| --- | --- | --- |
| 13 | "autonomous-friendly work surface is now substantially exhausted without spec-corpus closure on SI-001 / SI-002 / SI-003" | Surface has been productively extended through Sprint 38 via 14 SIs filed + Sprint 17 OR-218 closure + Sprint 33-34 SI-006 closure + Sprint 35 SI-001 ratification + ~6 sprints of post-ratification slice work. The 2026-05-05-snapshot "exhausted" claim was time-bounded; the floor moved. |
| 26 | "Slice 4 Pharmacy + Refill v2.1 — ⛔ Blocked on SI-001" | SI-001 ratified P-011 2026-05-11. Slice 4 Pharmacy + Refill is now PARTIALLY-IMPLEMENTED (prescribe surface live; refill/dispense/shipment still SI-007-gated). |
| 81 | "Slice 4 (Pharmacy + Refill v2.1) — needs SI-001 closure" | SI-001 closed P-011 2026-05-11. |
| 126 | "Spec Issues open: 3 (SI-001/002/003)" | Current OPEN inventory: 12 SIs (SI-001 closed, SI-006 closed, SI-007/008/009/010/011/012/013/014 also filed; SI-002/003/004/005 still open). |
| 139 | "If SI-001 closes:" — followed by forward-looking branch description | SI-001 closed P-011; the branch was taken. |

**Recommended treatment:** Top-of-doc historical-vs-current banner (mirroring the pattern PR #173 applied to PHARMACY_SLICE_STATUS_2026-05-05.md + FORMS_INTAKE_SLICE_STATUS_2026-05-05.md). Body preserved as-is; banner reframes the body as "captured 2026-05-05; current state at top of doc".

---

## §3 — `AUTONOMOUS_TURN_SUMMARY_2026-05-08.md` — LOW (historical-record framing)

| Line | Stale claim | Current ground truth |
| --- | --- | --- |
| 17 | "SI-001 / SI-002 / SI-003 / SI-004 / SI-005 remain open at the spec corpus governance layer" | SI-001 closed P-011 2026-05-11; SI-006 closed Sprint 33-34. SI-002/003/004/005 still open. SI-007 through SI-014 filed after this doc was written. |
| 52 | "pharmacy can adopt these from day 1 when SI-001 unblocks" (in PR #79 description) | SI-001 unblocked P-011; Pharmacy module did adopt the audit-dedupe + reserve-then-execute primitives. |
| 86 | "Spec Issues open: 5 (SI-001/002/003/004/005)" | Current OPEN inventory: 12. |
| 99 | "If SI-001 closes:" — followed by forward-looking branch description | Branch taken. |

**Recommended treatment:** Top-of-doc historical-vs-current banner.

---

## §4 — `AUTONOMOUS_TURN_SUMMARY_2026-05-11.md` — LOW (historical-record framing)

| Line | Stale claim | Current ground truth |
| --- | --- | --- |
| 107 | "PR #95 remains DRAFT pending SI-001 ratification" | SI-001 ratified P-011 later on 2026-05-11 (same calendar date as this doc but after the snapshot was captured). PR #95 was superseded by the Sprint 35 scaffold-rebuild branch (`feat/slice-4-pharmacy-scaffold-rebuild-p011`). |
| 126 | "PRs DRAFT-open: 1 (#95 — Codex Finding 1 closed; SI-001 ratification still pending)" | SI-001 ratified; PR #95 superseded. |
| 138 | "PR #95 disposition — Codex Finding 1 now closed; primary blocker is SI-001 ratification" | Same — superseded by Sprint 35 rebuild. |
| 266 | "Open Spec Issues with DRAFT closure proposals ready for Evans: 5 (SI-001 through SI-005)" | SI-001 ratified P-011 leaving 4 DRAFT closure proposals (SI-002/003/004/005); SI-007/008/009/010/011/012/013/014 filed after this doc was written and don't yet have DRAFT closure proposals — they remain in "filed but not yet proposed" state. |

**Recommended treatment:** Top-of-doc historical-vs-current banner.

---

## §5 — Recommended-patches table (for follow-on PR)

This audit doc is staged separately from the patches (PR #168 + PR #172 R3-class pattern). A follow-on patch PR should land the patches enumerated below; this audit doc is its evidence base.

| # | Severity | Target file | Change |
| --- | --- | --- | --- |
| 1 | HIGH | `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` | §4 OPEN-list: expand from 2 rows (SI-002/003) to 12 rows (SI-002/003/004/005/007/008/009/010/011/012/013/014). Pull row content from the SI source files' Status blocks + Resolution Expectations sections. |
| 2 | HIGH | `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` | §4 CLOSED-list: remove SI-004 + SI-005 rows entirely (both are OPEN per source files). Retain the existing SI-001 RATIFIED 2026-05-11 P-011 row (already at line 161). Retain the existing SI-006 CLOSED Sprint 33-34 row (already at line 162). No new CLOSED rows are needed — the table should just shrink from 4 rows to 2. |
| 3 | HIGH | `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` | §3 Async Consult row: replace "(start-intake gated on Payment SI-006, process gated on AI Service SI-007)" with accurate citations. Best replacement: "(start-intake branch gated on Payment integration not-yet-filed; process branch gated on Mode 2 AI surface not-yet-filed)" or strike the parenthetical if no SI carries those specific blockers. |
| 4 | MEDIUM | `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` | §2 BLOCKED-aware-skeletons table Pharmacy row: change blocker column from "SI-001 (MedicationRequest schema)" to "SI-007 (Refill/Dispensing/Shipment schema)" — and reclassify the Pharmacy row out of "BLOCKED-aware skeletons" into a new "Partially-implemented slices" group OR add a note column noting SI-001 P-011 closure with prescribe surface live. |
| 5 | MEDIUM | `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` | §1 I-012 row: replace "functional BLOCKED on SI-001 — no MedicationRequest schema yet" with "functional path active post-P-011 via `src/modules/pharmacy/internal/state-machine.ts` State Machines v1.2 §19 discriminated-union I-012 guard". |
| 6 | MEDIUM | `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` | §3 Pharmacy state-machine row: split into (a) MedicationRequest — IMPLEMENTED at State Machines v1.2 §19 post-P-011; (b) Refill / Dispensing / Shipment — BLOCKED on SI-007. |
| 7 | MEDIUM | `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` | §6 cumulative metrics "Closed Spec Issues" line: replace SI-004/005 with SI-001 ratification P-011 (SI-006 already correctly listed). |
| 8 | MEDIUM | `docs/BUILD_VS_SPEC_TRACEABILITY_MATRIX.md` | Add r7 revision-history block at top documenting all 7 changes above + this audit doc as the evidence pointer. |
| 9 | LOW | `docs/AUTONOMOUS_TURN_SUMMARY_2026-05-05.md` | Insert historical-vs-current banner at top (pattern from PR #173 PHARMACY_SLICE_STATUS_2026-05-05.md banner). Body preserved. |
| 10 | LOW | `docs/AUTONOMOUS_TURN_SUMMARY_2026-05-08.md` | Insert historical-vs-current banner at top. Body preserved. |
| 11 | LOW | `docs/AUTONOMOUS_TURN_SUMMARY_2026-05-11.md` | Insert historical-vs-current banner at top. Body preserved. |

**Total: 11 recommended patches** across 4 target files; **8 patches to matrix r6 → r7**; **3 banner-only patches** to the AUTONOMOUS_TURN_SUMMARY series.

---

## §6 — What this audit is NOT

- **Not a Spec Issue.** The drift is in code-repo `docs/` artifacts; no spec-corpus governance escalation needed.
- **Not a ratifier-agenda item.** The drift surfaces don't affect the Q2 2026 Ratifier Ceremony Agenda (PR #167) — that agenda already correctly enumerates the 12-OPEN-SI inventory. This audit closes the gap between the agenda + matrix.
- **Not patching the drifted artifacts in this PR.** This PR adds the audit doc only. Patches stage into a follow-on PR per the R3-class pattern established by PR #168 + PR #172.
- **Not asserting anything about the spec corpus.** All claims are about code-repo doc artifacts.
- **Not Codex-graded.** Codex review will run on this PR per the autoinvoke-on-PR-open discipline.

---

## §7 — Cross-references

- **PR #168** — 1st sibling-doc cross-validation audit (Implementation State Audit 2026-05-17). Established R3-class pattern.
- **PR #172** — 2nd sibling-doc cross-validation audit. Extended pattern to STATUS docs.
- **PR #173** — STATUS doc refresh follow-on to PR #172. Established historical-vs-current banner pattern.
- **PR #171** — Per-Track SI Navigation doc. Source for the authoritative 12-OPEN-SI inventory.
- **PR #169** — Q2 2026 Ratifier Ceremony Agenda 3-patch + SI-014 source patches. Authoritative SI count source.
- **CLAUDE.md autonomous-work authorization** (Evans's 2026-05-16 standing directive).
- **`Telecheck_Master_Completion_Plan_v1_0.md`** Track 6 (spec-corpus ratification).
- **`Telecheck_v1_10_PRD_Update/AI_Service_Rollout_24h_Status_2026-05-14.md`** Addendum 35 — explicitly recommended this 3rd cross-validation pass.
- **`migrations/001_tenants.sql`** — P-010 closure documentation.
- **Spec corpus commit `879cd57`** in `arthurmenson/telecheckONE` — P-011 ratification landing.

---

— Claude (Opus 4.7, 1M context), 2026-05-17 autonomous run.
