-- =============================================================================
-- File:    migrations/rollback/041_rollback.sql
-- Purpose: Rollback migration 041_admin_backend_derived_views.sql.
--
--          Drops the 2 created admin-backend derived views (the 2 deferred
--          views never existed at v0.1 so no rollback needed for them).
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - SECDEF wrappers from later PRs (042+) must be dropped first if
--              they reference these views. PostgreSQL CASCADE not used here
--              for safety; if DROP VIEW fails, roll back the dependent
--              wrappers first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Pending-only reviewer view + view-owner privilege grants (drop first;
--    no wrapper depends on it at v0.1 since reviewer reads it directly).
-- -----------------------------------------------------------------------------
REVOKE SELECT ON forms_template_admin_review_lifecycle_transition
    FROM forms_template_admin_review_pending_view_owner;
REVOKE SELECT ON forms_template_admin_review
    FROM forms_template_admin_review_pending_view_owner;
DROP VIEW IF EXISTS forms_template_admin_review_pending_v;

-- -----------------------------------------------------------------------------
-- 2. Crisis operational-health view (no wrapper at v0.1; wrapper lands PR 4).
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS admin_crisis_operational_health_v;

-- =============================================================================
-- Post-rollback verification: count of created admin-backend views should be 0.
-- =============================================================================
DO $$
DECLARE
    v_remaining_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining_count
      FROM pg_views
     WHERE schemaname = 'public'
       AND viewname IN (
           'admin_crisis_operational_health_v',
           'forms_template_admin_review_pending_v'
       );

    IF v_remaining_count > 0 THEN
        RAISE WARNING
            'migration-041-rollback-incomplete: % admin-backend view(s) remain in public schema. '
            'DROP VIEW statements may have failed because dependent wrappers from later '
            'migrations (042+) still reference them. Roll back those migrations first.',
            v_remaining_count;
    END IF;
END $$;
