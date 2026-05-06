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

-- to_regclass guards per Codex async-consult-r4 HIGH closure 2026-05-05.
-- Plain ALTER TABLE ... DROP CONSTRAINT IF EXISTS aborts when the table
-- itself doesn't exist (IF EXISTS applies to the constraint, not the
-- table). Wrap in DO blocks with to_regclass() existence checks so this
-- rollback is safe across partial-apply states.

DO $$
BEGIN
    IF to_regclass('consult_events') IS NOT NULL THEN
        ALTER TABLE consult_events DROP CONSTRAINT IF EXISTS consult_events_tenant_consult_fk;
    END IF;
END$$;

DO $$
BEGIN
    IF to_regclass('consults') IS NOT NULL THEN
        ALTER TABLE consults DROP CONSTRAINT IF EXISTS consults_tenant_intake_fk;
        ALTER TABLE consults DROP CONSTRAINT IF EXISTS consults_tenant_patient_fk;
        ALTER TABLE consults DROP CONSTRAINT IF EXISTS consults_tenant_id_id_unique;
    END IF;
END$$;
