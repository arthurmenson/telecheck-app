-- =============================================================================
-- File:    migrations/rollback/032_rollback.sql
-- Purpose: Rollback migration 032_crisis_response_rbac_roles.sql.
--
--          Drops the 15 net-new Crisis Response RBAC roles in reverse-
--          dependency order: view-owners → wrapper-owners → raw-writer-owner
--          → application reader roles → application writer roles.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - No tables/views/procedures may currently be OWNED by any of
--              these 15 roles. As of migration 032, no such objects exist
--              (entities + RLS + triggers land in migration 033;
--              wrappers + raw writer land in PR 3+). If those migrations
--              have shipped, roll back THEIR migrations first, then come
--              back to this one. The DROP ROLE statements below will fail
--              if any role still owns objects — that is the canonical PG
--              guard against forgetting cleanup.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. View-owner roles (2; will be dropped only if no views are OWNED by them).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS crisis_event_patient_summary_view_owner;
DROP ROLE IF EXISTS crisis_event_current_state_view_owner;

-- -----------------------------------------------------------------------------
-- 2. Procedure-owner roles (5 wrapper-owners + 1 raw-writer-owner).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS crisis_sweep_wrapper_owner;
DROP ROLE IF EXISTS crisis_resolution_wrapper_owner;
DROP ROLE IF EXISTS crisis_response_wrapper_owner;
DROP ROLE IF EXISTS crisis_acknowledgement_wrapper_owner;
DROP ROLE IF EXISTS crisis_initiation_wrapper_owner;
DROP ROLE IF EXISTS crisis_event_lifecycle_transition_writer_owner;

-- -----------------------------------------------------------------------------
-- 3. Application reader roles (2; P-040 R1 HIGH-2 split).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS crisis_event_patient_reader;
DROP ROLE IF EXISTS crisis_event_staff_reader;

-- -----------------------------------------------------------------------------
-- 4. Application writer/scheduler roles (5).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS crisis_sweep_scheduler;
DROP ROLE IF EXISTS crisis_resolver;
DROP ROLE IF EXISTS crisis_responder;
DROP ROLE IF EXISTS crisis_acknowledger;
DROP ROLE IF EXISTS crisis_initiator;

-- =============================================================================
-- Post-rollback verification: count of crisis_* roles should be 0.
-- =============================================================================
DO $$
DECLARE
    v_remaining_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining_count
      FROM pg_roles
     WHERE rolname LIKE 'crisis_%';

    IF v_remaining_count > 0 THEN
        RAISE WARNING
            'migration-032-rollback-incomplete: % crisis_* role(s) remain in pg_roles. '
            'DROP ROLE statements may have failed because the roles still own objects. '
            'Roll back later migrations (033+) first.', v_remaining_count;
    END IF;
END $$;
