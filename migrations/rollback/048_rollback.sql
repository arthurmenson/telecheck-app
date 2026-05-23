-- =============================================================================
-- File:    migrations/rollback/048_rollback.sql
-- Purpose: Rollback migration 048_med_interaction_view_mv_access_function.sql.
--
--          Drops the SECDEF access function + SECURITY BARRIER view +
--          optional MV in reverse-dependency order. The access function +
--          view both depend on the MV, so MV must be dropped LAST.
--
--          Per the PR 2 R6 closure pattern (DROP TABLE first cascades
--          triggers; DROP TYPE/MV first cascades dependent views/functions
--          when CASCADE is used): here we DROP each object explicitly +
--          in reverse-dependency order without CASCADE, since each object
--          stands independently of grants from other migrations. DROP IF
--          EXISTS handles absent-relation states safely.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - SECDEF wrappers from later PRs (049+) that may consume the
--              MV or view must be dropped first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. SECDEF access function (depends on MV).
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS get_interaction_signal_current_state(VARCHAR(26));

-- -----------------------------------------------------------------------------
-- 2. SECURITY BARRIER view (depends on MV).
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS interaction_signal_current_state_v;

-- -----------------------------------------------------------------------------
-- 3. Optional MV (root; drops its unique index automatically).
-- -----------------------------------------------------------------------------
DROP MATERIALIZED VIEW IF EXISTS interaction_signal_current_state_mv;

-- =============================================================================
-- Post-rollback verification: function + view + MV should all be absent.
-- =============================================================================
DO $$
DECLARE
    v_function_present  BOOLEAN := to_regprocedure(
        'public.get_interaction_signal_current_state(character varying)'
    ) IS NOT NULL;
    v_view_present      BOOLEAN := to_regclass(
        'public.interaction_signal_current_state_v'
    ) IS NOT NULL;
    v_mv_present        BOOLEAN := to_regclass(
        'public.interaction_signal_current_state_mv'
    ) IS NOT NULL;
BEGIN
    IF v_function_present OR v_view_present OR v_mv_present THEN
        RAISE WARNING
            'migration-048-rollback-incomplete: function_present=%, view_present=%, mv_present=%. '
            'DROP statements may have failed because dependent SECDEF wrappers from later '
            'migrations (049+) still reference them. Roll back those migrations first.',
            v_function_present, v_view_present, v_mv_present;
    END IF;
END $$;
