-- =============================================================================
-- File:    migrations/rollback/033_rollback.sql
-- Purpose: Rollback migration 033_crisis_response_entities.sql.
--
--          Drops the 3 Crisis Response canonical entities + 3 P-027
--          notification_crisis_* baseline entities + all per-table append-only
--          and terminal-row-immutable trigger functions in reverse-dependency
--          order: triggers → tables → FK cycle-breaker drops happen implicitly
--          via DROP TABLE CASCADE.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - No SECDEF procedures, views, or routes may currently reference
--              any of these 6 tables. As of migration 033, no such objects
--              exist (views land in PR 2 / migration 034; SECDEF wrappers
--              land in PR 3+ / migrations 035+). If those migrations have
--              shipped, roll back THEIR migrations first.
--            - Crisis response data is PHI per ADR-021; PHI loss has audit
--              implications. Confirm with Engineering Lead + Platform Privacy
--              Officer before rolling back in any environment containing
--              real crisis_event rows.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Drop tables (CASCADE drops dependent constraints + indexes; triggers drop
--    with their tables; trigger functions are dropped separately below).
-- -----------------------------------------------------------------------------

DROP TABLE IF EXISTS crisis_sweep_execution                  CASCADE;
DROP TABLE IF EXISTS crisis_event_lifecycle_transition       CASCADE;
DROP TABLE IF EXISTS notification_crisis_escalation_obligation CASCADE;
DROP TABLE IF EXISTS notification_crisis_provider_attempt    CASCADE;
DROP TABLE IF EXISTS notification_crisis_dispatch_ledger     CASCADE;
DROP TABLE IF EXISTS crisis_event                            CASCADE;

-- -----------------------------------------------------------------------------
-- 2. Drop per-table trigger functions (independent objects post-CASCADE).
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS crisis_sweep_execution_block_delete();
DROP FUNCTION IF EXISTS crisis_sweep_execution_terminal_immutable();
DROP FUNCTION IF EXISTS crisis_event_lifecycle_transition_enforce_monotonic_ordering();
DROP FUNCTION IF EXISTS crisis_event_lifecycle_transition_block_mutation();
DROP FUNCTION IF EXISTS crisis_event_block_mutation();
DROP FUNCTION IF EXISTS notification_crisis_escalation_obligation_block_delete();
DROP FUNCTION IF EXISTS notification_crisis_escalation_obligation_terminal_immutable();
-- R5 HIGH-1 closure 2026-05-22: drop the cycle-coherence assertion trigger function
DROP FUNCTION IF EXISTS notification_crisis_provider_attempt_assert_cycle_matches_ledger();
DROP FUNCTION IF EXISTS notification_crisis_provider_attempt_block_mutation();
DROP FUNCTION IF EXISTS notification_crisis_dispatch_ledger_block_mutation();

-- =============================================================================
-- Post-rollback verification: no crisis_* or notification_crisis_* tables OR
-- standalone trigger functions remain (R6 MED-1 closure 2026-05-22 — extended
-- the verification to catch orphaned functions, not just tables).
-- =============================================================================
DO $$
DECLARE
    v_remaining_tables    INTEGER;
    v_remaining_functions INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining_tables
      FROM pg_tables
     WHERE schemaname = 'public'
       AND (tablename LIKE 'crisis_%' OR tablename LIKE 'notification_crisis_%');

    SELECT COUNT(*) INTO v_remaining_functions
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname LIKE 'crisis_%' OR p.proname LIKE 'notification_crisis_%');

    IF v_remaining_tables > 0 THEN
        RAISE WARNING
            'migration-033-rollback-incomplete: % crisis/notification_crisis table(s) remain. '
            'DROP TABLE CASCADE may have failed due to remaining dependent objects. '
            'Roll back later migrations (034+) first.', v_remaining_tables;
    END IF;

    IF v_remaining_functions > 0 THEN
        RAISE WARNING
            'migration-033-rollback-incomplete: % crisis/notification_crisis function(s) remain in public schema. '
            'Add explicit DROP FUNCTION statements above for any orphaned trigger functions.',
            v_remaining_functions;
    END IF;
END $$;
