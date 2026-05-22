-- =============================================================================
-- File:    migrations/rollback/035_rollback.sql
-- Purpose: Rollback migration 035_crisis_response_raw_lifecycle_writer.sql.
--
--          Drops the raw lifecycle writer function + revokes the writer_owner
--          grants on crisis_event_lifecycle_transition.
--
--          Pre-rollback check: no wrapper procedures may currently depend
--          on this raw writer. As of migration 035, no wrappers exist
--          (PR 4-6 deploy them). If wrapper migrations have shipped, roll
--          back THEIR migrations (036+) first.
-- =============================================================================

-- 1. Drop the function (REVOKEs happen implicitly via DROP).
DROP FUNCTION IF EXISTS record_crisis_event_lifecycle_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB
);

-- 2. Revoke the writer_owner grants on crisis_event_lifecycle_transition.
--    The writer_owner role itself stays (created at migration 032).
REVOKE SELECT ON crisis_event_lifecycle_transition FROM crisis_event_lifecycle_transition_writer_owner;
REVOKE INSERT ON crisis_event_lifecycle_transition FROM crisis_event_lifecycle_transition_writer_owner;

-- Post-rollback verification: function removed.
DO $$
BEGIN
    PERFORM 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'record_crisis_event_lifecycle_transition';
    IF FOUND THEN
        RAISE WARNING
            'migration-035-rollback-incomplete: record_crisis_event_lifecycle_transition() function still exists. '
            'DROP FUNCTION may have failed due to dependent objects from later migrations. '
            'Roll back later migrations (036+) first.';
    END IF;
END $$;
