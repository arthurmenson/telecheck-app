-- =============================================================================
-- File:    migrations/rollback/047_rollback.sql
-- Purpose: Rollback migration 047_med_interaction_entities.sql.
--
--          Drops the 4 net-new Med-Interaction entities (interaction_engine_evaluation
--          + interaction_signal + interaction_signal_override +
--          interaction_signal_lifecycle_transition) plus per-table trigger
--          functions (including monotonic-ordering trigger function) in
--          reverse-dependency order.
--
--          R6 MED-1 closure 2026-05-23 (Codex R6): ordering is DROP TABLE
--          FIRST (cascades dependent triggers), THEN DROP FUNCTION. The
--          previous "DROP TRIGGER ... ON <table>" before DROP TABLE
--          pattern fails when the target table is absent (partial-migration-
--          failure or rerun-after-partial-rollback): `IF EXISTS` on DROP
--          TRIGGER covers the trigger name, NOT a missing target relation,
--          so the script errored before reaching the table-drop + function-
--          drop cleanup. Reversing the order makes the rollback robust to
--          absent-relation states — DROP TABLE IF EXISTS is a no-op on
--          absent tables, dependent triggers go with the table when it
--          exists, and DROP FUNCTION IF EXISTS handles the orphaned
--          trigger functions safely either way.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - SECDEF wrappers / view / MV / access function from later PRs
--              (048+) must be dropped first if they reference these tables.
--              PostgreSQL CASCADE not used here for safety; if DROP TABLE
--              fails because of a wrapper-FK dependency, roll back the
--              dependent objects first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Lifecycle transition log (innermost child; reverse-FK-dependency order).
--    DROP TABLE first; cascading drops the 3 attached triggers (block_update,
--    block_delete, monotonic-ordering). Then DROP FUNCTION drops the now-
--    orphan trigger functions.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS interaction_signal_lifecycle_transition;
DROP FUNCTION IF EXISTS interaction_signal_lifecycle_transition_enforce_monotonic_ordering();
DROP FUNCTION IF EXISTS interaction_signal_lifecycle_transition_block_mutation();

-- -----------------------------------------------------------------------------
-- 2. Override (child of interaction_signal).
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS interaction_signal_override;
DROP FUNCTION IF EXISTS interaction_signal_override_block_mutation();

-- -----------------------------------------------------------------------------
-- 3. Signal (child of interaction_engine_evaluation).
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS interaction_signal;
DROP FUNCTION IF EXISTS interaction_signal_block_mutation();

-- -----------------------------------------------------------------------------
-- 4. Engine evaluation (root).
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS interaction_engine_evaluation;
DROP FUNCTION IF EXISTS interaction_engine_evaluation_block_mutation();

-- =============================================================================
-- Post-rollback verification: count of net-new interaction_* tables should be 0.
-- =============================================================================
DO $$
DECLARE
    v_remaining_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining_count
      FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename IN (
           'interaction_engine_evaluation',
           'interaction_signal',
           'interaction_signal_override',
           'interaction_signal_lifecycle_transition'
       );

    IF v_remaining_count > 0 THEN
        RAISE WARNING
            'migration-047-rollback-incomplete: % interaction_* table(s) remain in public schema. '
            'DROP TABLE statements may have failed because dependent SECDEF wrappers / views / MV / '
            'access function from later migrations (048+) still reference them. Roll back those '
            'migrations first.', v_remaining_count;
    END IF;
END $$;
