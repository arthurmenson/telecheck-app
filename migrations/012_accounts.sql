-- =============================================================================
-- File:    migrations/012_accounts.sql
-- Purpose: Create the foundational `accounts` table — the Patient/Delegate
--          identity entity that replaces the unconstrained `patient_id` ULID
--          stub used throughout forms-intake. This is the FIRST migration of
--          the Identity & Auth slice scaffold.
--
-- Spec:    - CDM v1.2 §3.2 (Identity & Account — 4 entities; this is entity 7
--            "Account" per CDM)
--          - CDM v1.2 §5.1 (Same person, different tenants — uniqueness is
--            tenant-scoped, NOT global)
--          - Identity & Authentication Spec v1.0 §2 (patient registration
--            flow + identity fields + uniqueness rules)
--          - Master PRD v1.10 §17 + Glossary v5.2 C3 (consumer DBA sourced
--            from tenants.consumer_dba at render time; account row does NOT
--            store any DBA snapshot)
--          - Master PRD v1.10 §10.5 + ADR-024 (CCR runtime: country_of_care
--            decoupled from country_of_residence)
--          - ADR-023 (multi-tenancy Model A — logical isolation by tenant_id;
--            three-layer enforcement: RLS + app-layer + per-tenant KMS)
--          - I-023 (every PHI table has tenant_id; this is a PHI table)
--          - I-027 (tenant_id NOT NULL on every PHI row)
--
-- Out-of-scope for THIS migration (deferred to subsequent migrations of the
-- Identity & Auth slice):
--   - Session table (013)
--   - OTP table (014)
--   - AuthDevice table (015)
--   - Consent / Delegation tables (Consent & Access slice — separate)
--   - Composite-FK from forms_submission.patient_id → accounts.account_id
--     (separate migration 016 once Identity slice handlers are stubbed in)
--   - Column-level encryption for PII fields (handled at the AWS KMS data-key
--     layer per ADR-024; an envelope-encryption upgrade is a future migration
--     if column-level granularity is required by a regulatory finding)
--
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql        applied (FK target)
--   003_rls_helpers.sql    applied (current_tenant_id())
-- ---------------------------------------------------------------------------

-- =============================================================================
-- TABLE: accounts
-- The Patient/Delegate identity record. Tenant-scoped per CDM §5.1: the same
-- physical person registering in two tenants produces TWO account rows, each
-- bound to their own tenant_id. Phone numbers are unique PER TENANT, not
-- globally — a Telecheck-US account and a Telecheck-Ghana account may share
-- the same phone_e164 and remain distinct identities.
-- =============================================================================

