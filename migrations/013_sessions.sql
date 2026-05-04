-- =============================================================================
-- File:    migrations/013_sessions.sql
-- Purpose: Create the `sessions` table — the server-side record of active
--          authenticated sessions. Holds the refresh token hash for
--          revocation, the device binding, and the activity-tracking
--          timestamps that drive Identity Spec §3.2 multi-device + inactivity
--          rules.
--
-- Spec:    - Identity & Authentication Spec v1.0 §3.2 (session management):
--              * Access token TTL: 15 minutes
--              * Refresh token TTL: 30 days
--              * Max concurrent sessions: 3 devices per account
--              * Inactivity timeout: 10 min foreground, 5 min background
--          - Identity Spec v1.0 §3.3 (token architecture: access JWT +
--            refresh opaque token + device token)
--          - Identity Spec v1.0 §3.4 (multi-device: exceeding 3 forces
--            oldest logout)
--          - CDM v1.2 §3.2 entity 8 "Session"
--          - I-023 (every PHI-adjacent table is tenant-scoped + RLS)
--          - I-027 (tenant_id NOT NULL on every row)
--
-- Out-of-scope (deferred):
--   - OTP table (014)
--   - AuthDevice table (015) — sessions.device_id FK targets it but is
--     nullable until 015 lands; a follow-up migration will tighten the FK
--     once auth_devices exists.
--   - JWT signing keys + issuance plugin (separate runtime concern; the
--     refresh_token_hash column stores SHA-256 of the opaque refresh token
--     — the token plaintext is returned ONCE to the client at issuance and
--     never stored or logged server-side, mirroring the resume-token
--     pattern from forms-intake/internal/services/resume-token.ts).
--
-- Why store refresh-token HASH not plaintext:
--   Refresh tokens are bearer credentials. Storing them in plaintext means a
--   DB read leak yields all active sessions' refresh tokens; storing the
--   SHA-256 hash means a DB leak yields nothing useful (the hash can't be
--   used to obtain a new access token without the original opaque value).
--   This mirrors the same discipline applied to forms-intake resume tokens.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql      applied (FK target — tenants)
--   003_rls_helpers.sql  applied (current_tenant_id())
--   012_accounts.sql     applied (composite-FK target — accounts)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (

    session_id              VARCHAR(26)  PRIMARY KEY,

    -- ---------------------------------------------------------------------
    -- Tenant scope (I-023 / I-027)
    -- ---------------------------------------------------------------------

    tenant_id               TEXT         NOT NULL
                                REFERENCES tenants(id),

    -- ---------------------------------------------------------------------
    -- Account binding via composite FK (mirror of forms-intake v0.2 pattern).
    -- The composite (tenant_id, account_id) FK structurally prevents
    -- cross-tenant binding — a session row in tenant A cannot reference
    -- an account in tenant B even via SQL injection on account_id alone.
    -- ---------------------------------------------------------------------

    account_id              VARCHAR(26)  NOT NULL,

    -- ---------------------------------------------------------------------
    -- Refresh token hash. SHA-256 hex (64 chars) of the opaque refresh
    -- token value. Plaintext is returned to the client ONCE at session
    -- creation and never persisted server-side.
    -- ---------------------------------------------------------------------

    refresh_token_hash      VARCHAR(64)  NOT NULL,

    -- ---------------------------------------------------------------------
    -- Device binding (Identity Spec §3.4 multi-device).
    -- Nullable at v1.0 because the auth_devices table doesn't exist yet
    -- (migration 015). Once 015 lands, a follow-up migration will:
    --   1. Backfill device_id for existing rows (operator action)
    --   2. ALTER COLUMN device_id SET NOT NULL
    --   3. Add composite-FK to auth_devices
    -- ---------------------------------------------------------------------

    device_id               VARCHAR(26)  NULL,

    -- ---------------------------------------------------------------------
    -- Audit / forensics — IP + user-agent at session establishment.
    -- Captured for security analysis (impossible-travel detection,
    -- compromise investigation). NOT for use in authn/authz decisions
    -- (those rely on JWT + refresh_token_hash exclusively).
    -- ---------------------------------------------------------------------

    ip_address              INET         NULL,
    user_agent              TEXT         NULL,

    -- ---------------------------------------------------------------------
    -- Lifecycle timestamps
    -- ---------------------------------------------------------------------

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- last_active_at advances on every refresh-token use; drives the
    -- Identity Spec §3.2 inactivity timeout (10min foreground / 5min bg).
    last_active_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- expires_at = created_at + Identity Spec §3.2 refresh-token TTL (30
    -- days). Computed at issuance; the access-token 15-min TTL is
    -- expressed via JWT claims and is NOT stored in this row.
    expires_at              TIMESTAMPTZ  NOT NULL,

    -- ---------------------------------------------------------------------
    -- Revocation (logical delete; rows are NEVER hard-deleted so the
    -- revocation history is preserved for audit / compromise forensics).
    -- ---------------------------------------------------------------------

    revoked_at              TIMESTAMPTZ  NULL,

    -- Discriminated revocation reason for audit / debugging. NULL when
    -- revoked_at IS NULL.
    revoked_reason          TEXT         NULL
                                CHECK (revoked_reason IS NULL OR revoked_reason IN (
                                    'patient_logout',
                                    'max_devices_exceeded',
                                    'security_hold',
                                    'password_changed',
                                    'phone_number_changed',
                                    'admin_revoked',
                                    'expired',
                                    'compromise_detected'
                                )),

    -- ---------------------------------------------------------------------
    -- Composite-FK lookup key (mirror of forms-intake v0.2 hardening)
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_session_tenant_id
        UNIQUE (tenant_id, session_id),

    -- ---------------------------------------------------------------------
    -- Composite FK to accounts: a session row's tenant_id MUST match the
    -- bound account's tenant_id. Prevents cross-tenant binding even if
    -- account_id is forged.
    -- ---------------------------------------------------------------------

    CONSTRAINT fk_session_account
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- ---------------------------------------------------------------------
    -- Refresh token hash format: SHA-256 hex output is 64 chars [0-9a-f]
    -- ---------------------------------------------------------------------

    CONSTRAINT session_refresh_token_hash_format
        CHECK (refresh_token_hash ~ '^[0-9a-f]{64}$'),

    -- ---------------------------------------------------------------------
    -- Logical consistency: revoked_at and revoked_reason must agree —
    -- both NULL (active session) or both NOT NULL (revoked).
    -- ---------------------------------------------------------------------

    CONSTRAINT session_revocation_consistent
        CHECK (
            (revoked_at IS NULL AND revoked_reason IS NULL) OR
            (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)
        ),

    -- ---------------------------------------------------------------------
    -- Refresh token uniqueness — within a tenant, a refresh-token hash
    -- must be unique. Prevents accidental token-reuse via collision
    -- (cryptographically negligible at 256 bits but enforced at the DB
    -- layer for defense in depth).
    --
    -- Tenant-scoped (not global) per CDM §5.1: the same hash collision
    -- across tenants is treated as two independent records, consistent
    -- with the rest of the platform.
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_session_tenant_refresh_hash
        UNIQUE (tenant_id, refresh_token_hash)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- Key queries the Identity slice will issue:
--   - Refresh: WHERE tenant_id=$1 AND refresh_token_hash=$2 AND revoked_at IS NULL
--     (covered by uq_session_tenant_refresh_hash + WHERE filter)
--   - List active sessions per account: WHERE tenant_id=$1 AND account_id=$2 AND revoked_at IS NULL
--   - Cleanup expired: WHERE expires_at < NOW() AND revoked_at IS NULL
--   - Max-devices enforcement on issuance: COUNT WHERE tenant_id=$1 AND account_id=$2 AND revoked_at IS NULL
-- ---------------------------------------------------------------------------

-- Tenant + account + activity for active-session listings, max-devices
-- counts, and "all your sessions" admin views.
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_account_active
    ON sessions (tenant_id, account_id, last_active_at DESC)
    WHERE revoked_at IS NULL;

-- Expiration sweep for the cleanup job (eventually hourly cron).
CREATE INDEX IF NOT EXISTS idx_sessions_expires_active
    ON sessions (expires_at)
    WHERE revoked_at IS NULL;

-- Tenant + revoked_reason for security-incident analysis.
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_revoked_reason
    ON sessions (tenant_id, revoked_reason, revoked_at DESC)
    WHERE revoked_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sessions
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- last_active_at maintenance trigger
-- Mirror of the accounts updated_at pattern but bumping last_active_at.
-- Uses clock_timestamp() so the column advances on every UPDATE even
-- within the same transaction (per migration 012's HIGH-confidence fix
-- 2026-05-04 — NOW() returns transaction-start time which doesn't
-- advance for back-to-back UPDATEs in one tx).
--
-- NOTE: this trigger fires on EVERY UPDATE, not just refresh events.
-- Service-layer code that updates non-activity columns (e.g., a manual
-- admin revocation) will still bump last_active_at — which is harmless
-- for the inactivity-timeout semantics (revoked sessions are filtered
-- out before the timeout check anyway). If a finer-grained behavior is
-- needed, a follow-up can add a column-list WHEN clause to the trigger.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sessions_set_last_active_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.last_active_at := clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sessions_last_active_at ON sessions;
CREATE TRIGGER trg_sessions_last_active_at
    BEFORE UPDATE ON sessions
    FOR EACH ROW
    EXECUTE FUNCTION sessions_set_last_active_at();
