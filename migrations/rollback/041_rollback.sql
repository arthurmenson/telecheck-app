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
--          R2 + R3 HIGH-1 closures 2026-05-22 (Codex R2 + R3): each
--          drop/revoke section is wrapped in a DO block that:
--            1. Attempts DROP VIEW IF EXISTS.
--            2. Re-checks pg_views to confirm the view is actually gone.
--            3. RAISES EXCEPTION (aborting the DO block + the surrounding
--               script under any executor that propagates exceptions) BEFORE
--               any REVOKE if the view still exists (dependent wrappers
--               still reference it).
--          This is runner-independent: even under an autocommit non-stop-
--          on-error executor, the DO block's RAISE bubbles out of the block
--          and prevents the REVOKEs in the same block from executing.
--          The prior plain-statement DROP-then-REVOKE ordering relied on
--          the runner aborting on the DROP error, which is not guaranteed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Pending-only reviewer view + view-owner privilege grants.
--    DROP → verify-absent → REVOKE, all guarded by single DO block.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_view_still_present BOOLEAN;
BEGIN
    DROP VIEW IF EXISTS forms_template_admin_review_pending_v;

    -- Re-check pg_views: DROP IF EXISTS is a no-op if absent, but DOES NOT
    -- raise on dependency-block (the catalog still shows the view). The
    -- canonical signal is "is the view still present after the attempted
    -- drop." If yes, a dependent wrapper has it pinned; ABORT before any
    -- REVOKE so the live view retains its runtime grants.
    SELECT EXISTS (
        SELECT 1 FROM pg_views
         WHERE schemaname = 'public'
           AND viewname = 'forms_template_admin_review_pending_v'
    ) INTO v_view_still_present;

    IF v_view_still_present THEN
        RAISE EXCEPTION
            'migration-041-rollback-pending-view-blocked: '
            'DROP VIEW forms_template_admin_review_pending_v left the view in '
            'place (dependent SECDEF wrappers / views in later migrations still '
            'reference it). REVOKE of view-owner''s base-table SELECTs ABORTED to '
            'preserve runtime executability. Roll back dependent migrations '
            'first, then retry this rollback.';
    END IF;

    -- Safe to revoke now (view is confirmed dropped; grants are orphaned).
    REVOKE SELECT ON forms_template_admin_review_lifecycle_transition
        FROM forms_template_admin_review_pending_view_owner;
    REVOKE SELECT ON forms_template_admin_review
        FROM forms_template_admin_review_pending_view_owner;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Crisis operational-health view + wrapper-owner base-table SELECT grants.
--    Same DROP → verify-absent → REVOKE pattern under a guarding DO block.
--    No wrapper at v0.1 (wrapper lands PR 4), but a future PR-4-installed
--    wrapper would block DROP here if PR 4 has shipped.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_view_still_present BOOLEAN;
BEGIN
    DROP VIEW IF EXISTS admin_crisis_operational_health_v;

    SELECT EXISTS (
        SELECT 1 FROM pg_views
         WHERE schemaname = 'public'
           AND viewname = 'admin_crisis_operational_health_v'
    ) INTO v_view_still_present;

    IF v_view_still_present THEN
        RAISE EXCEPTION
            'migration-041-rollback-crisis-view-blocked: '
            'DROP VIEW admin_crisis_operational_health_v left the view in '
            'place (dependent SECDEF wrappers in later migrations still '
            'reference it). REVOKE of wrapper-owner''s base-table SELECTs '
            'ABORTED to preserve runtime executability. Roll back dependent '
            'migrations first, then retry this rollback.';
    END IF;

    -- Safe to revoke now (view is confirmed dropped; grants are orphaned).
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
END $$;

-- =============================================================================
-- Post-rollback verification: count of created admin-backend views should be 0.
-- Reachable only if both DO-block guards above succeeded (or were skipped
-- because the views never existed). Otherwise the RAISE EXCEPTION inside
-- the relevant DO block aborted execution before this point.
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
            'migration-041-rollback-incomplete: % admin-backend view(s) '
            'unexpectedly remain in public schema. The DO-block guards above '
            'should have aborted before reaching this verification, so this '
            'indicates a logic bug in the rollback script — investigate.',
            v_remaining_count;
    END IF;
END $$;
