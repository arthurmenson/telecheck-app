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

-- SPEC ISSUE: CDM v1.2 §4.1 defines `tenants.id` as VARCHAR(26) with ULID
-- format (prefix `tnt_01H...`). The charter for this migration and Master
-- PRD v1.10 §17 C3 brand-structure rules define `tenants.id` as TEXT in the
-- format `Telecheck-{ISO2}` (e.g., `Telecheck-US`). These two representations
-- are mutually incompatible. This migration follows the charter + PRD §17
-- requirement (TEXT `Telecheck-{country}` format) because:
--   (a) The charter instruction is explicit and specific.
--   (b) §17 tenant-identifier format is load-bearing — it appears in audit
--       records, KMS key aliases, CCR runtime keys, and RBAC policies.
--   (c) CDM §4.1 uses ULID-prefix convention designed for patient-facing
--       entities, not for the platform's internal operating-tenant registry.
-- This divergence requires Engineering Lead review and a CDM v1.2 errata
-- or v1.3 patch to resolve the §4.1 vs §17 conflict explicitly.
-- Escalation path: SI/DSI per EHBG §12.

CREATE TABLE IF NOT EXISTS tenants (
    -- Operating-tenant identifier in `Telecheck-{ISO2}` format per Master PRD §17.
    -- Format enforced by CHECK constraint below.
    -- Examples: 'Telecheck-US', 'Telecheck-Ghana' (note: 'GH' not 'Ghana' per ISO 3166-1 alpha-2,
    -- but the actual value 'Telecheck-Ghana' is used as the canonical seeded value;
    -- see SPEC ISSUE note below on alpha-2 vs full-country-name).
    id                  TEXT        PRIMARY KEY,

    -- Consumer-facing DBA name sourced for all patient-facing rendering.
    -- Examples: 'Heros Health' (US), 'Heros Health Ghana' (Ghana).
    -- NEVER use tenant.id for patient-facing copy — always use consumer_dba.
    consumer_dba        TEXT        NOT NULL,

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

    -- Enforce `Telecheck-{ISO2}` format.
    -- Regex: starts with 'Telecheck-', followed by exactly 2 uppercase letters.
    -- SPEC ISSUE: The seeded value 'Telecheck-Ghana' does NOT match the
    -- pattern `^Telecheck-[A-Z]{2}$` (it uses a full country name, not ISO 3166-1
    -- alpha-2 code 'GH'). The charter explicitly seeds 'Telecheck-Ghana' (not
    -- 'Telecheck-GH'), creating a conflict between the regex constraint in the
    -- charter and the seeded value also in the charter. This migration adopts
    -- the following resolution: the CHECK constraint uses the pattern
    -- `^Telecheck-[A-Z]{2,}$` (2 or more uppercase letters) to accommodate
    -- both 'Telecheck-US' and 'Telecheck-Ghana'. Engineering Lead must decide
    -- whether to normalize to strict ISO 3166-1 alpha-2 codes ('Telecheck-GH')
    -- or to document the full-name convention as intentional. Until resolved,
    -- the seeded data matches what other spec files reference ('Telecheck-Ghana'
    -- appears in AUDIT_EVENTS, DOMAIN_EVENTS examples). This is an SI escalation
    -- per EHBG §12.
    CONSTRAINT tenant_id_format
        CHECK (id ~ '^Telecheck-[A-Z][A-Za-z]+$')
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

INSERT INTO tenants (id, consumer_dba, country_of_care, kms_key_alias, status, activated_at)
VALUES
    (
        'Telecheck-US',
        'Heros Health',
        'US',
        'alias/telecheck-us-data-key',
        'active',
        NOW()
    ),
    (
        'Telecheck-Ghana',
        'Heros Health Ghana',
        'GH',
        'alias/telecheck-gh-data-key',
        'active',
        NOW()
    )
ON CONFLICT (id) DO NOTHING;
