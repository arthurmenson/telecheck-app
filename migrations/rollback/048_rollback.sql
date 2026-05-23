-- =============================================================================
-- File:    migrations/rollback/048_rollback.sql
-- Purpose: Rollback migration 048_med_interaction_read_path.sql.
--
--          Drops, in reverse-dependency order:
--            1. get_interaction_signal_current_state() SECDEF access function
--            2. interaction_signal_current_state_v SECURITY BARRIER view
--            3. interaction_signal_current_state_mv materialized view
--               (+ its UNIQUE index, dropped implicitly with the MV)
--
--          ROLLBACK HYGIENE (PR3/PR4/PR5 + migration 041/045 precedent):
--          - Function drop is OID-gated via to_regprocedure with the EXACT
--            signature so a partial-prior-rollback (function already gone) is
--            a clean no-op, and a wrong-signature object is never touched.
--          - View + MV drops use DROP IF EXISTS → verify-absent → only then
--            proceed, each guarded in a DO block whose RAISE bubbles out under
--            any executor (autocommit-non-stop OR single-transaction) so a
--            dependency-blocked drop ABORTS before downstream REVOKE/cleanup.
--          - The MV/view/function carry only SELECT/EXECUTE grants to
--            mv_refresh_owner + medication_interaction_signal_viewer; dropping
--            the objects removes those grants implicitly, so no standalone
--            REVOKE is needed. The role principals (migration 046) are NOT
--            dropped here — they are owned by migration 046's rollback.
--
--          OPERATOR NOTE: this rollback is independent of migrations 046/047.
--          Rolling 048 back leaves the 4 entities + 12 roles intact; the
--          read-path projection is rebuildable (CREATE MATERIALIZED VIEW …)
--          at any time by re-applying 048. No data loss (the MV is a
--          non-authoritative projection of interaction_signal_lifecycle_transition
--          per I-035).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. SECDEF access function — OID-gated drop (exact signature).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_fn_oid OID := to_regprocedure(
        'public.get_interaction_signal_current_state(character varying)');
BEGIN
    IF v_fn_oid IS NOT NULL THEN
        DROP FUNCTION public.get_interaction_signal_current_state(VARCHAR(26));
    ELSE
        RAISE NOTICE
            'migration-048-rollback-note: '
            'get_interaction_signal_current_state(varchar) already absent; skipping.';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. SECURITY BARRIER view — DROP → verify-absent (guards against a dependent
--    object in a future migration pinning it).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_view_still_present BOOLEAN;
BEGIN
    DROP VIEW IF EXISTS interaction_signal_current_state_v;

    SELECT EXISTS (
        SELECT 1 FROM pg_views
         WHERE schemaname = 'public'
           AND viewname = 'interaction_signal_current_state_v'
    ) INTO v_view_still_present;

    IF v_view_still_present THEN
        RAISE EXCEPTION
            'migration-048-rollback-view-blocked: '
            'DROP VIEW interaction_signal_current_state_v left the view in place '
            '(a dependent object in a later migration still references it). '
            'Roll back dependent migrations first, then retry this rollback.';
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Materialized view — DROP → verify-absent. The UNIQUE index
--    (interaction_signal_current_state_mv_pk) drops implicitly with the MV.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_mv_still_present BOOLEAN;
BEGIN
    DROP MATERIALIZED VIEW IF EXISTS interaction_signal_current_state_mv;

    SELECT (to_regclass('public.interaction_signal_current_state_mv') IS NOT NULL)
      INTO v_mv_still_present;

    IF v_mv_still_present THEN
        RAISE EXCEPTION
            'migration-048-rollback-mv-blocked: '
            'DROP MATERIALIZED VIEW interaction_signal_current_state_mv left the MV '
            'in place (a dependent object still references it). Roll back '
            'dependent migrations first, then retry this rollback.';
    END IF;
END $$;

-- =============================================================================
-- Post-rollback verification: all 3 read-path surfaces absent. Reachable only
-- if every DO-block guard above succeeded (or was a clean no-op).
-- =============================================================================
DO $$
DECLARE
    v_remaining INTEGER := 0;
BEGIN
    IF to_regclass('public.interaction_signal_current_state_mv') IS NOT NULL THEN
        v_remaining := v_remaining + 1;
    END IF;
    IF to_regclass('public.interaction_signal_current_state_v') IS NOT NULL THEN
        v_remaining := v_remaining + 1;
    END IF;
    IF to_regprocedure(
        'public.get_interaction_signal_current_state(character varying)') IS NOT NULL THEN
        v_remaining := v_remaining + 1;
    END IF;

    IF v_remaining > 0 THEN
        RAISE WARNING
            'migration-048-rollback-incomplete: % read-path surface(s) unexpectedly '
            'remain. The DO-block guards above should have aborted before this '
            'verification — investigate.', v_remaining;
    END IF;
END $$;
