-- =============================================================================
-- File:    migrations/rollback/038_rollback.sql
-- Purpose: Rollback migration 038_crisis_response_sweep_wrapper.sql.
-- =============================================================================

DROP FUNCTION IF EXISTS execute_crisis_no_acknowledgement_sweep(TEXT, UUID, INTEGER, TEXT, INTEGER);

REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM crisis_sweep_wrapper_owner;
REVOKE EXECUTE ON FUNCTION current_actor_account_id()        FROM crisis_sweep_wrapper_owner;
REVOKE SELECT  ON crisis_event_lifecycle_transition          FROM crisis_sweep_wrapper_owner;
REVOKE INSERT, SELECT, UPDATE ON crisis_sweep_execution      FROM crisis_sweep_wrapper_owner;
REVOKE SELECT, UPDATE ON crisis_event                        FROM crisis_sweep_wrapper_owner;

DO $$
BEGIN
    PERFORM 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'execute_crisis_no_acknowledgement_sweep';
    IF FOUND THEN
        RAISE WARNING 'migration-038-rollback-incomplete: function still exists';
    END IF;
END $$;
