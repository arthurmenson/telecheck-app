-- =============================================================================
-- File:    migrations/014_otp.sql
-- Purpose: Create the `otp` table — one-time-password challenge records used
--          for patient registration (Identity Spec §2.1) and login (§3.1).
--
-- Spec:    - Identity & Authentication Spec v1.0 §2.1 (registration:
--              6-digit OTP via SMS, 5-minute validity, max 3 attempts
--              before 15-minute cooldown lockout)
--          - Identity Spec v1.0 §3.1 (login: same OTP semantics)
--          - Identity Spec v1.0 §3.5 (account recovery: phone-number-change
--              OTP on the new number)
--          - CDM v1.2 §3.2 entity 9 "OTP"
--          - I-023 / I-027 (tenant scoping + RLS)
--
-- Security disciplines:
--   - Codes are HASHED at rest (SHA-256) — same discipline as
--     sessions.refresh_token_hash. The 6-digit space is small enough that
--     storing plaintext makes a DB-leak immediately exploitable; storing
--     SHA-256 hex (64 chars) raises the cost to a brute-force search of
--     1M possibilities per row, which is still cheap but at least
--     uniformly so per row rather than collectively.
--   - Rate limiting: attempts_remaining starts at 3 and decrements on
--     each verify failure. Service layer rejects before SQL when this hits 0.
--   - Cooldowns: locked_until enforces the 15-minute cooldown after the
--     3rd failed attempt or after a successful consumption.
--   - One row per challenge: each OTP send creates a NEW row; verifies
--     match the most-recent active row for (tenant, account, purpose).
--     Stale rows are kept for forensic analysis.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql      applied (FK target — tenants)
--   003_rls_helpers.sql  applied (current_tenant_id())
--   012_accounts.sql     applied (composite-FK target — accounts)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS otp_challenges (

    otp_id                  VARCHAR(26)  PRIMARY KEY,

    -- Tenant scope
    tenant_id               TEXT         NOT NULL
                                REFERENCES tenants(id),

    -- ---------------------------------------------------------------------
    -- Account binding via composite FK (mirror of sessions / forms-intake
    -- pattern). Nullable for the registration case: a brand-new patient
    -- entering a phone number for the FIRST time has no account_id yet —
    -- the OTP row is bound to the phone_e164 only, and on successful
    -- verification the service layer creates the account and consumes
    -- the OTP atomically.
    -- ---------------------------------------------------------------------

    account_id              VARCHAR(26)  NULL,

    -- ---------------------------------------------------------------------
    -- Phone number the OTP was sent to (E.164 — same format as
    -- accounts.phone_e164). Carried on every row so registration cases
    -- (account_id IS NULL) still have a binding, and so service-layer
    -- verifies can match by (tenant, phone, purpose) when the account
    -- doesn't exist yet.
    -- ---------------------------------------------------------------------

    phone_e164              TEXT         NOT NULL,

    -- ---------------------------------------------------------------------
    -- Purpose discriminator — the same OTP table backs multiple flows.
    -- Each purpose has its own service-layer rate limiter.
    -- ---------------------------------------------------------------------

    purpose                 TEXT         NOT NULL
                                CHECK (purpose IN (
                                    'registration',
                                    'login',
                                    'phone_number_change',
                                    'sensitive_action'
                                )),

    -- ---------------------------------------------------------------------
    -- 6-digit code stored as SHA-256 hex (64 chars). Plaintext sent via
    -- SMS once at issuance and never persisted. Verify path computes
    -- SHA-256 of the user-supplied code and constant-time compares with
    -- this column.
    -- ---------------------------------------------------------------------

    code_hash               VARCHAR(64)  NOT NULL,

    -- ---------------------------------------------------------------------
    -- Attempt tracking per Identity Spec §2.1 / §3.1: 3 attempts max
    -- before 15-minute cooldown lockout. Service layer decrements on
    -- failed verify; rejects further attempts when 0.
    -- ---------------------------------------------------------------------

    attempts_remaining      INT          NOT NULL DEFAULT 3
                                CHECK (attempts_remaining >= 0
                                       AND attempts_remaining <= 3),

    -- ---------------------------------------------------------------------
    -- Lifecycle
    -- ---------------------------------------------------------------------

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- expires_at = created_at + 5 minutes per Identity Spec §2.1 / §3.1.
    -- Past this, even with attempts_remaining > 0, the verify rejects.
    expires_at              TIMESTAMPTZ  NOT NULL,

    -- consumed_at NOT NULL means the OTP was successfully verified and
    -- consumed; cannot be reused. Once set, subsequent verifies for the
    -- same row reject (one-time use).
    consumed_at             TIMESTAMPTZ  NULL,

    -- locked_until enforces the 15-minute cooldown per Identity Spec
    -- §2.1: after the 3rd failed attempt OR after a successful
    -- consumption, NEW OTP issuance for the same (tenant, phone, purpose)
    -- is rejected until this timestamp passes.
    --
    -- Stored on the OTP row itself rather than a separate cooldown
    -- table because the lockout is intrinsic to the OTP lifecycle —
    -- the SAME row is the source of truth for both attempts and lockout.
    locked_until            TIMESTAMPTZ  NULL,

    -- ---------------------------------------------------------------------
    -- Composite-FK lookup key
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_otp_tenant_id
        UNIQUE (tenant_id, otp_id),

    -- ---------------------------------------------------------------------
    -- Composite FK to accounts (when account_id is non-null). The FK is
    -- defined inline because the target columns are guaranteed to be a
    -- UNIQUE pair via accounts' uq_account_tenant_id constraint.
    --
    -- A non-null account_id with mismatched tenant fails at the FK layer
    -- BEFORE RLS — same defense-in-depth as sessions.
    -- ---------------------------------------------------------------------

    CONSTRAINT fk_otp_account
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- ---------------------------------------------------------------------
    -- code_hash format: SHA-256 hex (64 lowercase hex chars)
    -- ---------------------------------------------------------------------

    CONSTRAINT otp_code_hash_format
        CHECK (code_hash ~ '^[0-9a-f]{64}$'),

    -- ---------------------------------------------------------------------
    -- E.164 format (same as accounts.phone_e164)
    -- ---------------------------------------------------------------------

    CONSTRAINT otp_phone_e164_format
        CHECK (phone_e164 ~ '^\+[1-9][0-9]{1,14}$'),

    -- ---------------------------------------------------------------------
    -- expires_at must be AFTER created_at (sanity: rows with reversed
    -- timestamps are nonsensical and would either expire on creation
    -- or never expire).
    -- ---------------------------------------------------------------------

    CONSTRAINT otp_expiry_after_creation
        CHECK (expires_at > created_at)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- Key queries the OTP service will issue:
--   - Verify lookup: WHERE tenant_id=$1 AND phone_e164=$2 AND purpose=$3
--                    AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1
--   - Cleanup expired: WHERE expires_at < NOW()
--   - Cooldown check on issuance: WHERE tenant_id=$1 AND phone_e164=$2
--                                 AND locked_until > NOW()
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_otp_tenant_phone_purpose_active
    ON otp_challenges (tenant_id, phone_e164, purpose, created_at DESC)
    WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_otp_expires
    ON otp_challenges (expires_at)
    WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_otp_locked_until
    ON otp_challenges (tenant_id, phone_e164, purpose)
    WHERE locked_until IS NOT NULL AND consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE otp_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_challenges FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON otp_challenges
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
