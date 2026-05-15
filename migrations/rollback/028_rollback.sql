-- =============================================================================
-- File:    migrations/rollback/028_rollback.sql
-- Purpose: Roll back migration 028 by re-narrowing the
--          accounts.account_type CHECK to the pre-PR-F1 admit set
--          (patient, delegate, clinician).
--
-- WARNING: If any rows have been inserted with
--          account_type='tenant_admin' or account_type='platform_admin'
--          after migration 028 ran, those rows will fail the re-narrowed
--          CHECK. Only roll back if you've manually verified no admin
--          accounts exist OR if you've migrated them away first.
--
-- Spec:    - migrations/028_accounts_account_type_admin.sql (forward)
-- =============================================================================

ALTER TABLE accounts
    DROP CONSTRAINT IF EXISTS accounts_account_type_check;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_account_type_check CHECK (
        account_type IN ('patient', 'delegate', 'clinician')
    );
