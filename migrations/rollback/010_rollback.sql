-- =============================================================================
-- File:    migrations/rollback/010_rollback.sql
-- Purpose: Rollback for 010_program_id_widen_to_text.sql — narrow program_id
--          back to VARCHAR(26) on forms_template + forms_deployment.
-- Warning: Will FAIL at runtime if any program_id row carries more than 26
--          chars — which is the realistic state post-v1.10 once the
--          `pce_`-prefixed identifier convention is adopted. Treat as
--          dev/test only.
-- =============================================================================

ALTER TABLE forms_deployment
    ALTER COLUMN program_id TYPE VARCHAR(26);

ALTER TABLE forms_template
    ALTER COLUMN program_id TYPE VARCHAR(26);
