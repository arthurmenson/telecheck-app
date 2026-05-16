-- =============================================================================
-- File:    migrations/rollback/031_rollback.sql
-- Purpose: Rollback migration 031_session_actor_context.sql.
--
--          Drops the SI-010 server-derived actor identity infrastructure
--          in reverse-dependency order: helper functions → core read
--          helper → write function → table → role.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - No production code currently calls bind_actor_context(),
--              current_actor_*(), or assert_request_nonce_bound() —
--              wiring lives in subsequent PRs not yet shipped at
--              migration-031 ratification. If those PRs have shipped,
--              roll back THEIR migrations (032+) first, then come back
--              to this one.
--            - Confirm no SECURITY DEFINER procedures depend on
--              current_actor_*() before dropping. As of migration 031,
--              no procedures do (SI-005/008/009 procedures land in
--              later migrations that depend on this one).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Public helpers (drop before the row-fetch helper they depend on).
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS current_actor_admin_home_tenant_id();
DROP FUNCTION IF EXISTS current_actor_role();
DROP FUNCTION IF EXISTS current_actor_account_tenant_id();
DROP FUNCTION IF EXISTS current_actor_account_id();

-- -----------------------------------------------------------------------------
-- 2. Assert/cleanup helpers.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS assert_request_nonce_bound();
DROP FUNCTION IF EXISTS _session_actor_context_cleanup();

-- -----------------------------------------------------------------------------
-- 3. Core read helper.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS _current_actor_context_row();

-- -----------------------------------------------------------------------------
-- 4. Write function.
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS bind_actor_context(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, INTEGER);

-- -----------------------------------------------------------------------------
-- 5. Table.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS _session_actor_context;

-- -----------------------------------------------------------------------------
-- 6. Role.
--
-- NOTE: not dropped automatically. The role may be referenced by
-- existing connections or DB grants made outside migration scope.
-- Operators DROP it explicitly after verifying no connections are
-- holding it:
--
--     DROP ROLE IF EXISTS bind_actor_context_role;
--
-- -----------------------------------------------------------------------------
