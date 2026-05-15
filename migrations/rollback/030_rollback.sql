-- =============================================================================
-- File:    migrations/rollback/030_rollback.sql
-- Purpose: Drop the F-4 actor_tenant_id CHECK constraint.
-- Spec:    Companion to migrations/030_audit_records_actor_tenant_id_check.sql.
-- =============================================================================

ALTER TABLE audit_records
    DROP CONSTRAINT IF EXISTS audit_records_actor_tenant_id_required_for_human_actors;
