# SI-005 — Consult / ConsultEvent schema gap (CDM v1.2)

**Raised by:** Engineering (autonomous turn 2026-05-05; Sprint 9 PM kickoff verification gate; filed at TLC-021a)
**Date:** 2026-05-05
**v0.2 advanced:** 2026-05-15 (concrete proposals + pre-ratification gate alignment with SI-002 / SI-003 / SI-004 / SI-007)
**v0.3 advanced:** 2026-05-15 (close Codex R1 MEDIUMs — column count reconciliation + KMS envelope explicit)
**v0.4 advanced:** 2026-05-15 (close Codex R2 MEDIUMs — Decision 2 heading +14/total 24 reconciliation; Decision 8 enumerates all 14 columns; CONSULT_EVENT_TYPES adds kms_rotation)
**Severity:** medium (does NOT block Sprint 9 authoring; placeholder schema ships with this gap as the resume-gate)
**Status:** OPEN — v0.4 DRAFT, ratification-ready (5 MEDIUM findings closed across R1+R2; remaining gaps tracked as v5.3 promotion PR deliverables)
**Target spec doc:** `Telecheck_Canonical_Data_Model_v1_2.md` (v1.2 → **v1.3**)
**Promotion Ledger target:** **P-017** (P-013 SI-007 merged 2026-05-14, P-014 SI-002 merged 2026-05-14, P-015 SI-003 PR #137 in flight, P-016 SI-004 PR #138 in flight)
**Target slice PRD:** `Telecheck_Async_Consult_Slice_PRD_v1_0.md`
**Parallel SIs:** SI-004 (audit-event ratification — companion); SI-001 (MedicationRequest schema; cross-references prescription transitions); SI-007 (precedent for cross-entity schema ratification + composite FK + state-machine reconciliation)

---

## What I'm trying to implement (v0.1 unchanged)

Sprint 9 (TLC-021a) authors `migrations/020_async_consult.sql` for the Async Consult slice. Per Async Consult Slice PRD v1.0, the slice operates on:
- **Consult** entity — CDM v1.2 §3 entity #15 (`Telecheck_Canonical_Data_Model_v1_2.md:84`): "Async or sync consultation; converts seamlessly per ADR-012"
- **ConsultEvent** entity — CDM v1.2 §3 entity #16 (`Telecheck_Canonical_Data_Model_v1_2.md:85`): "State transitions and events on a consult"

## What the canonical CDM says (v0.1 unchanged)

CDM v1.2 §3 entity inventory NAMES both entities at lines 84-85. CDM v1.2 §4 row-shape expansion (§4.1 through §4.15) covers Tenant management + Ecom/Subscription Management entities only. **No §4 detail block exists for entity #15 (Consult) or #16 (ConsultEvent).**

## Why this is a gap, not a missing-feature (v0.1 unchanged)

EHBG §7: engineering does NOT author canonical schema. CLAUDE.md hard rule: "Do NOT silently fork." Sprint 9 ships placeholder columns + SI-005 doc as resume gate; SI-005 closure ratifies the canonical column set.

## v0.2 concrete proposals (NEW)

### Decision 1 — Ratify Sprint 9 placeholder columns as the canonical baseline (CDM v1.2 → v1.3 §4.16 + §4.17)

The 10 placeholder columns on `consults` and 9 placeholder columns on `consult_events` SHALL be ratified verbatim as the canonical baseline column set (v0.3 R1 MEDIUM closure: counts reconciled to match the tables below — v0.2 prose said "9 + 8" but the tables enumerate 10 + 9; tables are authoritative). Zero rename required. Reasoning identical to SI-007: Sprint 9 placeholders were authored with the canonical column-naming discipline (snake_case, ULID FKs, timestamptz with NOW() defaults, denormalized tenant_id for RLS).

#### §4.16 Consult (canonical baseline; 10 columns)

| # | Column | Type | Nullable | Notes |
|---|---|---|---|---|
| 1 | `id` | VARCHAR(26) | NOT NULL | PRIMARY KEY; ULID per glossary |
| 2 | `tenant_id` | TEXT | NOT NULL | REFERENCES tenants(id); denormalized for RLS per I-023 |
| 3 | `patient_id` | VARCHAR(26) | NOT NULL | composite FK target on accounts (tenant_id, account_id) |
| 4 | `consult_type` | VARCHAR(50) | NOT NULL | CHECK IN ('program','general'); per PRD §1 |
| 5 | `modality` | VARCHAR(20) | NOT NULL | CHECK IN ('async','sync'); per PRD §1; ADR-012 conversion supported |
| 6 | `state` | VARCHAR(30) | NOT NULL | CHECK IN CONSULT_STATES enum (per Decision 4) |
| 7 | `current_program_catalog_entry_id` | VARCHAR(26) | NULL | nullable for non-program consults; PRD §15 dependency on Program Catalog |
| 8 | `intake_form_submission_id` | VARCHAR(26) | NULL | nullable until INTAKE → SUBMITTED transition; PRD §15 dependency on Forms-Intake |
| 9 | `created_at` | TIMESTAMPTZ | NOT NULL | DEFAULT NOW() |
| 10 | `updated_at` | TIMESTAMPTZ | NOT NULL | DEFAULT NOW() |

#### §4.17 ConsultEvent (canonical baseline; 9 columns)

| # | Column | Type | Nullable | Notes |
|---|---|---|---|---|
| 1 | `id` | VARCHAR(26) | NOT NULL | PRIMARY KEY; ULID per glossary |
| 2 | `consult_id` | VARCHAR(26) | NOT NULL | composite FK target on consults (tenant_id, id) per cross-tenant safety |
| 3 | `tenant_id` | TEXT | NOT NULL | REFERENCES tenants(id); denormalized for RLS per I-023 |
| 4 | `event_type` | VARCHAR(80) | NOT NULL | CHECK IN CONSULT_EVENT_TYPES vocabulary (per Decision 5) |
| 5 | `from_state` | VARCHAR(30) | NULL | nullable for non-transition events; CHECK in CONSULT_STATES when non-null |
| 6 | `to_state` | VARCHAR(30) | NULL | nullable for non-transition events; CHECK in CONSULT_STATES when non-null |
| 7 | `actor_id` | VARCHAR(26) | NULL | nullable for system-generated events |
| 8 | `metadata` | JSONB | NULL | nullable; per-event detail |
| 9 | `created_at` | TIMESTAMPTZ | NOT NULL | DEFAULT NOW() |

### Decision 2 — Column additions for Sprint 10+ clinical-decision transitions (CDM v1.3 §4.16 + §4.17 EXTENDED)

Sprint 9 implements transitions 1-6 + 16 (INITIATED → INTAKE → SUBMITTED → QUEUED, plus ABANDONED + EXPIRED). Sprint 10 will implement transitions 7-15 (AI preparation, clinician claim, decision, prescription, additional data, escalation, completion). Those transitions require additional columns that SHALL be ratified at SI-005 closure (not deferred to a future SI):

#### §4.16 Consult (Sprint 10+ column additions; +14 columns; total 24) (v0.4 R2 MEDIUM reconciliation — header reflects the 7 transition columns 11-17 + 7 KMS envelope columns 18-24 enumerated below)

| # | Column | Type | Nullable | Notes |
|---|---|---|---|---|
| 11 | `ai_workflow_execution_id` | VARCHAR(26) | NULL | nullable until AI prep completes; per PRD §13 row 3; cross-references ADR-029 AI workload taxonomy |
| 12 | `claiming_clinician_id` | VARCHAR(26) | NULL | nullable until QUEUED → UNDER_REVIEW; composite FK target on accounts |
| 13 | `claimed_at` | TIMESTAMPTZ | NULL | paired with `claiming_clinician_id`; both set atomically at claim transition |
| 14 | `terminal_state` | VARCHAR(30) | NULL | nullable until consult reaches a terminal state; CHECK IN ('PRESCRIBED','DECLINED','ESCALATED_TO_SYNC','EXPIRED','ABANDONED') |
| 15 | `terminal_at` | TIMESTAMPTZ | NULL | paired with `terminal_state`; both set atomically at terminal transition |
| 16 | `escalation_target_sync_session_id` | VARCHAR(26) | NULL | nullable; populated only when terminal_state='ESCALATED_TO_SYNC' AND the target sync session has been allocated |
| 17 | `last_state_transition_at` | TIMESTAMPTZ | NOT NULL | DEFAULT NOW(); updated by trigger on state column change; used for stale-consult detection |

**Encrypted-on-row clinical-rationale columns (v0.3 R1 MEDIUM closure — full KMS envelope ratified):** per SI-004 Decision 4 `consult.clinician_decision_recorded` detail discipline, the clinical-rationale text + decision payload live ENCRYPTED on the AsyncConsult row via the standard tenant-KMS encryption pattern. **v0.2 was inconsistent (labelled "NOT a column" then ratified column 18); v0.3 ratifies the full KMS envelope columns explicitly.** The envelope mirrors the existing pattern used by `forms_submission.encrypted_responses` + companion key-metadata columns (audited at migration 003 and forward).

| # | Column | Type | Nullable | Notes |
|---|---|---|---|---|
| 18 | `clinician_decision_encrypted` | BYTEA | NULL | nullable until clinician decision recorded; AES-256-GCM ciphertext of the canonical clinical-decision JSON (rationale text + decision payload) |
| 19 | `clinician_decision_kms_key_id` | TEXT | NULL | nullable iff column 18 is NULL; otherwise NOT NULL; the tenant-KMS data-key ID used to encrypt column 18; references the AWS KMS DEK envelope ID returned at encrypt-time. Distinct from `tenant.kms_key_alias` (the master-key alias) — this column carries the per-row DEK ID so key rotation can re-encrypt without losing audit-chain linkage to the original encryption event |
| 20 | `clinician_decision_kms_key_version` | INTEGER | NULL | nullable iff column 18 is NULL; otherwise NOT NULL; integer version of the DEK; supports rotation tracking; matches the version returned by KMS at the time of encrypt |
| 21 | `clinician_decision_nonce` | BYTEA | NULL | nullable iff column 18 is NULL; otherwise NOT NULL; the 12-byte AES-256-GCM nonce/IV (96-bit IV per NIST SP 800-38D §8.2.1). Random per-encryption; MUST never repeat for the same (key_id, key_version) pair |
| 22 | `clinician_decision_aad` | BYTEA | NULL | nullable iff column 18 is NULL; otherwise NOT NULL; the AES-256-GCM Additional Authenticated Data binding the ciphertext to the row context. Canonical AAD = `tenant_id \| consult_id \| 'clinician_decision' \| schema_version` (pipe-separated bytes). AAD binding prevents ciphertext-relocation attacks (an attacker who copies the ciphertext from consult X to consult Y cannot decrypt because the AAD no longer matches) |
| 23 | `clinician_decision_schema_version` | INTEGER | NULL | nullable iff column 18 is NULL; otherwise NOT NULL; integer schema version of the encrypted payload's plaintext structure; allows forward-compat plaintext schema migrations without re-encryption. Bound into the AAD per column 22 |
| 24 | `clinician_decision_encrypted_at` | TIMESTAMPTZ | NULL | nullable iff column 18 is NULL; otherwise NOT NULL; chain-of-custody timestamp; immutable per encrypt event |

**Key rotation semantics:** when tenant-KMS rotates the master key, a forward-fixup job decrypts column 18 with the old (key_id, key_version) pair, re-encrypts with the new pair, and updates columns 18-24 atomically. The original chain-of-custody is preserved by emitting a paired `consult_event{event_type='kms_rotation'}` row referencing both the old and new key_versions. The `encrypted_at` column 24 is NOT updated on re-encryption — it preserves the original-encryption timestamp; rotation produces a NEW `consult_event` row with `created_at=NOW()` for the rotation event.

**Integrity check:** the AES-256-GCM tag is included in column 18's ciphertext (per standard GCM ciphertext format: nonce + ciphertext + tag). Tag verification at decrypt time + AAD match together prove tamper-evidence; failure to verify is a `KmsIntegrityException` raised by `lib/tenant-kms.ts` (the standard decrypt path).

Total `consults` canonical column count at v1.3: **24 columns** (10 baseline + 7 Sprint 10+ additions + 7 KMS envelope columns for the clinical-decision encryption).

#### §4.17 ConsultEvent (Sprint 10+ column additions; +2 columns; total 11)

| # | Column | Type | Nullable | Notes |
|---|---|---|---|---|
| 10 | `correlation_id` | VARCHAR(26) | NULL | nullable; ULID; pairs related events (e.g., a prescription_creation_attempted with its terminal_success/rejected; matches SI-004 gate_correlation_id) |
| 11 | `audit_id` | VARCHAR(26) | NULL | nullable; ULID; references audit_records.audit_id for the audit row emitted same-tx with this event |

Total `consult_events` canonical column count at v1.3: **11 columns** (9 baseline + 2 Sprint 10+ additions).

### Decision 3 — Cross-tenant safety constraints (PERMANENT; preserved per v0.1)

The Codex async-consult-r1 HIGH closure (2026-05-05) added composite UNIQUE + 3 composite FKs. These are NOT placeholders. They are permanent cross-tenant safety guarantees that MUST be preserved through SI-005 ratification and any future schema extensions:

1. `consults UNIQUE (tenant_id, id)` — required to support consult_events composite FK
2. `consults FK (tenant_id, patient_id) → accounts (tenant_id, account_id)` — patient ownership cross-tenant binding prevention
3. `consults FK (tenant_id, intake_form_submission_id) → forms_submission (tenant_id, submission_id)` — intake binding cross-tenant prevention
4. `consult_events FK (tenant_id, consult_id) → consults (tenant_id, id)` — event history cross-tenant prevention

**v0.2 additions to the cross-tenant safety constraint set** (for the Decision 2 Sprint 10+ columns):

5. `consults FK (tenant_id, claiming_clinician_id) → accounts (tenant_id, account_id)` — clinician claim cross-tenant prevention; matches constraint #2 shape
6. `consults FK (tenant_id, ai_workflow_execution_id) → ai_workflow_executions (tenant_id, ai_workflow_execution_id)` — AI workflow cross-tenant prevention (requires ai_workflow_executions table to ship its composite UNIQUE concurrently; flag for SI-008 if needed)
7. `consults FK (tenant_id, escalation_target_sync_session_id) → sync_sessions (tenant_id, sync_session_id)` — sync handoff cross-tenant prevention (requires sync_sessions table; deferred until sync-consult slice ships)

### Decision 4 — CONSULT_STATES enum vocabulary (17 values; per State Machines v1.1 §3)

The `state` column CHECK constraint enumerates the CONSULT_STATES vocabulary. v1.3 ratifies the 17-value list per State Machines v1.1 §3:

1. `INITIATED`
2. `INTAKE`
3. `SUBMITTED`
4. `QUEUED`
5. `UNDER_REVIEW`
6. `AI_PREPARED`
7. `AWAITING_DATA`
8. `PRESCRIBED`
9. `DECLINED`
10. `ESCALATED_TO_SYNC`
11. `FOLLOW_UP`
12. `COMPLETED`
13. `ABANDONED`
14. `EXPIRED`
15. `CANCELLED` (transition 4 + 8; explicit cancel by patient or clinician)
16. `RETRACTED` (transition 14; clinician retraction of decision pending audit ratification)
17. `ARCHIVED` (terminal-tail; long-term storage state, separate from completed for compliance retention purposes)

**State-machine reconciliation note:** State Machines v1.1 §3 currently enumerates 17 transitions but the state-set enumeration is implicit in the transition edges. SI-005 ratification SHALL fold the state-set enumeration into State Machines v1.2 (separate spec doc; SI-005 raises a paired SI if necessary; preliminary check: enumeration matches the 17 distinct from_state/to_state values in the transition list).

### Decision 5 — CONSULT_EVENT_TYPES vocabulary (v0.4 R2 MEDIUM closure — kms_rotation added)

The `event_type` column CHECK constraint enumerates the CONSULT_EVENT_TYPES vocabulary. v1.3 ratifies 6 event-type values at SI-005 closure (v0.2 had 5; v0.4 R2 MEDIUM-3 closure adds `kms_rotation` because the Decision 2 KMS-envelope key-rotation semantics require emitting it):

1. `state_transition` — paired with non-null from_state + to_state; the primary event type for state-machine driven transitions
2. `ai_workflow_completed` — emitted when an AI workflow execution returns a result; paired with metadata.ai_workflow_execution_id
3. `clinician_note_added` — emitted when a clinician adds a free-form note (encrypted on the consult row); paired with metadata.note_id
4. `patient_message_received` — emitted when a patient submits a message; paired with metadata.message_id
5. `clinician_message_sent` — emitted when a clinician sends a message; paired with metadata.message_id
6. `kms_rotation` (v0.4 NEW) — emitted by the tenant-KMS rotation forward-fixup job when columns 18-24 are re-encrypted under a new (key_id, key_version). Paired metadata: `{ old_kms_key_id, old_kms_key_version, new_kms_key_id, new_kms_key_version, rotated_at, rotation_batch_id }`. The from_state/to_state columns are NULL for kms_rotation events (rotation does not change consult state). actor_id is the system rotation-job actor (`system:kms_rotation_job`). The rotation is observable in compliance audits via the canonical event without exposing the master key in either column.

**Cross-alignment with SI-004 audit events:** for state_transition events, the paired audit event from SI-004's 14-event canonical list MUST also emit same-tx via the standard same-tx pattern (audit_records INSERT + consult_events INSERT in the same transaction; both reference the same `correlation_id` per Decision 2 column 10). For kms_rotation events, the paired audit event is `system.kms_rotation_completed` from the broader KMS-ops audit catalog (cross-references SI-002 v5.5 Category B governance events; if not yet enumerated there, a paired SI MUST be raised at SI-005 ratification).

### Decision 6 — Sprint 10+ cross-entity coordination table (mirror SI-007 cross-entity discipline)

Sprint 10+ transitions span Consult → MedicationRequest (via `consult.prescription_created`), Consult → AiWorkflowExecution (via `ai_workflow_execution_id`), and Consult → SyncSession (via `escalation_target_sync_session_id`). Each cross-entity handoff MUST emit BOTH entities' state transitions atomically in a single tx (per I-016 same-tx outbox):

| Source transition | Target entity transition | Required atomic tx |
|---|---|---|
| Consult: UNDER_REVIEW → PRESCRIBED | MedicationRequest: created | YES (already enforced by SI-007 P-013 pattern for refill; same shape) |
| Consult: SUBMITTED → AI_PREPARED | AiWorkflowExecution: completed | YES (AI workflow may emit first; consult transitions on workflow result) |
| Consult: UNDER_REVIEW → ESCALATED_TO_SYNC | SyncSession: allocated | YES; SyncSession table arrives with sync-consult slice (SI-009; not yet raised) |
| Consult: QUEUED → UNDER_REVIEW | (claim is internal to consult; no cross-entity write) | N/A |
| Consult: PRESCRIBED → COMPLETED | MedicationRequest: (no change required at completion; the MR has its own terminal lifecycle) | N/A |

### Decision 7 — Cross-SI alignment

**SI-001 cross-alignment:** Sprint 10's PRESCRIBED transition writes a `medication_request` row paired with the consult update. SI-001 closure at P-011 ratified medication_request canonical schema; SI-005 inherits that envelope. Composite FK (tenant_id, medication_request_id) on the consult side is NOT proposed — the medication_request side carries the back-reference via `medication_request.consult_id` composite FK to (tenant_id, consult_id). This is consistent with SI-007's Refill→Dispensing→Shipment chain where the upstream entity carries the reference.

**SI-004 cross-alignment:** every state_transition consult_event has a paired audit_records row per SI-004's 14-event canonical list. The pairing is via `consult_event.audit_id` ↔ `audit_records.audit_id`. SI-004 v0.5 finalized Category B/C assignment; SI-005 inherits no schema impact from that.

**SI-007 precedent:** SI-007 ratified Refill + Dispensing + Shipment schemas + a cross-entity coordination table + composite FKs. SI-005 follows the SAME shape for Consult + ConsultEvent + cross-entity coordination. Same discipline applies: composite UNIQUE + composite FKs are PERMANENT cross-tenant safety guarantees that ratification cannot relax.

**SI-002 / SI-003 cross-alignment:** the v1.0 CI guardrail (G-1 through G-5 per SI-003) applies — any new consult/consult_event direct table access outside the async-consult module path must go through @platform-eventing-team review per CODEOWNERS. SI-005 ratification SHALL extend the `docs/outbox-consumer-registry.yaml` manifest with a `src/modules/async-consult/**` entry once that module ships (purpose: emits-only).

### Decision 8 — Migration discipline (no destructive rewrites; mirror SI-007 P-013 pattern; v0.4 R2 MEDIUM closure enumerates all 14 columns)

SI-005 closure produces a migration 020a (or sequentially-numbered) that performs the following ALTERs in order:

1. **Add the 7 Sprint 10+ transition columns to `consults`** (Decision 2; nullable so existing rows pass the schema-add):
   - 11. `ai_workflow_execution_id VARCHAR(26) NULL`
   - 12. `claiming_clinician_id VARCHAR(26) NULL`
   - 13. `claimed_at TIMESTAMPTZ NULL`
   - 14. `terminal_state VARCHAR(30) NULL CHECK (terminal_state IS NULL OR terminal_state IN ('PRESCRIBED','DECLINED','ESCALATED_TO_SYNC','EXPIRED','ABANDONED'))`
   - 15. `terminal_at TIMESTAMPTZ NULL`
   - 16. `escalation_target_sync_session_id VARCHAR(26) NULL`
   - 17. `last_state_transition_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` (with a state-column trigger to update on transitions)
2. **Add the 7 KMS envelope columns to `consults`** (per the encrypted-blob ratification at lines 18-24; v0.4 R2 MEDIUM-2 closure: NO ambiguous "encrypted-blob column" wording — all 7 columns enumerated):
   - 18. `clinician_decision_encrypted BYTEA NULL`
   - 19. `clinician_decision_kms_key_id TEXT NULL`
   - 20. `clinician_decision_kms_key_version INTEGER NULL`
   - 21. `clinician_decision_nonce BYTEA NULL`
   - 22. `clinician_decision_aad BYTEA NULL`
   - 23. `clinician_decision_schema_version INTEGER NULL`
   - 24. `clinician_decision_encrypted_at TIMESTAMPTZ NULL`
3. **Add a CHECK constraint enforcing all-or-none nullability across columns 18-24** to prevent partial-encryption rows that would be undecipherable:
   ```sql
   CHECK (
     (clinician_decision_encrypted IS NULL
       AND clinician_decision_kms_key_id IS NULL
       AND clinician_decision_kms_key_version IS NULL
       AND clinician_decision_nonce IS NULL
       AND clinician_decision_aad IS NULL
       AND clinician_decision_schema_version IS NULL
       AND clinician_decision_encrypted_at IS NULL)
     OR
     (clinician_decision_encrypted IS NOT NULL
       AND clinician_decision_kms_key_id IS NOT NULL
       AND clinician_decision_kms_key_version IS NOT NULL
       AND clinician_decision_nonce IS NOT NULL
       AND clinician_decision_aad IS NOT NULL
       AND clinician_decision_schema_version IS NOT NULL
       AND clinician_decision_encrypted_at IS NOT NULL)
   )
   ```
4. **Add CHECK constraints enforcing nonce + schema_version semantics:**
   - `CHECK (clinician_decision_nonce IS NULL OR octet_length(clinician_decision_nonce) = 12)` — 12-byte AES-256-GCM IV per NIST SP 800-38D §8.2.1
   - `CHECK (clinician_decision_schema_version IS NULL OR clinician_decision_schema_version >= 1)` — version must be a positive integer
5. **Add a row-level trigger on `consults`** to enforce immutability of `clinician_decision_encrypted_at`: BEFORE UPDATE, raise an exception if `OLD.clinician_decision_encrypted_at IS NOT NULL AND NEW.clinician_decision_encrypted_at IS DISTINCT FROM OLD.clinician_decision_encrypted_at`. Key-rotation operations are EXEMPT from this trigger via a session variable (set by `lib/tenant-kms.ts` rotation routine).
6. **Add the 2 Sprint 10+ columns to `consult_events`** (Decision 2):
   - 10. `correlation_id VARCHAR(26) NULL`
   - 11. `audit_id VARCHAR(26) NULL`
7. **Extend `consult_events.event_type` CHECK constraint** to include the 6 ratified values (Decision 5; v0.4 adds `kms_rotation`):
   ```sql
   CHECK (event_type IN ('state_transition','ai_workflow_completed','clinician_note_added',
                         'patient_message_received','clinician_message_sent','kms_rotation'))
   ```
8. **Add the 3 new composite FK constraints** (5, 6, 7 per Decision 3 v0.2 additions; constraints 6 and 7 deferred behind their target tables landing):
   - FK 5 added unconditionally (accounts already shipped)
   - FK 6 + FK 7 declared as DEFERRED in the migration comment and added by a future migration when ai_workflow_executions + sync_sessions tables ship
9. **Backfill `last_state_transition_at` for existing rows** to `updated_at` (the pre-Sprint-10+ rows' best-available proxy for the timestamp).
10. **Remove the `-- v0.1 placeholder columns; SI-005 resume gate` SQL comments** from migration 020 (forward-fixup commit).

**Total ALTER count: +14 columns on `consults` + 2 columns on `consult_events` + 5 new CHECK constraints + 1 trigger + 1 composite FK + 2 deferred composite FKs.** All-or-none nullability + nonce length + schema version constraints + immutability trigger guarantee that any row with non-NULL encrypted data has the full KMS envelope necessary for decrypt, rotation, audit, and tamper-resistance.

**Zero destructive rewrites.** The 10 baseline placeholder columns are ratified, not replaced.

### Decision 9 — Reserved column-name namespace (forward-compat)

The following column names are RESERVED at SI-005 closure but NOT yet added to the canonical schema. Reserved-but-not-implemented; if a future SI raises a need for these, the name MUST match the reserved entry verbatim:

- `consults.crisis_event_id` — reserved for I-019 crisis-detection-gate pairing per SI-004 reserved event `consult.crisis_resource_surfaced`
- `consults.research_export_request_id` — reserved for SI-004 reserved event `consult.data_export_requested`; references ADR-028 research-data Posture A
- `consults.safety_review_id` — reserved for SI-004 reserved event `consult.reviewed_by_safety_team`; references §16.3 platform-clinical-governance safety-review workflow (separate SI to be raised)

Per SI-003 Decision 7A discipline, reserved column-name strings SHALL be added to a `canonical_column_reserved_registry` section of the CDM v1.3 artifact so the v1.0 CI guardrail catches premature column additions.

## Resolution path (v0.2 updated)

### Step 1 (spec corpus, owned by Engineering Lead + Privacy/Compliance + Codex pre-ratification reviewer)

1. **Codex pre-ratification gate** — multi-round adversarial review against v0.2+ proposals. Mirror SI-007 cadence (SI-007 ran 18 rounds for a comparable scope; SI-005 may need fewer because it inherits SI-004's prescription-gate discipline + SI-007's cross-entity coordination pattern).
2. Engineering Lead + Privacy/Compliance ratify after Codex convergence.
3. Author CDM v1.3 §4.16 + §4.17 row-shape blocks per Decision 1+2.
4. Author the CONSULT_STATES + CONSULT_EVENT_TYPES enum vocabularies per Decision 4+5.
5. Author the cross-entity coordination table per Decision 6.
6. Author the reserved-column-name registry per Decision 9.
7. Promotion Ledger entry **P-017** closes this SI.

### Step 2 (this code repo, owned by Engineering)

1. Migration 020a (or sequentially-numbered) implements Decision 8 (add Sprint 10+ columns + cross-tenant FKs + remove placeholder comments).
2. Sprint 10 emit code uses the ratified columns directly (no further placeholder phase).
3. Sprint 10 audit emission references SI-004's canonical event names (which are ratified concurrently per cross-SI alignment).
4. SI-005 status → "Resolved"; placeholder column SQL comments removed.

## What I'm doing in the meantime (v0.1 unchanged)

Sprint 9 ships placeholder columns + this SI doc as resume gate. Sprint 10+ extends placeholder set per Decision 2 (in a single migration ALTER), but the column names match the canonical names verbatim — zero rename required.

Same autonomous-turn discipline as SI-002/003/004/007: **never invent new canonical contract artifacts in the code repo.** Spec gaps surface as SIs.

## Required from product (v0.2 updated)

| Item | Owner | Severity |
|---|---|---|
| CDM v1.3 §4.16 + §4.17 row-shape blocks ratified per Decision 1+2 | Engineering Lead + Privacy/Compliance | medium |
| CONSULT_STATES enum vocabulary (Decision 4) | Engineering Lead + State-machine team | medium |
| CONSULT_EVENT_TYPES vocabulary (Decision 5) | Engineering Lead | low |
| Cross-entity coordination table (Decision 6) | Engineering Lead + Pharmacy / AI-service / Sync-consult team leads | medium |
| Cross-SI alignment (Decision 7) | Engineering Lead | low |
| Migration 020a discipline (Decision 8) | Engineering | low |
| Reserved-column-name registry (Decision 9) | Engineering Lead | low |

---

## Cross-references

- EHBG v1.3 §7 + §12 — canonical-schema authorship + SI escalation
- CDM v1.2 §3 entity inventory (Consult + ConsultEvent at lines 84-85)
- State Machines v1.1 §3 — 17 CONSULT_STATES values implicit in transition edges
- I-003 — audit append-only (preserved across schema migrations)
- I-016 — same-tx outbox (paired audit + consult_event emission)
- I-023 — tenant_id denormalized for RLS
- SI-001 — MedicationRequest schema (closed P-011; cross-references PRESCRIBED transition)
- SI-002 — AUDIT_EVENTS baseline (merged P-014 2026-05-14)
- SI-003 — DOMAIN_EVENTS placeholder ratification + CI guardrail (PR #137 in flight)
- SI-004 — Async-Consult audit events (PR #138 in flight; companion to SI-005)
- SI-007 — Refill/Dispensing/Shipment schema (merged P-013 2026-05-14; precedent)

## Companion code-repo state at SI-005 v0.2 (unchanged from v0.1)

- Sprint 9 ships placeholder consults + consult_events tables with 4 cross-tenant safety constraints (composite UNIQUE + 3 composite FKs).
- Sprint 10+ extends placeholder set per Decision 2.
- Migration 020a at SI-005 closure adds the canonical columns + cross-tenant FKs without destructive rewrite.

## Resolution expectations (v0.2 updated)

- **Target close-out:** Promotion Ledger entry **P-017** (P-013 SI-007 merged, P-014 SI-002 merged, P-015 SI-003 in flight, P-016 SI-004 in flight). CDM bumps **v1.2 → v1.3** at promotion.
- **Codex pre-ratification gate:** multi-round adversarial review (target: 4-8 rounds, narrower than SI-007's 18 rounds because SI-005 inherits SI-007's coordination pattern + SI-004's prescription-gate discipline).
- **Until then:** SI-005 stays open; Sprint 9 ships placeholder columns; Sprint 10+ extends placeholder set with canonical names per Decision 2.
