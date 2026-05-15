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

- **Guarded forward-pointer update protocol (R1 MEDIUM + R2 HIGH closures 2026-05-15):** even without supersession-chain machinery, concurrent reschedule / cancel / no-show handling can race. A stale actor could move `consults.escalation_target_sync_session_id` back to an older cancelled / no_show / completed session or away from a newly scheduled one. The pointer update MUST use a guarded UPDATE with FOUR atomic predicates: CAS-on-pointer + consult-state-precondition + new-session-existence + new-session-state-actionable.

  ```sql
  UPDATE consults c
     SET escalation_target_sync_session_id = s.id
   FROM sync_sessions s
   WHERE c.id = $consult_id
     AND c.tenant_id = $tenant_id
     AND c.state IN ('UNDER_REVIEW', 'ESCALATED_TO_SYNC')
     AND c.escalation_target_sync_session_id IS NOT DISTINCT FROM $expected_prior_pointer
     AND s.id = $new_sync_session_id
     AND s.tenant_id = c.tenant_id
     AND s.originating_consult_id = c.id
     AND s.state IN ('scheduled', 'waiting_room', 'in_progress')
  RETURNING c.id;
  ```

  **R2 HIGH closure (Codex 2026-05-15):** the original R1 guard only validated `consults` row state + the CAS pointer. The triple-composite FK proved tenant/lineage but NOT lifecycle state of the target. A caller could repoint a consult to a `cancelled`/`no_show`/`completed` sync session for the same consult — referentially valid but operationally invalid. The R2 fix adds the sync-session lifecycle precondition (`s.state IN ('scheduled', 'waiting_room', 'in_progress')`) atomically in the same UPDATE. Inactive sessions can no longer become the current forward pointer.

  Zero-row return triggers `consult.escalation_target_swap_failed` Category C audit (captures the specific predicate that filtered: caller can probe by reading the current consult + target session state to determine whether CAS lost OR the target was inactive) + caller-side conflict resolution (typically refresh + re-attempt with a freshly scheduled session). Every successful swap emits `consult.escalation_target_swapped` Category C audit capturing `(prior_pointer, new_pointer, actor_id)` for forensic recovery.

  **R3 HIGH closure (Codex 2026-05-15):** the application-layer atomic UPDATE alone leaves the invariant bypassable by direct UPDATE, migration, admin repair, or background job paths. To match the same DB-boundary discipline SI-008 establishes for AI workflow pointer swaps, the swap MUST be enforced at the DB layer via a definer-rights stored procedure:

  - **GRANT model:** application code's role has NO direct UPDATE privilege on `consults.escalation_target_sync_session_id`. All mutations go through `record_consult_escalation_target_swap(...)`.
  - **Procedure signature:** `record_consult_escalation_target_swap(p_consult_id, p_tenant_id, p_new_sync_session_id, p_expected_prior_pointer)` returns `(success: boolean, rejection_code: TEXT, rejection_detail: JSONB)`.

  - **R4 + R5 HIGH closure — server-derived actor authorization (Codex 2026-05-15):** the procedure is SECURITY DEFINER so it bypasses RLS. The R4 closure accepted `p_actor_id` + `p_actor_account_tenant_id` as caller-supplied — but Codex R5 correctly identified that caller-supplied identity is the bypass class R4 was supposed to eliminate. An app-role caller could present the target tenant as the actor tenant and pass the existence check.

    R5 closure: the procedure derives actor identity from SERVER-TRUSTED session-context GUCs populated by the authContextPlugin from a verified JWT (mirror of `current_tenant_id()` in `_session_tenant_context` table that already exists per migration 003):
    - Add a `_session_actor_context` table (or extend the existing `_session_tenant_context`) carrying `(pg_backend_pid, actor_account_id, actor_account_tenant_id, actor_role, actor_admin_home_tenant_id, session_id, bound_at, expires_at)`. The authContextPlugin INSERTs/UPSERTs into this table on every authenticated request before any business query runs.
    - Procedure reads the actor context via a definer-safe helper function `current_actor_account_id()`, `current_actor_account_tenant_id()`, `current_actor_role()`, `current_actor_admin_home_tenant_id()` analogous to the existing `current_tenant_id()`.
    - Procedure validates:
      - `current_actor_account_id() IS NOT NULL` — caller is authenticated (else fail closed)
      - `current_actor_role() ∈ {clinician, tenant_admin, platform_admin}` — caller has appropriate role for sync session escalation
      - For non-platform_admin: `current_actor_account_tenant_id() = p_tenant_id` — caller's account home tenant matches target consult tenant
      - For platform_admin: per F-4 cross-tenant admin attribution; `current_actor_admin_home_tenant_id()` becomes the audit row's `actor_tenant_id` (NOT `p_tenant_id`)
    - **No caller-supplied actor identity** — the procedure ignores any actor-related arguments and trusts ONLY the server-derived context. Caller-supplied `p_actor_id` / `p_actor_account_tenant_id` parameters REMOVED from the signature.
    - Rejection messages MUST be tenant-blind per I-025.

  - **EXECUTE grants:** the procedure has `REVOKE ALL ... FROM PUBLIC` + `GRANT EXECUTE TO telecheck_app_role` (the canonical application role). Direct-SQL break-glass paths require the `telecheck_admin_role` GRANT (per the F-4 break-glass pattern).

  **Prerequisite for procedure landing:** the `_session_actor_context` table + authContextPlugin DB-binding work is itself a separate slice / SI deliverable that lands BEFORE this procedure (the procedure cannot reference helpers that don't exist). Track that prerequisite as the new F-3 successor follow-on: Identity slice extension for session-bound DB context. Until F-3 lands, the procedure either fails closed (no _session_actor_context binding → reject all swaps) OR a transitional GRANT model restricts the procedure to a privileged break-glass role only.

  **R6 HIGH closure — request-scoped (not backend-lifetime) binding (Codex 2026-05-15):** the prior R5 closure described `_session_actor_context` keyed by `pg_backend_pid`. In pooled Postgres connections, PIDs are reused across requests. If authContextPlugin misses a code path, fails mid-request, handles an unauthenticated request, or leaves an unexpired row behind, the SECURITY DEFINER procedure would read stale actor identity and authorize the wrong actor — cross-request privilege bleed at the exact trust boundary R5 was supposed to close.

  Required design corrections:
  - **Transaction-local binding via `SET LOCAL`:** instead of (or in addition to) the `_session_actor_context` table row, authContextPlugin issues `SET LOCAL app.actor_account_id = '...'; SET LOCAL app.actor_role = '...'; SET LOCAL app.actor_account_tenant_id = '...'; SET LOCAL app.actor_admin_home_tenant_id = '...';` inside the request-scoped transaction. `SET LOCAL` values are tx-scoped (cleared on COMMIT/ROLLBACK) so they cannot bleed across requests on pooled connections. Helper functions (`current_actor_account_id()` etc.) read via `current_setting('app.actor_account_id', /*missing_ok=*/false)` which fails closed when no value is set.
  - **Per-request nonce assertion:** authContextPlugin ALSO inserts a tx-scoped row into a transient `_request_nonce` table keyed by `(pg_backend_pid, txid_current(), session_id, nonce)`. The procedure validates the nonce exists for the current transaction — defense in depth against `SET LOCAL` being inadvertently inherited across savepoints or carried into autonomous transactions.
  - **Per-request cleanup:** any `SET LOCAL`-style binding is automatically tx-scoped; explicit cleanup is not required but documented as belt-and-suspenders.
  - **Fail-closed paths:** if `current_setting()` raises (no value set), the procedure rejects with `unauthenticated` rejection code BEFORE any row probe. Missing context = no swap. The procedure NEVER falls back to caller-supplied identity (eliminates R5 bypass).
  - **Pooled-connection regression test:** SI-009 acceptance criteria require a regression test that:
    1. Authenticates request A (sets `SET LOCAL` actor context), starts a transaction
    2. Authenticates request B on the SAME pooled connection (different actor), starts a separate transaction
    3. Asserts the procedure invoked in B reads B's actor context (not A's bleed-through)
    4. Asserts the procedure invoked on an UNAUTHENTICATED request fails closed with `unauthenticated`
  - **Procedure body:** runs the four-predicate atomic UPDATE shown above (CAS + consult-state + same-tenant + same-originating-consult + target-session-actionable-state). Emits paired audit row in same transaction on success.
  - **Failure modes:** four-predicate UPDATE returns zero rows → rejection_code ∈ {`cas_mismatch`, `consult_state_invalid`, `target_session_missing`, `target_session_inactive`}. Procedure probes both rows post-UPDATE to determine which predicate filtered.
  - **Durability:** same three-tier durability pattern as SI-008's `record_workflow_pointer_swap()` (savepoint + autonomous-transaction rejection log + caller-commit-boundary contract). The autonomous log is `audit_swap_rejection_log` (same table as SI-008; the `target_table` discriminator column says `consults`).

  The procedure is the AI-workflow-pointer-swap pattern from SI-008 applied to sync session escalation. Same definer-rights enforcement; same GRANT model; same audit durability. The earlier text claiming "application-layer is proportionate" is REJECTED — direct-SQL / migration / admin-repair paths are real risk surfaces and the DB-boundary discipline is mandatory.

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
