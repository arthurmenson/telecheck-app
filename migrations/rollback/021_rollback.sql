-- =============================================================================
-- File:    migrations/rollback/021_rollback.sql
-- Purpose: Rollback for 021_async_consult_tenant_boundary_constraints.sql
--          — drop the 4 composite UNIQUE + FK constraints if present.
-- Spec:    Companion to migrations/021_async_consult_tenant_boundary_constraints.sql.
-- Note:    Idempotent — uses IF EXISTS clauses so reapplication is a no-op.
--          If this rolls back BEFORE 020_rollback runs, that's fine —
--          020_rollback drops the tables entirely, which cascades to drop
--          any remaining constraints regardless.
-- Warning: Removing these composite FKs reopens the cross-tenant binding
--          gaps Codex async-consult-r1 (2 HIGH + 1 MEDIUM) flagged. Do
--          NOT roll back this migration without rolling back 020 as well.
-- =============================================================================

ALTER TABLE consult_events DROP CONSTRAINT IF EXISTS consult_events_tenant_consult_fk;
ALTER TABLE consults       DROP CONSTRAINT IF EXISTS consults_tenant_intake_fk;
ALTER TABLE consults       DROP CONSTRAINT IF EXISTS consults_tenant_patient_fk;
ALTER TABLE consults       DROP CONSTRAINT IF EXISTS consults_tenant_id_id_unique;
