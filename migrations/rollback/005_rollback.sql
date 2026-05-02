-- =============================================================================
-- File:    migrations/rollback/005_rollback.sql
-- Purpose: Rollback for 005_idempotency_keys.sql — drop the idempotency_keys
--          table.
-- Warning: DESTRUCTIVE. Any in-flight idempotency records will be lost.
--          Clients retrying requests after this rollback will re-process
--          (the key no longer exists, so the server treats it as a first
--          request). Only run in dev/test environments when no live client
--          traffic is in flight. Never run in production.
-- =============================================================================

DROP POLICY IF EXISTS tenant_isolation ON idempotency_keys;

DROP TABLE IF EXISTS idempotency_keys;
