-- =============================================================================
-- File:    migrations/018_tenant_config.sql
-- Purpose: Create the tenant-management config layer per CDM v1.2:
--            §4.2 TenantBrand        → tenant_brands
--            §4.3 CountryProfile     → country_profiles
--            §4.4 CCRConfig          → ccr_configs
--          These are foundational tenant-config entities consumed by every
--          CCR-driven downstream slice (Pharmacy, Notifications, Payments).
--          None reference medication_requests, so this migration is NOT
--          blocked by SI-001.
--
-- Spec:    - CDM v1.2 §4.2 (TenantBrand: per-tenant brand identity)
--          - CDM v1.2 §4.3 (CountryProfile: platform-level CCR templates)
--          - CDM v1.2 §4.4 (CCRConfig: per-tenant CCR overrides)
--          - ADR-024 (per-tenant KMS encryption — adapter_configs JSONB
--                     payload would be encrypted at rest under tenant key,
--                     but adapter_configs is NOT in this migration)
--          - I-009 (no hardcoded country assumptions — country_profiles is
--                   the registry; this migration seeds US + GH, future markets
--                   add via subsequent migration)
--          - I-023 / I-027 (RLS + tenant scoping for tenant-scoped tables;
--                           country_profiles is platform-level, not RLS'd)
--          - I-026 (tenant config changes are governance events; this
--                   migration's tables don't enforce immutability — the
--                   audit-events surface enforces I-026)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql     applied (FK targets for tenant_brands + ccr_configs)
--   003_rls_helpers.sql applied (current_tenant_id() function exists)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- TABLE 1: tenant_brands
-- One brand row per tenant (PRIMARY KEY (tenant_id) is also the FK).
-- Powers the Patient/Clinician UI's brand-identity surfaces (logo, colors,
-- legal links, support contact). Decoupled from the operating-tenant identity
-- columns on `tenants` so a future tenant rename / re-brand doesn't touch
-- the canonical identifier.
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_brands (

    -- One brand per tenant; tenant_id is BOTH the primary key and the FK.
    tenant_id       TEXT        PRIMARY KEY REFERENCES tenants(id),

    -- ---------------------------------------------------------------------
    -- Display identity
    -- ---------------------------------------------------------------------

    brand_name      VARCHAR(200) NOT NULL,
    logo_url        TEXT         NULL,             -- S3 URL; nullable until brand assets are uploaded
    primary_color   VARCHAR(7)   NULL,             -- hex e.g. '#1F4DBE'
    secondary_color VARCHAR(7)   NULL,
    accent_color    VARCHAR(7)   NULL,

    -- ---------------------------------------------------------------------
    -- Domains
    -- ---------------------------------------------------------------------

    custom_domain          VARCHAR(255) NULL,
    custom_domain_verified BOOLEAN      NOT NULL DEFAULT FALSE,

    -- ---------------------------------------------------------------------
    -- Legal copy links
    -- ---------------------------------------------------------------------

    terms_of_service_url TEXT NULL,
    privacy_policy_url   TEXT NULL,

    -- ---------------------------------------------------------------------
    -- Support
    -- ---------------------------------------------------------------------

    support_email   VARCHAR(255) NULL,
    support_phone   VARCHAR(50)  NULL,

    -- ---------------------------------------------------------------------
    -- Design Tokens (JSONB) — Design System token overrides per DIC v1.1.
    -- Schema-level structure intentionally loose; the Design System contract
    -- governs the shape via runtime validation.
    -- ---------------------------------------------------------------------

    design_tokens   JSONB        NULL,

    -- ---------------------------------------------------------------------
    -- Notification copy overrides (JSONB)
    -- ---------------------------------------------------------------------

    notification_copy_overrides JSONB NULL,

    -- ---------------------------------------------------------------------
    -- Lifecycle
    -- ---------------------------------------------------------------------

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Hex color format guard; null is permitted (defaults to design-system color).
    CONSTRAINT tenant_brand_primary_color_hex
        CHECK (primary_color IS NULL OR primary_color ~ '^#[0-9A-Fa-f]{6}$'),
    CONSTRAINT tenant_brand_secondary_color_hex
        CHECK (secondary_color IS NULL OR secondary_color ~ '^#[0-9A-Fa-f]{6}$'),
    CONSTRAINT tenant_brand_accent_color_hex
        CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$')
);

-- updated_at trigger using clock_timestamp() (not NOW()) per migration-012
-- precedent — NOW() returns transaction-start time so the trigger wouldn't
-- advance updated_at within a savepoint-wrapped test.

CREATE OR REPLACE FUNCTION tenant_brands_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_brands_updated_at ON tenant_brands;
CREATE TRIGGER tenant_brands_updated_at
    BEFORE UPDATE ON tenant_brands
    FOR EACH ROW EXECUTE FUNCTION tenant_brands_set_updated_at();

