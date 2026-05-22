-- =============================================================================
-- File:    migrations/rollback/037_rollback.sql
-- Purpose: Rollback migration 037_crisis_response_mid_lifecycle_wrappers.sql.
-- =============================================================================

DROP FUNCTION IF EXISTS record_crisis_resolution(TEXT, UUID, JSONB);
DROP FUNCTION IF EXISTS record_crisis_response(TEXT, UUID, JSONB);
DROP FUNCTION IF EXISTS record_crisis_acknowledgement_claim(TEXT, UUID, JSONB);

-- Revoke grants per wrapper-owner role.
REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM crisis_resolution_wrapper_owner;
REVOKE EXECUTE ON FUNCTION current_actor_account_id()        FROM crisis_resolution_wrapper_owner;
REVOKE SELECT  ON crisis_event_lifecycle_transition          FROM crisis_resolution_wrapper_owner;
REVOKE SELECT  ON crisis_event                               FROM crisis_resolution_wrapper_owner;

REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM crisis_response_wrapper_owner;
REVOKE EXECUTE ON FUNCTION current_actor_account_id()        FROM crisis_response_wrapper_owner;
REVOKE SELECT  ON crisis_event_lifecycle_transition          FROM crisis_response_wrapper_owner;
REVOKE SELECT  ON crisis_event                               FROM crisis_response_wrapper_owner;

REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM crisis_acknowledgement_wrapper_owner;
REVOKE EXECUTE ON FUNCTION current_actor_account_id()        FROM crisis_acknowledgement_wrapper_owner;
REVOKE SELECT  ON crisis_event_lifecycle_transition          FROM crisis_acknowledgement_wrapper_owner;
REVOKE SELECT  ON crisis_event                               FROM crisis_acknowledgement_wrapper_owner;

DO $$
BEGIN
    PERFORM 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('record_crisis_acknowledgement_claim',
                         'record_crisis_response',
                         'record_crisis_resolution');
    IF FOUND THEN
        RAISE WARNING 'migration-037-rollback-incomplete: one or more wrapper functions still exist; later migrations may need rollback first.';
    END IF;
END $$;
