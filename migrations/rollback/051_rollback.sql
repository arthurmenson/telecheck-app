-- =============================================================================
-- File:    migrations/rollback/051_rollback.sql
-- Purpose: Rollback migration 051_app_role_acquisition_foundation.sql.
--
--          Reverses Option B foundation bridge:
--          (a) REVOKE the 13 slice-role memberships from telecheck_app_role
--              (gated on role existence + membership existence for partial-
--              state robustness).
--          (b) ALTER ROLE telecheck_app_role INHERIT — restore the default
--              pre-051 inheritance posture.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - Fastify handlers that call SET LOCAL ROLE via the withDbRole
--              helper will lose their privilege acquisition mechanism after
--              this rollback. Drain handler traffic first OR ensure the
--              withDbRole helper PR (and its dependent handler PRs) are
--              also reverted, otherwise handlers will receive
--              `permission denied for function <wrapper>` errors after the
--              rollback applies (since NOINHERIT will be reverted to INHERIT
--              but the GRANTs will be REVOKEd, and the dependent helper PRs
--              would need the GRANTs to function).
--
--          IDEMPOTENCY:
--            - REVOKE ... FROM ... is naturally idempotent in PG (revoking a
--              non-existent grant is a no-op). The membership-existence gate
--              below is for cleaner NOTICE output, not correctness.
--            - ALTER ROLE INHERIT is unconditional; re-running is a no-op.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- §1. REVOKE the 13 slice-role memberships.
--
--     Gated on (a) telecheck_app_role exists AND (b) the slice role exists
--     AND (c) the membership currently exists. Idempotent across partial-
--     prior-rollback states.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v_slice_roles    TEXT[] := ARRAY[
        'crisis_initiator',
        'crisis_acknowledger',
        'crisis_responder',
        'crisis_resolver',
        'crisis_sweep_scheduler',
        'crisis_event_staff_reader',
        'crisis_event_patient_reader',
        'admin_basic_operator',
        'admin_template_reviewer',
        'medication_interaction_engine_evaluator',
        'medication_interaction_signal_viewer',
        'medication_interaction_override_recorder',
        'medication_interaction_knowledge_base_updater'
    ];
    v_role           TEXT;
    v_revoked        INTEGER := 0;
    v_skipped        INTEGER := 0;
BEGIN
    IF to_regrole('telecheck_app_role') IS NULL THEN
        RAISE NOTICE 'rollback-051-skip: telecheck_app_role does not exist; '
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

    RAISE NOTICE 'rollback-051-summary: % revokes applied, % skipped '
        '(role-absent or membership-absent)', v_revoked, v_skipped;
END $$;

-- -----------------------------------------------------------------------------
-- §2. Restore telecheck_app_role INHERIT (the pre-051 default posture).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regrole('telecheck_app_role') IS NOT NULL THEN
        ALTER ROLE telecheck_app_role INHERIT;
        COMMENT ON ROLE telecheck_app_role IS
            'Application login role for Fastify backend. (Foundation 051 '
            'rolled back: NOINHERIT reverted to INHERIT; slice-role '
            'memberships revoked.)';
    END IF;
END $$;

-- =============================================================================
-- Post-rollback verification:
--   - telecheck_app_role should be INHERIT.
--   - telecheck_app_role should NOT be a member of any of the 13 slice roles.
-- =============================================================================

DO $$
DECLARE
    v_inherits       BOOLEAN;
    v_slice_roles    TEXT[] := ARRAY[
        'crisis_initiator',
        'crisis_acknowledger',
        'crisis_responder',
        'crisis_resolver',
        'crisis_sweep_scheduler',
        'crisis_event_staff_reader',
        'crisis_event_patient_reader',
        'admin_basic_operator',
        'admin_template_reviewer',
        'medication_interaction_engine_evaluator',
        'medication_interaction_signal_viewer',
        'medication_interaction_override_recorder',
        'medication_interaction_knowledge_base_updater'
    ];
    v_role           TEXT;
    v_residual       INTEGER := 0;
BEGIN
    IF to_regrole('telecheck_app_role') IS NULL THEN
        RETURN;  -- nothing to verify
    END IF;

    SELECT rolinherit INTO v_inherits
      FROM pg_roles
     WHERE rolname = 'telecheck_app_role';
    IF v_inherits IS NOT NULL AND NOT v_inherits THEN
        RAISE WARNING 'rollback-051-incomplete: telecheck_app_role is still '
            'NOINHERIT after rollback. §2 ALTER ROLE INHERIT may have failed.';
    END IF;

    FOREACH v_role IN ARRAY v_slice_roles LOOP
        IF to_regrole(v_role) IS NULL THEN
            CONTINUE;
        END IF;
        IF pg_has_role('telecheck_app_role', v_role::regrole, 'MEMBER') THEN
            v_residual := v_residual + 1;
            RAISE WARNING 'rollback-051-incomplete: telecheck_app_role is '
                'still a member of %; §1 REVOKE may have failed.', v_role;
        END IF;
    END LOOP;

    IF v_residual = 0 THEN
        RAISE NOTICE 'rollback-051-verify: clean — telecheck_app_role is '
            'INHERIT + no residual slice-role memberships';
    END IF;
END $$;
