# Ratifier Packet — Sub-Ceremony 2 (SI-008 + SI-009)

**Estimated time:** 60–90 min total (per agenda §3 sub-ceremony 4 "Cluster B batch" estimate; SI-005 will follow in sub-ceremony 3 of the ratification queue per Evans's 2026-05-17 ordering)
**Quorum:** Evans + Engineering Lead + CDM v1.2 owner
**Unblocks:** Async-Consult Mode 2 case-prep AI workflow durability + LiveKit-backed sync video session durability. Cluster B HARD constraint: SI-008 + SI-009 MUST ratify BEFORE SI-005 because SI-005's FK 6 / FK 7 row shapes reference SI-008's `ai_workflow_executions` + SI-009's `sync_sessions` row shapes.

**Sub-ceremony 1 status:** SI-012 + SI-007 ratification-intent recorded in Promotion Ledger P-012 + P-013 (PR-A1 merged `36efccd` 2026-05-17 18:42 UTC). Canonical content port (PR-A2 + PR-A3) deferred to next loop firing per the lockstep invariant.

---

## TL;DR

Two schema-gap SIs in **Cluster B (HARD-sequenced)** — both deferred FK targets that SI-005 (Async-Consult Consult/ConsultEvent schema) names but cannot ratify against until SI-008 + SI-009 row shapes exist.

| SI | Entity | What blocks if unratified | Codex rounds | Source-file size |
| --- | --- | --- | --- | --- |
| **SI-008** | `ai_workflow_executions` (entity #19) | Async-Consult Mode 2 case-prep AI workflow durability + clinician-review queue authority (the SINGLE current authoritative AI recommendation per consult) | **14+ rounds** (v0.3 trajectory; 11 substantive findings closed inline) | 335 lines |
| **SI-009** | `sync_sessions` (entity #17) | LiveKit-backed sync video consult session durability + async→sync escalation path per ADR-012 | **6 rounds** (v0.X trajectory) | 187 lines |

Both SIs share the **SI-007 / SI-008 design pattern lineage**: triple-composite FKs (`tenant_id, parent_id, *_id` → parent table's `tenant_id, id, child_id`) enforcing same-tenant AND same-parent lineage declaratively; SECURITY DEFINER stored procedures gating mutation paths with definer-rights GRANT model; three-tier audit durability (savepoint + autonomous-transaction rejection log + caller-commit-boundary contract).

**Critical IMPL-readiness dependency on SI-010:** both SI-008's `record_workflow_pointer_swap()` and SI-009's `record_consult_escalation_target_swap()` SECURITY DEFINER procedures depend on SI-010's `_session_actor_context` table + `SET LOCAL` tx-scoped actor binding + authContextPlugin DB-binding work. **Per the agenda's three-class framing, this is IMPLEMENTATION-readiness, NOT ratification-order.** SI-008 + SI-009 can ratify TODAY independently of SI-010; but the SECURITY DEFINER procedures they specify cannot LAND in code until SI-010 ratifies + lands. Sub-ceremony 7 ratifies SI-010 per Evans's 2026-05-17 ordering.

---

## SI-008 — AiWorkflowExecution schema (Mode 2 case-prep AI workflow durability) — 30–45 min

### TL;DR

The `ai_workflow_executions` row records every Mode 2 case-prep AI workflow run (the AI Service slice's protocol-execution surface per ADR-002 + ADR-029). One consult can have multiple workflow runs over its lifecycle (re-runs after failure, refinement passes). The schema captures the **single current authoritative execution per consult** (the one whose recommendation drives clinician review) + a **supersession chain** for forensic recovery of the full lineage.

### What's already resolved by Codex (no judgment needed — accept as-is)

The 14-round Codex trajectory closed these as architectural invariants:

- **23-column placeholder schema** (15 base columns: id, tenant_id, consult_id, workload_type, ai_mode, protocol_id, protocol_version, model_version, guardrail_template_id, autonomy_level, state, supersedes_execution_id, created_at, started_at, completed_at + **8-column KMS envelope** for `recommendation_encrypted`: recommendation_encrypted, recommendation_kms_key_id, recommendation_kms_key_version, recommendation_nonce, recommendation_aad, recommendation_schema_version, recommendation_encrypted_at, recommendation_dek_ciphertext)
- **Triple-composite UNIQUE** `(tenant_id, consult_id, id)` — required so SI-005's FK 6 forward pointer (triple-composite) can REFERENCE this entity
- **Same-tenant + same-consult lineage** enforced via composite FK `(tenant_id, consult_id) → consults(tenant_id, id)` (backward) + SI-005's FK 6 `(tenant_id, id, ai_workflow_execution_id) → ai_workflow_executions(tenant_id, consult_id, id)` (forward triple-composite)
- **Bidirectional pointer invariant** — non-unique backward pointer (consult can have multiple workflow rows over time) + supersession-aware forward pointer (consult's forward pointer points at the CURRENT authoritative execution; `supersedes_execution_id` links the chain)
- **Self-referential triple-composite FK** for supersession chain: `(tenant_id, consult_id, supersedes_execution_id) → ai_workflow_executions(tenant_id, consult_id, id)` — enforces SAME-TENANT AND SAME-CONSULT lineage at the DB layer (R3 + R4 closures)
- **CAS-and-supersession protocol** for forward-pointer updates: `consults.ai_workflow_execution_id = $expected_prior_execution_id` guard in UPDATE; `new_execution.supersedes_execution_id = $expected_prior_execution_id` set at INSERT-time-immutable
- **`record_workflow_pointer_swap()` SECURITY DEFINER procedure** is the ONLY write path to `consults.ai_workflow_execution_id`. Application code's role has NO direct UPDATE privilege. Validates: row-locks both rows in id-order (deadlock prevention) → declarative FK validations (defense-in-depth) → state='completed' gate → CAS guard → supersession-pointer-vs-CAS consistency (R13) → chain acyclicity walk (R6) → atomic UPDATE + audit emission
- **`supersedes_execution_id` is IMMUTABLE post-INSERT** via BEFORE UPDATE trigger (R9 closure) — set once at workflow START; never mutated thereafter
- **Three-tier audit durability** (R14 closure): Tier 1 SAVEPOINT-rollback-then-INSERT for within-tx behavior; Tier 2 `audit_swap_rejection_log` autonomous-transaction backstop survives caller rollback; Tier 3 caller-required-commit-boundary contract
- **5 rejection codes**: `cas_mismatch` / `supersession_pointer_mismatch` / `chain_cycle` / `state_invalid` / `unauthenticated`

### Genuine ratifier decisions (4 items from SI-008 "Open questions for CDM author" §)

| # | Decision | Recommendation |
| :---: | --- | --- |
| 1 | **State vocabulary:** is `pending | running | completed | failed | cancelled` the canonical 5-state set, OR does Mode 2 case-prep need additional states (e.g., `requires_clinician_review`, `clinician_approved`, `clinician_declined`)? | **Keep the 5-state set.** Clinician-decision states belong on the Consult entity (per SI-005's `clinician_decision_class` column set), not on the AI workflow execution. Clean separation: `ai_workflow_executions.state` = AI lifecycle; `consults.state` = clinician lifecycle. |
| 2 | **Protocol versioning:** what's the relationship between `ai_workflow_executions.protocol_version` and the `protocols` table's version-immutability? Pattern A semantics suggest a version is captured at execution time + immutable thereafter. | **Ratify Pattern A pin:** `protocol_version` captured at workflow START time + INSERT-time-immutable (mirrors `supersedes_execution_id` immutability via BEFORE UPDATE trigger). Re-execution against a newer protocol version creates a NEW workflow row with the new version pinned; supersession chain links them. |
| 3 | **Recommendation storage size:** KMS-encrypted Mode 2 recommendations could grow large (multi-page clinician-facing rationale). Use TOAST-stored BYTEA, OR move recommendation to S3 with only pointer in DB? | **NEEDS DISCUSSION** — operational judgment call. Recommend: TOAST-stored BYTEA at v1.0 (simpler; KMS envelope semantics straightforward; TOAST handles multi-MB cleanly). Revisit if recommendations exceed ~1 MB regularly. S3-pointer pattern can be a future SI when scale warrants. |
| 4 | **KMS envelope consolidation:** the **8-column envelope** (`recommendation_encrypted` + `recommendation_kms_key_id` + `recommendation_kms_key_version` + `recommendation_nonce` + `recommendation_aad` + `recommendation_schema_version` + `recommendation_encrypted_at` + `recommendation_dek_ciphertext`) is duplicated from SI-005 Decision 8 (which the SI-008 source explicitly cites as "8-column envelope including DEK ciphertext"). Should the column set consolidate via a shared `EncryptedPayload` composite type when SI-008 closes? | **Defer to future SI.** Ratify the **8-column flat layout** at SI-008 closure (mirrors SI-005 Decision 8 precedent verbatim; minimizes ratification surface). The composite-type refactor can be a separate housekeeping SI when other entities (e.g., audit row payloads) adopt the same envelope. |

### What ships if Evans ratifies

- CDM v1.4 §4.23 AiWorkflowExecution (or next-available § number after the sub-ceremony 1 §4.17–§4.22 additions land)
- AUDIT_EVENTS v5.5 amendments: `ai_workflow_execution.{started, completed, failed, cancelled, current_pointer_swapped, swap_rejected, race_lost}` (7 net-new Category A action IDs)
- DOMAIN_EVENTS v5.2 in-place amendment: `ai_workflow_execution.{completed, failed}` (2 net-new tenant-scoped event types; partition_key `tenant_id:ai_workflow_execution_id`)
- New `_session_actor_context` table + `SET LOCAL`-based actor-binding infrastructure (DEFERRED to SI-010 landing per IMPL-readiness gate)
- `record_workflow_pointer_swap()` SECURITY DEFINER procedure (DEFERRED to SI-010 landing)
- `audit_swap_rejection_log` operational table (lands with SI-008 procedure — Tier 2 durability backstop)
- Unblocks **SI-005 ratification** (Cluster B sub-ceremony 4) — SI-005's FK 6 row shape now references a ratified target

### Cross-references

- SI-008 source: `docs/SI-008-AiWorkflowExecutions-Schema-Gap.md` v0.3 (335 lines; 14 Codex rounds; 11 findings closed inline)
- ADR-002 (AI mode taxonomy: Mode 1 conversational; Mode 2 protocol execution)
- ADR-029 (AI workload taxonomy; supersedes ADR-002 prospectively)
- WORKLOAD_TAXONOMY v5.2 (`workload_type` enum)
- AUTONOMY_LEVELS v5.2 (`autonomy_level` enum)
- SI-005 (Cluster B sibling — names FK 6 as deferred to this SI)
- SI-007 (precedent for triple-composite FK + atomic cross-entity tx discipline)
- SI-010 (IMPL-readiness gate — the `_session_actor_context` infrastructure SI-008's SECURITY DEFINER procedure depends on)

---

## SI-009 — SyncSession schema (LiveKit-backed sync video consult durability) — 30–45 min

### TL;DR

The `sync_sessions` row records every LiveKit-backed synchronous (video or phone) consultation session per ADR-021. SI-005's FK 7 (`consults.escalation_target_sync_session_id`) names this entity as deferred — the async→sync escalation path per ADR-012 cannot ratify until this row shape exists.

### What's already resolved by Codex (no judgment needed — accept as-is)

The 6-round Codex trajectory closed these:

- **13-column placeholder schema** (id, tenant_id, patient_id, clinician_account_id, originating_consult_id, modality, state, scheduled_start_at, actual_start_at, actual_end_at, livekit_room_id, created_at, updated_at)
- **Triple-composite UNIQUE** `(tenant_id, originating_consult_id, id)` — required so SI-005's FK 7 forward pointer (triple-composite) can REFERENCE this entity (R1 closure)
- **Same-tenant + same-originating-consult lineage** enforced via composite FK `(tenant_id, originating_consult_id) → consults(tenant_id, id)` + SI-005's FK 7 triple-composite forward pointer
- **NO supersession chain** (simpler than SI-008): sync sessions transition via human action (clinician schedules, patient joins, technical failure → manual reschedule). Multiple sync sessions per consult are legitimate (reschedule, retry); the consult's forward pointer tracks the CURRENT scheduled/in-progress session via standard state-machine transitions.
- **Four-predicate atomic UPDATE** for forward-pointer swaps (R1 MEDIUM + R2 HIGH closures): CAS-on-pointer + consult-state-precondition (`UNDER_REVIEW` | `ESCALATED_TO_SYNC`) + new-session-existence (FK validation) + new-session-state-actionable (`scheduled` | `waiting_room` | `in_progress`). Inactive sessions (cancelled/no_show/completed) can no longer become the current forward pointer.
- **`record_consult_escalation_target_swap()` SECURITY DEFINER procedure** is the ONLY write path to `consults.escalation_target_sync_session_id` (R3 closure mirrors SI-008's DB-boundary discipline). Same GRANT model: app-role has NO direct UPDATE privilege.
- **Server-trusted actor identity** via `SET LOCAL`-bound `_session_actor_context` (R5 + R6 closures): caller-supplied actor identity REMOVED; procedure derives from `current_actor_account_id()` / `current_actor_account_tenant_id()` / `current_actor_role()` / `current_actor_admin_home_tenant_id()`. Tx-scoped binding via `SET LOCAL` prevents cross-request bleed on pooled connections.
- **Three-tier audit durability** (mirrors SI-008): same SAVEPOINT + `audit_swap_rejection_log` autonomous-transaction + caller-commit-boundary contract. Shared `audit_swap_rejection_log` table (discriminator column `target_table` says `consults`).
- **4 rejection codes**: `cas_mismatch` / `consult_state_invalid` / `target_session_missing` / `target_session_inactive`

### Genuine ratifier decisions (4 items from SI-009 "Open questions for CDM author" §)

| # | Decision | Recommendation |
| :---: | --- | --- |
| 1 | **LiveKit room ID storage:** is `livekit_room_id` PHI? At v1.0 the room identifier is a synthetic UUID; combined with `patient_id` + `clinician_account_id` it could enable patient-conversation correlation. Should the column be encrypted at rest (KMS envelope per SI-005 Decision 8 pattern)? | **NEEDS DISCUSSION** — privacy judgment call. Recommend: **encrypt at rest via KMS envelope.** The combination `livekit_room_id + patient_id + clinician_account_id` is effectively a session correlation key — encrypting at rest preserves operational PHI minimization even if `sync_sessions` rows are inadvertently exposed via a future query path. Cost: ~7 envelope columns added (mirrors SI-005 + SI-008 pattern). |
| 2 | **Multi-participant sessions:** the placeholder assumes a single patient + single clinician. Group consults (a patient + caregiver + clinician + interpreter) need a separate participants table. | **Defer to v1.x.** v1.0 scopes 1-patient + 1-clinician sync sessions. When group consult scope expands, file a follow-on SI introducing `sync_session_participants` table with FK to `sync_sessions`. |
| 3 | **Recording retention:** if sync sessions are recorded (per regulatory requirements in some jurisdictions), where do encrypted recording files live (S3 with KMS) vs the row in `sync_sessions`? Pointer column + retention policy TBD. | **NEEDS DISCUSSION** — regulatory + operational. Recommend: **defer to a separate SI when first jurisdiction with recording requirements is activated.** At v1.0 (Telecheck-US greenfield, no recording requirement; Telecheck-Ghana, no recording requirement at pilot scope), the recording surface is out-of-scope. When activated, the SI introduces a `sync_session_recording_pointer` column + S3 bucket + KMS key + retention-policy CCR key. |
| 4 | **Cancellation reason taxonomy:** `state='cancelled'` needs a `cancellation_reason` discriminator (`patient_initiated`, `clinician_initiated`, `system_cancellation`, `regulatory_hold`). | **Ratify the 4-value enum** as proposed. Add `cancellation_reason VARCHAR(40) NULL CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('patient_initiated', 'clinician_initiated', 'system_cancellation', 'regulatory_hold'))` to the canonical column set. Required NOT NULL when `state='cancelled'`. |

### What ships if Evans ratifies

- CDM v1.4 §4.24 SyncSession (or next-available § number after sub-ceremony 1 + SI-008)
- AUDIT_EVENTS v5.5 amendments: `sync_session.{scheduled, started, completed, no_show, cancelled, escalation_target_swapped, escalation_target_swap_failed}` (7 net-new Category C action IDs; Category C because sync-session state is patient-visible operational metadata, not Category A clinical-decision-evidence)
- DOMAIN_EVENTS v5.2 in-place amendment: `sync_session.{scheduled, started, completed}` (3 net-new tenant-scoped event types)
- `record_consult_escalation_target_swap()` SECURITY DEFINER procedure (DEFERRED to SI-010 landing per IMPL-readiness gate)
- `cancellation_reason` enum added to canonical column set
- Shared `audit_swap_rejection_log` table extended with `target_table='consults'` rows (lands with SI-008 procedure infrastructure)
- Unblocks **SI-005 ratification** (Cluster B sub-ceremony 4) — SI-005's FK 7 row shape now references a ratified target

### Cross-references

- SI-009 source: `docs/SI-009-SyncSessions-Schema-Gap.md` v0.X (187 lines; 6 Codex rounds)
- ADR-012 (Async ↔ Sync seamless conversion)
- ADR-021 (LiveKit self-hosted for sync video)
- SI-005 (Cluster B sibling — names FK 7 as deferred to this SI)
- SI-008 (precedent for SECURITY DEFINER procedure + actor-context binding pattern; shared `audit_swap_rejection_log` infrastructure)
- SI-010 (IMPL-readiness gate — same `_session_actor_context` infrastructure SI-008 depends on)

---

## Ratification checklist (one page; sign-off surface)

**SI-008:**
- [ ] **23-column placeholder schema** (15 base columns + 8-column KMS envelope including `recommendation_dek_ciphertext`) — APPROVE / REJECT / DISCUSS
- [ ] Triple-composite UNIQUE `(tenant_id, consult_id, id)` + same-tenant + same-consult lineage FKs — APPROVE / REJECT
- [ ] Bidirectional pointer invariant (non-unique backward; supersession-aware forward) + supersession chain via `supersedes_execution_id` self-referential triple-composite FK — APPROVE / REJECT
- [ ] CAS-and-supersession protocol + `record_workflow_pointer_swap()` SECURITY DEFINER procedure + GRANT model — APPROVE / REJECT
- [ ] `supersedes_execution_id` immutable post-INSERT via BEFORE UPDATE trigger — APPROVE / REJECT
- [ ] Three-tier audit durability (savepoint + autonomous-transaction `audit_swap_rejection_log` + caller-commit-boundary contract) — APPROVE / REJECT
- [ ] **State vocabulary: keep 5-state set (`pending | running | completed | failed | cancelled`); clinician-decision states live on Consult** — APPROVE / REJECT
- [ ] **Protocol versioning: Pattern A pin (`protocol_version` captured at workflow START + INSERT-time-immutable)** — APPROVE / REJECT
- [ ] **Recommendation storage: TOAST-stored BYTEA at v1.0; defer S3-pointer to future SI when scale warrants** — APPROVE / REJECT / DISCUSS
- [ ] **KMS envelope: ratify 8-column flat layout at SI-008 closure (mirrors SI-005 Decision 8 precedent); defer composite-type refactor** — APPROVE / REJECT
- [ ] AUDIT_EVENTS v5.5 amendments (7 net-new Category A action IDs) — APPROVE
- [ ] DOMAIN_EVENTS v5.2 in-place amendment (2 net-new event types) — APPROVE
- [ ] IMPL-readiness gate on SI-010 acknowledged (procedure cannot land until SI-010's `_session_actor_context` infrastructure ratifies + lands; SI-010 sub-ceremony 7 in Evans's ordering) — ACKNOWLEDGED

**SI-009:**
- [ ] 13-column placeholder schema (id, tenant_id, patient_id, clinician_account_id, originating_consult_id, modality, state, scheduled_start_at, actual_start_at, actual_end_at, livekit_room_id, created_at, updated_at) — APPROVE / REJECT / DISCUSS
- [ ] Triple-composite UNIQUE `(tenant_id, originating_consult_id, id)` + same-tenant + same-originating-consult lineage FKs — APPROVE / REJECT
- [ ] No supersession chain (sync sessions transition via human action; multiple per consult legitimate; forward pointer tracks current scheduled/in-progress session) — APPROVE / REJECT
- [ ] Four-predicate atomic UPDATE (CAS + consult-state + new-session-existence + new-session-state-actionable) + `record_consult_escalation_target_swap()` SECURITY DEFINER procedure — APPROVE / REJECT
- [ ] Server-trusted actor identity via `SET LOCAL`-bound `_session_actor_context` (no caller-supplied actor identity) — APPROVE / REJECT
- [ ] Three-tier audit durability (shared `audit_swap_rejection_log` with SI-008; discriminator column `target_table`) — APPROVE / REJECT
- [ ] **`livekit_room_id` encrypted at rest via KMS envelope (~7 added columns; mirrors SI-005 + SI-008 pattern)** — APPROVE / REJECT / DISCUSS ← privacy call
- [ ] **Multi-participant sessions deferred to v1.x via follow-on SI (`sync_session_participants` table)** — APPROVE / DEFER
- [ ] **Recording retention deferred to separate SI when first jurisdiction with recording requirement is activated** — APPROVE / DEFER / DISCUSS ← regulatory call
- [ ] **Cancellation reason 4-value enum (`patient_initiated` | `clinician_initiated` | `system_cancellation` | `regulatory_hold`)** — APPROVE / REJECT
- [ ] AUDIT_EVENTS v5.5 amendments (7 net-new Category C action IDs) — APPROVE
- [ ] DOMAIN_EVENTS v5.2 in-place amendment (3 net-new event types) — APPROVE
- [ ] IMPL-readiness gate on SI-010 acknowledged — ACKNOWLEDGED

**Post-ratification (Track 6 mechanical, deferred to PR-A4 + PR-A5 lockstep commits):**
- [ ] Promotion Ledger entries P-018 (SI-008) + P-019 (SI-009) appended
- [ ] CDM v1.4 → v1.5 bump (or next-available CDM version)
- [ ] AUDIT_EVENTS v5.4 → v5.5 bump (post sub-ceremony 1 PR-A3)
- [ ] Registry v2.12 → v2.13 bump (post sub-ceremony 1 PR-A2 + PR-A3)

---

## What to flag if anything blocks

- **If `livekit_room_id` PHI-encryption call (SI-009 decision 1) needs Platform Privacy Officer input** — defer SI-009 to sub-ceremony 2.5; ratify SI-008 standalone (no shared dependency on the LiveKit room ID call). Cluster B HARD constraint still holds: SI-008 alone is sufficient to unblock SI-005's FK 6 ratification; FK 7 to SI-009 ratifies whenever SI-009 closes.
- **If recommendation-storage call (SI-008 decision 3) needs operational deep-dive** — TOAST-BYTEA is the safe default that doesn't preclude future S3-pointer refactor. Ratify as TOAST-BYTEA; revisit at first scale incident.
- **If any of the 23 SI-008 columns (15 base + 8-column KMS envelope) or 13 SI-009 columns need amendment** — engineering opens a v0.4 / v0.X+1 DRAFT amendment + re-runs Codex pre-ratification gate (precedent: SI-007 took 18 rounds; SI-001 took 11; further rounds on SI-008/009 are cheap on Codex).

---

## Cross-references

- **Sub-Ceremony 1 Ratifier Packet** (the precedent format) — authored as turn message 2026-05-17; ratified via chat-message; result: PR-A1 `36efccd` (P-012 + P-013 ratification-intent records)
- **`docs/Ratifier-Ceremony-Agenda-Q2-2026.md`** — agenda §3 sub-ceremony 4 "Cluster B batch" (SI-008 + SI-009 + SI-005 grouped together; Evans's 2026-05-17 ordering splits SI-005 into sub-ceremony 3 of the ratification queue after sub-ceremony 2 SI-008/009 ratifies, preserving the HARD-sequenced constraint while ratifying Cluster B in two adjacent steps)
- **`docs/Per-Track-SI-Navigation-2026-05-17.md`** — SI → Track → Cluster mapping
- **`docs/SI-008-AiWorkflowExecutions-Schema-Gap.md`** v0.3 — workstream ratifier-input artifact for SI-008
- **`docs/SI-009-SyncSessions-Schema-Gap.md`** v0.X — workstream ratifier-input artifact for SI-009
- **`docs/SI-005-Consult-ConsultEvent-Schema-Gap.md`** — Cluster B sibling that ratifies in sub-ceremony 3 after SI-008/009; depends on this packet's outcome for FK 6 + FK 7 row shapes
- **`docs/SI-010-Session-Actor-Context-DB-Binding.md`** — IMPL-readiness gate that both SI-008 + SI-009 SECURITY DEFINER procedures depend on; ratifies in sub-ceremony 7 per Evans's ordering

---

— Claude (Opus 4.7, 1M context), 2026-05-17 sub-ceremony 2 Ratifier Packet authored at the post-sub-ceremony-1-ratification-intent milestone (PR-A1 `36efccd` merged 2026-05-17 18:42 UTC; SI-012 + SI-007 ratification-intent recorded; sub-ceremony 2 SI-008 + SI-009 packet ready for Evans's review when convenient).
