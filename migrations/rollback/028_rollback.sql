-- =============================================================================
-- File:    migrations/rollback/028_rollback.sql
-- Purpose: Roll back migration 028 by re-narrowing the
--          accounts.account_type CHECK to the pre-PR-F1 admit set
--          (patient, delegate, clinician).
--
-- WARNING: Rolling back this migration breaks any production session
-- whose JWT carries role IN ('tenant_admin', 'platform_admin') AND
-- every accounts row with account_type IN ('tenant_admin',
-- 'platform_admin') will fail the re-narrowed CHECK. Only roll back
-- if:
--   - No admin sessions are live in any tenant (revoke first).
--   - No accounts row carries account_type='tenant_admin' or
--     'platform_admin' (DELETE or UPDATE first).
--   - Admin-routed handlers (templates/variants/deployments via
--     requireAdminRole) are also reverted or otherwise blocked from
--     authorizing JWT admin actors (the JWT path will keep accepting
--     in-flight admin tokens until they expire even after rollback).
--
-- Spec:    Companion to migrations/028_accounts_account_type_admin.sql.
--          Codex R1 MEDIUM closure 2026-05-15: mirrors the 027_rollback
--          DO-precheck pattern so the rollback aborts with a clear
--          exception BEFORE any DDL fires if admin rows exist.
-- =============================================================================

-- Defensive pre-rollback check: count admin accounts. The migration
-- runner's transactional apply means RAISE EXCEPTION here will abort
-- the rollback before any constraint change takes effect, preserving
-- the production schema intact.
DO $$
DECLARE
    admin_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO admin_count
      FROM accounts
     WHERE account_type IN ('tenant_admin', 'platform_admin');
    IF admin_count > 0 THEN
        RAISE EXCEPTION
            'rollback 028 aborted: % accounts row(s) carry account_type IN '
            '(tenant_admin, platform_admin). DELETE or UPDATE these rows to a '
            'non-admin type BEFORE rolling back. Rolling back with active admin '
            'rows would leave them violating the re-narrowed CHECK constraint.',
            admin_count
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
END;
$$;

ALTER TABLE accounts
    DROP CONSTRAINT IF EXISTS accounts_account_type_check;

ALTER TABLE accounts
    ADD CONSTRAINT accounts_account_type_check CHECK (
        account_type IN ('patient', 'delegate', 'clinician')
    );
