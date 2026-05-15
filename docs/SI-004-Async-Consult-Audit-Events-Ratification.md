# SI-004 — Async Consult audit events ratification

**Raised by:** Engineering (autonomous turn 2026-05-05; Sprint 8 retro decision; filed at TLC-021a)
**Date:** 2026-05-05
**v0.2 advanced:** 2026-05-14 (concrete proposals + pre-ratification gate alignment with SI-002 / SI-003)
**Severity:** medium (does NOT block Sprint 9 authoring; placeholder events ship with this gap as the resume-gate)
**Status:** OPEN — v0.2 DRAFT, awaiting Contracts Pack v5.X AUDIT_EVENTS ratification (Codex pre-ratification gate pending; mirror SI-007 / SI-002 / SI-003 cadence)
**Target spec doc:** `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.5 once SI-002 closes → **v5.6** at SI-004 closure)
**Promotion Ledger target:** **P-016** (P-013 consumed by SI-007 merged 2026-05-14; P-014 reserved by SI-002 PR #136 MERGED 2026-05-14; P-015 reserved by SI-003 PR #137 in flight)
**Target slice PRD:** `Telecheck_Async_Consult_Slice_PRD_v1_0.md` §13
**Parallel SIs:** SI-002 (AUDIT_EVENTS broader placeholder ratification — must close FIRST); SI-003 (DOMAIN_EVENTS placeholder ratification — concurrent dot-namespaced naming convention)

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

## What the canonical contract says (v0.1 unchanged)

Grepped `Telecheck_Contracts_Pack_v5_00_AUDIT_EVENTS.md` (v5.2) for `consult.` and for any of the 11 PRD §13 event names. Result: **0 matches.** None of the 11 events exists in the canonical AUDIT_EVENTS contract today.

The Contracts Pack v5.2 AUDIT_EVENTS catalog does NOT yet enumerate Async Consult slice events. This is a spec-corpus gap, not an engineering bug.

## v0.2 concrete proposals (NEW)

### Decision 1 — Naming convention: dot-namespaced (`<aggregate>.<lifecycle_event>`)

Aligns with:
- The placeholder event names already used by Sprint 9 (`consult.initiated`, `consult.intake_submitted`, `consult.abandoned`, `consult.expired`)
- SI-002 v0.2+ AUDIT_EVENTS naming convention (dot-namespaced)
- SI-003 v0.2+ DOMAIN_EVENTS naming convention (dot-namespaced)
- SI-007 P-013 ratified strings (`refill.requested`, `shipment.dispatched`)
- P-011 Category A audit IDs

**No renames required at SI-004 closure** — Sprint 9 placeholders match the canonical naming convention verbatim.

### Decision 2 — Aggregate-type: `consult`

All 11 PRD §13 events + the 2 state-machine-derived events (`consult.abandoned`, `consult.expired`) share aggregate-type `consult`. The aggregate row is the AsyncConsult row in the consult state-machine table.

### Decision 3 — Final 13-string canonical table

Enumerates all 13 events (11 PRD §13 + 2 state-machine derived). v0.2 ratification covers all 13 even though Sprint 9 only emits 4 — the remaining 9 stay declared-but-deferred so Sprint 10+ implementation lands without an additional ratification cycle.

| # | Canonical event_type | Category (per SI-002 Decision 2) | PRD §13 row | First-emit sprint |
| --- | --- | --- | --- | --- |
| 1 | `consult.initiated` | C (operational) | Consult initiated | Sprint 9 ✅ |
| 2 | `consult.intake_submitted` | C | Intake submitted | Sprint 9 ✅ |
| 3 | `consult.abandoned` | C | (state-machine §3 transition 3) | Sprint 9 ✅ |
| 4 | `consult.expired` | C | (state-machine §3 transition 5) | Sprint 9 ✅ (scheduled job; Sprint 10) |
| 5 | `consult.ai_preparation_completed` | C | AI preparation completed | Sprint 10+ ⏸️ |
| 6 | `consult.case_claimed` | C | Case claimed by clinician | Sprint 10 ⏸️ |
| 7 | `consult.clinician_decision_recorded` | **B (governance)** | Clinician decision | Sprint 10 ⏸️ |
| 8 | `consult.prescription_created` | **B (governance)** | Prescription created | Sprint 10 ⏸️ (depends on SI-001 closure) |
| 9 | `consult.additional_data_requested` | C | Additional data requested | Sprint 10 ⏸️ |
| 10 | `consult.escalated_to_sync` | **B (governance)** | Escalation to sync | Sprint 10+ ⏸️ |
| 11 | `consult.patient_notification_sent` | C | Patient notification sent | Sprint 10+ ⏸️ |
| 12 | `consult.follow_up_message_sent` | C | Follow-up message | Sprint 10+ ⏸️ |
| 13 | `consult.completed` | C | Consult completed | Sprint 10 ⏸️ |

**Category B vs C rationale (Decision 3a):**
- **Category B (governance)** for 3 events: `consult.clinician_decision_recorded` (clinical decision; medico-legal artifact), `consult.prescription_created` (medication order; medico-legal + regulatory; cross-references SI-001 MedicationRequest schema gap and SI-007 P-013 refill ratification), `consult.escalated_to_sync` (case-routing change affecting on-call governance + clinical-safety triage path).
- **Category C (operational)** for 10 events: state-machine transitions, intake bookkeeping, notifications. No medico-legal artifact; no regulatory significance beyond audit trail.

### Decision 4 — Mandatory detail-shape proposals

Per AUDIT_EVENTS v5.2 §envelope, every audit event already carries the canonical envelope (`audit_id`, `tenant_id`, `action_id`, `actor_id`, `resource_type`, `resource_id`, `at`, `country_of_care`, `category`, `ai_workload_type`, `autonomy_level`, `chain_prev_hash`, `chain_hash`). v0.2 detail proposals (the `detail` JSONB column):

#### `consult.initiated` (Category C)
```json
{
  "consult_id": "<ULID>",
  "consult_type": "<async-consult-type-enum>",
  "country_of_care": "US|GH",
  "patient_account_id": "<ULID>",
  "initiated_via": "patient-direct|delegate|forms-intake-followup"
}
```

#### `consult.intake_submitted` (Category C)
```json
{
  "consult_id": "<ULID>",
  "form_submission_id": "<ULID>",
  "form_template_id": "<ULID>",
  "intake_completeness_score": 0.0-1.0
}
```

#### `consult.abandoned` (Category C)
```json
{
  "consult_id": "<ULID>",
  "abandoned_reason": "patient_action|timeout|system_initiated",
  "elapsed_seconds": "<integer>"
}
```

#### `consult.expired` (Category C)
```json
{
  "consult_id": "<ULID>",
  "expired_after_state": "ABANDONED",
  "expiry_window_days": "<integer>"
}
```

#### `consult.ai_preparation_completed` (Category C)
```json
{
  "consult_id": "<ULID>",
  "ai_workflow_execution_id": "<ULID>",
  "ai_workload_type": "<per WORKLOAD_TAXONOMY v5.2>",
  "model_version": "<string>",
  "preparation_duration_ms": "<integer>"
}
```

#### `consult.case_claimed` (Category C)
```json
{
  "consult_id": "<ULID>",
  "clinician_account_id": "<ULID>",
  "queue_wait_seconds": "<integer>"
}
```

#### `consult.clinician_decision_recorded` (Category B; governance — medico-legal)
```json
{
  "consult_id": "<ULID>",
  "clinician_account_id": "<ULID>",
  "decision_class": "prescribe|decline|request_more_data|escalate_to_sync",
  "decision_hash": "<SHA-256 hex of canonical decision payload; full payload retained encrypted on AsyncConsult row, hash here for chain-integrity reconstruction>",
  "clinical_rationale_summary_present": true|false
}
```
Note: Category B detail intentionally does NOT include the rationale text or the decision payload itself — those live encrypted on the AsyncConsult row. The audit detail carries the HASH for tamper-evidence + a boolean for compliance reporting (was a clinical rationale recorded? per regulatory requirement).

#### `consult.prescription_created` (Category B; governance — medico-legal + regulatory)
```json
{
  "consult_id": "<ULID>",
  "medication_request_id": "<ULID — references medication_request entity per SI-001>",
  "clinician_account_id": "<ULID>",
  "interaction_check_outcome": "passed|warnings_accepted|blocked-override"
}
```
Note: Per glossary `medication_request` (NOT `prescription`). Per platform-floor I-012 reject-unless three-clause rule: `interaction_check_outcome=passed|warnings_accepted` AND `autonomy_level == action_with_confirm` AND explicit clinician confirmation. If blocked-override, the matching `medication_request.execution_rejected` event MUST emit per I-012 §rejection.

#### `consult.additional_data_requested` (Category C)
```json
{
  "consult_id": "<ULID>",
  "clinician_account_id": "<ULID>",
  "data_request_id": "<ULID>",
  "data_request_kind_hash": "<SHA-256 hex of request-kind enum; the kind enum itself is on the AsyncConsult row>"
}
```

#### `consult.escalated_to_sync` (Category B; governance — case-routing change)
```json
{
  "consult_id": "<ULID>",
  "escalating_clinician_account_id": "<ULID>",
  "escalation_reason_code": "<enum: clinical_complexity|crisis_detected|patient_request|protocol_required>",
  "target_sync_session_id": "<ULID nullable; null if escalation queued without session yet>"
}
```

#### `consult.patient_notification_sent` (Category C)
```json
{
  "consult_id": "<ULID>",
  "notification_channel": "sms|email|push",
  "notification_template_id": "<ULID>",
  "delivery_provider": "twilio|sendgrid|fcm|apns",
  "provider_message_id_hash": "<SHA-256 hex of provider's message_id; raw ID kept on AsyncConsult row>"
}
```

#### `consult.follow_up_message_sent` (Category C)
```json
{
  "consult_id": "<ULID>",
  "follow_up_message_id": "<ULID>",
  "follow_up_kind": "scheduled|patient_initiated_reply|clinician_initiated"
}
```

#### `consult.completed` (Category C)
```json
{
  "consult_id": "<ULID>",
  "terminal_state": "PRESCRIBED|DECLINED|ESCALATED_TO_SYNC|EXPIRED|ABANDONED",
  "total_duration_minutes": "<integer>"
}
```

### Decision 5 — Cross-SI alignment

**SI-002 cross-alignment:** SI-002 (PR #136 MERGED 2026-05-14) ratifies the broader AUDIT_EVENTS placeholder set at v5.5. SI-004 lands AFTER SI-002 closes — the SI-004 13 events are an INCREMENT on top of the SI-002 baseline. AUDIT_EVENTS goes v5.5 (SI-002) → v5.6 (SI-004). The dot-namespaced naming convention and detail-shape discipline established at SI-002 apply.

**SI-003 cross-alignment:** SI-003 ratifies DOMAIN_EVENTS at v5.3. Most consult events emit ONLY an audit event (no domain event) at v1.0 because no downstream subscriber exists yet (the consult slice is producer-only at v1.0). Future Sprint 10+ work that wires AI-service or downstream consumers MAY add paired domain events — those would be enumerated in a future SI (SI-008 or later) per the SI-003 Decision 7B subscriber-compat protocol.

**SI-001 cross-alignment:** `consult.prescription_created` cross-references the MedicationRequest entity per SI-001. SI-001 closure at P-011 ratified the MedicationRequest canonical schema; SI-004 prescriber emission inherits that envelope.

**SI-005 cross-alignment:** SI-005 (Consult / ConsultEvent schema gap) raised the schema-row-level gap; SI-004 is the audit-event-level companion. SI-005 closure ratifies the AsyncConsult entity + the ConsultEvent state-transition history table. The audit chain enumerated here PAIRS with the ConsultEvent rows: every state transition has BOTH a ConsultEvent row (state-machine history) AND an audit event (chain-of-custody attestation). Both are written same-tx per I-016.

### Decision 6 — Reserved event-type strings for forward-compat

The following event-type strings are RESERVED at SI-004 ratification but NOT yet emitted by any code path. Reserved for Sprint 11+ hardening work; ratification now avoids a future micro-SI:

- `consult.reviewed_by_safety_team` — reserved for the platform-clinical-governance safety-review workflow (forward-compat with §16.3 governance escalation).
- `consult.data_export_requested` — reserved for Research Data slice (cross-references ADR-028 + I-029 6-condition gate).
- `consult.crisis_resource_surfaced` — reserved for I-019 crisis-detection-gate emission specifically from the consult intake flow (the canonical I-019 event lives elsewhere; this is the consult-bound paired entry).

Per SI-003 Decision 7A discipline, reserved event-type strings MUST be added to the canonicalization map at SI-004 closure even though no code emits them yet, so the v1.0 CI guardrail (G-2 grep over the canonical 13-string list + 3 reserved = 16 strings) catches premature emission attempts.

### Decision 7 — Cutover discipline (mirror SI-003 Decision 7A)

Sprint 9 already emits the 4 placeholder strings (`consult.initiated`, `consult.intake_submitted`, `consult.abandoned`, `consult.expired`) which match the canonical names verbatim. **Zero rename required at SI-004 closure.** This is the cleanest case in the SI-00X family (vs SI-002's 31-string rename and SI-003's 11-string rename).

Sprint 10+ work that adds emission for the remaining 9 events MUST use the canonical names from Decision 3 (no placeholder phase). Per SI-003 Decision 7A G-2 enforcement, any deviation from the canonical strings will fail the CI guardrail at PR time.

## Resolution path (v0.2 updated)

### Step 1 (spec corpus, owned by Engineering Lead + Privacy/Compliance + Codex pre-ratification reviewer)

1. **Codex pre-ratification gate** — multi-round adversarial review against v0.2+ proposals. Mirror SI-007 / SI-002 / SI-003 cadence. SI-004's scope is narrower than its predecessors (13 events vs 28-31), so convergence may be faster (target: 3-6 rounds).
2. Engineering Lead + Privacy/Compliance ratify after Codex convergence.
3. Author the AUDIT_EVENTS v5.6 enumeration block adding all 13 ratified event-type strings + the `detail` shape definitions per Decision 4 + the 3 reserved strings per Decision 6.
4. Promotion Ledger entry **P-016** closes this SI.

### Step 2 (this code repo, owned by Engineering)

Zero placeholder→canonical rename required (Sprint 9 names already match). Sprint 10+ emission for the remaining 9 events uses the canonical names directly per Decision 7.

## What I'm doing in the meantime (v0.1 unchanged)

**Continuing to ship Sprint 9 work using the placeholder pattern.** Per Sprint 8 retro option (c): placeholder events ship; SI-004 closure ratifies them upstream. Sprint 10+ extends to the remaining 9 events using the canonical names directly.

Same autonomous-turn discipline as SI-002/SI-003: **never invent new canonical contract artifacts in the code repo.** Spec gaps surface as SIs.

## Required from product (v0.2 updated)

| Item                                                                                 | Owner                                 | Severity |
| ------------------------------------------------------------------------------------ | ------------------------------------- | -------- |
| AUDIT_EVENTS v5.6 — ratify 13 placeholder event-type strings + 3 reserved per Decision 3/6 | Engineering Lead + Privacy/Compliance | medium   |
| Confirm Category B vs C assignment for the 13 events (Decision 3a)                   | Engineering Lead + Clinical Governance | medium   |
| Confirm per-event detail shapes (Decision 4)                                         | Engineering Lead + Privacy/Compliance | medium   |
| Confirm reserved event-type strings (Decision 6)                                     | Engineering Lead                      | low      |
| Confirm zero-rename cutover discipline (Decision 7)                                  | Engineering Lead                      | low      |

---

## Cross-references

- EHBG v1.3 §12 — SI escalation template
- AUDIT_EVENTS v5.5 — current shape (post SI-002 closure 2026-05-14)
- I-003 — audit append-only (preserved)
- I-012 — reject-unless three-clause rule for prescription execution (paired with `consult.prescription_created`)
- I-019 — crisis detection platform-floor (paired with `consult.crisis_resource_surfaced` reserved)
- SI-001 — MedicationRequest canonical schema (closed P-011; paired with `consult.prescription_created`)
- SI-002 — broader AUDIT_EVENTS placeholder ratification (closed PR #136 MERGED 2026-05-14; SI-004 baseline)
- SI-003 — DOMAIN_EVENTS placeholder ratification (concurrent; CI guardrail discipline applies)
- SI-005 — Consult / ConsultEvent schema gap (paired schema-side companion)
- SI-007 — Refill/Dispensing/Shipment schema gap (precedent for Codex pre-ratification cadence)

## Companion code-repo state at SI-004 v0.2

- **Sprint 9 emits 4 placeholder events** matching canonical names verbatim.
- **Sprint 10+ extension covers 9 additional events** + emits using canonical names directly.
- **Sprint 11+ hardening may emit 3 reserved events** per Decision 6.

## Resolution expectations (v0.2 updated)

- **Target close-out:** Promotion Ledger entry **P-016** (P-013 SI-007 merged, P-014 SI-002 merged, P-015 SI-003 in flight). AUDIT_EVENTS bumps **v5.5 → v5.6** at promotion.
- **Codex pre-ratification gate:** multi-round adversarial review begins on PR opening (mirror SI-007 / SI-002 / SI-003 cadence). Target convergence: 3-6 rounds (narrower scope than predecessors).
- **Until then:** SI-004 stays open in this file; Sprint 9 emits 4 placeholder events (names match canonical verbatim); Sprint 10+ work proceeds without ratification blocker per Sprint 8 retro option (c).
