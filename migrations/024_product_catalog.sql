-- =============================================================================
-- File:    migrations/024_product_catalog.sql
-- Purpose: ProductCatalog table per CDM v1.2 §4.9. Per-tenant medication +
--          product catalog with pricing and adapter routing. Targets
--          Pharmacy + Refill Slice PRD v2.1 §8 binding (Subscription.product_id
--          FK; future MedicationRequest.product_catalog_id FK per SI-001 DRAFT).
--
-- Spec:    - Canonical Data Model v1.2 §4.9 ProductCatalog (lines 496-554)
--          - Pharmacy + Refill Slice PRD v2.1 (consumer)
--          - SI-001 Closure DRAFT v0.2 (Telecheck_SI_Closure_Cycle_2026-05-11/)
--            — describes the composite FK target pattern that MedicationRequest
--            will use; we add the composite UNIQUE (tenant_id, id) defensively
--            so future migrations can establish the composite FK without
--            requiring an ALTER pass.
--          - ADR-001 (modular monolith)
--          - ADR-023 (multi-tenancy Model A; three-layer RLS)
--          - PROJECT_CONVENTIONS r5 §1.1 (composite UNIQUE for FK targets)
--          - PROJECT_CONVENTIONS r5 §1.2 (named constraints)
--          - I-023 / I-027 (RLS + tenant scoping)
--          - migrations/003_rls_helpers.sql (current_tenant_id() helper)
--
-- DEVIATIONS FROM CDM v1.2 §4.9 (additive only; no breaking changes):
--   1. RLS policy uses the repo-canonical `current_tenant_id()` helper from
--      migration 003 instead of CDM §4.9's `current_setting('app.tenant_id',
--      true)::VARCHAR` example. The CDM example predates the helper; every
--      shipped migration in this repo (016 consent, 020 async-consult, etc.)
--      uses the helper. The helper hardens against user-settable-session-
--      variable trust-boundary issues. This deviation matches Codex Finding 4
--      on SI-001 v0.2 — same correction applied here.
--   2. Composite UNIQUE (tenant_id, id) added defensively per
--      PROJECT_CONVENTIONS r5 §1.1. CDM §4.9 doesn't enumerate it, but
--      Subscription.product_id (CDM §4.7 line 229) is a simple FK to
--      product_catalog.id today; MedicationRequest.product_catalog_id (SI-001
--      DRAFT v0.2) wants a composite FK to (tenant_id, id). Adding the
--      composite UNIQUE now makes both possible without forcing a future
--      ALTER.
--   3. `tenant_id` typed as VARCHAR(26) to match the existing tenants.id
--      column type (CDM §4.1 sets tenants.id as VARCHAR(26)). CDM §4.9 used
--      the same; no deviation here, just calling it out.
--
-- PRECONDITIONS:
--   001_tenants.sql       applied (FK target for tenant_id)
--   003_rls_helpers.sql   applied (current_tenant_id())
--
-- DOWNSTREAM CONSUMERS (forward-looking):
--   - Subscription slice (CDM §4.7): subscriptions.product_id FK to
--     product_catalog.id (already canonical at v1.2)
--   - Pharmacy slice (Sprint 35+ / TLC-055; pending SI-001 ratification):
--     medication_requests.product_catalog_id composite FK to
--     (tenant_id, id)
--
-- ROLLBACK:
--   migrations/rollback/024_rollback.sql
-- =============================================================================

CREATE TABLE IF NOT EXISTS product_catalog (
    id                              VARCHAR(26) PRIMARY KEY,
    tenant_id                       VARCHAR(26) NOT NULL REFERENCES tenants(id),

    -- Identification (per CDM v1.2 §4.9)
    display_name                    VARCHAR(200) NOT NULL,
    generic_name                    VARCHAR(200) NOT NULL,
    rxnorm_code                     VARCHAR(20),
    ndc_codes                       JSONB,

    -- Form / strength
    form                            VARCHAR(50),                          -- 'injection_solution' | 'tablet' | 'topical_solution' | etc.
    strength                        VARCHAR(50),
    package_size                    VARCHAR(50),

    -- Categorization
    program                         VARCHAR(50) NOT NULL,                 -- 'weight_loss' | 'ed' | 'hair_loss' | 'skincare' | 'diabetes' | etc.
    category                        VARCHAR(50) NOT NULL,                 -- 'primary_treatment' | 'supplement' | 'support'

    -- Pharmacy routing
    available_adapters              JSONB NOT NULL,                       -- ['truepill', 'honeybee']
    preferred_adapter               VARCHAR(50),

    -- Compounding
    is_compounded                   BOOLEAN NOT NULL DEFAULT FALSE,
    compounding_pharmacy_type       VARCHAR(20),                          -- '503A' | '503B' | NULL

    -- Pricing (per cadence, in tenant currency per CCR)
    pricing                         JSONB NOT NULL,                       -- {"monthly": 199.00, "quarterly": 549.00, "one_time": 99.00}

    -- Subscription support
    subscription_eligible           BOOLEAN NOT NULL DEFAULT TRUE,

    -- Status
    status                          VARCHAR(20) NOT NULL,                 -- 'active' | 'out_of_stock' | 'discontinued'

    -- Operational
    description_patient_facing      TEXT,
    description_clinical            TEXT,

    created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Composite UNIQUE per PROJECT_CONVENTIONS r5 §1.1 — enables downstream
    -- composite-FK targeting (medication_requests per SI-001 DRAFT v0.2)
    -- without requiring a future ALTER.
    CONSTRAINT product_catalog_tenant_id_id_unique UNIQUE (tenant_id, id),

    -- Status enum validation (additive guard; matches CDM §4.9 inline comment)
    CONSTRAINT product_catalog_status_valid CHECK (
        status IN ('active', 'out_of_stock', 'discontinued')
    ),

    -- Compounding pharmacy type validation (additive guard; matches CDM §4.9 inline comment)
    CONSTRAINT product_catalog_compounding_type_valid CHECK (
        compounding_pharmacy_type IS NULL
        OR compounding_pharmacy_type IN ('503A', '503B')
    )
);

-- Indexes per CDM v1.2 §4.9 + tenant-scoped lookups
CREATE INDEX IF NOT EXISTS idx_product_catalog_tenant
    ON product_catalog (tenant_id);
CREATE INDEX IF NOT EXISTS idx_product_catalog_program
    ON product_catalog (tenant_id, program, status);
CREATE INDEX IF NOT EXISTS idx_product_catalog_rxnorm
    ON product_catalog (rxnorm_code)
    WHERE rxnorm_code IS NOT NULL;

-- RLS policy: tenant-scoped read+write per ADR-023 + I-023 three-layer
-- enforcement. Uses the canonical `current_tenant_id()` helper from
-- migration 003 (NOT the CDM §4.9 example's
-- `current_setting('app.tenant_id', true)::VARCHAR` which predates the helper).
ALTER TABLE product_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_catalog FORCE ROW LEVEL SECURITY;

CREATE POLICY product_catalog_tenant_isolation
    ON product_catalog
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
