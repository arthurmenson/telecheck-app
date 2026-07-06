-- =============================================================================
-- File:    migrations/rollback/053_rollback.sql
-- Purpose: Rollback migration 053_async_consult_rbac_roles.sql.
--
--          Drops the 13 net-new Async Consult (SI-020) RBAC roles in
--          reverse-dependency order: view/MV owners → wrapper-owners →
--          application roles.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - No tables / views / MV / procedures may currently be OWNED by
--              any of these 13 roles, and no grants may reference them. As of
--              migration 053, no such objects exist (entities + RLS land in
--              the PR 2 migration; the 2 caller-class-split views + the
--              optional MV land in PR 3; the raw writer + 5 wrappers land in
--              PR 4-5). If those migrations have shipped, roll back THEIR
--              migrations first, then come back to this one. The DROP ROLE
--              statements below will fail if any role still owns objects or
--              holds grants — that is the canonical PG guard against
--              forgetting cleanup.
--
--          DROP ROLE IF EXISTS is used (not bare DROP ROLE) so a partial-prior-
--          rollback state does not abort this script before the post-rollback
--          verification runs. Matches migration 046 rollback hygiene.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. View/MV owner roles (2).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS async_consult_mv_refresh_owner;
DROP ROLE IF EXISTS async_consult_view_owner;

-- -----------------------------------------------------------------------------
-- 2. SECURITY DEFINER wrapper-owner roles (6).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS record_consult_decision_wrapper_owner;
DROP ROLE IF EXISTS consult_claim_wrapper_owner;
DROP ROLE IF EXISTS consult_ai_preparation_wrapper_owner;
DROP ROLE IF EXISTS consult_intake_wrapper_owner;
DROP ROLE IF EXISTS consult_initiation_wrapper_owner;
DROP ROLE IF EXISTS consult_lifecycle_transition_writer_owner;

-- -----------------------------------------------------------------------------
-- 3. Application roles (5).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS async_consult_staff_reader;
DROP ROLE IF EXISTS async_consult_patient_reader;
DROP ROLE IF EXISTS async_consult_clinician_reviewer;
DROP ROLE IF EXISTS async_consult_delegate_initiator;
DROP ROLE IF EXISTS async_consult_patient_initiator;

-- =============================================================================
-- Post-rollback verification: count of SI-020 async-consult roles should be 0.
-- WARNING (not EXCEPTION) so a partial-state operator gets a diagnostic surface
-- without blocking subsequent rollback steps (matches migration 039 / 045 / 046
-- rollback-hygiene precedent).
-- =============================================================================
DO $$
DECLARE
    v_remaining_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining_count
      FROM pg_roles
     WHERE rolname IN (
         'async_consult_patient_initiator',
         'async_consult_delegate_initiator',
         'async_consult_clinician_reviewer',
         'async_consult_patient_reader',
         'async_consult_staff_reader',
         'consult_lifecycle_transition_writer_owner',
         'consult_initiation_wrapper_owner',
         'consult_intake_wrapper_owner',
         'consult_ai_preparation_wrapper_owner',
         'consult_claim_wrapper_owner',
         'record_consult_decision_wrapper_owner',
         'async_consult_view_owner',
         'async_consult_mv_refresh_owner'
     );

    IF v_remaining_count > 0 THEN
        RAISE WARNING
            'migration-053-rollback-incomplete: % SI-020 async-consult role(s) remain in '
            'pg_roles. DROP ROLE statements may have failed because the roles still own objects '
            'or hold grants. Roll back later migrations (054+) first.', v_remaining_count;
    END IF;
END $$;
