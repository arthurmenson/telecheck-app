-- =============================================================================
-- File:    migrations/001_tenants.sql
-- Purpose: Create the foundational `tenants` table. Every PHI-touching table
--          in the platform references `tenant_id` as a foreign key to this
--          table. This migration MUST run before any other table migration.
-- Spec:    - CDM v1.2 §4.1 (Tenant entity schema)
--          - Master PRD v1.10 §17 (C3 brand-structure rules)
--          - Contracts Pack v5.2 GLOSSARY (forbidden aliases, canonical
--            tenant-identifier format)
--          - ADR-023 (multi-tenancy Model A — logical isolation by tenant_id)
--          - ADR-024 (per-tenant KMS key for encryption-at-rest)
--          - I-023 (three-layer tenant isolation; tenant_id on every PHI record)
--          - I-026 (tenant configuration changes are governance events;
--            country_of_care is effectively immutable post-creation)
--          - I-028 (single DB, single schema; isolation is logical)
-- Summary: Creates `tenants` table with operating-tenant identifiers in
--          `Telecheck-{country}` format per §17 C3 brand-structure rules.
--          Seeds the two day-1 operating tenants. No RLS on this table —
--          it is the root identity table used by the RLS system itself (RLS
--          policies on PHI tables reference tenants.id; applying RLS here
--          would create a bootstrap circularity).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- C3 Brand-Structure Rule (Master PRD v1.10 §17 + Glossary v5.2):
--
--   Operating-tenant identifiers (tenant.id) MUST use the format
--   `Telecheck-{ISO2}` (e.g., Telecheck-US, Telecheck-Ghana).
--
--   Consumer-facing brand names (e.g., "Heros Health", "Heros Health Ghana")
--   are stored in `consumer_dba` and sourced from that column for ALL
--   patient-facing rendering. NEVER render `tenant.id` to a patient.
--
--   Bare "Heros" as a tenant or operator identifier is FORBIDDEN outside
--   the §17 contextual carve-outs. It is not a valid tenant.id value.
-- ---------------------------------------------------------------------------

-- SPEC ISSUE RESOLVED 2026-05-02 (Promotion Ledger P-010 in spec corpus):
--   CDM v1.2 §4.1 was previously inconsistent with Master PRD v1.10 §17 (ULID
--   prefix `tnt_01H...` vs operating-tenant `Telecheck-{country}` format).
--   The SoT hierarchy resolution (Master PRD outranks engineering specs)
--   set the canonical state to `Telecheck-{country}`. CDM §4.1 has been
--   physically updated in the spec corpus (telecheckONE @ 509071c) with
--   the canonical SQL DDL — including the 3 columns the v1.10.1 hygiene
--   cycle promised but never merged: display_name, legal_entity,
--   consumer_subdomain. This migration is now consistent with that
--   canonical schema. The column type difference (TEXT here vs VARCHAR(26)
--   in CDM) is functionally identical for the values in use.

