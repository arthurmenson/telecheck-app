# SI-005 — Consult / ConsultEvent schema gap (CDM v1.2)

**Raised by:** Engineering (autonomous turn 2026-05-05; Sprint 9 PM kickoff verification gate; filed at TLC-021a)
**Date:** 2026-05-05
**Severity:** medium → **HIGH at v0.2 expansion 2026-05-17** (sub-ceremony 3 ratification adds clinician-decision branches + 2 deferred FKs + SECURITY DEFINER procedure + 8-column KMS envelope; full canonical row shape needed to unblock Sprint 10+ Async Consult clinician-decision implementation)
**Status:** **OPEN — v0.2 DRAFT** (pre-Codex pre-ratification gate; sub-ceremony 3 of Q2 2026 ratifier ceremony 2026-05-17 ratified the 6-decision expansion path per Evans's "ratify" chat-message after Sub-Ceremony 3 Decision Brief review; v0.2 captures the ratified expansion; Codex pre-ratification gate ahead per SI-007/008/009/009.1 retrospective discipline)
**Target spec doc:** `Telecheck_Canonical_Data_Model_v1_2.md`
**Target slice PRD:** `Telecheck_Async_Consult_Slice_PRD_v1_0.md`
**Target Promotion Ledger entry:** **P-021** (per the post-sub-ceremony-2 cascade: SI-009.1 took P-020 per Evans's successor-packaging choice 2026-05-17; SI-005 → P-021; SI-010 → P-022; SI-011 umbrella → P-023; SI-012/013/014 → P-024/025/026. Pre-cascade target was P-017 per the SI-008 status-block sequencing chain established 2026-05-15.)
**Cluster B HARD-sequencing status:** **UNBLOCKED** at sub-ceremony 2 — SI-008 P-018 + SI-009 P-019 ratification-intent landed 2026-05-17 (PR `arthurmenson/telecheckONE#2` merged `74c189b`). SI-005's FK 6 + FK 7 can now reference canonical SI-008/SI-009 targets via triple-composite forward pointers.
**Companion SIs:** SI-008 (P-018; FK 6 target — `ai_workflow_executions`), SI-009 (P-019; FK 7 target — `sync_sessions`), SI-004 (Async Consult audit events — sub-ceremony 5 per Evans's ordering; same Async-Consult slice scope)

---

## v0.2 Canonical Expansion (Sub-Ceremony 3 ratified 2026-05-17 — pre-Codex pre-ratification gate)

Per Evans's 2026-05-17 sub-ceremony 3 ratification ("ratify" chat-message after Sub-Ceremony 3 Decision Brief review; defaulted to "all 6 ratifier decisions as recommended"), this section captures the canonical row shape expansion. The original Sprint 9 placeholder columns (preserved unedited in "Placeholder column set" sections below) become the **canonical base** + this section adds the clinician-decision branches + the 2 deferred FK wirings + the SECURITY DEFINER procedure + the append-only invariants.

### 6 Evans-ratified sub-ceremony 3 decisions (verbatim provenance)

| # | Ratified decision | Recommendation followed |
| :---: | --- | --- |
| **1** | FK 6 wiring to SI-008 ai_workflow_executions: triple-composite `(tenant_id, id, ai_workflow_execution_id) → ai_workflow_executions(tenant_id, consult_id, id)` | Yes — per SI-008 R5 closure (declarative same-consult enforcement). Two-column shape REJECTED. |
| **2** | FK 7 wiring to SI-009 sync_sessions: triple-composite `(tenant_id, id, escalation_target_sync_session_id) → sync_sessions(tenant_id, originating_consult_id, id)` | Yes — per SI-009 R1 closure (same-tenant + same-originating-consult lineage). |
| **3** | Clinician-decision branch columns (5 column groups): `decided_by_clinician_account_id` + `clinician_decision_class` enum + `clinician_decision_at` + `clinician_decision_rationale_encrypted` 8-column KMS envelope + `clinician_decision_audit_id` (I-012 evidence FK) | Yes — full 5-group expansion. 5-value `clinician_decision_class` enum: `approved \| declined \| requires_more_info \| escalated_to_sync \| deferred`. |
| **4** | Two-tier append-only on clinician decision (Tier 1 payload + KMS envelope immutable post-decision; Tier 2 state-machine progression allowed via guarded service-layer transitions) | Yes — same discipline as SI-007/SI-008/SI-009.1 R2-R5 closure precedent. |
| **5** | `record_consult_clinician_decision()` SECURITY DEFINER procedure as ONLY write path to clinician-decision columns; SET LOCAL actor binding via SI-010 (IMPL-readiness gate); three-tier audit durability; shared `audit_swap_rejection_log` table | Yes — mirrors SI-008's `record_workflow_pointer_swap()` + SI-009's `record_consult_escalation_target_swap()`. |
| **6** | `consult_events` strict append-only via BEFORE UPDATE + BEFORE DELETE triggers (forensic-evidence semantics per I-027 audit-chain precedent) | Yes — even system-error correction goes through INSERTing a compensating event, not mutating prior events. |

### Canonical `consults` table column set (v0.2 expansion of Sprint 9 placeholder)

```sql
-- v0.2 canonical column set per Evans's 2026-05-17 sub-ceremony 3
-- ratification. Base 10 columns from Sprint 9 / TLC-021a placeholder
-- preserved verbatim; 12 new columns added (5 clinician-decision groups
-- including 8-column KMS envelope + 2 FK forward-pointer columns).

-- ===== BASE 10 COLUMNS (Sprint 9 / TLC-021a placeholder — preserved) =====
id                                  VARCHAR(26)  PRIMARY KEY
tenant_id                           TEXT         NOT NULL REFERENCES tenants(id)
patient_id                          VARCHAR(26)  NOT NULL  -- composite FK below
consult_type                        VARCHAR(50)  NOT NULL CHECK (consult_type IN ('program', 'general'))
modality                            VARCHAR(20)  NOT NULL CHECK (modality IN ('async', 'sync'))  -- per PRD §1; ADR-012 conversion
state                               VARCHAR(30)  NOT NULL CHECK (...)  -- CONSULT_STATES enum (17 values per State Machines §3)
current_program_catalog_entry_id    VARCHAR(26)  NULL  -- nullable; PRD §15 dependency on Program Catalog
intake_form_submission_id           VARCHAR(26)  NULL  -- nullable; PRD §15 dependency on Forms-Intake; populated at INTAKE → SUBMITTED
created_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
updated_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW()

-- ===== NEW: 2 FK FORWARD-POINTER COLUMNS (sub-decisions #1 + #2 — now-unblocked deferred FKs) =====
ai_workflow_execution_id            VARCHAR(26)  NULL  -- triple-composite FK 6 to SI-008 ai_workflow_executions
escalation_target_sync_session_id   VARCHAR(26)  NULL  -- triple-composite FK 7 to SI-009 sync_sessions

-- ===== NEW: 5 CLINICIAN-DECISION COLUMN GROUPS (sub-decision #3) =====
decided_by_clinician_account_id     VARCHAR(26)  NULL  -- composite FK to accounts; populated at clinician-decision transition
clinician_decision_class            VARCHAR(40)  NULL CHECK (clinician_decision_class IS NULL OR clinician_decision_class IN ('approved', 'declined', 'requires_more_info', 'escalated_to_sync', 'deferred'))
clinician_decision_at               TIMESTAMPTZ  NULL  -- timestamp of decision
clinician_decision_audit_id         VARCHAR(26)  NULL  -- composite FK to audit_records; I-012 clinical-decision evidence

-- ===== NEW: 8-COLUMN KMS ENVELOPE for clinician rationale (sub-decision #3; mirrors SI-005 Decision 8 / SI-008 pattern) =====
clinician_decision_rationale_encrypted          BYTEA      NULL  -- KMS-encrypted clinician rationale text
clinician_decision_rationale_kms_key_id         TEXT       NULL
clinician_decision_rationale_kms_key_version    INTEGER    NULL
clinician_decision_rationale_nonce              BYTEA      NULL
clinician_decision_rationale_aad                BYTEA      NULL
clinician_decision_rationale_schema_version     INTEGER    NULL
clinician_decision_rationale_encrypted_at       TIMESTAMPTZ NULL
clinician_decision_rationale_dek_ciphertext     BYTEA      NULL

-- ===== TOTAL: 10 base + 2 FKs + 5 clinician-decision + 8 envelope = 25 columns =====

-- ===== Composite UNIQUE for cross-entity composite FK safety (per Sprint 9 R1 closure; preserved) =====
UNIQUE (tenant_id, id)

-- Triple-composite UNIQUE required so SI-008 forward FK CAN reference
-- (per the SI-008 v0.3 R4 closure precedent; same pattern here for
-- SI-005 ↔ SI-008 forward-pointer triple-composite):
UNIQUE (tenant_id, id, ai_workflow_execution_id)  -- TBD: verify at Codex pre-ratification gate
-- ^ Open question OQ1: is this triple-composite UNIQUE needed for the
--   FK 6 referential target, OR does the (tenant_id, id) UNIQUE
--   suffice? Codex round to confirm.

-- ===== Composite FKs (Sprint 9 R1 closures preserved + 2 new FKs from sub-decisions #1 + #2) =====
FOREIGN KEY (tenant_id, patient_id) REFERENCES accounts (tenant_id, account_id)
FOREIGN KEY (tenant_id, intake_form_submission_id)
    REFERENCES forms_submission (tenant_id, submission_id)
FOREIGN KEY (tenant_id, decided_by_clinician_account_id) REFERENCES accounts (tenant_id, account_id)
FOREIGN KEY (tenant_id, clinician_decision_audit_id) REFERENCES audit_records (tenant_id, audit_id)

-- ===== NEW: FK 6 triple-composite (per sub-decision #1) =====
FOREIGN KEY (tenant_id, id, ai_workflow_execution_id)
    REFERENCES ai_workflow_executions (tenant_id, consult_id, id)
-- ^ Enforces SAME-TENANT AND SAME-CONSULT lineage declaratively per
--   SI-008 R5 closure. Two-column shape (tenant_id, ai_workflow_execution_id)
--   → (tenant_id, id) REJECTED throughout this SI + SI-008.

-- ===== NEW: FK 7 triple-composite (per sub-decision #2) =====
FOREIGN KEY (tenant_id, id, escalation_target_sync_session_id)
    REFERENCES sync_sessions (tenant_id, originating_consult_id, id)
-- ^ Enforces SAME-TENANT AND SAME-ORIGINATING-CONSULT lineage
--   declaratively per SI-009 R1 closure. The forward pointer can ONLY
--   point at a sync_session whose originating_consult_id equals this
--   consult's id — DB-enforced, regardless of which code path mutates.
```

### Canonical `consult_events` table column set (Sprint 9 placeholder — UNCHANGED; sub-decision #6 ratifies strict append-only enforcement)

```sql
-- v0.2 canonical column set per Evans's 2026-05-17 sub-ceremony 3
-- ratification. Sprint 9 / TLC-021a placeholder columns preserved
-- VERBATIM (no v0.2 column changes for consult_events). Sub-decision #6
-- adds DB-layer strict append-only enforcement via BEFORE UPDATE +
-- BEFORE DELETE triggers — events table is forensic evidence per
-- I-027 audit-chain precedent.

id           VARCHAR(26)  PRIMARY KEY
consult_id   VARCHAR(26)  NOT NULL  -- composite FK below; not bare REFERENCES
tenant_id    TEXT         NOT NULL REFERENCES tenants(id)  -- denormalized for RLS
event_type   VARCHAR(80)  NOT NULL  -- e.g. 'state_transition', 'clinician_decision_recorded'
from_state   VARCHAR(30)  NULL  -- nullable for non-transition events
to_state     VARCHAR(30)  NULL  -- nullable for non-transition events
actor_id     VARCHAR(26)  NULL  -- nullable for system-generated events
metadata     JSONB        NULL  -- nullable; per-event detail
created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()

-- ===== Composite FK preserved from Sprint 9 R1 closure =====
FOREIGN KEY (tenant_id, consult_id) REFERENCES consults (tenant_id, id)

-- ===== NEW: Strict append-only enforcement (sub-decision #6) =====
-- BEFORE UPDATE trigger rejects ANY UPDATE attempt:
CREATE OR REPLACE FUNCTION consult_events_reject_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'consult_events(% / %): forensic evidence; no UPDATEs permitted (I-027 audit-chain precedent; sub-decision #6 ratification 2026-05-17). Use INSERT of a compensating event instead of mutation.', NEW.tenant_id, NEW.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consult_events_strict_append_only_update
  BEFORE UPDATE ON consult_events
  FOR EACH ROW
  EXECUTE FUNCTION consult_events_reject_update();

-- BEFORE DELETE trigger rejects ANY DELETE attempt:
CREATE OR REPLACE FUNCTION consult_events_reject_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'consult_events(% / %): forensic evidence; no DELETEs permitted (I-027 audit-chain precedent; sub-decision #6 ratification 2026-05-17). Forensic events are append-only forever.', OLD.tenant_id, OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consult_events_strict_append_only_delete
  BEFORE DELETE ON consult_events
  FOR EACH ROW
  EXECUTE FUNCTION consult_events_reject_delete();
```

### Two-tier append-only invariant on `consults` clinician-decision columns (sub-decision #4)

Mirrors SI-007 / SI-008 / SI-009.1 R2-R5 closure two-tier discipline.

**Tier 1 — Clinician-decision payload + envelope immutable post-decision** (once `clinician_decision_class IS NOT NULL`, the following columns are FROZEN):

- `decided_by_clinician_account_id` — clinician identity is immutable post-decision
- `clinician_decision_class` — decision class is immutable
- `clinician_decision_at` — decision timestamp is immutable
- `clinician_decision_audit_id` — I-012 evidence audit row FK is immutable (the audit row itself is append-only per I-027)
- All 8 envelope columns (`clinician_decision_rationale_*`) — clinical rationale encryption envelope is immutable

**Tier 2 — Allowed state-machine transitions** (state column + state-transition timestamps remain mutable, but ONLY through guarded service-layer transitions invoked AFTER `clinician_decision_class IS NOT NULL`):

- `state`: transitions per State Machines §3 (e.g., `clinician_approved → fulfillment_dispatched` via downstream slice work like Pharmacy or Sync-Consult escalation). Allowed via `UPDATE ... WHERE clinician_decision_class IS NOT NULL AND state IN (<allowed_prior_set>)` guard.
- `updated_at`: bumped on each allowed state transition.
- `current_program_catalog_entry_id`: MAY be updatable if a downstream slice work amends program assignment (TBD at Codex pre-ratification gate; OQ2).
- All other columns (Tier 1 list above): FROZEN; any attempted UPDATE rejected at repository + DB-trigger layers.

**Tier 0 — Always-immutable columns** (frozen from INSERT regardless of state):

- `id`, `tenant_id`, `patient_id`, `consult_type`, `modality`, `created_at`

**Non-bypassable Tier 2 enforcement** via BEFORE UPDATE trigger (mirrors SI-009.1 R5 closure pattern):

```sql
CREATE OR REPLACE FUNCTION consults_reject_post_decision_payload_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.clinician_decision_class IS NOT NULL THEN
    -- Tier 1 payload immutability: reject if any Tier 1 column changed
    IF NEW.decided_by_clinician_account_id IS DISTINCT FROM OLD.decided_by_clinician_account_id
       OR NEW.clinician_decision_class IS DISTINCT FROM OLD.clinician_decision_class
       OR NEW.clinician_decision_at IS DISTINCT FROM OLD.clinician_decision_at
       OR NEW.clinician_decision_audit_id IS DISTINCT FROM OLD.clinician_decision_audit_id
       OR NEW.clinician_decision_rationale_encrypted IS DISTINCT FROM OLD.clinician_decision_rationale_encrypted
       OR NEW.clinician_decision_rationale_kms_key_id IS DISTINCT FROM OLD.clinician_decision_rationale_kms_key_id
       OR NEW.clinician_decision_rationale_kms_key_version IS DISTINCT FROM OLD.clinician_decision_rationale_kms_key_version
       OR NEW.clinician_decision_rationale_nonce IS DISTINCT FROM OLD.clinician_decision_rationale_nonce
       OR NEW.clinician_decision_rationale_aad IS DISTINCT FROM OLD.clinician_decision_rationale_aad
       OR NEW.clinician_decision_rationale_schema_version IS DISTINCT FROM OLD.clinician_decision_rationale_schema_version
       OR NEW.clinician_decision_rationale_encrypted_at IS DISTINCT FROM OLD.clinician_decision_rationale_encrypted_at
       OR NEW.clinician_decision_rationale_dek_ciphertext IS DISTINCT FROM OLD.clinician_decision_rationale_dek_ciphertext
    THEN
      RAISE EXCEPTION 'consults(% / %): clinician-decision payload columns are immutable post-decision (Tier 1 append-only per SI-005 v0.2 sub-decision #4 ratification 2026-05-17). Only state + updated_at + (TBD) current_program_catalog_entry_id may transition.', NEW.tenant_id, NEW.id;
    END IF;
  END IF;
  -- Tier 0 always-immutable columns: reject any change regardless of decision state
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.consult_type IS DISTINCT FROM OLD.consult_type
     OR NEW.modality IS DISTINCT FROM OLD.modality
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'consults(% / %): Tier 0 identity/temporal columns are immutable from INSERT (per SI-005 v0.2 ratification 2026-05-17).', NEW.tenant_id, NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER consults_two_tier_append_only
  BEFORE UPDATE ON consults
  FOR EACH ROW
  EXECUTE FUNCTION consults_reject_post_decision_payload_update();
```

### `record_consult_clinician_decision()` SECURITY DEFINER procedure (sub-decision #5)

The ONLY write path to `consults` clinician-decision columns. Application code's role has NO direct UPDATE privilege. Mirrors SI-008's `record_workflow_pointer_swap()` + SI-009's `record_consult_escalation_target_swap()` patterns.

**Procedure signature:**
```sql
record_consult_clinician_decision(
    p_consult_id                                VARCHAR(26),
    p_tenant_id                                 TEXT,
    p_clinician_decision_class                  VARCHAR(40),
    p_rationale_encrypted_payload               JSONB,  -- 8 envelope columns as nested JSONB
    p_audit_event_id                            VARCHAR(26)  -- pre-emitted I-012 evidence audit row
) RETURNS (success: BOOLEAN, rejection_code: TEXT, rejection_detail: JSONB)
```

**SECURITY DEFINER + SET LOCAL actor binding:** procedure derives caller identity from `current_actor_account_id()` / `current_actor_account_tenant_id()` / `current_actor_role()` (DEFERRED to SI-010 landing per IMPL-readiness gate). No caller-supplied actor identity.

**Validation steps (in order):**
1. Row-locks `consults` row + `audit_records` row by `p_audit_event_id` (canonical id-order to prevent deadlocks)
2. Validates `current_actor_role() ∈ {clinician, tenant_admin, platform_admin}` (else `rejection_code='unauthenticated'`)
3. Validates `current_actor_account_tenant_id() = p_tenant_id` for non-platform-admin (else `rejection_code='cross_tenant_attempt'`)
4. Validates `consults.state ∈ {'clinician_review'}` (else `rejection_code='consult_state_invalid'`)
5. Validates `consults.clinician_decision_class IS NULL` — one-shot decision per consult (else `rejection_code='decision_already_recorded'`)
6. Validates `p_clinician_decision_class IN ('approved', 'declined', 'requires_more_info', 'escalated_to_sync', 'deferred')` (else `rejection_code='invalid_decision_class'`)
7. Validates `audit_records.action_id = 'consult.clinician_decision_recorded'` AND `audit_records.actor_id = current_actor_account_id()` (else `rejection_code='audit_mismatch'`)
8. Performs atomic UPDATE on `consults` (sets all 5 clinician-decision column groups; sets `decided_by_clinician_account_id = current_actor_account_id()`; sets `state` per the decision-class transition map) + INSERTs paired `consult_events` row capturing the transition
9. Returns `(success=true)` tuple

**Failure behavior:** SAVEPOINT-rollback + autonomous-transaction rejection log + caller-required-commit-boundary (three-tier audit durability mirroring SI-008 R14 closure). Shared `audit_swap_rejection_log` table; discriminator `target_table='consults'`.

**6 rejection codes:** `unauthenticated | cross_tenant_attempt | consult_state_invalid | decision_already_recorded | invalid_decision_class | audit_mismatch`

### Cross-tenant safety constraints (consolidated; sub-decision #1/2 add 2 new composite FKs)

Per the Sprint 9 R1 closure precedent + Codex SI-007/008/009 lineage:

**`consults` table (6 composite FKs total — 4 existing preserved + 2 new from sub-decisions #1 + #2):**
1. `UNIQUE (tenant_id, id)` (preserved)
2. `FK (tenant_id, patient_id) → accounts(tenant_id, account_id)` (preserved)
3. `FK (tenant_id, intake_form_submission_id) → forms_submission(tenant_id, submission_id)` (preserved)
4. **NEW:** `FK (tenant_id, decided_by_clinician_account_id) → accounts(tenant_id, account_id)` (clinician same-tenant binding)
5. **NEW:** `FK (tenant_id, clinician_decision_audit_id) → audit_records(tenant_id, audit_id)` (I-012 evidence same-tenant binding)
6. **NEW:** `FK (tenant_id, id, ai_workflow_execution_id) → ai_workflow_executions(tenant_id, consult_id, id)` (triple-composite per sub-decision #1)
7. **NEW:** `FK (tenant_id, id, escalation_target_sync_session_id) → sync_sessions(tenant_id, originating_consult_id, id)` (triple-composite per sub-decision #2)

**`consult_events` table (1 composite FK preserved):**
1. `FK (tenant_id, consult_id) → consults(tenant_id, id)` (preserved)

### AUDIT_EVENTS amendments (3 net-new Cat A action IDs)

Sub-ceremony 3 ratification adds:
- `consult.clinician_decision_recorded` — Cat A; emitted from `record_consult_clinician_decision()`. Detail: `(consult_id, clinician_decision_class, decided_by_clinician_account_id, prior_state, new_state, kms_key_id, kms_key_version)`. I-012 evidence row.
- `consult.escalation_target_swapped` — Cat A; emitted from `record_consult_escalation_target_swap()` (SI-009 procedure operates on consults rows; the audit is on the consults change). Detail: `(consult_id, prior_sync_session_id, new_sync_session_id, swapping_actor_account_id)`. Note: this action ID may already be in SI-009 P-019 scope; verify at Codex pre-ratification gate (OQ3).
- `consult.ai_workflow_execution_swapped` — Cat A; emitted whenever `consults.ai_workflow_execution_id` is swapped (via SI-008's `record_workflow_pointer_swap()` operating on consults rows). Detail: `(consult_id, prior_execution_id, new_execution_id, swapping_actor_account_id, supersedes_chain_depth)`. Note: this action ID may already be in SI-008 P-018 scope; verify at Codex pre-ratification gate (OQ4).

### DOMAIN_EVENTS amendments (2 net-new tenant-scoped event types; v5.2 in-place additive extension)

- `consult.clinician_decided.v1` — partition_key `tenant_id:consult_id` — downstream subscribers (e.g., Pharmacy slice listens for `approved` decisions on program consults)
- `consult.escalated_to_sync.v1` — partition_key `tenant_id:consult_id` — downstream subscribers (e.g., Sync Consult slice listens for `escalated_to_sync` decisions to spawn the sync_session row)

### IMPL-readiness gates (NOT ratification-order blockers per agenda's three-class framing)

SI-005 itself ratifies independently at P-021; the following items must ratify + land BEFORE SI-005 canonical content can be implemented:

1. **SI-008 P-018 canonical content port** (sub-ceremony 1 + 2 future PR-A2/A3-class commit) — `ai_workflow_executions` table must exist in bundle CDM before SI-005's FK 6 can install. Cluster B sub-ceremony 2 ratification-intent landed today; canonical content port deferred.
2. **SI-009 P-019 canonical content port** — `sync_sessions` table must exist before FK 7 can install. Same deferral.
3. **SI-010 P-022 ratification + landing** — `_session_actor_context` + `SET LOCAL` infrastructure for `record_consult_clinician_decision()` SECURITY DEFINER procedure. Sub-ceremony 7 per Evans's ordering.
4. **SI-004 P-???** — Async Consult audit events; `consult.clinician_decision_recorded` action ID must canonicalize before procedure can emit it. Sub-ceremony 5 per Evans's ordering.
5. **Shared `audit_swap_rejection_log` table** — SI-008 P-018 introduces it; SI-005's procedure inherits it.

All 5 IMPL-readiness gates land in autonomous-scope work after their respective ratifications close. None blocks SI-005's P-021 ratification-intent recording today.

### Open questions for next Codex pre-ratification rounds

The 6 Evans-ratified decisions close the major design surface. Remaining open questions for Codex rounds:

| # | Question | Anticipated Codex round |
| :---: | --- | --- |
| **OQ1** | Triple-composite UNIQUE `(tenant_id, id, ai_workflow_execution_id)` on consults — is this needed for the FK 6 referential target, OR does the (tenant_id, id) UNIQUE suffice given the triple-composite FK 6 references ai_workflow_executions(tenant_id, consult_id, id)? | R1 likely |
| **OQ2** | Tier 2 mutability of `current_program_catalog_entry_id` post-clinician-decision — does program re-assignment by downstream slice work require an immutability carve-out, OR is the column frozen with the rest of the payload? | R1-R2 |
| **OQ3** | `consult.escalation_target_swapped` audit action ID — already in SI-009 P-019 scope, OR new in SI-005? | R1 |
| **OQ4** | `consult.ai_workflow_execution_swapped` audit action ID — already in SI-008 P-018 scope, OR new in SI-005? | R1 |
| **OQ5** | State-machine consistency CHECK enumerating valid `(state, clinician_decision_class)` tuples — needed at DB layer, OR sufficient to enforce at service layer? | R2-R3 likely |
| **OQ6** | Multi-clinician scenarios (consult re-assigned mid-decision OR co-clinician decision) — does the schema need a `clinician_decision_co_signers` table, OR is single-clinician sufficient at v1.0? | R3-R4 |
| **OQ7** | Idempotency on `record_consult_clinician_decision()` — does the procedure need an Idempotency-Key parameter to guard against retried decision-submission requests? Mirrors SI-008's reserve-then-execute pattern but for a one-shot transition rather than supersession chain. | R2-R3 |

### Acceptance regression-test criteria

Per the SI-007/008/009/009.1 precedent:

1. **Cross-tenant prevention**: cannot create a `consults` row in tenant A pointing at tenant B's patient OR intake_form_submission OR decided_by_clinician OR audit_record OR ai_workflow_execution OR sync_session (composite FK violations)
2. **Triple-composite FK 6 enforcement**: cannot set `ai_workflow_execution_id` to a value whose `consult_id` does not match this consult's `id` (SI-008 R5 closure precedent)
3. **Triple-composite FK 7 enforcement**: cannot set `escalation_target_sync_session_id` to a value whose `originating_consult_id` does not match this consult's `id` (SI-009 R1 closure precedent)
4. **Tier 0 identity immutability**: any UPDATE attempting to change `id`/`tenant_id`/`patient_id`/`consult_type`/`modality`/`created_at` rejected by BEFORE UPDATE trigger
5. **Tier 1 payload immutability post-decision**: any UPDATE attempting to change `clinician_decision_class` OR the 8-column KMS envelope OR `decided_by_clinician_account_id` etc. rejected when `clinician_decision_class IS NOT NULL`
6. **Tier 2 state progression allowed post-decision**: UPDATE on `state` (per allowed prior-state set) AND `updated_at` succeeds when invoked via the service-layer transition methods
7. **One-shot clinician decision**: `record_consult_clinician_decision()` rejects with `decision_already_recorded` if invoked twice on the same consult
8. **`consult_events` strict append-only**: any UPDATE OR DELETE on `consult_events` rejected by BEFORE UPDATE + BEFORE DELETE triggers
9. **`consult_events` audit trail**: every `consults` state transition + every clinician decision results in a paired `consult_events` INSERT (atomic in same transaction)
10. **SECURITY DEFINER bypass prevention**: app-role direct UPDATE on `consults` clinician-decision columns rejected (only `record_consult_clinician_decision()` procedure can write)

### Codex pre-ratification gate

v0.1 → v0.2 is the initial expansion (this commit). Codex pre-ratification gate begins immediately + iterates until convergence (estimated 3-8 rounds per SI-007 18-round / SI-008 14-round / SI-009 6-round / SI-009.1 6-round precedent — SI-005's scope is similar to SI-009.1 so 4-6 rounds expected).

Each Codex round expected to surface lifecycle invariant gaps (state-machine consistency edge cases, FK enforcement edge cases, audit-emission timing) — same asymptote-class iteration pattern.

Once Codex APPROVE clean, Promotion Ledger entry P-021 records SI-005 ratification-intent (mirrors P-012/P-013/P-018/P-019 pattern). Canonical CDM §4.27 (Consult) + §4.28 (ConsultEvent) content lands in future PR-A2/A3-class lockstep commit per the lockstep invariant.

---

## What I'm trying to implement

Sprint 9 (TLC-021a) authors `migrations/020_async_consult.sql` for the Async Consult slice. Per Async Consult Slice PRD v1.0, the slice operates on:
- **Consult** entity — CDM v1.2 §3 entity #15 (`Telecheck_Canonical_Data_Model_v1_2.md:84`): "Async or sync consultation; converts seamlessly per ADR-012"
- **ConsultEvent** entity — CDM v1.2 §3 entity #16 (`Telecheck_Canonical_Data_Model_v1_2.md:85`): "State transitions and events on a consult"

## What the canonical CDM says

CDM v1.2 §3 entity inventory NAMES both entities at lines 84-85. CDM v1.2 §4 row-shape expansion (§4.1 through §4.15) covers Tenant management + Ecom/Subscription Management entities only:
- §4.1 Tenant
- §4.2 TenantBrand
- §4.3 CountryProfile
- §4.4 CcrConfig
- §4.5 AdapterConfig
- §4.6 TenantUser
- §4.7 Subscription
- §4.8 ProductCatalog
- §4.9 Order
- §4.10 OrderItem
- §4.11 PaymentRecord
- §4.12 Discount
- §4.13 AffiliateProgram
- §4.14 AffiliateReferral
- §4.15 PromoCode

**No §4 detail block exists for entity #15 (Consult) or #16 (ConsultEvent).** Same shape as SI-001 (MedicationRequest, entity #18, also missing from §4) — the entity inventory names them but no field-level row shape is canonicalized.

## Why this is a gap, not a missing-feature

EHBG §7 (Engineering Handoff Build Guide) is explicit: engineering does NOT author canonical schema. The Slice PRD authors describe behavior; CDM §4 authors row shapes; engineering implements per the canonical contract. When CDM §4 is silent, engineering MUST raise an SI rather than author placeholder schemas without spec backing — otherwise the spec corpus silently forks.

CLAUDE.md hard rule on this: "Do NOT silently fork. When a slice PRD disagrees with CDM / OpenAPI / State Machines, open a Spec Issue (per EHBG §12); do not edit the engineering spec to match the slice."

## Decision (Sprint 9 / TLC-021a — placeholder schema with resume gate)

Per the same Sprint 8 retro option (c) posture applied to SI-004 audit events:

**Decision: Sprint 9 ships placeholder schema for `consults` + `consult_events` tables; SI-005 closure ratifies the column set upstream.**

Rationale:
1. **Authoring should not block on out-of-repo spec work.** SI-001 has been open for the entire 9-sprint cycle; we cannot afford to leave Async Consult schema-blocked for the same indefinite duration.
2. **Placeholder columns are minimal-viable.** Only what the Sprint 9-implemented transitions (1-6 + 16) actually require:
   - `id`, `tenant_id`, `patient_id` (foreign-key core)
   - `consult_type`, `modality` (PRD §1 distinguishes async vs sync; §2 distinguishes program vs general)
   - `state` (CONSULT_STATES enum vocabulary per State Machines §3)
   - `current_program_catalog_entry_id` (PRD §15 dependency on Program Catalog; nullable for non-program consults)
   - `intake_form_submission_id` (PRD §15 dependency on Forms-Intake; nullable until INTAKE → SUBMITTED transition)
   - `created_at`, `updated_at` (audit-trail timestamps)
3. **Each placeholder column carries a SQL comment** pointing to SI-005 as the resume gate, identical to how migration 002 and 005 comment their hash-chain + idempotency-key columns.
4. **Parallel posture to SI-004** for symmetry — both audit events (SI-004) and schema rows (SI-005) ship placeholders + SI docs.

## Resolution path

When SI-005 closes:

1. CDM v1.2 §4 expansion adds row-shape detail blocks for Consult (entity #15) + ConsultEvent (entity #16).
2. Engineering compares Sprint 9 placeholder columns against ratified columns.
3. Forward migration ALTER (paired with rollback) adds any new columns ratified by §4 that Sprint 9 placeholder set didn't include.
4. Forward migration ALTER (paired with rollback) renames / retypes any columns where placeholder + ratified differ.
5. PR includes closing-rationale comment referencing this SI-005 doc.
6. SI-005 status changed to "Resolved"; placeholder column SQL comments removed.

## Placeholder column set (Sprint 9 / TLC-021a — `consults` table)

```sql
-- v0.1 placeholder columns; SI-005 resume gate
id                              VARCHAR(26)  PRIMARY KEY
tenant_id                       TEXT         NOT NULL REFERENCES tenants(id)
patient_id                      VARCHAR(26)  NOT NULL
consult_type                    VARCHAR(50)  NOT NULL CHECK (...)  -- 'program' | 'general'
modality                        VARCHAR(20)  NOT NULL CHECK (...)  -- 'async' | 'sync' (per PRD §1; ADR-012 conversion)
state                           VARCHAR(30)  NOT NULL CHECK (...)  -- CONSULT_STATES enum (17 values)
current_program_catalog_entry_id VARCHAR(26) NULL  -- nullable; PRD §15 dependency on Program Catalog
intake_form_submission_id       VARCHAR(26)  NULL  -- nullable; PRD §15 dependency on Forms-Intake; populated at INTAKE → SUBMITTED
created_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
updated_at                      TIMESTAMPTZ  NOT NULL DEFAULT NOW()

-- Codex async-consult-r1 HIGH closure 2026-05-05: composite UNIQUE +
-- composite FKs structurally enforce same-tenant relationships at the
-- DB layer. NOT placeholders — these are permanent cross-tenant safety
-- guarantees that any future SI-005 column-set ratification must preserve.
UNIQUE (tenant_id, id)
FOREIGN KEY (tenant_id, patient_id) REFERENCES accounts (tenant_id, account_id)
FOREIGN KEY (tenant_id, intake_form_submission_id)
    REFERENCES forms_submission (tenant_id, submission_id)
```

## Placeholder column set (Sprint 9 / TLC-021a — `consult_events` table)

```sql
-- v0.1 placeholder columns; SI-005 resume gate
id          VARCHAR(26)  PRIMARY KEY
consult_id  VARCHAR(26)  NOT NULL  -- composite FK below; not bare REFERENCES
tenant_id   TEXT         NOT NULL REFERENCES tenants(id)  -- denormalized for RLS
event_type  VARCHAR(80)  NOT NULL  -- e.g. 'state_transition'
from_state  VARCHAR(30)  NULL  -- nullable for non-transition events
to_state    VARCHAR(30)  NULL  -- nullable for non-transition events
actor_id    VARCHAR(26)  NULL  -- nullable for system-generated events
metadata    JSONB        NULL  -- nullable; per-event detail
created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()

-- Codex async-consult-r1 HIGH closure 2026-05-05: composite FK to
-- consults (tenant_id, id). Without this, a tenant-A insert could
-- write a consult_event referencing tenant-B's consult by knowing the
-- consult id — RLS on consult_events.tenant_id would still pass,
-- corrupting the consult lifecycle history. Composite FK makes this
-- structurally impossible.
FOREIGN KEY (tenant_id, consult_id) REFERENCES consults (tenant_id, id)
```

## Cross-tenant safety constraints (NOT placeholders; permanent)

The composite UNIQUE + 3 composite FKs added at Sprint 9 / TLC-021a Codex async-consult-r1 HIGH closure are NOT placeholders. They are permanent cross-tenant safety guarantees that must survive SI-005 column-set ratification. Any future migration that expands the column set MUST preserve them:

1. `consults UNIQUE (tenant_id, id)` — required to support consult_events composite FK
2. `consults FK (tenant_id, patient_id) → accounts (tenant_id, account_id)` — patient ownership cross-tenant binding prevention
3. `consults FK (tenant_id, intake_form_submission_id) → forms_submission (tenant_id, submission_id)` — intake binding cross-tenant prevention
4. `consult_events FK (tenant_id, consult_id) → consults (tenant_id, id)` — event history cross-tenant prevention

## Sprint reference

Filed at Sprint 9 / TLC-021a as part of the Async Consult slice authoring continuation. PM-brief verification gate at Sprint 9 kickoff confirmed CDM §4 silent on Consult / ConsultEvent. Sprint 9 ships placeholder schema + SI-005 doc as resume gate. Sprint 10 may extend placeholder columns for clinician-decision branches (transitions 9-15) — those extensions also flagged with SI-005 references in the migration comments.
