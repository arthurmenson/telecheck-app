-- =============================================================================
-- File:    migrations/rollback/039_rollback.sql
-- Purpose: Rollback migration 039_admin_backend_rbac_roles.sql.
--
--          Drops the 12 net-new Admin Backend RBAC roles in reverse-dependency
--          order: view-owners → wrapper-owners → raw-writer-owner →
--          application roles.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - No tables/views/procedures may currently be OWNED by any of
--              these 12 roles. As of migration 039, no such objects exist
--              (entities + RLS + triggers land in migration 040;
--              wrappers + raw writer + views land in PR 2+). If those
--              migrations have shipped, roll back THEIR migrations first,
--              then come back to this one. The DROP ROLE statements below
--              will fail if any role still owns objects — that is the
--              canonical PG guard against forgetting cleanup.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. View-owner roles (4; will be dropped only if no views are OWNED by them).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS forms_template_admin_review_pending_view_owner;
DROP ROLE IF EXISTS admin_mode1_volume_health_view_owner;
DROP ROLE IF EXISTS admin_consult_queue_health_view_owner;
DROP ROLE IF EXISTS admin_crisis_operational_health_view_owner;

-- -----------------------------------------------------------------------------
-- 2. Raw-writer-owner role (1).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS forms_template_admin_review_transition_writer_owner;

-- -----------------------------------------------------------------------------
-- 3. Template-wrapper-owner roles (2).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS forms_template_admin_review_decision_wrapper_owner;
DROP ROLE IF EXISTS forms_template_admin_review_submit_wrapper_owner;

-- -----------------------------------------------------------------------------
-- 4. Dashboard-wrapper-owner roles (3).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS read_admin_mode1_volume_health_wrapper_owner;
DROP ROLE IF EXISTS read_admin_consult_queue_health_wrapper_owner;
DROP ROLE IF EXISTS read_admin_crisis_operational_health_wrapper_owner;

-- -----------------------------------------------------------------------------
-- 5. Application roles (2).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS admin_template_reviewer;
DROP ROLE IF EXISTS admin_basic_operator;

-- =============================================================================
-- Post-rollback verification: count of admin/template/dashboard admin_* roles
-- should be 0 (admin_basic_operator + admin_template_reviewer +
-- admin_*_view_owner + read_admin_* + forms_template_admin_*).
-- =============================================================================
DO $$
DECLARE
    v_remaining_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining_count
      FROM pg_roles
     WHERE rolname IN (
         'admin_basic_operator',
         'admin_template_reviewer',
         'read_admin_crisis_operational_health_wrapper_owner',
         'read_admin_consult_queue_health_wrapper_owner',
         'read_admin_mode1_volume_health_wrapper_owner',
         'forms_template_admin_review_submit_wrapper_owner',
         'forms_template_admin_review_decision_wrapper_owner',
         'forms_template_admin_review_transition_writer_owner',
         'admin_crisis_operational_health_view_owner',
         'admin_consult_queue_health_view_owner',
         'admin_mode1_volume_health_view_owner',
         'forms_template_admin_review_pending_view_owner'
     );

    IF v_remaining_count > 0 THEN
        RAISE WARNING
            'migration-039-rollback-incomplete: % admin role(s) remain in pg_roles. '
            'DROP ROLE statements may have failed because the roles still own objects. '
            'Roll back later migrations (040+) first.', v_remaining_count;
    END IF;
END $$;
