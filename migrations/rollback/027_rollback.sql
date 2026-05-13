-- =============================================================================
-- File:    migrations/rollback/027_rollback.sql
-- Purpose: Rollback for 027_accounts_account_type_clinician.sql — re-narrow
--          the accounts.account_type CHECK to the pre-PR-058 admit set.
-- Spec:    Companion to migrations/027_accounts_account_type_clinician.sql.
--
-- Warning: Rolling back this migration breaks any production session
-- whose JWT carries role='clinician' AND every accounts row with
-- account_type='clinician' will fail the re-narrowed CHECK. Only roll
-- back if:
--   - No clinician sessions are live in any tenant (revoke first).
--   - No accounts row carries account_type='clinician' (DELETE or
--     ALTER first).
--   - The pharmacy clinician-write surface (TLC-055 PR E+) is also
--     reverted or otherwise blocked from issuance.
-- =============================================================================

-- Defensive pre-rollback check: count clinician accounts. The migration
-- runner's transactional apply means RAISE EXCEPTION here will abort
-- the rollback before any constraint change takes effect, preserving
-- the production schema intact.
DO $$
DECLARE
    clinician_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO clinician_count
      FROM accounts
     WHERE account_type = 'clinician';
    IF clinician_count > 0 THEN
        RAISE EXCEPTION
            'rollback 027 aborted: % accounts row(s) carry account_type=clinician. '
            'DELETE or UPDATE these rows to a non-clinician type BEFORE rolling back. '
            'Rolling back with active clinician rows would leave them violating the '
            're-narrowed CHECK constraint.',
            clinician_count
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
END;
$$;

ALTER TABLE accounts
    DROP CONSTRAINT IF EXISTS accounts_account_type_check;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_account_type_check CHECK (
        account_type IN ('patient', 'delegate')
    );
