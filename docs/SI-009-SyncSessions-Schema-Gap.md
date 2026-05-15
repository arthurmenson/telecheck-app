# SI-009 — SyncSession schema gap (CDM v1.2)

**Raised by:** Engineering (autonomous run 2026-05-15; SI-005 deferred-FK trigger)
**Date:** 2026-05-15
**Severity:** medium (does NOT block current slices; comes due when async→sync conversion ships per ADR-012 — SI-005's deferred FK 7 points here)
**Status:** Open — awaiting CDM v1.2 §4 row-shape expansion
**Target spec doc:** `Telecheck_Canonical_Data_Model_v1_2.md`
**Target slice PRD:** `Telecheck_Async_Consult_Slice_PRD_v1_0.md` (uses `escalation_target_sync_session_id` for the async→sync conversion path)
**Parallel SIs:** SI-005 (Consult/ConsultEvent — names this FK as deferred), SI-008 (AiWorkflowExecution — sibling deferred-FK SI)

---

## What this is

CDM v1.2 §3 entity inventory names **SyncSession** (entity #17) at the entity-roster level: "Synchronous (video / phone) consultation session per ADR-021 (LiveKit-based)."

CDM v1.2 §4 row-shape expansion does NOT include a detail block for entity #17. Same shape as SI-001, SI-005, SI-008.

## Why this is a gap, not a missing-feature

SI-005's resolution path explicitly defers FK 7 (`consults.escalation_target_sync_session_id → sync_sessions.id`) to "post-Sync-Consult slice ratification." That ratification is THIS SI.

## Decision (placeholder schema gated on SI-009 closure)

When async→sync conversion work begins:

- Sprint X ships placeholder `sync_sessions` table
- SI-009 closure ratifies the column set upstream

Placeholder columns (minimal-viable for ADR-021 LiveKit integration):

```sql
-- v0.1 placeholder columns; SI-009 resume gate
id                          VARCHAR(26)  PRIMARY KEY
tenant_id                   TEXT         NOT NULL REFERENCES tenants(id)
patient_id                  VARCHAR(26)  NOT NULL
clinician_account_id        VARCHAR(26)  NULL  -- nullable until clinician assignment
originating_consult_id      VARCHAR(26)  NULL  -- when this sync session is the result of an async→sync escalation; references the originating async consult
modality                    VARCHAR(20)  NOT NULL CHECK (...)  -- 'video' | 'phone'; ADR-021 LiveKit pluggable
state                       VARCHAR(30)  NOT NULL CHECK (...)  -- 'scheduled', 'waiting_room', 'in_progress', 'completed', 'no_show', 'cancelled'
scheduled_start_at          TIMESTAMPTZ  NOT NULL  -- when the session is/was scheduled to begin
actual_start_at             TIMESTAMPTZ  NULL  -- when patient + clinician both joined
actual_end_at               TIMESTAMPTZ  NULL  -- when session ended
livekit_room_id             TEXT         NULL  -- LiveKit room identifier (provisional; encrypted-at-rest if PHI)
created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()

-- Cross-tenant safety constraints (NOT placeholders; permanent)
UNIQUE (tenant_id, id)

-- R1 HIGH closure: triple-composite UNIQUE required so the forward
-- FK from consults.escalation_target_sync_session_id can REFERENCE
-- a uniquely-backed column set. Without this, the triple FK fails
-- to install at migration time.
UNIQUE (tenant_id, originating_consult_id, id)

FOREIGN KEY (tenant_id, patient_id) REFERENCES accounts (tenant_id, account_id)
FOREIGN KEY (tenant_id, clinician_account_id) REFERENCES accounts (tenant_id, account_id)

-- Same-tenant + same-consult lineage for async→sync escalation:
-- when originating_consult_id is set, it MUST be a consult in the
-- SAME tenant. The originating consult may have additional sync
-- sessions over its lifecycle (clinician reschedule, technical
-- failure retry), so the column is non-unique on its own.
FOREIGN KEY (tenant_id, originating_consult_id) REFERENCES consults (tenant_id, id)
```

## Async → sync escalation invariant (mirrors SI-008 forward-pointer pattern)

Same lessons-learned as SI-008's 14-round Codex review series apply here:

- **Forward pointer** (from SI-005 deferred FK 7): `consults.escalation_target_sync_session_id → sync_sessions (tenant_id, ?, id)` — MUST use a triple-composite FK to enforce same-tenant + same-originating-consult. The `?` field is `originating_consult_id` on `sync_sessions`; the FK shape is:
  ```sql
  ALTER TABLE consults
      ADD CONSTRAINT fk_consults_escalation_target_sync_session
      FOREIGN KEY (tenant_id, id, escalation_target_sync_session_id)
      REFERENCES sync_sessions (tenant_id, originating_consult_id, id);
  ```
- **Backward pointer** (this SI): `sync_sessions.originating_consult_id → consults (tenant_id, id)` — already triple-component safe via the (tenant_id, id) composite UNIQUE on consults.

- **Multiple sync sessions per consult are legitimate.** Reschedule, technical-failure retry, etc. all produce additional rows. The consult's authoritative forward pointer (`escalation_target_sync_session_id`) tracks the CURRENT scheduled/in-progress session.

- **No supersession chain needed (simpler than SI-008).** Unlike AI workflow executions which support automated reruns, sync sessions transition via human action (clinician schedules, patient joins, technical failure → manual reschedule). The consult's forward pointer is updated via standard state-machine transitions on `consults`, not via the SI-008-style CAS-and-supersession protocol.

- **Guarded forward-pointer update protocol (R1 MEDIUM closure 2026-05-15):** even without supersession-chain machinery, concurrent reschedule / cancel / no-show handling can race. A stale actor could move `consults.escalation_target_sync_session_id` back to an older cancelled / no_show session or away from a newly scheduled one. The pointer update MUST use a guarded UPDATE with both CAS-on-pointer + state-precondition:

  ```sql
  UPDATE consults
     SET escalation_target_sync_session_id = $new_sync_session_id
   WHERE id = $consult_id
     AND tenant_id = $tenant_id
     AND state IN ('UNDER_REVIEW', 'ESCALATED_TO_SYNC')
     AND escalation_target_sync_session_id IS NOT DISTINCT FROM $expected_prior_pointer
  RETURNING id;
  ```

  Where `$expected_prior_pointer` is the value the caller read at the start of the transition (NULL for first-write, or the prior sync_session_id for a reschedule). Zero-row return triggers `consult.escalation_target_swap_failed` Category C audit + caller-side conflict resolution (typically refresh + re-attempt). Every successful swap emits `consult.escalation_target_swapped` Category C audit capturing `(prior_pointer, new_pointer, actor_id)` for forensic recovery.

  No DB-layer procedure-only path is required (unlike SI-008's `record_workflow_pointer_swap()`) because the sync-session lifecycle is human-driven + scheduling-data has simpler integrity semantics than AI-recommendation lineage. Application-layer CAS + audit is the proportionate defense for this surface.

## Resolution path

When SI-009 closes:

1. CDM v1.2 §4 expansion adds row-shape detail block for SyncSession (entity #17).
2. Spec defines the canonical state machine (`scheduled → waiting_room → in_progress → completed | no_show | cancelled`) per State Machines v1.1.
3. AUDIT_EVENTS expansion canonicalizes `sync_session.{scheduled, started, completed, no_show, cancelled}` Category C audit IDs.
4. DOMAIN_EVENTS expansion canonicalizes the wire-out events.
5. Forward migration ALTER (paired with rollback) adds any new columns ratified by §4 that the placeholder set didn't include.
6. SI-005 deferred FK 7 (`consults.escalation_target_sync_session_id`) added as triple-composite FK per the invariant above.
7. SI-009 status changed to "Resolved"; placeholder column SQL comments removed.

## Cross-tenant safety constraints (NOT placeholders; permanent)

Mirror of SI-005 / SI-007 / SI-008 discipline:

1. `sync_sessions UNIQUE (tenant_id, id)` — required to support cross-entity composite FKs
2. `sync_sessions FK (tenant_id, patient_id) → accounts (tenant_id, account_id)` — same-tenant patient binding
3. `sync_sessions FK (tenant_id, clinician_account_id) → accounts (tenant_id, account_id)` — same-tenant clinician binding
4. `sync_sessions FK (tenant_id, originating_consult_id) → consults (tenant_id, id)` — same-tenant consult lineage
5. Forward FK from `consults.escalation_target_sync_session_id` uses triple-composite enforcing same-tenant AND same-originating-consult (per "Async → sync escalation invariant" above)

## Open questions for CDM author

- **LiveKit room ID storage:** is `livekit_room_id` PHI? At v1.0 the room identifier is a synthetic UUID; combined with `patient_id` + `clinician_account_id` it could enable patient-conversation correlation. Should the column be encrypted at rest (KMS envelope per SI-005 Decision 8 pattern)? Engineering Lead amendment pending.
- **Multi-participant sessions:** the placeholder assumes a single patient + single clinician. Group consults (a patient + caregiver + clinician + interpreter) need a separate participants table. Defer to v1.x if scope expands.
- **Recording retention:** if sync sessions are recorded (per regulatory requirements in some jurisdictions), where do the encrypted recording files live (S3 with KMS) vs the row in `sync_sessions`? Pointer column + retention policy TBD.
- **Cancellation reason taxonomy:** `state='cancelled'` needs a `cancellation_reason` discriminator (`patient_initiated`, `clinician_initiated`, `system_cancellation`, `regulatory_hold`). Engineering Lead amendment pending.

## Spec references

- CDM v1.2 §3 entity #17 (SyncSession — named, no row shape)
- ADR-012 (Async ↔ Sync seamless conversion)
- ADR-021 (LiveKit self-hosted for sync video)
- Async-Consult Slice PRD v1.0 §X (async→sync escalation flow)
- SI-005 §"Cross-tenant safety constraints" (deferred FK 7 reference)
- SI-008 (precedent for triple-composite FK + same-consult-lineage enforcement)

## Status

- **Filed:** 2026-05-15 (autonomous run)
- **Target Promotion Ledger entry:** P-019 (P-018 SI-008 in flight)
