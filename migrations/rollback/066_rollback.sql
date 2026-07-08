-- =============================================================================
-- File:    migrations/rollback/066_rollback.sql
-- Purpose: Rollback migration 066_ai_mode1_rbac_roles.sql.
--
--          Drops the 2 net-new Mode 1 (P-036 Section 6) RBAC roles in
--          reverse-dependency order: reader -> view owner.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - No tables / views may currently be OWNED by ai_mode1_view_owner,
--              and no grants may reference either role. As of migration 066,
--              no such objects exist (the 5 entities + the
--              ai_mode1_conversation_state view + the grant chain land in
--              migration 067). If migration 067 has shipped, roll back
--              rollback/067_rollback.sql FIRST, then come back to this one.
--              The DROP ROLE statements below will fail if any role still
--              owns objects or holds grants -- that is the canonical PG guard
--              against forgetting cleanup.
--
--          DROP ROLE IF EXISTS is used (not bare DROP ROLE) so a partial-
--          prior-rollback state does not abort this script before the
--          post-rollback verification runs. Matches migration 046/055
--          rollback hygiene.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Reader application role.
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS ai_mode1_reader;

-- -----------------------------------------------------------------------------
-- 2. View-owner role.
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS ai_mode1_view_owner;

-- =============================================================================
-- Post-rollback verification: count of P-036 Mode 1 roles should be 0.
-- WARNING (not EXCEPTION) so a partial-state operator gets a diagnostic
-- surface without blocking subsequent rollback steps (matches migration
-- 039 / 045 / 046 / 055 rollback-hygiene precedent).
-- =============================================================================
DO $$
DECLARE
    v_remaining_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining_count
      FROM pg_roles
     WHERE rolname IN (
         'ai_mode1_view_owner',
         'ai_mode1_reader'
     );

    IF v_remaining_count > 0 THEN
        RAISE WARNING
            'migration-066-rollback-incomplete: % Mode 1 role(s) remain in pg_roles. '
            'DROP ROLE statements may have failed because the roles still own objects '
            'or hold grants. Roll back migration 067 first.', v_remaining_count;
    END IF;
END $$;
