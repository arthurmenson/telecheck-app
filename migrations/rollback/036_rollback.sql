-- =============================================================================
-- File:    migrations/rollback/036_rollback.sql
-- Purpose: Rollback migration 036_crisis_response_initiation_wrapper.sql.
--
--          Drops the record_crisis_initiation function + revokes the
--          initiation_wrapper_owner grants on crisis_event.
--
--          Pre-rollback check: no Fastify routes may currently call this
--          wrapper. PR 7+ wires the route handler; if shipped, roll back
--          its migration first.
-- =============================================================================

DROP FUNCTION IF EXISTS record_crisis_initiation(
    TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
);

REVOKE INSERT, SELECT ON crisis_event FROM crisis_initiation_wrapper_owner;
-- R2 HIGH-1 closure 2026-05-22: revoke the SI-010 helper grants
REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM crisis_initiation_wrapper_owner;
REVOKE EXECUTE ON FUNCTION current_actor_account_id() FROM crisis_initiation_wrapper_owner;

DO $$
BEGIN
    PERFORM 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'record_crisis_initiation';
    IF FOUND THEN
        RAISE WARNING
            'migration-036-rollback-incomplete: record_crisis_initiation() function still exists. '
            'DROP FUNCTION may have failed due to dependent objects from later migrations. '
            'Roll back later migrations first.';
    END IF;
END $$;
