-- =============================================================================
-- File:    migrations/rollback/016_rollback.sql
-- Purpose: Rollback for 016_consent.sql — drop the consent + consent_versions
--          tables and all dependent objects (RLS policies, triggers, indexes,
--          REVOKE statements).
-- Spec:    Companion to migrations/016_consent.sql per migrations/README.md
--          "Every migration has a rollback companion."
-- Warning: DESTRUCTIVE. All consent grants + revocations + consent-version
--          terms_text rows will be permanently lost. Running this rollback
--          in any environment that has live patient consents will violate
--          Slice PRD §7.1 append-only invariants AND clinical audit
--          obligations. The rollback should ONLY be used in:
--            - Local development (fresh DB)
--            - Isolated integration test environments with synthetic data
--          NEVER run in production without explicit sign-off from:
--            - Engineering Lead
--            - Platform Privacy Officer (consent record destruction)
--            - Platform Clinical Governance (revocation history loss)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Drop order: child objects before parents.
-- Dependency chain (FK order):
--   consent          → accounts (012), consent_versions (this migration)
--   consent_versions → tenants (001)
-- ---------------------------------------------------------------------------

-- Step 1: Drop RLS policies (must precede DROP TABLE).

DROP POLICY IF EXISTS tenant_isolation ON consent;
DROP POLICY IF EXISTS tenant_isolation ON consent_versions;

-- ---------------------------------------------------------------------------
-- Step 2: Drop tables in dependency order (children first).
-- The append-only REVOKEs from migration 016 are dropped implicitly with
-- DROP TABLE — no separate cleanup needed.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS consent;
DROP TABLE IF EXISTS consent_versions;
