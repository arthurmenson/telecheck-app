-- =============================================================================
-- File:    migrations/rollback/012_rollback.sql
-- Purpose: Rollback for 012_accounts.sql — drop the accounts table and
--          all dependent objects (RLS, trigger + trigger function, indexes).
-- Spec:    Companion to migrations/012_accounts.sql.
-- Warning: DESTRUCTIVE. All patient + delegate Account rows will be
--          permanently lost. This rollback CASCADE-fails when downstream
--          tables (sessions / otp_challenges / auth_devices / consent /
--          delegations) reference accounts via FK — those migrations
--          (013/014/015/016/017) MUST be rolled back FIRST in the
--          reverse order they were applied. Sign-off requirements
--          identical to 016_rollback.sql.
-- =============================================================================

-- Step 1: Drop RLS policy.
DROP POLICY IF EXISTS tenant_isolation ON accounts;

-- Step 2: Drop trigger + trigger function.
DROP TRIGGER IF EXISTS trg_accounts_updated_at ON accounts;
DROP FUNCTION IF EXISTS accounts_set_updated_at();

-- Step 3: Drop the table. Indexes drop automatically.
DROP TABLE IF EXISTS accounts;
