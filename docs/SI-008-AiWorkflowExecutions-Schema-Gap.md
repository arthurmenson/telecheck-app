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
7. SI-005 deferred FK 6 (`consults.ai_workflow_execution_id`) can now be added as a NOT VALID composite FK referencing `ai_workflow_executions (tenant_id, id)`.
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

### Same-tenant invariant via composite FK

- The forward FK uses `(tenant_id, ai_workflow_execution_id)` so the pointed-at execution must be in the same tenant as the consult. Backward FK already enforces same-tenant per (2) above.

### Closure rule (v0.3 R2 HIGH-2 closure)

Codex R2 HIGH-2 correctly identified that application-layer closure enforcement leaves direct-SQL / migration / alternate-worker paths able to violate the invariant. v0.3 moves closure enforcement to the DB layer:

**Definer-rights stored procedure `record_workflow_pointer_swap(...)`** is the ONLY path that can UPDATE `consults.ai_workflow_execution_id`. The procedure:
1. Row-locks both `consults` and the new `ai_workflow_executions` row (in canonical id-order to prevent deadlocks)
2. Validates the new execution's `consult_id` equals the consult's `id`
3. Validates the new execution's `tenant_id` equals the consult's `tenant_id`
4. Validates the new execution's `state = 'completed'`
5. Validates the CAS guard (`$expected_prior_execution_id`)
6. Performs the UPDATE + sets `supersedes_execution_id` on the new execution + INSERTs the paired audit row in the same transaction
7. Returns success/failure

**GRANT model:** application code's role has NO direct UPDATE privilege on `consults.ai_workflow_execution_id` or `ai_workflow_executions.consult_id` or `ai_workflow_executions.supersedes_execution_id`. All mutations go through `record_workflow_pointer_swap()`. This closes Codex R2 HIGH-2 by making the closure rule a DB contract, not an application convention.

The procedure is the AI-workflow analog of SI-005's `record_consult_clinician_decision` + `rotate_consult_clinician_decision_kms` definer-rights pattern.

### Acyclicity enforcement for the SUPERSESSION chain (R6 HIGH closure 2026-05-15)

Codex R6 HIGH correctly identified that the self-cycle CHECK alone (`supersedes_execution_id <> id`) doesn't prevent deeper cycles (A→B→A) or reuse of a stale execution as a supersession target. The R3 application-layer assertion was vague about exact enforcement.

**Three concrete DB contracts to close R6 HIGH:**

1. **`supersedes_execution_id` is IMMUTABLE once set.** Add a trigger BEFORE UPDATE on `ai_workflow_executions` that REJECTS any UPDATE where `OLD.supersedes_execution_id IS NOT NULL AND NEW.supersedes_execution_id IS DISTINCT FROM OLD.supersedes_execution_id`. This prevents post-INSERT mutation of the lineage column. Combined with the v0.3 GRANT model (app role has NO direct UPDATE rights on this column), only `record_workflow_pointer_swap()` can set the value — and only on a fresh INSERT or as a transition NULL → value.

2. **Pointer swaps target a fresh execution not already in the chain.** `record_workflow_pointer_swap()` MUST walk the consult's existing supersession chain (starting from `consults.ai_workflow_execution_id` and recursively following `supersedes_execution_id` until NULL) and REJECT the swap if the proposed new execution's id appears anywhere in the chain. The chain walk runs INSIDE the procedure's row-locked transaction so it sees the current authoritative state.

3. **Reusing a completed execution as a fresh swap target is rejected.** If `new_execution.supersedes_execution_id IS NOT NULL` (i.e., it was already the result of a prior supersession), AND the same `new_execution.id` is being swapped INTO `consults.ai_workflow_execution_id`, the procedure REJECTS. This is the A→B→A guard: B can only supersede A once; reusing B (with its B→A supersession) to subsequently replace any execution in the same consult is forbidden.

Combined, these three contracts make the supersession chain a strictly-monotonic DAG: each execution appears at most once per consult lineage, the chain root (NULL `supersedes_execution_id`) is set once at INSERT, and post-INSERT `supersedes_execution_id` is immutable.

**Failure behavior:** all three checks raise `SQLSTATE 22000` (data exception) inside the procedure with HINT messages directing operators to the specific violation. The audit row emitted is `ai_workflow_execution.supersession_rejected` Category A capturing the (proposed_new_execution_id, prior_pointer, rejection_reason) tuple for forensic recovery.

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