CREATE TABLE IF NOT EXISTS accounts (

    -- Identity ULID. VARCHAR(26) matches the canonical PK shape used across
    -- the platform (forms_template, forms_submission, etc.).
    account_id              VARCHAR(26)  PRIMARY KEY,

    -- ---------------------------------------------------------------------
    -- Tenant scope (PHI — mandatory per I-027)
    -- ---------------------------------------------------------------------

    tenant_id               TEXT         NOT NULL
                                REFERENCES tenants(id),

    -- ---------------------------------------------------------------------
    -- Primary identifier — phone number in E.164 format
    -- Per Identity Spec §2.1: phone is the primary identifier. Stored in
    -- E.164 international format (e.g., +233XXXXXXXXX for Ghana,
    -- +1XXXXXXXXXX for US).
    -- ---------------------------------------------------------------------

    phone_e164              TEXT         NOT NULL,

    -- Optional secondary contact — patient-facing (account recovery, surveys,
    -- non-clinical comms). Email IS PHI when paired with health data.
    email                   TEXT         NULL,

    -- ---------------------------------------------------------------------
    -- Profile (PHI per HIPAA / GHS Data Protection Act)
    -- ---------------------------------------------------------------------

    first_name              TEXT         NOT NULL,
    last_name               TEXT         NOT NULL,
    date_of_birth           DATE         NOT NULL,

    -- Gender — clinical relevance for pregnancy/lactation flags + protocol
    -- eligibility per Identity Spec §2.2. Loose enum at v1.0; expand as
    -- regulatory module guidance arrives.
    gender                  TEXT         NOT NULL
                                CHECK (gender IN (
                                    'female',
                                    'male',
                                    'non_binary',
                                    'prefer_not_to_say'
                                )),

    -- National identifier (Ghana Card, SSN-equivalent, etc.) — optional
    -- per Identity Spec §2.2 line 37. Required for some programs (verified
    -- at the program-policy layer, not the schema layer).
    national_id             TEXT         NULL,

    -- ---------------------------------------------------------------------
    -- CCR fields per ADR-024 (country_of_residence ≠ country_of_care)
    -- Per Master PRD v1.10 §10.5: country_of_care drives protocol selection,
    -- formulary, payment processor, SMS provider, regulatory module.
    -- country_of_residence is the jurisdictional residency for regulatory
    -- compliance (e.g., GDPR / HIPAA applicability), independent of
    -- country_of_care.
    --
    -- Both stored as ISO 3166-1 alpha-2 codes. country_of_care is constrained
    -- to active markets at v1.0 (US, GH); country_of_residence is open to
    -- any valid 2-letter code (a US-resident who is the legal guardian of
    -- a Ghana-care patient via delegation IS a valid case).
    -- ---------------------------------------------------------------------

    country_of_residence    TEXT         NOT NULL
                                CHECK (country_of_residence ~ '^[A-Z]{2}$'),

    country_of_care         TEXT         NOT NULL
                                CHECK (country_of_care IN ('US', 'GH')),

    -- BCP 47 locale (e.g., 'en-US', 'en-GH'). Defaults to en-{country_of_care}
    -- at app-layer registration; this column captures the patient's preferred
    -- locale for UI rendering + outbound comms.
    locale                  TEXT         NOT NULL DEFAULT 'en-US',

    -- ---------------------------------------------------------------------
    -- Account classification (CDM §3.2: Patient OR Delegate)
    -- A delegate account does NOT have its own clinical record — it acts on
    -- behalf of one or more Patient accounts via the Delegation entity
    -- (Consent & Access slice, separate migration).
    -- ---------------------------------------------------------------------

    account_type            TEXT         NOT NULL DEFAULT 'patient'
                                CHECK (account_type IN (
                                    'patient',
                                    'delegate'
                                )),

    -- ---------------------------------------------------------------------
    -- Lifecycle status — registration → activation flow per Identity Spec §2
    -- Default 'pending_verification' captures the state between OTP send
    -- and OTP verify; transitions to 'active' on successful OTP + consent.
    -- ---------------------------------------------------------------------

    status                  TEXT         NOT NULL DEFAULT 'pending_verification'
                                CHECK (status IN (
                                    'pending_verification',
                                    'active',
                                    'suspended',
                                    'archived'
                                )),

    -- ---------------------------------------------------------------------
    -- Lifecycle timestamps
    -- ---------------------------------------------------------------------

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    activated_at            TIMESTAMPTZ  NULL,    -- set on status → 'active'
    suspended_at            TIMESTAMPTZ  NULL,    -- set on status → 'suspended'
    archived_at             TIMESTAMPTZ  NULL,    -- set on status → 'archived'

    -- ---------------------------------------------------------------------
    -- Soft deletion (clinical entity per CDM §2 — soft delete with
    -- deleted_at timestamp, never DELETE; audit chain references survive)
    -- ---------------------------------------------------------------------

    deleted_at              TIMESTAMPTZ  NULL,

    -- ---------------------------------------------------------------------
    -- Composite UNIQUE for downstream composite-FK pattern (mirror of
    -- the v0.2 hardening from migration 006). Downstream tables that
    -- reference accounts will use FOREIGN KEY (tenant_id, account_id)
    -- REFERENCES accounts (tenant_id, account_id) so cross-tenant binding
    -- is structurally impossible.
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_account_tenant_id
        UNIQUE (tenant_id, account_id),

    -- ---------------------------------------------------------------------
    -- Tenant-scoped phone uniqueness per CDM §5.1.
    -- The same phone number in two different tenants is TWO distinct
    -- accounts (cross-tenant patient identity does NOT federate at launch).
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_account_tenant_phone
        UNIQUE (tenant_id, phone_e164),

    -- ---------------------------------------------------------------------
    -- E.164 format check (loose: + then 1-15 digits, leading 1-9).
    -- Tighter validation (country prefix matching country_of_residence,
    -- carrier-specific numbering plans) lives at the app layer.
    -- ---------------------------------------------------------------------

    CONSTRAINT account_phone_e164_format
        CHECK (phone_e164 ~ '^\+[1-9][0-9]{1,14}$'),

    -- ---------------------------------------------------------------------
    -- Email shape (when present). Loose RFC 5322 sanity check; deliverability
    -- validation is a separate app-layer concern.
    -- ---------------------------------------------------------------------

    CONSTRAINT account_email_format_or_null
        CHECK (email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

-- ---------------------------------------------------------------------------
-- Indexes
-- Key queries the Identity slice + downstream slices will issue:
--   - Login: WHERE tenant_id=$1 AND phone_e164=$2 AND deleted_at IS NULL
--     (covered by uq_account_tenant_phone partial index below)
--   - Admin search: WHERE tenant_id=$1 AND status=$2 ORDER BY created_at DESC
--   - Patient submission ownership cross-check: composite FK lookup
-- ---------------------------------------------------------------------------

-- Tenant + status + recency for admin queues (active accounts; suspended
-- review; archived audit). Partial on deleted_at IS NULL because soft-deleted
-- rows shouldn't appear in operator queues.
CREATE INDEX IF NOT EXISTS idx_accounts_tenant_status
    ON accounts (tenant_id, status, created_at DESC)
    WHERE deleted_at IS NULL;

-- Tenant + phone for login lookups. The UNIQUE constraint already creates a
-- btree index covering this query, but the explicit partial index narrows it
-- to active rows so login lookups skip soft-deleted history.
CREATE INDEX IF NOT EXISTS idx_accounts_tenant_phone_active
    ON accounts (tenant_id, phone_e164)
    WHERE deleted_at IS NULL;

-- Tenant + account_type + recency for delegate-vs-patient breakdowns.
CREATE INDEX IF NOT EXISTS idx_accounts_tenant_type
    ON accounts (tenant_id, account_type, created_at DESC)
    WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- Mirror of the canonical pattern from migrations 003–006: ENABLE + FORCE
-- RLS so the policy applies to every role including superusers, and the
-- policy gates BOTH read (USING) and write (WITH CHECK) on tenant_id =
-- current_tenant_id().
-- ---------------------------------------------------------------------------

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON accounts
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- Mirror of the trigger pattern used by other clinical tables in the schema.
-- Keeps updated_at honest without requiring every UPDATE to set it explicitly.
-- ---------------------------------------------------------------------------

-- Use clock_timestamp() rather than NOW()/transaction_timestamp() so the
-- column advances on EVERY update, even when a transaction issues
-- INSERT then UPDATE on the same row (NOW() returns the transaction-
-- start timestamp; clock_timestamp() returns wall-clock time at call).
-- This matters for:
--   1. Test environments using savepoint-wrapped transactions where
--      INSERT and UPDATE share a transaction.
--   2. Service-layer code that mutates a freshly-inserted row inside
--      the same business transaction (e.g., status flip + audit emit).
-- The DEFAULT NOW() on the column itself is preserved so created_at ==
-- updated_at on a fresh INSERT (both fire from the same transaction
-- timestamp); the asymmetry is intentional.
CREATE OR REPLACE FUNCTION accounts_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_accounts_updated_at ON accounts;
CREATE TRIGGER trg_accounts_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW
    EXECUTE FUNCTION accounts_set_updated_at();
