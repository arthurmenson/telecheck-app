-- =============================================================================
-- File:    migrations/rollback/003_rollback.sql
-- Purpose: Rollback for 003_rls_helpers.sql — drop RLS helper functions.
-- Warning: Dropping these functions will break any RLS policy that references
--          current_tenant_id(). Drop RLS policies from all PHI tables before
--          running this rollback. Run slice rollbacks first, then 005→004→003.
--          Dev/test environments only.
-- =============================================================================

DROP FUNCTION IF EXISTS set_break_glass_context(TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS current_tenant_id();
DROP FUNCTION IF EXISTS set_tenant_context(TEXT);
