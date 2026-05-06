# SI-004 — Async Consult audit events ratification

**Raised by:** Engineering (autonomous turn 2026-05-05; Sprint 8 retro decision; filed at TLC-021a)
**Date:** 2026-05-05
**Severity:** medium (does NOT block Sprint 9 authoring; placeholder events ship with this gap as the resume-gate)
**Status:** Open — awaiting Contracts Pack v5.2 AUDIT_EVENTS ratification
**Target spec doc:** `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.2)
**Target slice PRD:** `Telecheck_Async_Consult_Slice_PRD_v1_0.md` §13

---

## What I'm trying to implement

Sprint 9 (TLC-021) of the autonomous Scrum cycle authors the Async Consult slice. Per Async Consult Slice PRD v1.0 §13 (`Telecheck_Async_Consult_Slice_PRD_v1_0.md:441-455`), the slice emits 11 audit events:

| # | PRD §13 event name | Sprint 9 emit? |
| --- | --- | --- |
| 1 | Consult initiated | ✅ TLC-021d (transition INITIATED → INTAKE) |
| 2 | Intake submitted | ✅ TLC-021d (transition INTAKE → SUBMITTED) |
| 3 | AI preparation completed | ⏸️ deferred (depends on AI service wiring; Sprint 10+) |
| 4 | Case claimed by clinician | ⏸️ deferred (transition QUEUED → UNDER_REVIEW; Sprint 10) |
| 5 | Clinician decision | ⏸️ deferred (transitions 9-15; Sprint 10) |
| 6 | Prescription created | ⏸️ deferred (transition 9 PRESCRIBED; Sprint 10; depends on Pharmacy slice closure of SI-001) |
| 7 | Additional data requested | ⏸️ deferred (transition 11 AWAITING_DATA; Sprint 10) |
| 8 | Escalation to sync | ⏸️ deferred (transition 13 ESCALATED_TO_SYNC; Sprint 10+) |
| 9 | Patient notification sent | ⏸️ deferred (cross-cutting; Sprint 10+) |
| 10 | Follow-up message | ⏸️ deferred (FOLLOW_UP state messaging; Sprint 10+) |
| 11 | Consult completed | ⏸️ deferred (terminal state transitions; Sprint 10) |

**Sprint 9 only emits 4 of 11** at the v0.1 state-machine coverage:
- `consult.initiated` (transition 1: INITIATED → INTAKE)
- `consult.intake_submitted` (transition 2: INTAKE → SUBMITTED)
- `consult.abandoned` (transition 3: INTAKE → ABANDONED)
- `consult.expired` (transition 5: ABANDONED → EXPIRED)

## What the canonical contract says

Grepped `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.2) for `consult.` and for any of the 11 PRD §13 event names. Result: **0 matches.** None of the 11 events exists in the canonical AUDIT_EVENTS contract today.

The Contracts Pack v5.2 AUDIT_EVENTS catalog does NOT yet enumerate Async Consult slice events. This is a spec-corpus gap, not an engineering bug.

## Decision (Sprint 8 retro option (c) — placeholder events with resume gate)

Per Sprint 8 retro process change #2 (decision required at Sprint 9 PM kickoff):

**Decision: option (c) — Sprint 9 ships placeholder events matching PRD §13 verbatim; SI-004 closure ratifies them upstream.**

Rationale:
1. **Authoring should not block on out-of-repo spec work.** Waiting on AUDIT_EVENTS ratification would idle the autonomous build for an indefinite period (parallel to SI-001/002/003 which have been open for the entire 9-sprint cycle).
2. **Placeholder events match PRD §13 verbatim.** Spec-side ratification at SI-004 closure becomes a string-comparison verification against the placeholder names — low rework cost.
3. **Parallels SI-005 schema-placeholder posture for symmetry.** Both SI-004 (audit events) and SI-005 (schema rows) ship placeholders + SI docs as resume gates.
4. **Audit emission still happens.** The 4 Sprint 9 events are emitted to the audit chain via `emitAudit()` per the platform-floor I-003 audit append-only invariant. Placeholder status only means the wire-protocol identifier is unratified upstream.

## Resolution path

When SI-004 closes:

1. Audit events ratified into Contracts Pack v5.2 AUDIT_EVENTS. Canonical event_type names landed (likely matching the placeholder names verbatim; if not, ratified names used).
2. Engineering grep `consult.` across `src/modules/async-consult/` and update placeholder event names to ratified names (string replace; trivial if names match verbatim).
3. PR includes a closing-rationale comment referencing this SI-004 doc.
4. SI-004 status changed to "Resolved"; Sprint backlog updates "deferred to SI-004 resolution" markers.

## Placeholder event vocabulary (Sprint 9 — 4 events emitted)

| Placeholder event_type | PRD §13 row | Sprint 9 emit point |
| --- | --- | --- |
| `consult.initiated` | "Consult initiated" | `consult-service.ts` initiate handler at INITIATED → INTAKE transition |
| `consult.intake_submitted` | "Intake submitted" | `consult-service.ts` submit handler at INTAKE → SUBMITTED transition |
| `consult.abandoned` | (implicit; PRD §13 missing — added per state machine §3 transition 3) | `consult-service.ts` abandon handler at INTAKE → ABANDONED transition |
| `consult.expired` | (implicit; PRD §13 missing — added per state machine §3 transition 5) | scheduled job (Sprint 10+) at ABANDONED → EXPIRED transition |

Note: PRD §13 omits explicit "Consult abandoned" and "Consult expired" rows; State Machines §3 has these transitions. Per CLAUDE.md hard rule "Slice PRD vs State Machines v1.1 → State Machines wins", we emit audit events for them. SI-004 closure should ratify these even though PRD §13 didn't enumerate them.

## Sprint reference

Filed at Sprint 9 / TLC-021a as part of the Async Consult slice authoring continuation. PM-brief verification gate (Evans 2026-05-05 oversight directive) confirmed the gap at Sprint 8 + Sprint 9 PM kickoffs. Sprint 9 ships placeholder events; Sprint 10+ may close the remaining 7 events (still placeholder until SI-004 ratifies). Sprint 11 hardening will revisit if SI-004 still open.
