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
DROP FUNCTION IF EXISTS clear_tenant_context();
DROP FUNCTION IF EXISTS set_tenant_context(TEXT);

-- Drop the session-binding table (added v0.2 patch 2026-05-02 per Codex
-- foundation-verify-r3 CRITICAL — replaces the prior GUC-based current_
-- tenant_id() pattern with a non-spoofable per-PG-backend binding).
DROP TABLE IF EXISTS _session_tenant_context;
