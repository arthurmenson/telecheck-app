-- =============================================================================
-- File:    migrations/rollback/040_rollback.sql
-- Purpose: Rollback migration 040_admin_backend_entities.sql.
--
--          Drops the 4 net-new Admin Backend entities (admin_dashboard_query_execution
--          + forms_template_admin_review + forms_template_admin_review_lifecycle_transition
--          + admin_template_decision_idempotency_key) plus all per-table trigger
--          functions (including unified lifecycle-invariants + one-active-review
--          defense-in-depth) in reverse-dependency order.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - Wrappers / views from later PRs (041+) must be dropped first.
--              The cascading DROP TABLE statements below DO NOT drop dependent
--              SECDEF wrappers or views (PostgreSQL would error). Roll back
--              later migrations first if they have shipped.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Idempotency entity (children of forms_template_admin_review).
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS admin_template_decision_idempotency_key_block_delete
    ON admin_template_decision_idempotency_key;
DROP TRIGGER IF EXISTS admin_template_decision_idempotency_key_block_update
    ON admin_template_decision_idempotency_key;
DROP TABLE IF EXISTS admin_template_decision_idempotency_key;
DROP FUNCTION IF EXISTS admin_template_decision_idempotency_key_block_mutation();

-- -----------------------------------------------------------------------------
-- 2. Lifecycle log + lifecycle invariants + one-active-review defense-in-depth.
--    The one-active-review trigger is on forms_template_admin_review but
--    queries forms_template_admin_review_lifecycle_transition; drop it before
--    the lifecycle table to be safe even though PG allows it either way.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS forms_template_admin_review_one_active_check
    ON forms_template_admin_review;
DROP FUNCTION IF EXISTS enforce_one_active_review_per_template();

DROP TRIGGER IF EXISTS forms_template_admin_review_lifecycle_invariants_trigger
    ON forms_template_admin_review_lifecycle_transition;
DROP FUNCTION IF EXISTS forms_template_admin_review_lifecycle_invariants();

DROP TRIGGER IF EXISTS forms_template_admin_review_lifecycle_transition_block_delete
    ON forms_template_admin_review_lifecycle_transition;
DROP TRIGGER IF EXISTS forms_template_admin_review_lifecycle_transition_block_update
    ON forms_template_admin_review_lifecycle_transition;
DROP TABLE IF EXISTS forms_template_admin_review_lifecycle_transition;
DROP FUNCTION IF EXISTS forms_template_admin_review_lifecycle_transition_block_mutation();

-- -----------------------------------------------------------------------------
-- 3. Review root.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS forms_template_admin_review_block_delete
    ON forms_template_admin_review;
DROP TRIGGER IF EXISTS forms_template_admin_review_block_update
    ON forms_template_admin_review;
DROP TABLE IF EXISTS forms_template_admin_review;
DROP FUNCTION IF EXISTS forms_template_admin_review_block_mutation();

-- -----------------------------------------------------------------------------
-- 4. Standalone dashboard audit-trail entity.
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS admin_dashboard_query_execution_block_delete
    ON admin_dashboard_query_execution;
DROP TRIGGER IF EXISTS admin_dashboard_query_execution_block_update
    ON admin_dashboard_query_execution;
DROP TABLE IF EXISTS admin_dashboard_query_execution;
DROP FUNCTION IF EXISTS admin_dashboard_query_execution_block_mutation();

-- =============================================================================
-- Post-rollback verification: count of net-new admin/forms_template_admin_*
-- tables should be 0.
-- =============================================================================
DO $$
DECLARE
    v_remaining_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining_count
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename IN (
           'admin_dashboard_query_execution',
           'forms_template_admin_review',
           'forms_template_admin_review_lifecycle_transition',
           'admin_template_decision_idempotency_key'
       );

    IF v_remaining_count > 0 THEN
        RAISE WARNING
            'migration-040-rollback-incomplete: % admin table(s) remain in public schema. '
            'DROP TABLE statements may have failed because dependent SECDEF wrappers '
            'or views from later migrations (041+) still reference them. Roll back '
            'those migrations first.', v_remaining_count;
    END IF;
END $$;
