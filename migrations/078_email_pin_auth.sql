-- =============================================================================
-- File:    migrations/078_email_pin_auth.sql
-- Purpose: Add an EMAIL + 6-digit-PIN authentication path alongside the
--          ratified phone + SMS-OTP path (Identity & Authentication Spec
--          v1.0 §2/§3). Signup = email + a 6-digit PIN; login = email + PIN;
--          reset/recovery = a one-time passcode delivered to email.
--
--          Three schema changes:
--            1. accounts.phone_e164 → NULLABLE (email-only accounts have no
--               phone). Additive: the phone + OTP flow always supplies a
--               phone, so it is unaffected. Adds a per-tenant unique email
--               index + an "at least one identifier" CHECK.
--            2. account_pin_credentials (NEW) — the persistent 6-digit PIN
--               credential, stored as a scrypt hash + per-credential random
--               salt, with a failed-attempt lockout (a 6-digit PIN is a small
--               1e6 space; a slow KDF + lockout are mandatory).
--            3. email_passcodes (NEW) — one-time email codes for signup email
--               verification + PIN recovery (the email analogue of the phone
--               otp_challenges table 014; SHA-256 hashed, 3-attempt lockout).
--
-- SPEC ISSUE (§12 candidate — recorded, not a silent fork):
--   Email + PIN is NOT in CDM v1.2 nor the ratified Identity & Authentication
--   Spec v1.0 (which specifies phone + SMS OTP). This migration adds an
--   ALTERNATIVE auth path per operator (Evans) direction 2026-07-09
--   ("6-digit PIN with email to login; emailed passcode for resets"), chosen
--   as an ADDITION alongside phone+OTP (not a replacement). It must be
--   ratified into the Identity spec + CDM (new entities AccountPinCredential
--   + EmailPasscode; accounts.phone_e164 nullability). Flagged in
--   docs/SI-EMAIL-PIN-AUTH.md + the module README. The phone+OTP path is
--   untouched.
--
-- Security disciplines:
--   - PIN is hashed with scrypt (node:crypto) + a 16-byte per-credential
--     salt — NOT SHA-256. SHA-256 is acceptable for the short-lived,
--     rate-limited OTP/passcode codes, but a PERSISTENT PIN needs a slow KDF
--     so a DB leak is not trivially reversible for the 1e6 PIN space.
--   - PIN login is rate-limited: failed_attempts increments per wrong PIN;
--     locked_until enforces a cooldown after the cap. The app layer rejects
--     before hashing when locked.
--   - Email passcodes mirror the otp_challenges disciplines (SHA-256 at rest,
--     5-min TTL, 3 attempts, cooldown lockout, one-time consume).
--
-- Spec:  - migrations/012_accounts.sql (accounts; email column already exists
--          nullable with account_email_format_or_null CHECK)
--        - migrations/014_otp.sql (otp_challenges — the phone analogue this
--          mirrors for email)
--        - migrations/003_rls_helpers.sql (current_tenant_id())
--        - I-023 / I-025 / I-027 (tenant isolation + tenant-blind + audit
--          tenancy); ADR-023 (multi-tenancy Model A)
-- Preconditions: migrations 001 (tenants), 003 (rls helpers), 012 (accounts),
--   014 (otp_challenges) applied.
-- Rollback: migrations/rollback/078_rollback.sql
-- =============================================================================

-- =============================================================================
-- Section 1 — accounts: allow email-only accounts (phone nullable) + unique
--             email + at-least-one-identifier CHECK.
-- =============================================================================

-- Phone becomes optional. The existing account_phone_e164_format CHECK stays
-- valid for NULL (a NULL ~ regex evaluates to NULL, which a CHECK permits);
-- and uq_account_tenant_phone (UNIQUE tenant_id, phone_e164) allows multiple
-- NULL-phone rows per tenant (SQL treats NULLs as distinct in UNIQUE).
ALTER TABLE accounts ALTER COLUMN phone_e164 DROP NOT NULL;

-- Every account MUST carry at least one login identifier.
ALTER TABLE accounts
    ADD CONSTRAINT account_has_identifier
    CHECK (phone_e164 IS NOT NULL OR email IS NOT NULL);

-- Case-insensitive per-tenant email uniqueness (active rows only). Email is
-- the login identifier for the PIN path; normalize to lower() so
-- 'A@x.com' and 'a@x.com' are the same identity. The app layer also lowercases
-- before insert/lookup; this index is the durable floor.
CREATE UNIQUE INDEX uq_account_tenant_email
    ON accounts (tenant_id, lower(email))
    WHERE email IS NOT NULL AND deleted_at IS NULL;

-- Email login lookup: WHERE tenant_id=$1 AND lower(email)=lower($2)
--                     AND deleted_at IS NULL
CREATE INDEX idx_accounts_tenant_email_active
    ON accounts (tenant_id, lower(email))
    WHERE email IS NOT NULL AND deleted_at IS NULL;

-- =============================================================================
-- Section 2 — account_pin_credentials: the persistent 6-digit PIN.
--             One credential row per account (PK = account_id). Set at signup,
--             replaced on recovery. scrypt hash + per-credential salt.
-- =============================================================================

