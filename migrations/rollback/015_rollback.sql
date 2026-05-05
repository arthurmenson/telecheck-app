-- =============================================================================
-- File:    migrations/rollback/015_rollback.sql
-- Purpose: Rollback for 015_auth_devices.sql — drop the auth_devices table.
-- Spec:    Companion to migrations/015_auth_devices.sql.
-- Warning: DESTRUCTIVE. All registered-device records (public keys +
--          attestation metadata + revocation history) lost. Patient
--          devices forced to re-register; the 3-device cap re-engages
--          on first registration after rollback.
-- =============================================================================

DROP POLICY IF EXISTS tenant_isolation ON auth_devices;
DROP TRIGGER IF EXISTS trg_auth_devices_last_seen_at ON auth_devices;
DROP FUNCTION IF EXISTS auth_devices_set_last_seen_at();
DROP TABLE IF EXISTS auth_devices;
