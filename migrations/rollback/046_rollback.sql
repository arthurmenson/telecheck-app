-- =============================================================================
-- File:    migrations/rollback/046_rollback.sql
-- Purpose: Rollback migration 046_med_interaction_rbac_roles.sql.
--
--          Drops the 12 net-new Med-Interaction (SI-019) RBAC roles in
--          reverse-dependency order: service-level owners → wrapper-owners →
--          application roles.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - No tables / views / MV / procedures may currently be OWNED by
--              any of these 12 roles, and no grants may reference them. As of
--              migration 046, no such objects exist (entities + RLS land in
--              the PR 2 migration; the MV + view land in PR 3; the raw writer
--              + wrappers land in PR 4-5). If those migrations have shipped,
--              roll back THEIR migrations first, then come back to this one.
--              The DROP ROLE statements below will fail if any role still owns
--              objects or holds grants — that is the canonical PG guard against
--              forgetting cleanup.
--
--          DROP ROLE IF EXISTS is used (not bare DROP ROLE) so a partial-prior-
--          rollback state does not abort this script before the post-rollback
--          verification runs.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Service-level owner roles (2).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS mv_refresh_owner;
DROP ROLE IF EXISTS lifecycle_transition_writer_owner;

-- -----------------------------------------------------------------------------
-- 2. SECURITY DEFINER wrapper-owner roles (6).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS expiry_wrapper_owner;
DROP ROLE IF EXISTS resolution_wrapper_owner;
DROP ROLE IF EXISTS superseded_wrapper_owner;
DROP ROLE IF EXISTS override_wrapper_owner;
DROP ROLE IF EXISTS activation_wrapper_owner;
DROP ROLE IF EXISTS emission_wrapper_owner;

-- -----------------------------------------------------------------------------
-- 3. Application roles (4).
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS medication_interaction_knowledge_base_updater;
DROP ROLE IF EXISTS medication_interaction_override_recorder;
DROP ROLE IF EXISTS medication_interaction_signal_viewer;
DROP ROLE IF EXISTS medication_interaction_engine_evaluator;

-- =============================================================================
-- Post-rollback verification: count of SI-019 med-interaction roles should be 0.
-- WARNING (not EXCEPTION) so a partial-state operator gets a diagnostic surface
-- without blocking subsequent rollback steps (matches migration 039 / 045
-- rollback-hygiene precedent).
-- =============================================================================
DO $$
DECLARE
    v_remaining_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining_count
      FROM pg_roles
     WHERE rolname IN (
         'medication_interaction_engine_evaluator',
         'medication_interaction_signal_viewer',
         'medication_interaction_override_recorder',
         'medication_interaction_knowledge_base_updater',
         'emission_wrapper_owner',
         'activation_wrapper_owner',
         'override_wrapper_owner',
         'superseded_wrapper_owner',
         'resolution_wrapper_owner',
         'expiry_wrapper_owner',
         'lifecycle_transition_writer_owner',
         'mv_refresh_owner'
     );

    IF v_remaining_count > 0 THEN
        RAISE WARNING
            'migration-046-rollback-incomplete: % SI-019 med-interaction role(s) remain in '
            'pg_roles. DROP ROLE statements may have failed because the roles still own objects '
            'or hold grants. Roll back later migrations (047+) first.', v_remaining_count;
    END IF;
END $$;
