-- =============================================================================
-- File:    migrations/rollback/017_rollback.sql
-- Purpose: Rollback for 017_delegations.sql — drop the delegations +
--          delegation_scopes tables and all dependent objects.
-- Spec:    Companion to migrations/017_delegations.sql.
-- Warning: DESTRUCTIVE. All delegation invitations / acceptances /
--          revocations + per-scope grants will be permanently lost.
--          Running in any environment with live patient delegations
--          violates Slice PRD §6 + clinical audit obligations.
--          Sign-off requirements identical to 016_rollback.sql.
-- =============================================================================

-- Drop order: delegation_scopes (child) → delegations (parent).
-- Indexes are dropped automatically with DROP TABLE.

-- Step 1: Drop RLS policies.
DROP POLICY IF EXISTS tenant_isolation ON delegation_scopes;
DROP POLICY IF EXISTS tenant_isolation ON delegations;

-- Step 2: Drop tables (children first per composite-FK dependency).
DROP TABLE IF EXISTS delegation_scopes;
DROP TABLE IF EXISTS delegations;
