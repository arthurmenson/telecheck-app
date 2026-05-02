-- =============================================================================
-- File:    migrations/rollback/002_rollback.sql
-- Purpose: Rollback for 002_audit_chain.sql — drop the audit_records table
--          and its associated triggers and functions.
-- Warning: DESTRUCTIVE. Per I-003, audit records are NEVER deleted in
--          production. This rollback is ONLY valid in a dev/test environment
--          where audit_records has never held real patient or clinical data.
--          NEVER run in production or staging environments.
--          The hash-chain integrity model means dropping and recreating this
--          table breaks the immutability guarantee — use only to reset a
--          development schema from scratch.
-- =============================================================================

-- Drop RLS policies first (they reference the table).
DROP POLICY IF EXISTS audit_break_glass_read   ON audit_records;
DROP POLICY IF EXISTS audit_tenant_isolation   ON audit_records;

-- Drop triggers (they depend on the functions).
DROP TRIGGER IF EXISTS audit_records_block_delete  ON audit_records;
DROP TRIGGER IF EXISTS audit_records_block_update  ON audit_records;
DROP TRIGGER IF EXISTS audit_records_before_insert ON audit_records;

-- Drop trigger functions.
DROP FUNCTION IF EXISTS audit_records_block_mutation();
DROP FUNCTION IF EXISTS audit_records_hash_insert();

-- Drop the table (and all its indexes + RLS configuration, which CASCADE).
DROP TABLE IF EXISTS audit_records;
