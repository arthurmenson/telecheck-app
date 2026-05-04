-- =============================================================================
-- File:    migrations/rollback/011_rollback.sql
-- Purpose: Rollback for 011_actor_columns_widen_to_text.sql — narrow the
--          forms_* actor columns back to VARCHAR(26).
-- Warning: Will FAIL at runtime if any row carries an actor identifier > 26
--          chars (production may evolve to typed identifiers per
--          Master PRD v1.10 §10.5). Treat as dev/test only.
-- =============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'forms_variant'
           AND column_name = 'created_by'
    ) THEN
        EXECUTE 'ALTER TABLE forms_variant ALTER COLUMN created_by TYPE VARCHAR(26)';
    END IF;
END $$;

ALTER TABLE forms_deployment
    ALTER COLUMN deployed_by TYPE VARCHAR(26);

ALTER TABLE forms_template
    ALTER COLUMN approved_by TYPE VARCHAR(26);

ALTER TABLE forms_template
    ALTER COLUMN created_by TYPE VARCHAR(26);
