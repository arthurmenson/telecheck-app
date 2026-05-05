-- =============================================================================
-- File:    migrations/rollback/018_rollback.sql
-- Purpose: Rollback for 018_tenant_config.sql — drop tenant_brands +
--          country_profiles + ccr_configs and all dependent objects.
-- Spec:    Companion to migrations/018_tenant_config.sql.
-- Warning: DESTRUCTIVE. All per-tenant brand customization (colors,
--          logo, support contacts), country-profile registry rows
--          (US + GH + any post-launch markets), and per-tenant CCR
--          overrides will be permanently lost. Downstream slices that
--          depend on the CCR resolver (Pharmacy, Notifications, Payment,
--          Crisis-detection rendering) will fail their lookups until
--          re-seeded. Sign-off identical to 016_rollback.sql plus
--          Engineering Lead approval for the cross-slice impact.
-- =============================================================================

-- Drop order:
--   ccr_configs      → tenants (001)              [drop first]
--   tenant_brands    → tenants (001)              [drop next]
--   country_profiles → no FKs                     [drop last]

-- Step 1: Drop RLS policies on the tenant-scoped tables. country_profiles
-- has NO RLS by design (platform-level data); skip.
DROP POLICY IF EXISTS tenant_isolation ON ccr_configs;
DROP POLICY IF EXISTS tenant_isolation ON tenant_brands;

-- Step 2: Drop triggers + trigger functions (per-table updated_at clocks).
DROP TRIGGER IF EXISTS ccr_configs_updated_at ON ccr_configs;
DROP TRIGGER IF EXISTS tenant_brands_updated_at ON tenant_brands;
DROP TRIGGER IF EXISTS country_profiles_updated_at ON country_profiles;

DROP FUNCTION IF EXISTS ccr_configs_set_updated_at();
DROP FUNCTION IF EXISTS tenant_brands_set_updated_at();
DROP FUNCTION IF EXISTS country_profiles_set_updated_at();

-- Step 3: Drop tables. Indexes drop automatically.
DROP TABLE IF EXISTS ccr_configs;
DROP TABLE IF EXISTS tenant_brands;
DROP TABLE IF EXISTS country_profiles;
