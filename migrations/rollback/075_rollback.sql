-- =============================================================================
-- File:    migrations/rollback/075_rollback.sql
-- Purpose: Rollback migration 075_subscription_rbac_roles.sql.
--
-- Drops the 4 Subscription slice roles. Precondition: migrations 076 + 077
-- rolled back FIRST (table grants + telecheck_app_role memberships must be
-- gone before DROP ROLE succeeds — matches the 066/067 rollback ordering
-- discipline).
--
-- Greenfield safety: no production patient data; role drops are safe
-- pre-pilot only. After first real patient data, forward-fix migrations
-- replace rollbacks per the F4 deploy runbook discipline.
-- =============================================================================

DROP ROLE IF EXISTS subscription_patient_manager;
DROP ROLE IF EXISTS subscription_clinician_reviewer;
DROP ROLE IF EXISTS subscription_system_scheduler;
DROP ROLE IF EXISTS subscription_staff_reader;

DO $$
DECLARE
    v_remaining INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining
      FROM pg_roles
     WHERE rolname IN (
         'subscription_patient_manager',
         'subscription_clinician_reviewer',
         'subscription_system_scheduler',
         'subscription_staff_reader'
     );
    IF v_remaining <> 0 THEN
        RAISE EXCEPTION 'rollback-075-verification: % subscription role(s) remain', v_remaining;
    END IF;
END $$;
