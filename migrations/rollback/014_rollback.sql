-- =============================================================================
-- File:    migrations/rollback/014_rollback.sql
-- Purpose: Rollback for 014_otp.sql — drop the otp_challenges table.
-- Spec:    Companion to migrations/014_otp.sql.
-- Warning: DESTRUCTIVE. All OTP challenge records (code hashes + lockout
--          state) lost. In-flight registration / login flows abort.
-- =============================================================================

DROP POLICY IF EXISTS tenant_isolation ON otp_challenges;
DROP TABLE IF EXISTS otp_challenges;