CREATE TABLE IF NOT EXISTS tenants (
    -- Operating-tenant identifier in `Telecheck-{country}` format per Master PRD v1.10 §17.
    -- Examples: 'Telecheck-US', 'Telecheck-Ghana'.
    -- (CDM v1.2 §4.1 SPEC ISSUE P-010 RESOLVED 2026-05-02 — see Promotion Ledger
    --  P-010 in the spec corpus. CDM §4.1 now canonically specifies the
    --  Telecheck-{country} format with VARCHAR(26) column type; this migration
    --  uses TEXT which is functionally identical at the values used.)
    id                  TEXT        PRIMARY KEY,

    -- Operating-tenant display label shown in platform-admin UI per CDM §4.1.
    -- Typically equals `id` (e.g., 'Telecheck-US'); separate column allows
    -- richer admin-side rendering without polluting the canonical identifier.
    display_name        TEXT        NOT NULL,

    -- Consumer-facing DBA name sourced for all patient-facing rendering per C3.
    -- Examples: 'Heros Health' (US), 'Heros Health Ghana' (Ghana).
    -- NEVER use tenant.id for patient-facing copy — always use consumer_dba.
    consumer_dba        TEXT        NOT NULL,

    -- Per-country incorporated legal entity per CDM §4.1.
    -- Examples: 'Telecheck Health LLC' (US), 'Telecheck-Ghana Ltd.' (Ghana).
    -- Used by audit-export, regulatory filings, contract metadata (BAAs etc.).
    legal_entity        TEXT        NOT NULL,

    -- Country-instanced consumer subdomain serving the DBA's web/mobile UI.
    -- Examples: 'heroshealth.com' (US), 'ghana.heroshealth.com' (Ghana).
    -- Drives subdomain-based tenant resolution in src/lib/tenant-context.ts.
    consumer_subdomain  TEXT        NOT NULL,

    -- ISO 3166-1 alpha-2 country code driving CCR runtime resolution.
    -- Constrained to active countries at launch; extend via migration when
    -- new markets are added (not by editing this constraint — add a new migration).
    -- I-009: no hardcoded country assumptions; this constraint is the
    --        permitted-country registry, extended via migrations, not inline.
    country_of_care     TEXT        NOT NULL
                            CHECK (country_of_care IN ('US', 'GH')),

    -- AWS KMS key alias for per-tenant encryption at rest per ADR-024.
    -- Format: 'alias/telecheck-{country_of_care}-data-key'
    -- The actual KMS key is managed in AWS; this column stores the alias
    -- reference used by the application-layer encryption module.
    kms_key_alias       TEXT        NOT NULL,

    -- Tenant lifecycle status.
    status              TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'suspended', 'archived')),

    -- Lifecycle timestamps.
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Governance timestamps (set by governance events per I-026).
    activated_at        TIMESTAMPTZ,
    suspended_at        TIMESTAMPTZ,
    archived_at         TIMESTAMPTZ,

    -- Internal notes for platform admin use only (never patient-facing).
    notes               TEXT,

    -- Enforce `Telecheck-{country}` format per CDM §4.1 + Master PRD §17.
    -- Regex permits 2+ uppercase letters or a leading uppercase + mixed-case
    -- to cover both ISO 3166-1 alpha-2 codes ('Telecheck-US') and full
    -- country names ('Telecheck-Ghana') — both are canonical per spec.
    CONSTRAINT tenant_id_format_valid
        CHECK (id ~ '^Telecheck-[A-Z][A-Za-z]+$'),

    -- Anti-pattern: bare 'Heros' as a tenant identifier is forbidden per
    -- Glossary v5.2 + Master PRD §17. Consumer brand 'Heros Health' belongs
    -- in consumer_dba ONLY.
    CONSTRAINT tenant_id_no_bare_heros
        CHECK (id NOT ILIKE 'Heros%'),

    -- C3 invariant: consumer_dba must start with 'Heros Health' (e.g.,
    -- 'Heros Health', 'Heros Health Ghana'). A future market would extend
    -- this CHECK to permit additional country variants.
    CONSTRAINT consumer_dba_starts_heros_health
        CHECK (consumer_dba LIKE 'Heros Health%')
);

-- Index for status-based lookups (admin surface, health checks).
CREATE INDEX IF NOT EXISTS idx_tenants_status
    ON tenants (status);

-- Index for country-based lookups (CCR resolution, market-availability checks).
CREATE INDEX IF NOT EXISTS idx_tenants_country_of_care
    ON tenants (country_of_care);

-- ---------------------------------------------------------------------------
-- Day-1 operating tenant seed data
-- Per Master PRD v1.10 §17 + Glossary v5.2 C3 brand-structure rules:
--   - Telecheck-US: operated by Telecheck Health LLC; consumer DBA = Heros Health;
--     greenfield, zero patients day 1; primary domain heroshealth.com
--   - Telecheck-Ghana: operated by Telecheck-Ghana Ltd.; consumer DBA = Heros Health Ghana;
--     chronic-care anchor; primary domain ghana.heroshealth.com
--
-- KMS aliases follow the convention established by ADR-024. The actual KMS
-- key ARNs must be provisioned in AWS before application startup.
-- ---------------------------------------------------------------------------

INSERT INTO tenants (id, display_name, consumer_dba, legal_entity, consumer_subdomain, country_of_care, kms_key_alias, status, activated_at)
VALUES
    (
        'Telecheck-US',
        'Telecheck-US',                      -- operating-tenant label per CDM §4.1; NOT the consumer DBA
        'Heros Health',                      -- consumer DBA per C3 brand structure
        'Telecheck Health LLC',              -- per-country incorporated subsidiary
        'heroshealth.com',                   -- country-instanced consumer subdomain
        'US',
        'alias/telecheck-us-data-key',
        'active',
        NOW()
    ),
    (
        'Telecheck-Ghana',
        'Telecheck-Ghana',                   -- operating-tenant label per CDM §4.1
        'Heros Health Ghana',                -- consumer DBA per C3 brand structure
        'Telecheck-Ghana Ltd.',              -- per-country incorporated subsidiary
        'ghana.heroshealth.com',             -- country-instanced consumer subdomain
        'GH',
        'alias/telecheck-gh-data-key',
        'active',
        NOW()
    )
ON CONFLICT (id) DO NOTHING;
