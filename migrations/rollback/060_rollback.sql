-- =============================================================================
-- File:    migrations/rollback/060_rollback.sql
-- Purpose: Rollback migration 060_async_consult_app_role_bridge.sql.
--
--          REVOKEs the 5 async consult application/reader role memberships
--          from telecheck_app_role. Does NOT touch the 051 foundation
--          posture (NOINHERIT stays; the 13 original slice-role memberships
--          stay) — 060 was purely additive to the membership set.
--
--          PRE-ROLLBACK CHECK (manual / operator): the /v1/async-consults
--          Fastify handlers lose their privilege-acquisition mechanism after
--          this rollback (withDbRole('async_consult_*') will fail with
--          "permission denied to set role"). Drain / disable that handler
--          surface first, or revert the handler PR alongside.
--
--          IDEMPOTENCY: REVOKE of a non-existent grant is a no-op; the
--          existence gates below are for cleaner NOTICE output.
-- =============================================================================

DO $$
DECLARE
    v_slice_roles  TEXT[] := ARRAY[
        'async_consult_patient_initiator',
        'async_consult_delegate_initiator',
        'async_consult_clinician_reviewer',
        'async_consult_patient_reader',
        'async_consult_staff_reader'
    ];
    v_role    TEXT;
    v_revoked INTEGER := 0;
    v_skipped INTEGER := 0;
BEGIN
    IF to_regrole('telecheck_app_role') IS NULL THEN
        RAISE NOTICE 'rollback-060-skip: telecheck_app_role does not exist; '
            'nothing to revoke.';
        RETURN;
    END IF;

    FOREACH v_role IN ARRAY v_slice_roles LOOP
        IF to_regrole(v_role) IS NULL THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;
        IF NOT pg_has_role('telecheck_app_role', v_role::regrole, 'MEMBER') THEN
            v_skipped := v_skipped + 1;
            CONTINUE;
        END IF;
        EXECUTE format('REVOKE %I FROM telecheck_app_role', v_role);
        v_revoked := v_revoked + 1;
    END LOOP;

    RAISE NOTICE 'rollback-060-summary: % revokes applied, % skipped '
        '(role-absent or membership-absent)', v_revoked, v_skipped;
END $$;

-- Post-rollback verification: no residual async consult memberships.
DO $$
DECLARE
    v_slice_roles  TEXT[] := ARRAY[
        'async_consult_patient_initiator',
        'async_consult_delegate_initiator',
        'async_consult_clinician_reviewer',
        'async_consult_patient_reader',
        'async_consult_staff_reader'
    ];
    v_role     TEXT;
    v_residual INTEGER := 0;
BEGIN
    IF to_regrole('telecheck_app_role') IS NULL THEN
        RETURN;
    END IF;
    FOREACH v_role IN ARRAY v_slice_roles LOOP
        IF to_regrole(v_role) IS NULL THEN
            CONTINUE;
        END IF;
        IF pg_has_role('telecheck_app_role', v_role::regrole, 'MEMBER') THEN
            v_residual := v_residual + 1;
            RAISE WARNING 'rollback-060-incomplete: telecheck_app_role is '
                'still a member of %; REVOKE may have failed.', v_role;
        END IF;
    END LOOP;
    IF v_residual = 0 THEN
        RAISE NOTICE 'rollback-060-verify: clean — no residual async consult '
            'role memberships on telecheck_app_role';
    END IF;
END $$;
