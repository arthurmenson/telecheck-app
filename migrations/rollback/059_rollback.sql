-- =============================================================================
-- File:    migrations/rollback/059_rollback.sql
-- Purpose: Rollback migration 059_async_consult_wrappers.sql.
--
-- Drops the 6 wrapper functions + revokes the §0 supplemental grants.
-- Entities (056), views (057), raw writer (058), roles (055) untouched.
-- =============================================================================

DROP FUNCTION IF EXISTS record_consult_initiation(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TEXT, TEXT, TEXT, INTEGER, TEXT, VARCHAR(26), TEXT, TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), TEXT);
DROP FUNCTION IF EXISTS record_consult_intake_submission(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT);
DROP FUNCTION IF EXISTS record_consult_ai_preparation_completed(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TEXT, TEXT, TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, JSONB, TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT);
DROP FUNCTION IF EXISTS claim_consult_for_review(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), TEXT);
DROP FUNCTION IF EXISTS reassign_consult_claim(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TIMESTAMPTZ);
DROP FUNCTION IF EXISTS record_consult_clinician_decision(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT, TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, VARCHAR(26)[], VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT);

REVOKE SELECT (tenant_id, delegation_id, grantor_account_id, delegate_account_id, status)
    ON delegations FROM consult_initiation_wrapper_owner;
REVOKE SELECT (tenant_id, delegation_id, scope, revoked_at)
    ON delegation_scopes FROM consult_initiation_wrapper_owner;
REVOKE UPDATE ON consult_review_claim FROM record_consult_decision_wrapper_owner;

DO $$
DECLARE
    v_remaining INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining
      FROM pg_proc
     WHERE pronamespace = 'public'::regnamespace
       AND proname IN (
        'record_consult_initiation', 'record_consult_intake_submission',
        'record_consult_ai_preparation_completed', 'claim_consult_for_review',
        'reassign_consult_claim', 'record_consult_clinician_decision');
    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'migration-059-rollback-incomplete: % wrapper(s) remain', v_remaining
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
