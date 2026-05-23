-- =============================================================================
-- File:    migrations/rollback/042_rollback.sql
-- Purpose: Rollback migration 042_admin_backend_raw_lifecycle_writer.sql.
--
--          Drops record_forms_template_admin_review_transition() + revokes
--          writer-owner's INSERT + SELECT grants on
--          forms_template_admin_review_lifecycle_transition.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - Template wrapper SECDEF procedures from later PRs (043+) must
--              be dropped first if they have been deployed. Per R3 PR 2
--              closure pattern, we DROP FUNCTION first then REVOKE in a
--              DO block with verification of function-absent, so a blocked
--              DROP cannot strand wrapper-owner grants.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Raw lifecycle writer function + writer-owner table grants.
--    DROP FUNCTION → verify-absent → REVOKE, all guarded by single DO block.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_function_still_present BOOLEAN;
BEGIN
    -- REVOKE EXECUTE grants first (these are on the function itself, so
    -- dropping the function would drop them anyway, but explicit REVOKE
    -- documents the anti-bypass cleanup). These are safe to revoke even
    -- under a continuing executor because the function's existence does
    -- not depend on them.
    REVOKE EXECUTE ON FUNCTION record_forms_template_admin_review_transition(
        TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
    ) FROM forms_template_admin_review_decision_wrapper_owner;
    REVOKE EXECUTE ON FUNCTION record_forms_template_admin_review_transition(
        TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
    ) FROM forms_template_admin_review_submit_wrapper_owner;

    -- DROP the function. If dependent template wrappers still reference it,
    -- this DROP fails (CASCADE intentionally not used).
    DROP FUNCTION IF EXISTS record_forms_template_admin_review_transition(
        TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
    );

    -- Verify the function is actually gone. If still present, abort before
    -- revoking writer-owner's table-level grants (those grants are required
    -- for the still-installed function's body to execute).
    SELECT EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'record_forms_template_admin_review_transition'
    ) INTO v_function_still_present;

    IF v_function_still_present THEN
        RAISE EXCEPTION
            'migration-042-rollback-function-blocked: '
            'DROP FUNCTION record_forms_template_admin_review_transition left '
            'the function in place (dependent template wrappers from later '
            'migrations 043+ still reference it). REVOKE of writer-owner''s '
            'table-level INSERT/SELECT ABORTED to preserve runtime '
            'executability. Roll back dependent migrations first, then '
            'retry this rollback.';
    END IF;

    -- Safe to revoke writer-owner's table grants now (function is gone;
    -- grants are orphaned).
    REVOKE SELECT ON forms_template_admin_review_lifecycle_transition
        FROM forms_template_admin_review_transition_writer_owner;
    REVOKE INSERT ON forms_template_admin_review_lifecycle_transition
        FROM forms_template_admin_review_transition_writer_owner;
END $$;

-- =============================================================================
-- Post-rollback verification: function should be absent.
-- =============================================================================
DO $$
DECLARE
    v_function_present BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.proname = 'record_forms_template_admin_review_transition'
    ) INTO v_function_present;

    IF v_function_present THEN
        RAISE WARNING
            'migration-042-rollback-incomplete: '
            'record_forms_template_admin_review_transition() unexpectedly '
            'remains in public schema. The DO-block guard above should have '
            'aborted before reaching this verification — investigate.';
    END IF;
END $$;
