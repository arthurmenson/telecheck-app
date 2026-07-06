-- =============================================================================
-- File:    migrations/rollback/057_rollback.sql
-- Purpose: Rollback migration 057_async_consult_derived_views.sql.
--
-- Drops the 2 derived views + revokes the reader-role base-table column
-- grants + the SI-010 helper EXECUTE grants added by 057. Base tables
-- (migration 056) and roles (migration 055) are untouched — they have
-- their own rollbacks.
-- =============================================================================

DROP VIEW IF EXISTS async_consult_patient_summary_v;
DROP VIEW IF EXISTS async_consult_staff_summary_v;

-- Revoke the column-level base-table grants (idempotent; REVOKE on absent
-- grants is a no-op).
REVOKE SELECT (id, tenant_id, patient_id, consult_type, created_at)
    ON consult
    FROM async_consult_staff_reader, async_consult_patient_reader;
REVOKE SELECT (tenant_id, consult_id, to_state, transition_at, id)
    ON consult_lifecycle_transition
    FROM async_consult_staff_reader, async_consult_patient_reader;
REVOKE SELECT (tenant_id, consult_id, decision_type, decided_at)
    ON consult_clinician_decision
    FROM async_consult_staff_reader, async_consult_patient_reader;
REVOKE SELECT (tenant_id, consult_id)
    ON consult_follow_up_message
    FROM async_consult_staff_reader, async_consult_patient_reader;
REVOKE SELECT (tenant_id, delegation_id, grantor_account_id, delegate_account_id, status)
    ON delegations
    FROM async_consult_patient_reader;
REVOKE SELECT (tenant_id, delegation_id, scope, revoked_at)
    ON delegation_scopes
    FROM async_consult_patient_reader;

REVOKE EXECUTE ON FUNCTION current_actor_account_id()        FROM async_consult_patient_reader;
REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM async_consult_patient_reader;

-- Verification: neither view remains
DO $$
DECLARE
    v_remaining INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining
      FROM pg_views
     WHERE schemaname = 'public'
       AND viewname IN ('async_consult_staff_summary_v', 'async_consult_patient_summary_v');
    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'migration-057-rollback-incomplete: % async-consult view(s) remain', v_remaining
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
