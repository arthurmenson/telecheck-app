-- =============================================================================
-- File:    migrations/017_delegations.sql
-- Purpose: Create the `delegations` + `delegation_scopes` tables — CDM
--          v1.2 §3.3 entities 13 + 14 per Consent Slice PRD v1.0 §6.
--
-- Spec:    - Consent & Delegated Access Slice PRD v1.0 §6 (delegation
--              primitive: scopable per-delegate; no chaining; all
--              actions audited)
--          - Slice PRD §6.2 (9 delegate scopes)
--          - Slice PRD §6.3 (suggested defaults per relationship type)
--          - Slice PRD §6.4 (sensitive-category rules; platform-floor
--              gate forbids autonomous bypass)
--          - Slice PRD §10 (audit emission requirements)
--          - CDM v1.2 §3.3 entities 13 (Delegation) + 14 (DelegationScope)
--          - I-022 (consent UI clarity)
--          - I-023 / I-027 (RLS + tenant scoping)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   012_accounts.sql     applied (FK targets — both grantor and delegate
--                                  are accounts)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- TABLE 1: delegations
-- A delegation is a permission bridge between two accounts: the grantor
-- (the patient on whose behalf the delegate acts) and the delegate (the
-- account that gets the granted permissions). Both parties have their
-- own Telecheck accounts (Slice PRD §6.1 — delegation is a permission
-- bridge, NOT an account hierarchy).
-- =============================================================================

