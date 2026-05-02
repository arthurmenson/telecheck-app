-- =============================================================================
-- File:    migrations/rollback/001_rollback.sql
-- Purpose: Rollback for 001_tenants.sql — drop the tenants table.
-- Warning: This is a DESTRUCTIVE operation. All tenant seed data is lost.
--          Any table that has a foreign-key reference to tenants(id) MUST be
--          dropped first (via its own rollback script) before this rollback
--          can succeed. Run rollbacks in REVERSE migration order:
--            005_rollback → 004_rollback → 003_rollback → 002_rollback → 001_rollback
--          This rollback is valid only in a development/test environment
--          before any PHI data has been written. NEVER run in production.
-- =============================================================================

-- IF EXISTS makes this safe to run even if the table was never created
-- (e.g., if 001_tenants.sql failed partway).
DROP TABLE IF EXISTS tenants;