-- RLS: tenant_brands is tenant-scoped via tenant_id PK.

ALTER TABLE tenant_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_brands FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_brands
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- =============================================================================
-- TABLE 2: country_profiles
-- Platform-level CCR templates per country. NOT tenant-scoped — these are
-- the platform-wide registry of permitted countries. Adding a new market
-- means adding a row here via a future migration. I-009 says we can't
-- hardcode country assumptions; this table is the canonical registry.
-- =============================================================================

CREATE TABLE IF NOT EXISTS country_profiles (

    -- ISO 3166-1 alpha-2 code is the natural primary key.
    country         CHAR(2) PRIMARY KEY,

    -- ---------------------------------------------------------------------
    -- Regulatory module (per CDM §4.3)
    -- ---------------------------------------------------------------------

    regulatory_module VARCHAR(100) NOT NULL,         -- 'us_hipaa_state_telehealth', 'gh_dpa_mdc'

    -- ---------------------------------------------------------------------
    -- Payment defaults
    -- ---------------------------------------------------------------------

    default_payment_processor VARCHAR(50)  NOT NULL,  -- 'stripe', 'paystack'
    supported_payment_methods JSONB        NOT NULL,  -- ['card', 'mobile_money', ...]

    -- ---------------------------------------------------------------------
    -- Currency
    -- ---------------------------------------------------------------------

    currency_code   CHAR(3) NOT NULL,                 -- ISO 4217 'USD', 'GHS'
    currency_symbol VARCHAR(5) NOT NULL,

    -- ---------------------------------------------------------------------
    -- Locale + formatting
    -- ---------------------------------------------------------------------

    default_locale  VARCHAR(10) NOT NULL,             -- 'en-US', 'en-GH'
    date_format     VARCHAR(20) NOT NULL,             -- 'MM/DD/YYYY', 'DD/MM/YYYY'
    time_format     VARCHAR(10) NOT NULL,             -- '12h', '24h'
    measurement_units VARCHAR(20) NOT NULL,           -- 'imperial', 'metric'
    phone_format    VARCHAR(50) NOT NULL,
    address_format  JSONB       NOT NULL,

    -- ---------------------------------------------------------------------
    -- Emergency / crisis
    -- ---------------------------------------------------------------------

    emergency_number VARCHAR(20) NOT NULL,
    crisis_helplines JSONB       NOT NULL,            -- list of {name, number, available_hours}

    -- ---------------------------------------------------------------------
    -- Notification defaults
    -- ---------------------------------------------------------------------

    default_notification_channels JSONB NOT NULL,
    default_quiet_hours          JSONB NOT NULL,

    -- ---------------------------------------------------------------------
    -- Adapter availability — registry of integration adapters usable per market.
    -- ---------------------------------------------------------------------

    available_clinician_network_adapters JSONB NOT NULL,  -- ['telecheck_pllc', 'openloop', ...]
    available_pharmacy_adapters         JSONB NOT NULL,
    available_sms_providers             JSONB NOT NULL,

    -- ---------------------------------------------------------------------
    -- Lifecycle
    -- ---------------------------------------------------------------------

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- updated_at trigger
CREATE OR REPLACE FUNCTION country_profiles_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS country_profiles_updated_at ON country_profiles;
CREATE TRIGGER country_profiles_updated_at
    BEFORE UPDATE ON country_profiles
    FOR EACH ROW EXECUTE FUNCTION country_profiles_set_updated_at();

-- NO RLS on country_profiles: platform-level data, readable by all tenants.

-- Seed US + GH country profiles inline. Adding a new market means:
--   1. New migration with INSERT INTO country_profiles + tenant rows
--   2. Update the tenants.country_of_care CHECK constraint via the same migration
-- Per I-009 — no hardcoded country assumptions in code; the registry IS the constraint.

INSERT INTO country_profiles (
    country, regulatory_module,
    default_payment_processor, supported_payment_methods,
    currency_code, currency_symbol,
    default_locale, date_format, time_format, measurement_units,
    phone_format, address_format,
    emergency_number, crisis_helplines,
    default_notification_channels, default_quiet_hours,
    available_clinician_network_adapters, available_pharmacy_adapters, available_sms_providers
) VALUES (
    'US',
    'us_hipaa_state_telehealth',
    'stripe',
    '["card", "ach"]'::jsonb,
    'USD', '$',
    'en-US', 'MM/DD/YYYY', '12h', 'imperial',
    '(XXX) XXX-XXXX',
    '{"lines": ["address_line_1", "address_line_2"], "city": true, "state": true, "postal_code": true, "country": "US"}'::jsonb,
    '911',
    '[{"name": "988 Suicide & Crisis Lifeline", "number": "988", "available_hours": "24/7"}]'::jsonb,
    '["sms", "email", "in_app"]'::jsonb,
    '{"start": "21:00", "end": "07:00", "timezone_anchor": "patient_local"}'::jsonb,
    '["telecheck_pllc", "openloop"]'::jsonb,
    '["truepill", "honeybee"]'::jsonb,
    '["twilio"]'::jsonb
),
(
    'GH',
    'gh_dpa_mdc',
    'paystack',
    '["card", "mobile_money"]'::jsonb,
    'GHS', '₵',
    'en-GH', 'DD/MM/YYYY', '24h', 'metric',
    'XXX XXX XXXX',
    '{"lines": ["address_line_1", "address_line_2"], "city": true, "region": true, "postal_code": false, "country": "GH"}'::jsonb,
    '112',
    '[{"name": "Mental Health Authority Helpline", "number": "0244 846 666", "available_hours": "24/7"}]'::jsonb,
    '["sms", "email", "in_app", "whatsapp"]'::jsonb,
    '{"start": "21:00", "end": "07:00", "timezone_anchor": "patient_local"}'::jsonb,
    '["telecheck_ghana_clinical"]'::jsonb,
    '["telecheck_ghana_pharmacy"]'::jsonb,
    '["hubtel", "twilio"]'::jsonb
)
ON CONFLICT (country) DO NOTHING;

-- =============================================================================
-- TABLE 3: ccr_configs
-- Per-tenant CCR overrides via key/value pairs. Most tenants inherit
-- country_profiles defaults; some override specific keys (e.g., a US tenant
-- wanting Twilio Verify for SMS instead of generic Twilio).
-- =============================================================================

CREATE TABLE IF NOT EXISTS ccr_configs (

    id              VARCHAR(26) PRIMARY KEY,

    tenant_id       TEXT        NOT NULL REFERENCES tenants(id),

    -- Dotted-namespace config key per CCR_RUNTIME contract.
    -- Examples: 'notification.sms_provider', 'pharmacy.routing_strategy'
    config_key      VARCHAR(100) NOT NULL,

    -- Free-form JSONB to allow scalar OR object values.
    config_value    JSONB        NOT NULL,

    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- One config row per (tenant, key) tuple.
    UNIQUE (tenant_id, config_key)
);

CREATE INDEX IF NOT EXISTS idx_ccr_configs_tenant ON ccr_configs (tenant_id);

-- updated_at trigger
CREATE OR REPLACE FUNCTION ccr_configs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ccr_configs_updated_at ON ccr_configs;
CREATE TRIGGER ccr_configs_updated_at
    BEFORE UPDATE ON ccr_configs
    FOR EACH ROW EXECUTE FUNCTION ccr_configs_set_updated_at();

-- RLS: ccr_configs is tenant-scoped.

ALTER TABLE ccr_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ccr_configs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ccr_configs
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- =============================================================================
-- Brand seed for the two day-1 operating tenants.
-- These mirror the brand data already in the tenants table (display_name,
-- consumer_dba, legal_entity, consumer_subdomain) but expand to include
-- brand colors / support contact / legal-copy URLs.
-- The colors below are placeholders aligned with the Design System v1.1
-- token palette (Iris primary at #6E5BD6 reserved for AI; tenant primary
-- distinct).
-- =============================================================================

-- Tenant brand seeds run with elevated privileges (no tenant context bound
-- at migration-apply time), so we use SECURITY DEFINER sidestep via
-- DISABLE ROW LEVEL SECURITY for the duration of the inserts. Wrapped in a
-- DO block so the disable/enable is atomic with the inserts.

DO $$
BEGIN
    EXECUTE 'ALTER TABLE tenant_brands DISABLE ROW LEVEL SECURITY';

    INSERT INTO tenant_brands (
        tenant_id, brand_name, primary_color, secondary_color, accent_color,
        custom_domain, custom_domain_verified,
        support_email
    ) VALUES
    ('Telecheck-US', 'Heros Health', '#1F4DBE', '#0E2A6B', '#FFB347',
     'heroshealth.com', TRUE, 'support@heroshealth.com'),
    ('Telecheck-Ghana', 'Heros Health Ghana', '#1F4DBE', '#0E2A6B', '#FFB347',
     'ghana.heroshealth.com', TRUE, 'support@ghana.heroshealth.com')
    ON CONFLICT (tenant_id) DO NOTHING;

    EXECUTE 'ALTER TABLE tenant_brands ENABLE ROW LEVEL SECURITY';
END $$;

-- =============================================================================
-- Migration 018 complete.
-- =============================================================================
