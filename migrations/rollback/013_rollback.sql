-- =============================================================================
-- File:    migrations/rollback/013_rollback.sql
-- Purpose: Rollback for 013_sessions.sql — drop the sessions table.
-- Spec:    Companion to migrations/013_sessions.sql.
-- Warning: DESTRUCTIVE. All session records (refresh-token hashes +
--          revocation history) lost. Patient app + clinician portal
--          sessions all forced to re-authenticate after rollback.
-- =============================================================================

DROP POLICY IF EXISTS tenant_isolation ON sessions;
DROP TRIGGER IF EXISTS trg_sessions_last_active_at ON sessions;
DROP FUNCTION IF EXISTS sessions_set_last_active_at();
DROP TABLE IF EXISTS sessions;
