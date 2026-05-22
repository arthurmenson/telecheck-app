-- =============================================================================
-- File:    migrations/rollback/034_rollback.sql
-- Purpose: Rollback migration 034_crisis_response_derived_views.sql.
--
--          Drops the 2 Crisis Response derived views + revokes the
--          base-table SELECT grants given to the 2 reader roles.
--
--          Pre-rollback check: no SECDEF wrappers or routes may currently
--          read these views. As of migration 034, no such consumers exist
--          (wrappers + Fastify routes land in PR 3+ / migrations 035+).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Drop the 2 views (REVOKEs happen implicitly via DROP).
-- -----------------------------------------------------------------------------

DROP VIEW IF EXISTS crisis_event_patient_summary_v;
DROP VIEW IF EXISTS crisis_event_current_state_v;

-- -----------------------------------------------------------------------------
-- 2. Revoke the base-table SELECT grants given to the 2 reader roles in §3.
--    The reader roles themselves stay (created at migration 032; that
--    migration's rollback handles them).
-- -----------------------------------------------------------------------------

REVOKE SELECT ON crisis_event_lifecycle_transition  FROM crisis_event_patient_reader;
REVOKE SELECT ON crisis_event                       FROM crisis_event_patient_reader;
REVOKE SELECT ON crisis_event_lifecycle_transition  FROM crisis_event_staff_reader;
REVOKE SELECT ON crisis_event                       FROM crisis_event_staff_reader;

-- =============================================================================
-- Post-rollback verification: no crisis_event_*_v views remain in public.
-- =============================================================================
DO $$
DECLARE
    v_remaining INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining
      FROM pg_views
     WHERE schemaname = 'public'
       AND viewname IN ('crisis_event_current_state_v', 'crisis_event_patient_summary_v');

    IF v_remaining > 0 THEN
        RAISE WARNING
            'migration-034-rollback-incomplete: % crisis_event_*_v view(s) remain. '
            'DROP VIEW may have failed due to dependent objects from later migrations. '
            'Roll back later migrations (035+) first.', v_remaining;
    END IF;
END $$;