CREATE TABLE IF NOT EXISTS delegations (

    delegation_id           VARCHAR(26)  PRIMARY KEY,

    tenant_id               TEXT         NOT NULL
                                REFERENCES tenants(id),

    -- Grantor: the patient whose data + actions the delegate may access.
    grantor_account_id      VARCHAR(26)  NOT NULL,

    -- Delegate: the account that gets the granted scopes.
    delegate_account_id     VARCHAR(26)  NOT NULL,

    -- ---------------------------------------------------------------------
    -- Relationship type per Slice PRD §6.3
    -- Drives the suggested-defaults UI; doesn't restrict scope grants
    -- (the patient overrides defaults).
    -- ---------------------------------------------------------------------

    relationship_type       TEXT         NOT NULL
                                CHECK (relationship_type IN (
                                    'parent_of_minor',
                                    'adult_child',
                                    'spouse_partner',
                                    'professional_caregiver',
                                    'healthcare_proxy',
                                    'other'
                                )),

    -- ---------------------------------------------------------------------
    -- Status — 'pending_acceptance' | 'active' | 'revoked' | 'declined'
    -- Lifecycle:
    --   1. Patient invites delegate → row created with status='pending_acceptance'
    --   2. Delegate accepts → status='active' + accepted_at set
    --   3. OR delegate declines → status='declined' + declined_at set
    --   4. OR patient revokes → status='revoked' + revoked_at + reason set
    --   5. OR delegate steps down → status='revoked' with reason='delegate_initiated'
    -- ---------------------------------------------------------------------

    status                  TEXT         NOT NULL DEFAULT 'pending_acceptance'
                                CHECK (status IN (
                                    'pending_acceptance',
                                    'active',
                                    'revoked',
                                    'declined'
                                )),

    -- For healthcare_proxy: reference to the legal documentation
    -- (healthcare proxy form, power of attorney, court order). Stored
    -- as a document_id once the Documents slice lands; null at v1.0.
    legal_documentation_id  VARCHAR(26)  NULL,

    -- ---------------------------------------------------------------------
    -- Lifecycle timestamps
    -- ---------------------------------------------------------------------

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    accepted_at             TIMESTAMPTZ  NULL,
    declined_at             TIMESTAMPTZ  NULL,
    revoked_at              TIMESTAMPTZ  NULL,

    revoked_reason          TEXT         NULL
                                CHECK (revoked_reason IS NULL OR revoked_reason IN (
                                    'patient_initiated',
                                    'delegate_initiated',
                                    'expiration',
                                    'admin_revoked',
                                    'compromise_detected'
                                )),

    -- ---------------------------------------------------------------------
    -- Composite-FK lookup keys
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_delegation_tenant_id
        UNIQUE (tenant_id, delegation_id),

    -- Composite FK to grantor account
    CONSTRAINT fk_delegation_grantor
        FOREIGN KEY (tenant_id, grantor_account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- Composite FK to delegate account (must be in the SAME tenant as
    -- the grantor — cross-tenant delegation is not supported at v1.0)
    CONSTRAINT fk_delegation_delegate
        FOREIGN KEY (tenant_id, delegate_account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- ---------------------------------------------------------------------
    -- Slice PRD §6.1 chain-prevention: a delegate cannot delegate
    -- their delegation. Enforced at the application layer (the service
    -- rejects createDelegation when grantor is themselves a delegate).
    -- The DB layer carries this as documentation only at v1.0; a
    -- proper CHECK requires a recursive query that doesn't fit a
    -- column-level CHECK constraint.
    -- ---------------------------------------------------------------------

    -- Self-delegation prevention (a patient can't delegate to themselves)
    CONSTRAINT delegation_no_self
        CHECK (grantor_account_id != delegate_account_id),

    -- Status-timestamp consistency: when status is set, the corresponding
    -- timestamp must be set (and vice versa).
    CONSTRAINT delegation_status_timestamp_consistent
        CHECK (
            (status = 'pending_acceptance' AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL) OR
            (status = 'active' AND accepted_at IS NOT NULL AND declined_at IS NULL AND revoked_at IS NULL) OR
            (status = 'declined' AND accepted_at IS NULL AND declined_at IS NOT NULL AND revoked_at IS NULL) OR
            (status = 'revoked' AND revoked_at IS NOT NULL)
        ),

    -- Revocation reason consistency
    CONSTRAINT delegation_revocation_reason_consistent
        CHECK (
            (status = 'revoked' AND revoked_reason IS NOT NULL) OR
            (status != 'revoked' AND revoked_reason IS NULL)
        )
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_delegations_grantor_active
    ON delegations (tenant_id, grantor_account_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_delegations_delegate_active
    ON delegations (tenant_id, delegate_account_id, status, created_at DESC)
    WHERE status = 'active';

-- RLS
ALTER TABLE delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON delegations
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- =============================================================================
-- TABLE 2: delegation_scopes
-- Per-scope grants on a delegation. Each delegation has 0..N scope rows;
-- the absence of a row for a given scope means the delegate does NOT
-- have that permission (scopes are ALLOW-listed, not DENY-listed).
-- =============================================================================

CREATE TABLE IF NOT EXISTS delegation_scopes (

    delegation_scope_id     VARCHAR(26)  PRIMARY KEY,

    tenant_id               TEXT         NOT NULL
                                REFERENCES tenants(id),

    -- Composite FK to the parent delegation
    delegation_id           VARCHAR(26)  NOT NULL,

    -- ---------------------------------------------------------------------
    -- Scope per Slice PRD §6.2 (9 scopes)
    -- ---------------------------------------------------------------------

    scope                   TEXT         NOT NULL
                                CHECK (scope IN (
                                    'view_records',
                                    'request_refills',
                                    'book_consults',
                                    'attend_consults',
                                    'receive_notifications',
                                    'make_payments',
                                    'upload_documents',
                                    'give_consent_on_behalf',
                                    'view_community'
                                )),

    -- For view_records: a JSONB array of category restrictions if any.
    -- Sensitive categories (mental_health, sexual_health, etc.) per
    -- Slice PRD §6.4 require EXPLICIT inclusion here — they are
    -- excluded by default. A null/empty restrictions list grants the
    -- broadest visibility for the scope.
    visibility_restrictions JSONB        NULL,

    granted_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    revoked_at              TIMESTAMPTZ  NULL,

    -- ---------------------------------------------------------------------
    -- Composite-FK lookup key
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_delegation_scope_tenant_id
        UNIQUE (tenant_id, delegation_scope_id),

    -- Composite FK to delegations: tenant_id + delegation_id
    CONSTRAINT fk_delegation_scope_delegation
        FOREIGN KEY (tenant_id, delegation_id)
        REFERENCES delegations (tenant_id, delegation_id),

    -- A delegation can have at most ONE row per scope (re-grants happen
    -- via revoke + new INSERT, not by INSERT-on-existing).
    CONSTRAINT uq_delegation_scope_per_delegation
        UNIQUE (tenant_id, delegation_id, scope, granted_at)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_delegation_scopes_active
    ON delegation_scopes (tenant_id, delegation_id, scope)
    WHERE revoked_at IS NULL;

-- RLS
ALTER TABLE delegation_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE delegation_scopes FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON delegation_scopes
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());
