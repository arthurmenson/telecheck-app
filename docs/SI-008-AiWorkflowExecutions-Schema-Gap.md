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
-- v0.1 placeholder columns; SI-008 resume gate
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
state                       VARCHAR(30)  NOT NULL CHECK (...)  -- e.g. 'pending', 'completed', 'failed'
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

UNIQUE (tenant_id, id)  -- composite UNIQUE for cross-tenant FK safety (precedent: SI-005, SI-007)
FOREIGN KEY (tenant_id, consult_id) REFERENCES consults (tenant_id, id)
FOREIGN KEY (tenant_id, protocol_id) REFERENCES protocols (tenant_id, id)  -- when protocols table ratifies
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

**Decision (v0.2; pre-ratification):**

- **`ai_workflow_executions.consult_id` is non-unique** — a single consult may have multiple workflow execution rows representing retries / re-runs over time.
- **`consults.ai_workflow_execution_id` is the authoritative current pointer** — at any moment, points to the SINGLE execution whose recommendation is currently in the consult's clinician-review queue.
- **State machine invariant:** the workflow whose id is in `consults.ai_workflow_execution_id` MUST have `state='completed'`. The forward pointer is set when a workflow execution transitions `running → completed` AND wins the "current execution" race (atomic UPDATE with `WHERE consults.state='UNDER_REVIEW' AND consults.ai_workflow_execution_id IS NULL` or equivalent).
- **Same-tenant invariant via composite FK:** the forward FK uses `(tenant_id, ai_workflow_execution_id)` so the pointed-at execution must be in the same tenant as the consult. Backward FK already enforces same-tenant per (2) above.
- **Closure rule:** `ai_workflow_executions.consult_id` MUST equal `consults.id` for the execution row that `consults.ai_workflow_execution_id` points to. This invariant is enforced at the application layer (the state-machine transition that sets `consults.ai_workflow_execution_id` reads the execution row's `consult_id` and validates equality before UPDATE). A trigger-level enforcement is desirable for defense-in-depth but is complex (requires reading two rows in a single trigger fire); DB-level enforcement deferred until the application-layer invariant is proven stable.

This decision preserves the ability to re-run a workflow after failure (multiple execution rows allowed) while pinning authoritative reference to a single row at any moment.

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
