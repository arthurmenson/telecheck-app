-- =============================================================================
-- File:    migrations/015_auth_devices.sql
-- Purpose: Create the `auth_devices` table — registered devices bound to a
--          patient's account for biometric unlock + impossible-travel
--          detection per Identity Spec §3.1 / §3.4.
--
-- Spec:    - Identity & Authentication Spec v1.0 §3.1 (biometric unlock:
--              after first login on a device, the patient can enable
--              biometric authentication; biometric token is device-bound
--              via secure enclave/keychain)
--          - Identity Spec v1.0 §3.4 (multi-device: max 3 devices per
--              account; exceeding forces oldest logout)
--          - Identity Spec v1.0 §3.5 (account recovery: 24-hour security
--              hold post phone-number change applies to all devices)
--          - CDM v1.2 §3.2 entity 10 "AuthDevice"
--          - I-023 / I-027 (RLS + tenant scoping)
--
-- Out-of-scope (deferred):
--   - Tightening sessions.device_id FK to NOT NULL with composite FK to
--     auth_devices (separate migration once Identity service layer is
--     stubbed and existing test sessions are backfilled)
--   - Device-attestation challenge/response (Apple App Attest, Android
--     Play Integrity) — requires platform-specific runtime. v1.0 stores
--     the device-bound public key as opaque base64 + records the
--     attestation_format string for forward compat.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql      applied
--   003_rls_helpers.sql  applied
--   012_accounts.sql     applied
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_devices (

    device_id               VARCHAR(26)  PRIMARY KEY,

    tenant_id               TEXT         NOT NULL
                                REFERENCES tenants(id),

    -- Account binding via composite FK
    account_id              VARCHAR(26)  NOT NULL,

    -- ---------------------------------------------------------------------
    -- Device platform discriminator. Drives platform-specific attestation
    -- behavior at the service layer. `web` is permitted at v1.0 for
    -- web-app sessions that don't use biometric unlock — those rows
    -- carry a placeholder device_public_key but participate in the
    -- multi-device cap.
    -- ---------------------------------------------------------------------

    platform                TEXT         NOT NULL
                                CHECK (platform IN ('ios', 'android', 'web')),

    -- ---------------------------------------------------------------------
    -- Patient-readable device label for the device-management UI
    -- (e.g., "Pixel 7", "iPhone 14"). Patient-supplied at registration.
    -- Bounded length to prevent abuse; nullable for backfilled rows.
    -- ---------------------------------------------------------------------

    device_label            TEXT         NULL
                                CHECK (device_label IS NULL OR LENGTH(device_label) <= 200),

    -- ---------------------------------------------------------------------
    -- Device-bound public key (for biometric/device-token verification).
    -- Stored as base64 string; verification at the service layer decodes
    -- and uses the platform-appropriate verifier.
    --
    -- The device-bound PRIVATE key never leaves the secure enclave /
    -- keychain — only signatures (challenge-response on each biometric
    -- unlock) reach the server.
    -- ---------------------------------------------------------------------

    device_public_key       TEXT         NOT NULL,

    -- ---------------------------------------------------------------------
    -- Attestation envelope format for forward compat. v1.0 ships with
    -- 'none' for web and 'placeholder' for native (until App Attest /
    -- Play Integrity are wired). The CHECK gate is enforced via enum
    -- so a future migration adds new formats by ALTER TABLE / re-CHECK.
    -- ---------------------------------------------------------------------

    attestation_format      TEXT         NOT NULL DEFAULT 'placeholder'
                                CHECK (attestation_format IN (
                                    'none',
                                    'placeholder',
                                    'apple_app_attest',
                                    'android_play_integrity'
                                )),

    -- ---------------------------------------------------------------------
    -- Lifecycle
    -- ---------------------------------------------------------------------

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- last_seen_at advances on every authenticated request from this
    -- device. Drives the "oldest device" picker for max-3-device
    -- enforcement (Identity Spec §3.4).
    last_seen_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Revoked devices retain the row for audit; the service layer
    -- filters revoked rows before max-3-device counting + verification.
    revoked_at              TIMESTAMPTZ  NULL,

    revoked_reason          TEXT         NULL
                                CHECK (revoked_reason IS NULL OR revoked_reason IN (
                                    'patient_unregistered',
                                    'max_devices_evicted',
                                    'security_hold',
                                    'phone_number_changed',
                                    'admin_revoked',
                                    'compromise_detected'
                                )),

    -- ---------------------------------------------------------------------
    -- Composite-FK lookup key
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_auth_device_tenant_id
        UNIQUE (tenant_id, device_id),

    -- Composite FK to accounts: device's tenant_id MUST match account's
    CONSTRAINT fk_auth_device_account
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- Revocation consistency (mirror of sessions pattern)
    CONSTRAINT auth_device_revocation_consistent
        CHECK (
            (revoked_at IS NULL AND revoked_reason IS NULL) OR
            (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
        )
);

-- ---------------------------------------------------------------------------
-- Indexes
-- Key queries:
--   - Active devices per account (max-3 enforcement):
--       WHERE tenant_id=$1 AND account_id=$2 AND revoked_at IS NULL
--   - Oldest active device picker (for eviction):
--       WHERE tenant_id=$1 AND account_id=$2 AND revoked_at IS NULL
--       ORDER BY last_seen_at ASC LIMIT 1
--   - Device verification by id:
--       WHERE tenant_id=$1 AND device_id=$2 AND revoked_at IS NULL
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_auth_devices_tenant_account_active
    ON auth_devices (tenant_id, account_id, last_seen_at ASC)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_auth_devices_tenant_revoked_reason
    ON auth_devices (tenant_id, revoked_reason, revoked_at DESC)
    WHERE revoked_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE auth_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_devices FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON auth_devices
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- last_seen_at maintenance trigger (clock_timestamp() per migration 012 fix)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auth_devices_set_last_seen_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_seen_at := clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auth_devices_last_seen_at ON auth_devices;
CREATE TRIGGER trg_auth_devices_last_seen_at
    BEFORE UPDATE ON auth_devices
    FOR EACH ROW
    EXECUTE FUNCTION auth_devices_set_last_seen_at();
