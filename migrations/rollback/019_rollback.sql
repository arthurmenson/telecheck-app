-- =============================================================================
-- File:    migrations/rollback/019_rollback.sql
-- Purpose: Rollback for 019_adapter_configs_tenant_users.sql — drop
--          adapter_configs + tenant_users tables and all dependent
--          objects (RLS, triggers, indexes).
-- Spec:    Companion to migrations/019_adapter_configs_tenant_users.sql.
-- Warning: DESTRUCTIVE. All per-tenant adapter configurations (encrypted
--          API keys, account IDs) and operator accounts (platform admins,
--          tenant admins, clinical leads, etc.) will be permanently lost.
--          The encrypted adapter_config payloads cannot be restored from
--          the dropped table — they are encrypted at the application layer
--          under tenants.kms_key_alias and the source plaintext is held
--          off-DB only briefly during INSERT.
--          Sign-off identical to 018_rollback.sql; tenant_users table
--          drop is a credentials-destruction event that requires
--          Platform Privacy Officer + Platform Security sign-off.
-- =============================================================================

-- Drop order:
--   adapter_configs → tenants (001)
--   tenant_users    → tenants (001) [tenant_id NULLable for platform admins]

-- Step 1: Drop RLS policies. tenant_users has the special-cased
-- visibility policy `tenant_users_visibility` (not the standard
-- `tenant_isolation` name) per the migration's platform-admin
-- cross-tenant accommodation.
DROP POLICY IF EXISTS tenant_isolation ON adapter_configs;
DROP POLICY IF EXISTS tenant_users_visibility ON tenant_users;

-- Step 2: Drop triggers + trigger functions.
DROP TRIGGER IF EXISTS adapter_configs_updated_at ON adapter_configs;
DROP TRIGGER IF EXISTS tenant_users_updated_at ON tenant_users;

DROP FUNCTION IF EXISTS adapter_configs_set_updated_at();
DROP FUNCTION IF EXISTS tenant_users_set_updated_at();

-- Step 3: Drop tables (no inter-table FK ordering needed; both reference
-- tenants which we are NOT dropping).
DROP TABLE IF EXISTS adapter_configs;
DROP TABLE IF EXISTS tenant_users;
