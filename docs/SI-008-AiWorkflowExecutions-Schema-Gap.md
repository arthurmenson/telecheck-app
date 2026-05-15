# SI-008 — AiWorkflowExecution schema gap (CDM v1.2)

**Raised by:** Engineering (autonomous run 2026-05-15; SI-005 deferred-FK trigger)
**Date:** 2026-05-15
**Severity:** medium (does NOT block current slices; comes due when async-consult Mode 2 case-prep AI workflows land — SI-005's deferred FK 6 points here)
**Status:** Open — awaiting CDM v1.2 §4 row-shape expansion
**Target spec doc:** `Telecheck_Canonical_Data_Model_v1_2.md`
**Target slice PRD:** `Telecheck_Async_Consult_Slice_PRD_v1_0.md` (uses `ai_workflow_execution_id` on consult rows)
**Parallel SIs:** SI-005 (Consult/ConsultEvent — names this FK as deferred), SI-001 (precedent pattern), SI-007 (cross-entity schema ratification + composite FK precedent)

---

## What this is

CDM v1.2 §3 entity inventory names **AiWorkflowExecution** (entity #19) at the entity-roster level: "Mode 2 protocol-execution AI workflow run; produces a recommendation for clinician review per ADR-002 + ADR-029."

CDM v1.2 §4 row-shape expansion does NOT include a detail block for entity #19. Same shape as SI-001 (MedicationRequest, entity #18, named without row-shape) and SI-005 (Consult, entity #15, same gap). The entity is named; no field-level schema is canonical.

## Why this is a gap, not a missing-feature

Per EHBG §7 and CLAUDE.md hard rules: engineering does NOT silently fork. When CDM §4 is silent on an entity that downstream slices reference (via FK like SI-005's `consults.ai_workflow_execution_id`), engineering MUST raise an SI rather than author placeholder schema without spec backing.

SI-005's resolution path explicitly defers FK 6 (`consults.ai_workflow_execution_id → ai_workflow_executions.id`) to "post-Mode-2-Case-Prep AI workflow slice ratification." That ratification is THIS SI.

## Decision (placeholder schema gated on SI-008 closure)

Per the established SI-001 / SI-005 / SI-007 pattern, when async-consult Mode 2 case-prep work begins:

- Sprint X ships placeholder `ai_workflow_executions` table
- SI-008 closure ratifies the column set upstream

Placeholder columns (minimal-viable for Mode 2 case-prep authoring):

```sql
-- v0.3 placeholder columns; SI-008 resume gate (R3 HIGH closure: schema
-- now includes every column referenced by the v0.3 CAS rerun protocol +
-- DB-layer closure procedure)
id                          VARCHAR(26)  PRIMARY KEY
tenant_id                   TEXT         NOT NULL REFERENCES tenants(id)
consult_id                  VARCHAR(26)  NOT NULL  -- composite FK below
workload_type               VARCHAR(50)  NOT NULL CHECK (...)  -- WORKLOAD_TAXONOMY v5.2 enum
ai_mode                     VARCHAR(20)  NOT NULL CHECK (...)  -- 'mode_2_case_prep' at v1.0
protocol_id                 VARCHAR(26)  NOT NULL  -- which protocol drove execution
protocol_version            INTEGER      NOT NULL  -- versioned per FORMS_ENGINE Pattern A
model_version               VARCHAR(50)  NOT NULL  -- provider+model identifier
guardrail_template_id       VARCHAR(26)  NULL  -- if Mode 1-style guardrails apply
autonomy_level              VARCHAR(50)  NOT NULL CHECK (...)  -- AUTONOMY_LEVELS v5.2 enum
state                       VARCHAR(30)  NOT NULL CHECK (...)  -- e.g. 'pending', 'running', 'completed', 'failed', 'cancelled'
supersedes_execution_id     VARCHAR(26)  NULL  -- R3 closure: rerun chain (NULL for first execution; set when superseding a prior)
created_at                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
started_at                  TIMESTAMPTZ  NULL
completed_at                TIMESTAMPTZ  NULL
recommendation_encrypted    BYTEA        NULL  -- KMS-encrypted output payload
recommendation_kms_key_id   TEXT         NULL  -- mirror of SI-005 Decision 8 KMS envelope columns
recommendation_kms_key_version INTEGER   NULL
recommendation_nonce        BYTEA        NULL
recommendation_aad          BYTEA        NULL
recommendation_schema_version INTEGER    NULL
recommendation_encrypted_at TIMESTAMPTZ  NULL
recommendation_dek_ciphertext BYTEA      NULL

UNIQUE (tenant_id, id)  -- composite UNIQUE for cross-entity composite FK safety (SI-005, SI-007 precedent)

-- R4 closure: triple-composite UNIQUE for same-consult-lineage
-- supersession FK below. Required so the (tenant_id, consult_id, id)
-- composite is referenceable.
UNIQUE (tenant_id, consult_id, id)

FOREIGN KEY (tenant_id, consult_id) REFERENCES consults (tenant_id, id)
FOREIGN KEY (tenant_id, protocol_id) REFERENCES protocols (tenant_id, id)  -- when protocols table ratifies

-- R3 + R4 closure: self-referential triple-composite FK for the rerun
-- chain. Enforces SAME-TENANT AND SAME-CONSULT lineage at the DB
-- layer — a workflow execution can only supersede a prior execution
-- that belongs to the SAME consult, not just any execution in the
-- same tenant. Closes Codex R4 HIGH: prior FK only enforced
-- same-tenant, leaving the supersession chain corrupt-able via a
-- stale forward pointer.
FOREIGN KEY (tenant_id, consult_id, supersedes_execution_id)
    REFERENCES ai_workflow_executions (tenant_id, consult_id, id)

-- R3 closure: acyclicity guard. A workflow execution MUST NOT
-- supersede itself. Deeper-cycle detection (A→B→A) requires graph
-- walking; deferred to application-layer assertion in
-- record_workflow_pointer_swap() (which validates against the consult's
-- current forward pointer before accepting the supersession).
CHECK (supersedes_execution_id IS NULL OR supersedes_execution_id <> id)
```

The KMS envelope columns mirror SI-005's Decision 8 (8-column envelope including DEK ciphertext) — the same Mode-2-output-protection-at-rest pattern. When SI-008 closes, the column set may consolidate via a shared `EncryptedPayload` composite type.

## Resolution path

When SI-008 closes:

1. CDM v1.2 §4 expansion adds row-shape detail block for AiWorkflowExecution (entity #19).
2. Spec defines the canonical state machine (e.g., `pending → running → completed | failed | cancelled`) per State Machines v1.1.
3. AUDIT_EVENTS expansion canonicalizes the `ai_workflow_execution.started / completed / failed` Category A audit IDs (currently expected at AUDIT_EVENTS v5.5).
4. DOMAIN_EVENTS expansion canonicalizes the wire-out events.
5. Forward migration ALTER (paired with rollback) adds any new columns ratified by §4 that the placeholder set didn't include.
6. Forward migration ALTER (paired with rollback) renames / retypes any columns where placeholder + ratified differ.
7. SI-005 deferred FK 6 (`consults.ai_workflow_execution_id`) MUST be added as a TRIPLE-composite FK enforcing same-tenant AND same-consult lineage (per R5 closure below):
   ```sql
   ALTER TABLE consults
       ADD CONSTRAINT fk_consults_ai_workflow_execution
       FOREIGN KEY (tenant_id, id, ai_workflow_execution_id)
       REFERENCES ai_workflow_executions (tenant_id, consult_id, id)
       NOT VALID;
   ```
   The earlier-drafted shape `(tenant_id, ai_workflow_execution_id) → (tenant_id, id)` is **REJECTED** because it only enforces same-tenant — a tenant-A consult could point at any tenant-A execution regardless of which consult that execution belongs to. R5 HIGH closure made this triple-composite the only acceptable closure target.
8. SI-008 status changed to "Resolved"; placeholder column SQL comments removed.

## Cross-tenant safety constraints (NOT placeholders; permanent)

Mirror of SI-005 + SI-007 discipline:

1. `ai_workflow_executions UNIQUE (tenant_id, id)` — required to support cross-entity composite FKs
2. `ai_workflow_executions FK (tenant_id, consult_id) → consults (tenant_id, id)` — prevents a tenant-A consult from being associated with a tenant-B workflow execution
3. KMS column-update path through a definer-rights stored procedure (mirror of SI-005 Decision 8 5a/5b): prevents direct UPDATE of the KMS envelope columns without same-tx audit emission

## Bidirectional pointer invariant (Codex R1 HIGH closure 2026-05-15)

The schema has two pointers:

- **Forward:** `consults.ai_workflow_execution_id → ai_workflow_executions (tenant_id, id)` (added at SI-005 closure)
- **Backward:** `ai_workflow_executions.consult_id → consults (tenant_id, id)` (this SI)

Without a single source of truth + consistency invariant, retries / re-runs / partial rollback could leave consult A pointing at execution X while execution Y ALSO claims consult A. Multiple workflows per consult is a legitimate semantic (a consult may have re-runs after a draft failure), but at any moment exactly ONE of those workflows is the **current authoritative** one whose recommendation drives clinician review.

**Decision (v0.3; Codex R2 HIGH x2 closure 2026-05-15):**

### Non-unique backward pointer + supersession-aware forward pointer

- **`ai_workflow_executions.consult_id` is non-unique** — a single consult may have multiple workflow execution rows over its lifecycle (re-runs after failure, refinement passes, etc.).
- **`consults.ai_workflow_execution_id` is the authoritative current pointer** — at any moment, points to the SINGLE execution whose recommendation is currently in the consult's clinician-review queue.
- **`ai_workflow_executions.supersedes_execution_id`** (NEW v0.3): when a re-run replaces an earlier execution, the new execution's `supersedes_execution_id` MUST equal the prior `consults.ai_workflow_execution_id` value at the moment of the swap. Audit trail recovers the entire chain via `supersedes_execution_id` walks.

### Compare-and-swap protocol for forward-pointer updates (v0.3 R2 HIGH-1 closure)

Codex R2 HIGH-1 correctly identified that `WHERE consults.ai_workflow_execution_id IS NULL` blocks legitimate re-runs. v0.3 defines explicit CAS rules:

**First-write (cold path):**
```sql
UPDATE consults
   SET ai_workflow_execution_id = $new_execution_id
 WHERE id = $consult_id
   AND tenant_id = $tenant_id
   AND state = 'UNDER_REVIEW'
   AND ai_workflow_execution_id IS NULL    -- expected prior
RETURNING id;
```

**Supersession (re-run path):**
```sql
UPDATE consults
   SET ai_workflow_execution_id = $new_execution_id
 WHERE id = $consult_id
   AND tenant_id = $tenant_id
   AND state = 'UNDER_REVIEW'                                     -- consult still pending decision
   AND ai_workflow_execution_id = $expected_prior_execution_id    -- CAS guard
RETURNING id;
```

The caller MUST supply `$expected_prior_execution_id` (the value they read at workflow-start time) — this is the compare-and-swap discriminator that prevents lost updates when two re-runs race. The new execution's `supersedes_execution_id` MUST also be set to `$expected_prior_execution_id` in the same transaction.

**Audit emission paired with every swap:** every forward-pointer UPDATE (first-write OR supersession) emits an `ai_workflow_execution.current_pointer_swapped` Category A audit row capturing the (prior, new) execution_id pair + the actor that initiated the swap. The `supersedes_execution_id` column on the new execution + the audit row together enable forensic recovery of the full execution chain.

**Cold-path failure:** if the first-write UPDATE affects zero rows (consult not UNDER_REVIEW or already has a pointer), the workflow caller reads the current consult state, decides whether to retry as a supersession OR fail the workflow with `ai_workflow_execution.race_lost` audit.

### Forward FK invariant (R5 + R7 + R8 closure: triple-composite same-tenant + same-consult)

- The forward FK is a TRIPLE-composite: `(tenant_id, id, ai_workflow_execution_id) → ai_workflow_executions (tenant_id, consult_id, id)`. This enforces both same-tenant AND same-consult lineage declaratively at the DB layer. See "Declarative same-consult enforcement for the FORWARD pointer (R5 HIGH closure)" below for the canonical SQL.
- The earlier-drafted same-tenant-only shape `(tenant_id, ai_workflow_execution_id) → (tenant_id, id)` is REJECTED throughout this SI. Any implementer following any section of this document MUST use the triple-composite form.
- Backward FK from `ai_workflow_executions.consult_id → consults (tenant_id, id)` already enforces same-tenant per (2) above; combined with the triple-composite forward FK, the bidirectional consistency is DB-enforced.

### Closure rule (v0.3 R2 HIGH-2 closure)

Codex R2 HIGH-2 correctly identified that application-layer closure enforcement leaves direct-SQL / migration / alternate-worker paths able to violate the invariant. v0.3 moves closure enforcement to the DB layer:

**Definer-rights stored procedure `record_workflow_pointer_swap(...)`** is the ONLY path that can UPDATE `consults.ai_workflow_execution_id`. R10 HIGH closure: the procedure adopts a SINGLE canonical lifecycle reconciling R6/R9's immutability trigger with the swap flow.

**Canonical lifecycle (R10):** the execution row already exists (it was INSERTed at workflow START with `state='running'` and an INSERT-time-fixed `supersedes_execution_id` value — either NULL for first-write, or `$expected_prior_execution_id` for a planned supersession). The procedure ONLY swaps the consult's forward pointer; it does NOT mutate `supersedes_execution_id` on the execution row (immutable post-INSERT per R9).

The procedure performs (in order):
1. Row-locks `consults` and the existing `ai_workflow_executions` row (canonical id-order to prevent deadlocks)
2. Validates the execution's `consult_id` equals the consult's `id` (declarative FK already enforces this; defense-in-depth)
3. Validates the execution's `tenant_id` equals the consult's `tenant_id` (declarative FK already enforces this)
4. Validates the execution's `state = 'completed'` (workflow caller has already transitioned `running → completed` BEFORE invoking the procedure; this gate ensures the procedure operates on terminal-state rows)
5. Validates the CAS guard: `consults.ai_workflow_execution_id = $expected_prior_execution_id`
6. **R13 HIGH closure:** validates the supersession-pointer-vs-CAS-prior consistency: `new_execution.supersedes_execution_id IS NOT DISTINCT FROM $expected_prior_execution_id`. This rejects a completed-but-unswapped row created against a stale prior from becoming authoritative under a refreshed CAS — the supersession pointer + the CAS guard MUST agree about what the proposed swap replaces. Retries after CAS loss require inserting a FRESH execution row with `supersedes_execution_id` set to the refreshed current pointer.
7. Validates supersession chain acyclicity per R6: walks the consult's current supersession chain from `consults.ai_workflow_execution_id` recursively via `supersedes_execution_id` and REJECTS if the proposed new execution's id appears anywhere
8. Performs the UPDATE on `consults.ai_workflow_execution_id` + INSERTs the paired audit row in the same transaction
9. Returns success / specific rejection code

**Failed-CAS recovery:** if the procedure rejects (CAS guard, state, chain, or other validation fails), the execution row stays in `state='completed'` with its INSERT-time-fixed `supersedes_execution_id`, but is NOT authoritative on the consult. The workflow caller emits `ai_workflow_execution.swap_rejected` Category A audit + can either:
- Retry the swap with a refreshed `$expected_prior_execution_id` (treats the failed swap as a CAS race; the now-completed but unswapped execution row is preserved as a forensic record)
- Mark the workflow as abandoned by INSERTing a NEW `ai_workflow_executions` row representing a fresh retry with state='cancelled' + supersedes_execution_id=NULL pointing-policy

**Orphan-row interpretation:** a completed execution row whose id never appears in the consult's authoritative forward pointer + chain is a LEGITIMATE forensic artifact — it records a workflow that succeeded computationally but failed to win the swap race. The chain walker filters these out when reconstructing the authoritative recommendation history.

**GRANT model:** application code's role has NO direct UPDATE privilege on `consults.ai_workflow_execution_id` or `ai_workflow_executions.consult_id` or `ai_workflow_executions.supersedes_execution_id`. All mutations go through `record_workflow_pointer_swap()`. This closes Codex R2 HIGH-2 by making the closure rule a DB contract, not an application convention.

The procedure is the AI-workflow analog of SI-005's `record_consult_clinician_decision` + `rotate_consult_clinician_decision_kms` definer-rights pattern.

### Acyclicity enforcement for the SUPERSESSION chain (R6 HIGH closure 2026-05-15)

Codex R6 HIGH correctly identified that the self-cycle CHECK alone (`supersedes_execution_id <> id`) doesn't prevent deeper cycles (A→B→A) or reuse of a stale execution as a supersession target. The R3 application-layer assertion was vague about exact enforcement.

**Three concrete DB contracts to close R6 HIGH:**

1. **`supersedes_execution_id` is IMMUTABLE for ALL post-INSERT mutations (R9 HIGH closure).** Add a trigger BEFORE UPDATE on `ai_workflow_executions` that REJECTS any UPDATE where `NEW.supersedes_execution_id IS DISTINCT FROM OLD.supersedes_execution_id` — regardless of whether OLD was NULL or non-NULL. This is stricter than the original R6 formulation (which only blocked non-NULL → other transitions). The stricter rule prevents owner-role SQL / migrations / backfills from retroactively inserting a NULL-supersession row into a lineage chain.

   Combined with this immutability rule, `supersedes_execution_id` is set at the row's INSERT time by the workflow caller (NOT by `record_workflow_pointer_swap()`). The trigger's BEFORE UPDATE then forbids ANY change to that column on ANY future UPDATE of the row, regardless of caller role.

   See the canonical lifecycle above for the full sequence: the execution row is INSERTed at workflow START (state='running', `supersedes_execution_id` supplied INSERT-time-immutable), the workflow caller transitions state to 'completed' via a separate UPDATE (allowed; only `supersedes_execution_id` is immutable, not `state`), and ONLY THEN invokes `record_workflow_pointer_swap()` which swaps `consults.ai_workflow_execution_id` to the now-completed row.

2. **Pointer swaps target a fresh execution not already in the chain.** `record_workflow_pointer_swap()` MUST walk the consult's existing supersession chain (starting from `consults.ai_workflow_execution_id` and recursively following `supersedes_execution_id` until NULL) and REJECT the swap if the proposed new execution's id appears anywhere in the chain. The chain walk runs INSIDE the procedure's row-locked transaction so it sees the current authoritative state.

3. **Reusing an already-authoritative execution as a fresh swap target is rejected (R12 HIGH closure).** The procedure REJECTS the swap if the proposed `new_execution.id` was EVER previously authoritative on this consult — i.e., if it appears anywhere in the consult's current supersession chain (walked from `consults.ai_workflow_execution_id` recursively via `supersedes_execution_id`). The check at R6 contract item 2 above already implements this walk; this item is the explicit guard.

   Codex R12 HIGH correctly identified that a naive "reject if `supersedes_execution_id IS NOT NULL`" guard would block every legitimate rerun (every supersession row has non-NULL supersedes_execution_id by definition). The CORRECT guard rejects only `id`-already-in-chain reuse.

   **Accepted examples:**
   - First-write: insert A with supersedes_execution_id=NULL, swap pointer to A. ✓
   - First rerun: insert B with supersedes_execution_id=A (the current pointer), swap pointer A→B. ✓
   - Second rerun: insert C with supersedes_execution_id=B, swap pointer B→C. Chain is C→B→A. ✓
   - Deep chain: D supersedes C, becomes authoritative. Chain is D→C→B→A. ✓

   **Rejected examples:**
   - A→B→A cycle: attempt to swap pointer back to A after chain is B→A. A already in chain → REJECT.
   - Re-INSERT of completed-but-unswapped orphan: a workflow caller cannot swap an orphaned completed row into authority via a NEW insert with the same id; ULIDs are unique by construction so this is impossible at the DB layer.
   - Reuse of completed authoritative row: impossible by construction since IDs are unique + supersedes_execution_id is INSERT-time-immutable.

Combined, these three contracts make the supersession chain a strictly-monotonic DAG: each execution appears at most once per consult lineage, the chain root (NULL `supersedes_execution_id`) is set once at INSERT, and post-INSERT `supersedes_execution_id` is immutable.

**Failure behavior (R13 MEDIUM closure 2026-05-15):** all validation failures use a NON-THROWING rejection path. The procedure RETURNS a structured `(success: boolean, rejection_code: TEXT, rejection_detail: JSONB)` tuple instead of raising. This is essential because Postgres transactional semantics roll back any audit row INSERTed in the same transaction as a raised exception — claiming "same-transaction audit durability" for a raised-exception path is incorrect.

For rejections, the procedure runs in a NESTED transaction (via SAVEPOINT):

```sql
BEGIN  -- outer transaction (caller's)
  SAVEPOINT swap_attempt;
  ... validation checks ...
  IF any_check_fails THEN
    ROLLBACK TO SAVEPOINT swap_attempt;  -- discard partial work
    -- Emit the rejection audit AFTER the savepoint rollback so it's
    -- in the OUTER transaction, NOT the rolled-back savepoint
    INSERT INTO audit_records (... action='ai_workflow_execution.swap_rejected' ...);
    RETURN (success=false, rejection_code=$code, rejection_detail=$detail);
  END IF;
  ... perform swap ...
  INSERT INTO audit_records (... action='ai_workflow_execution.current_pointer_swapped' ...);
  RETURN (success=true, ...);
END
```

The rejection audit row SURVIVES the savepoint rollback (it's emitted AFTER the `ROLLBACK TO SAVEPOINT`), so it's in the outer transaction. **But R14 HIGH closure (Codex 2026-05-15):** that is NOT the same as "durable." If the caller's outer transaction rolls back (timeout, later error, application-level abort), the rejection audit row is lost.

**Durability contract — three-tier defense (R14 closure):**

1. **Tier 1 (savepoint survival):** the SAVEPOINT-rollback-then-INSERT pattern above. Rejection audit survives the partial-work discard. Sufficient when the caller's outer transaction commits.

2. **Tier 2 (autonomous-transaction rejection log):** the procedure ALSO emits the rejection record to a SEPARATE `audit_swap_rejection_log` table via an autonomous-transaction wrapper (Postgres lacks native `PRAGMA AUTONOMOUS_TRANSACTION` but the same effect is achieved via `dblink` to localhost or a deferred constraint trigger with a wrapper function on a separate background-worker connection). This table is non-tenant-scoped (operational) and writes commit independently of the caller's transaction state. The schema:
   ```sql
   CREATE TABLE audit_swap_rejection_log (
       id BIGSERIAL PRIMARY KEY,
       attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       tenant_id TEXT NOT NULL,
       consult_id VARCHAR(26) NOT NULL,
       proposed_execution_id VARCHAR(26) NOT NULL,
       expected_prior_execution_id VARCHAR(26),
       rejection_code TEXT NOT NULL,
       rejection_detail JSONB NOT NULL,
       caller_actor_id VARCHAR(26)
   );
   ```
   Rows survive caller rollback. The chain walker reconciles `audit_swap_rejection_log` entries with the `audit_records` chain when reconstructing forensic history.

3. **Tier 3 (caller-required commit boundary):** the SI's acceptance criteria require that `record_workflow_pointer_swap()` be invoked inside a transaction the caller commits IMMEDIATELY upon receiving the result tuple — no further work in the same transaction after the procedure returns. This contract is enforced via a runtime check at procedure entry that inspects the call stack via `current_query()` and rejects with a hard exception if invoked from inside a long-lived application transaction. The check is best-effort (Postgres exposes limited transaction context); the Tier 2 autonomous log is the unconditional durability backstop.

**Acceptance criteria:** an SI-008 implementation MUST include a regression test that:
1. Invokes `record_workflow_pointer_swap()` from a caller transaction that then rolls back
2. Asserts the `audit_swap_rejection_log` row IS PRESENT post-rollback (Tier 2 durability)
3. Asserts the `audit_records.ai_workflow_execution.swap_rejected` row IS ABSENT post-rollback (Tier 1 within-tx behavior; expected loss)
4. Reconciles forensic history by joining the rejection log + the audit chain in the chain-walker test helper

Three rejection codes:
- `cas_mismatch`: CAS guard violation (step 5)
- `supersession_pointer_mismatch`: supersedes_execution_id != $expected_prior (step 6)
- `chain_cycle`: proposed id already in chain (step 7)
- `state_invalid`: execution not in 'completed' state (step 4)

### Declarative same-consult enforcement for the FORWARD pointer (R5 HIGH closure 2026-05-15)

Codex R5 HIGH correctly identified that even with the procedure-only-write GRANT model, a future migration / owner-role SQL / backfill path could obtain UPDATE rights and bypass the procedure. The forward FK in SI-005's resolution path must be tightened to enforce same-consult lineage declaratively, not just same-tenant.

**Forward FK (SI-005 closure must use this shape):**

```sql
-- The `consults` table needs a UNIQUE (tenant_id, id) (it already does
-- per SI-005's existing composite UNIQUE). The forward pointer FK is
-- a triple-composite that proves the pointed-at execution belongs to
-- THIS consult, not just to this tenant.
ALTER TABLE consults
    ADD CONSTRAINT fk_consults_ai_workflow_execution
    FOREIGN KEY (tenant_id, id, ai_workflow_execution_id)
    REFERENCES ai_workflow_executions (tenant_id, consult_id, id);
```

The FK uses the SI-008 placeholder's `UNIQUE (tenant_id, consult_id, id)` (added at R4 closure) as the referenced uniqueness target. Now a `consult` row can ONLY point at an execution whose `consult_id` equals the `consult`'s own `id` — DB-enforced, regardless of which code path mutates the pointer.

`record_workflow_pointer_swap()` continues to enforce the CAS guard + state validation + audit emission. The FK is the declarative backstop that catches any path that bypasses the procedure.

**SI-005 closure follow-up:** the SI-005 resolution path's FK 6 definition must be updated to use this triple-composite shape, replacing the original `(tenant_id, ai_workflow_execution_id) → ai_workflow_executions (tenant_id, id)` proposal.

## Open questions for CDM author

- **state vocabulary:** is `pending | running | completed | failed | cancelled` the canonical set, or does Mode 2 case-prep need additional states (e.g., `requires_clinician_review`, `clinician_approved`, `clinician_declined`)? If the workflow lifecycle includes clinician-decision states, those may belong on the Consult entity (per SI-005's clinician_decision_class column set) rather than here.
- **protocol versioning:** what's the relationship between `ai_workflow_executions.protocol_version` and the `protocols` table's version-immutability? Pattern A semantics suggest a version is captured at execution time + immutable thereafter; needs explicit pin.
- **recommendation storage size:** KMS-encrypted Mode 2 recommendations could grow large (multi-page clinician-facing rationale). Should the table use TOAST-stored BYTEA, or should the recommendation move to S3 with only a pointer in the DB? Engineering Lead amendment pending.

## Spec references

- CDM v1.2 §3 entity #19 (AiWorkflowExecution — named, no row shape)
- ADR-002 (AI mode taxonomy: Mode 1 conversational, Mode 2 protocol execution)
- ADR-029 (AI workload taxonomy; supersedes ADR-002 prospectively)
- WORKLOAD_TAXONOMY v5.2 (workload_type enum)
- AUTONOMY_LEVELS v5.2 (autonomy_level enum)
- Async-Consult Slice PRD v1.0 §X (Mode 2 case-prep workflow integration)
- SI-005 §"Cross-tenant safety constraints" (deferred FK 6 reference)

## Status

- **Filed:** 2026-05-15 (autonomous run)
- **Target Promotion Ledger entry:** P-018 (P-017 SI-005 pending)
