-- =============================================================================
-- File:    migrations/rollback/029_rollback.sql
-- Purpose: Roll back migration 029 by dropping the actor_tenant_id
--          column from audit_records.
--
-- WARNING: This drops attribution data captured by F-4. If
--          actor_tenant_id was populated in any rows (post-migration
--          rows from emitAudit), that data is permanently lost. Only
--          roll back if the F-4 work is being abandoned.
--
-- Spec:    Companion to migrations/029_audit_records_actor_tenant_id.sql.
-- =============================================================================

ALTER TABLE audit_records
    DROP COLUMN IF EXISTS actor_tenant_id;