CREATE TABLE account_pin_credentials (
    account_id          VARCHAR(26)  PRIMARY KEY,
    tenant_id           TEXT         NOT NULL REFERENCES tenants(id),

    -- scrypt-derived key, lowercase hex. node:crypto scryptSync(pin, salt, 64)
    -- → 128 hex chars. Stored with the salt (also hex) so verify can re-derive.
    pin_hash            TEXT         NOT NULL,
    pin_salt            TEXT         NOT NULL,
    -- Algorithm tag so a future KDF upgrade can migrate credentials lazily.
    algorithm           TEXT         NOT NULL DEFAULT 'scrypt',

    -- Rate limiting: failed_attempts increments per wrong PIN; locked_until
    -- enforces the cooldown once the app-layer cap is hit. Reset to 0 on a
    -- successful login or a PIN reset.
    failed_attempts     INT          NOT NULL DEFAULT 0
                            CHECK (failed_attempts >= 0),
    locked_until        TIMESTAMPTZ  NULL,

    set_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_pin_cred_tenant_id
        UNIQUE (tenant_id, account_id),

    -- Composite FK — the PIN credential must belong to a same-tenant account.
    CONSTRAINT fk_pin_cred_account
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- scrypt hex shapes (defense-in-depth on the durable boundary).
    CONSTRAINT pin_hash_hex_format  CHECK (pin_hash ~ '^[0-9a-f]{32,256}$'),
    CONSTRAINT pin_salt_hex_format  CHECK (pin_salt ~ '^[0-9a-f]{16,64}$')
);

CREATE INDEX idx_pin_cred_tenant ON account_pin_credentials (tenant_id);

ALTER TABLE account_pin_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_pin_credentials FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON account_pin_credentials
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

CREATE OR REPLACE FUNCTION account_pin_credentials_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pin_cred_updated_at ON account_pin_credentials;
CREATE TRIGGER trg_pin_cred_updated_at
    BEFORE UPDATE ON account_pin_credentials
    FOR EACH ROW
    EXECUTE FUNCTION account_pin_credentials_set_updated_at();

-- =============================================================================
-- Section 3 — email_passcodes: one-time email codes (email analogue of the
--             phone otp_challenges table 014). Purposes: email_registration
--             (verify a new email at signup) + pin_recovery (reset the PIN).
-- =============================================================================

CREATE TABLE email_passcodes (
    passcode_id         VARCHAR(26)  PRIMARY KEY,
    tenant_id           TEXT         NOT NULL REFERENCES tenants(id),

    -- Nullable for registration: a brand-new email has no account yet. On a
    -- successful verify the service creates the account + consumes the
    -- passcode atomically. Set for pin_recovery (resolved account).
    account_id          VARCHAR(26)  NULL,

    -- The email the passcode was sent to (lowercased; same format CHECK as
    -- accounts.email). Carried on every row so registration cases
    -- (account_id NULL) still bind by (tenant, email, purpose).
    email               TEXT         NOT NULL,

    purpose             TEXT         NOT NULL
                            CHECK (purpose IN (
                                'email_registration',
                                'pin_recovery'
                            )),

    -- 6-digit code as SHA-256 hex (64 chars). Plaintext emailed once, never
    -- persisted (same discipline as otp_challenges.code_hash).
    code_hash           VARCHAR(64)  NOT NULL,

    attempts_remaining  INT          NOT NULL DEFAULT 3
                            CHECK (attempts_remaining >= 0 AND attempts_remaining <= 3),

    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ  NOT NULL,
    consumed_at         TIMESTAMPTZ  NULL,
    locked_until        TIMESTAMPTZ  NULL,

    CONSTRAINT uq_email_passcode_tenant_id
        UNIQUE (tenant_id, passcode_id),

    CONSTRAINT fk_email_passcode_account
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES accounts (tenant_id, account_id),

    CONSTRAINT email_passcode_code_hash_format
        CHECK (code_hash ~ '^[0-9a-f]{64}$'),

    CONSTRAINT email_passcode_email_format
        CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),

    CONSTRAINT email_passcode_expiry_after_creation
        CHECK (expires_at > created_at)
);

-- Verify lookup: WHERE tenant_id=$1 AND email=$2 AND purpose=$3
--                AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1
CREATE INDEX idx_email_passcode_tenant_email_purpose_active
    ON email_passcodes (tenant_id, email, purpose, created_at DESC)
    WHERE consumed_at IS NULL;

CREATE INDEX idx_email_passcode_expires
    ON email_passcodes (expires_at)
    WHERE consumed_at IS NULL;

CREATE INDEX idx_email_passcode_locked_until
    ON email_passcodes (tenant_id, email, purpose)
    WHERE locked_until IS NOT NULL AND consumed_at IS NULL;

ALTER TABLE email_passcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_passcodes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON email_passcodes
    USING     (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- =============================================================================
-- Section 4 — Verification
-- =============================================================================

DO $$
BEGIN
    -- phone nullable
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'accounts' AND column_name = 'phone_e164'
           AND is_nullable = 'NO'
    ) THEN
        RAISE EXCEPTION 'migration-078: accounts.phone_e164 is still NOT NULL';
    END IF;

    -- both new tables exist with RLS FORCED
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'account_pin_credentials'
           AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
        RAISE EXCEPTION 'migration-078: account_pin_credentials missing or RLS not FORCED';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'email_passcodes'
           AND c.relrowsecurity AND c.relforcerowsecurity
    ) THEN
        RAISE EXCEPTION 'migration-078: email_passcodes missing or RLS not FORCED';
    END IF;

    -- unique email index present
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'uq_account_tenant_email'
    ) THEN
        RAISE EXCEPTION 'migration-078: uq_account_tenant_email index missing';
    END IF;

    -- at-least-one-identifier CHECK present
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'account_has_identifier'
    ) THEN
        RAISE EXCEPTION 'migration-078: account_has_identifier CHECK missing';
    END IF;
END $$;
