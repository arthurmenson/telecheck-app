-- =============================================================================
-- File:    migrations/rollback/058_rollback.sql
-- Purpose: Rollback migration 058_async_consult_raw_lifecycle_writer.sql.
--
-- Drops the raw lifecycle writer function. Grants drop with the function.
-- Table (056) + roles (055) untouched — they have their own rollbacks.
-- =============================================================================

DROP FUNCTION IF EXISTS record_consult_lifecycle_transition(
    VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
);

DO $$
BEGIN
    IF to_regprocedure(
        'record_consult_lifecycle_transition(VARCHAR, TEXT, VARCHAR, TEXT, TEXT, VARCHAR, TEXT, JSONB)'
    ) IS NOT NULL THEN
        RAISE EXCEPTION 'migration-058-rollback-incomplete: record_consult_lifecycle_transition still exists'
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
