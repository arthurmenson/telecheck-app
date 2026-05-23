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
--
--          R2 HIGH-1 closure 2026-05-22 (Codex R2): order is DROP VIEW FIRST,
--          then REVOKE base-table grants. If DROP VIEW fails (dependent
--          wrappers still reference the view), the REVOKE statements have
--          NOT yet been executed and the live view retains its required
--          runtime grants. The prior order (REVOKE then DROP) stranded
--          installed views with privileges revoked if DROP was blocked,
--          turning a safe rollback refusal into a runtime permission outage.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Pending-only reviewer view — DROP FIRST, then REVOKE view-owner's
--    base-table SELECTs. Drop-first ordering preserves runtime grants if
--    the DROP is blocked by a still-extant dependent.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS forms_template_admin_review_pending_v;
REVOKE SELECT ON forms_template_admin_review_lifecycle_transition
    FROM forms_template_admin_review_pending_view_owner;
REVOKE SELECT ON forms_template_admin_review
    FROM forms_template_admin_review_pending_view_owner;

-- -----------------------------------------------------------------------------
-- 2. Crisis operational-health view — DROP FIRST, then REVOKE wrapper-owner's
--    base-table SELECTs (R1 HIGH-1 closure grants). Same drop-first ordering
--    for the same reason: keep installed views functional if DROP is blocked.
--    No wrapper at v0.1 (wrapper lands PR 4), but a future PR-4-installed
--    wrapper would block DROP here if PR 4 has shipped.
-- -----------------------------------------------------------------------------
DROP VIEW IF EXISTS admin_crisis_operational_health_v;
REVOKE SELECT ON audit_records
    FROM read_admin_crisis_operational_health_wrapper_owner;
REVOKE SELECT ON crisis_sweep_execution
    FROM read_admin_crisis_operational_health_wrapper_owner;
REVOKE SELECT ON notification_crisis_escalation_obligation
    FROM read_admin_crisis_operational_health_wrapper_owner;
REVOKE SELECT ON crisis_event_lifecycle_transition
    FROM read_admin_crisis_operational_health_wrapper_owner;
REVOKE SELECT ON crisis_event
    FROM read_admin_crisis_operational_health_wrapper_owner;

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
            'migrations (042+) still reference them. Roll back those migrations first. '
            'Per R2 HIGH-1 closure ordering, base-table grants are STILL intact at this '
            'point because REVOKE follows DROP VIEW — the still-installed view(s) remain '
            'executable until you successfully drop them in a follow-up rollback step.',
            v_remaining_count;
    END IF;
END $$;
