-- =============================================================================
-- File:    migrations/025_medication_requests.sql
-- Purpose: Create the `medication_requests` table — the Pharmacy + Refill
--          slice's foundational schema per SI-001 DRAFT (CDM v1.2 §4.16
--          proposal as of 2026-05-11).
--
-- STATUS:  SPECULATIVE DRAFT pre-SI-001-ratification.
--          The schema below is implemented exactly per the SI-001 closure
--          artifact at
--            Telecheck_SI_Closure_Cycle_2026-05-11/
--            Telecheck_SI_001_MedicationRequest_Schema_DRAFT.md
--          Evans has not yet ratified that artifact into the canonical
--          CDM v1.2 §4.16. If ratification adjusts column types, FK
--          targets, CHECK constraints, indexes, or the state enum, this
--          migration MUST be revised (or superseded by a follow-on
--          migration) before merge into main.
--
-- Spec references:
--   - Telecheck_SI_001_MedicationRequest_Schema_DRAFT.md (the DRAFT) — §"Proposed CDM §4.16"
--   - CDM v1.2 §3.5 entity #18 (MedicationRequest inventory row)
--   - State Machines v1.1 §19 (DRAFT — MedicationRequest lifecycle: 8 states)
--   - AUDIT_EVENTS v5.2 §Category-A (DRAFT — 11 medication_request.* IDs)
--   - DOMAIN_EVENTS v5.2 §envelope (DRAFT — 5 medication_request.* types)
--   - Pharmacy + Refill Slice PRD v2.1 §8
--   - PROJECT_CONVENTIONS r5 §1.1 (composite UNIQUE + composite FK),
--                          §1.2 (named constraints),
--                          §1.3 (RLS mandatory)
--   - I-003 (audit append-only; supersession-chain pattern), I-012
--     (prescribing reject-unless three-clause), I-023 (tenant isolation
--     three-layer), I-025 (tenant-blind errors), I-027 (audit tenant
--     context), I-031 (high_pii audit class — does NOT apply here)
--
-- Append-only semantics:
--   Discontinuation creates a new row at status='discontinued' with
--   supersedes_id pointing back at the row it replaces. The replaced row
--   is UPDATEd to status='superseded' + superseded_by_id under a
--   controlled UPDATE that the I-003 hash-chain audit captures. Bare
--   suppression on the prior row would itself be an I-003 violation.
--
-- Out-of-scope for THIS migration (deferred):
--   - interaction_overrides table (Med Interaction Engine slice; Path 1
--     ratification 2026-05-11 means MedicationRequest does NOT carry an
--     FK to it — domain-event integration only)
--   - refills, dispensings, shipments tables (Pharmacy + Refill follow-on)
--   - protocols table (referenced by protocol_id; future entity)
--
-- v0.2 Codex Finding 1 closure (2026-05-11):
--   v0.1 of this migration omitted the composite (tenant_id, product_catalog_id)
--   FK because `product_catalog` did not yet exist in the migrations chain.
--   Codex flagged this as HIGH severity on PR #95 — orphan or wrong-tenant
--   catalog references in prescribing records undermine the snapshot-at-
--   prescribe-time safety model. Migration 024 (PR #101 MERGED 2026-05-11)
--   now provides the canonical `product_catalog` table per CDM v1.2 §4.9
--   with a composite UNIQUE (tenant_id, id) defensively added per
--   PROJECT_CONVENTIONS r5 §1.1 specifically to enable this FK. v0.2 of
--   this migration establishes the composite FK from row 0.
--
-- v0.3 Codex re-review closures (2026-05-11):
--   CRITICAL ordering bug — file was numbered 023, but its 024 FK target
--   applied later in lexicographic order. RENUMBERED 023 → 025 so the
--   apply order is: 020-022 (existing) → 023-skipped → 024_product_catalog
--   → 025_medication_requests. References in
--   src/modules/pharmacy/internal/{types,repositories/*-repo}.ts updated.
--
--   HIGH stale I-012 CHECK — v0.1/v0.2 used parity-only check (ai_workload_
--   type and autonomy_level both null or both set). SI-001 v0.2 DRAFT
--   tightened this to state-dependent + canonical-value enforcement
--   (i012_envelope_active_check + i012_protocol_binding_check). v0.3
--   strengthens the DDL to match. Reserved AI workload types and reserved
--   autonomy levels are rejected by omission from the canonical IN-list.
--
--   MEDIUM rollback partial-apply — rollback 025's `DROP POLICY IF EXISTS`
--   required the target table to exist. Wrapped in to_regclass-guarded
--   DO block mirroring rollback 024's pattern.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql      applied (FK target — tenants)
--   003_rls_helpers.sql  applied (current_tenant_id())
--   012_accounts.sql     applied (composite-FK target — accounts UNIQUE (tenant_id, account_id))
--   020+021_async_consult applied (composite-FK target — consults UNIQUE (tenant_id, id))
--   024_product_catalog  applied (composite-FK target — product_catalog UNIQUE (tenant_id, id))
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS medication_requests (

    -- Identity ---------------------------------------------------------------
    id                                  VARCHAR(26)  PRIMARY KEY,            -- ULID
    tenant_id                           VARCHAR(26)  NOT NULL
                                            REFERENCES tenants(id),

    -- Patient anchor (composite FK enforces same-tenant binding) -------------
    patient_account_id                  VARCHAR(26)  NOT NULL,

    -- Catalog anchor ---------------------------------------------------------
    -- v0.2 Codex Finding 1 closure: composite FK target now exists via
    -- migration 024 (product_catalog per CDM v1.2 §4.9; composite UNIQUE
    -- on (tenant_id, id) per PROJECT_CONVENTIONS r5 §1.1). FK constraint
    -- below in the constraints block.
    product_catalog_id                  VARCHAR(26)  NOT NULL,

    -- Clinical detail (snapshot-at-prescribe-time) ---------------------------
    medication_name                     VARCHAR(200) NOT NULL,               -- snapshot
    strength                            VARCHAR(80)  NOT NULL,               -- '500mg' etc.
    formulation                         VARCHAR(40)  NOT NULL,               -- 'tablet' etc.
    dose_instructions                   TEXT         NOT NULL,
    quantity                            INTEGER      NOT NULL,
    quantity_unit                       VARCHAR(20)  NOT NULL,
    refills_allowed                     INTEGER      NOT NULL,
    indication                          VARCHAR(200),
    clinical_notes                      TEXT,

    -- Lifecycle status (see State Machines §19 DRAFT) ------------------------
    status                              VARCHAR(30)  NOT NULL,

    -- Lifecycle timestamps ---------------------------------------------------
    prescribed_at                       TIMESTAMPTZ,
    activated_at                        TIMESTAMPTZ,
    discontinued_at                     TIMESTAMPTZ,
    discontinued_reason                 VARCHAR(60),
    expires_at                          TIMESTAMPTZ,

    -- Authorship (clinician anchor) ------------------------------------------
    prescribed_by_clinician_account_id  VARCHAR(26),
    prescribing_consult_id              VARCHAR(26),

    -- Safety integration (Med Interaction Engine) ----------------------------
    interaction_signals_evaluated_at    TIMESTAMPTZ,
    interaction_signals_status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
    -- v1.0 RATIFICATION (Evans 2026-05-11; Promotion Ledger P-011 Path 1):
    -- the `interaction_override_id` column was REMOVED from CDM §4.16 per
    -- Path 1 of the SI-001 closure. The Med Interaction Engine slice owns
    -- its own override workflow + table; MedicationRequest integrates via
    -- the `medication_request.interaction_safety_hold_triggered` domain
    -- event (DOMAIN_EVENTS v5.2 — also added at P-011). No FK pointer
    -- here means cleaner module-boundary separation per ADR-001.

    -- I-012 reject-unless three-clause envelope ------------------------------
    ai_workload_type                    VARCHAR(40),
    autonomy_level                      VARCHAR(40),
    protocol_id                         VARCHAR(26),
    protocol_version                    VARCHAR(20),

    -- Append-only via supersession -------------------------------------------
    supersedes_id                       VARCHAR(26),
    superseded_by_id                    VARCHAR(26),

    -- CCR linkage (denormalized per Tenant Threading Addendum §3.4) ----------
    country_of_care                     CHAR(2)      NOT NULL,

    -- Standard timestamps ----------------------------------------------------
    created_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at                          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- ---------------------------------------------------------------------
    -- Composite UNIQUE for downstream composite-FK pattern (subscription,
    -- refill, dispensing, shipment will FK against this)
    -- ---------------------------------------------------------------------

    CONSTRAINT medication_requests_tenant_id_id_unique
        UNIQUE (tenant_id, id),

    -- ---------------------------------------------------------------------
    -- Composite FKs (per PROJECT_CONVENTIONS r5 §1.1)
    -- ---------------------------------------------------------------------

    -- Patient must belong to the same tenant
    CONSTRAINT medication_requests_tenant_patient_fk
        FOREIGN KEY (tenant_id, patient_account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- Prescriber (when set) must belong to the same tenant
    CONSTRAINT medication_requests_tenant_clinician_fk
        FOREIGN KEY (tenant_id, prescribed_by_clinician_account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- Prescribing consult (when set) must belong to the same tenant
    CONSTRAINT medication_requests_tenant_consult_fk
        FOREIGN KEY (tenant_id, prescribing_consult_id)
        REFERENCES consults (tenant_id, id),

    -- Product catalog item must belong to the same tenant (composite FK).
    -- v0.2 Codex Finding 1 closure: enabled by migration 024 product_catalog
    -- + its composite UNIQUE (tenant_id, id). Closes orphan-/cross-tenant-
    -- catalog-reference risk on snapshot-at-prescribe-time records.
    CONSTRAINT medication_requests_tenant_product_fk
        FOREIGN KEY (tenant_id, product_catalog_id)
        REFERENCES product_catalog (tenant_id, id),

    -- Supersession-chain self-FKs (composite) -----------------------------
    CONSTRAINT medication_requests_supersedes_fk
        FOREIGN KEY (tenant_id, supersedes_id)
        REFERENCES medication_requests (tenant_id, id),
    CONSTRAINT medication_requests_superseded_by_fk
        FOREIGN KEY (tenant_id, superseded_by_id)
        REFERENCES medication_requests (tenant_id, id),

    -- ---------------------------------------------------------------------
    -- CHECK constraints (per SI-001 DRAFT §"Proposed CDM §4.16")
    -- ---------------------------------------------------------------------

    -- State enum validation
    CONSTRAINT medication_requests_status_valid CHECK (
        status IN (
            'draft',
            'pending_interaction_check',
            'pending_clinician_review',
            'active',
            'discontinued',
            'superseded',
            'expired',
            'rejected'
        )
    ),

    -- Discontinuation reason enum
    CONSTRAINT medication_requests_discontinued_reason_valid CHECK (
        discontinued_reason IS NULL OR
        discontinued_reason IN (
            'clinical_decision',
            'adverse_event',
            'patient_request',
            'replaced_by_new_prescription',
            'expired',
            'safety_hold'
        )
    ),

    -- Set when discontinued; null otherwise
    CONSTRAINT medication_requests_discontinued_reason_set_when_discontinued CHECK (
        (status = 'discontinued') = (discontinued_reason IS NOT NULL)
    ),

    -- Interaction-signals enum
    CONSTRAINT medication_requests_interaction_signals_status_valid CHECK (
        interaction_signals_status IN ('pending', 'clean', 'caution', 'safety_hold')
    ),

    -- I-012 three-clause rule per AUDIT_EVENTS v5.2 + INVARIANTS I-012
    -- (v0.2 Codex Finding 3 closure — strengthened from parity-only check
    -- to state-dependent + canonical-value enforcement per the SI-001 v0.2
    -- DRAFT artifact):
    --   (1) ai_workload_type must be canonical (WORKLOAD_TAXONOMY v5.2
    --       active levels at v1.0)
    --   (2) autonomy_level must be 'action_with_confirm' (the single
    --       I-012-permitted level at v1.0)
    --   (3) reserved workload/autonomy values forbidden until ADR-030 +
    --       successor invariant
    -- The CHECK is state-dependent: status='active' (and onward terminal
    -- states) MUST either have both AI fields null (clinician-only path)
    -- OR both populated with canonical I-012 values (AI-participating
    -- path). Pre-active states accept null AI fields by omission.
    CONSTRAINT medication_requests_i012_envelope_active_check CHECK (
        -- Pre-active states: AI fields can be null (envelope not yet populated)
        (status NOT IN ('active', 'discontinued', 'superseded', 'expired')
         AND ai_workload_type IS NULL
         AND autonomy_level IS NULL)
        OR
        -- Active and post-active states: I-012 envelope must be valid
        (status IN ('active', 'discontinued', 'superseded', 'expired')
         AND (
           -- (a) Clinician-only path: no AI fields set
           (ai_workload_type IS NULL AND autonomy_level IS NULL)
           OR
           -- (b) AI-participating path: canonical v1.0 values only
           (ai_workload_type IN ('clinical_assistant_mode_1', 'protocol_execution_mode_2')
            AND autonomy_level = 'action_with_confirm')
         ))
    ),

    -- Protocol-authorized path: when autonomy_level set, protocol_id +
    -- protocol_version required. Catches Mode 2 protocol-authorized
    -- prescribing rows that lack the protocol-binding evidence.
    CONSTRAINT medication_requests_i012_protocol_binding_check CHECK (
        autonomy_level IS NULL
        OR (autonomy_level = 'action_with_confirm'
            AND protocol_id IS NOT NULL
            AND protocol_version IS NOT NULL)
    ),

    -- Country-of-care must be ISO 3166-1 alpha-2
    CONSTRAINT medication_requests_country_valid CHECK (
        country_of_care ~ '^[A-Z]{2}$'
    )
);

-- ---------------------------------------------------------------------------
-- Row-Level Security per ADR-023 + PROJECT_CONVENTIONS r5 §1.3
-- ---------------------------------------------------------------------------

ALTER TABLE medication_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON medication_requests
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Indexes (per SI-001 DRAFT §"Proposed CDM §4.16")
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_medication_requests_tenant_patient
    ON medication_requests (tenant_id, patient_account_id, status);

CREATE INDEX IF NOT EXISTS idx_medication_requests_tenant_clinician
    ON medication_requests (tenant_id, prescribed_by_clinician_account_id)
    WHERE prescribed_by_clinician_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_medication_requests_tenant_consult
    ON medication_requests (tenant_id, prescribing_consult_id)
    WHERE prescribing_consult_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_medication_requests_tenant_status_active
    ON medication_requests (tenant_id, status)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_medication_requests_supersession_chain
    ON medication_requests (tenant_id, supersedes_id)
    WHERE supersedes_id IS NOT NULL;

-- Migration 023 complete. medication_requests is now the canonical
-- prescribing-record table for the Pharmacy + Refill slice (DRAFT
-- pending SI-001 ratification).
