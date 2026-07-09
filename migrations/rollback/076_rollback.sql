-- =============================================================================
-- File:    migrations/rollback/076_rollback.sql
-- Purpose: Rollback migration 076_subscription_app_role_bridge.sql.
--
-- Revokes telecheck_app_role's membership in the 4 Subscription slice roles
-- and the SI-010 actor-context helper EXECUTE grants. Run BEFORE the 074
-- rollback (DROP ROLE requires the memberships/grants be gone).
-- =============================================================================

DO $$
DECLARE
    v_slice_roles TEXT[] := ARRAY[
        'subscription_patient_manager',
        'subscription_clinician_reviewer',
        'subscription_system_scheduler',
        'subscription_staff_reader'
    ];
    v_role TEXT;
BEGIN
    FOREACH v_role IN ARRAY v_slice_roles LOOP
        IF to_regrole(v_role) IS NULL THEN
            CONTINUE;
        END IF;
        EXECUTE format('REVOKE %I FROM telecheck_app_role', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION _current_actor_context_row() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_account_id() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_role() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_admin_home_tenant_id() FROM %I', v_role);
    END LOOP;
END $$;

DO $$
DECLARE
    v_role TEXT;
BEGIN
    FOR v_role IN
        SELECT unnest(ARRAY[
            'subscription_patient_manager',
            'subscription_clinician_reviewer',
            'subscription_system_scheduler',
            'subscription_staff_reader'
        ])
    LOOP
        IF to_regrole(v_role) IS NOT NULL
           AND pg_has_role('telecheck_app_role', v_role::regrole, 'MEMBER') THEN
            RAISE EXCEPTION 'rollback-076-verification: telecheck_app_role still member of %', v_role;
        END IF;
    END LOOP;
END $$;
