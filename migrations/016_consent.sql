-- =============================================================================
-- File:    migrations/016_consent.sql
-- Purpose: Create the `consent` + `consent_versions` tables — the
--          Consent & Delegated Access slice's foundational schema per
--          CDM v1.2 §3.3 entities 11-12 + Consent Slice PRD v1.0 §7.
--
-- Spec:    - Consent & Delegated Access Slice PRD v1.0 §5 (six consent
--              types: platform, care, data_use, delegation,
--              jurisdictional, episode)
--          - Slice PRD §7 (consent record structure: scope, granularity,
--              duration, evidence, versioning)
--          - Slice PRD §7.1 (immutable append-only storage; never
--              modified — superseded or revoked by a newer record)
--          - Slice PRD §10 (audit emission requirements)
--          - CDM v1.2 §3.3 entities 11 (Consent) + 12 (ConsentVersion)
--          - Master PRD v1.10 §15 (consent five-attribute model)
--          - I-022 (consent presented as clear concise agreement, not
--              wall of text — UI concern, schema is presence-tracker)
--          - I-023 / I-027 (RLS + tenant scoping)
--
-- Out-of-scope (deferred to follow-up migrations):
--   - delegation table (017) — CDM §3.3 entity 13
--   - delegation_scopes table (018) — CDM §3.3 entity 14
--   - Per-jurisdiction consent requirements (sourced from Market
--     Rollout Cockpit at runtime; not stored in this schema)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql      applied (FK target — tenants)
--   003_rls_helpers.sql  applied (current_tenant_id())
--   012_accounts.sql     applied (composite-FK target — accounts)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- TABLE 1: consent_versions
-- Versioned consent terms text per Slice PRD §5 (every consent type has
-- versioned terms). A consent_version row captures the EXACT text the
-- patient saw + accepted at consent time. Append-only: never UPDATE or
-- DELETE — superseded versions remain for audit linkage.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consent_versions (

    consent_version_id      VARCHAR(26)  PRIMARY KEY,

    -- Tenant scope (consent terms can vary per tenant; the v1.0 day-1
    -- tenants share most terms but jurisdictional consents may differ)
    tenant_id               TEXT         NOT NULL
                                REFERENCES tenants(id),

    -- Consent type — the six types from Slice PRD §5
    consent_type            TEXT         NOT NULL
                                CHECK (consent_type IN (
                                    'platform',
                                    'care',
                                    'data_use',
                                    'delegation',
                                    'jurisdictional',
                                    'episode'
                                )),

    -- Semantic version of the terms text. Format: 'vN.N' or 'vN.N.N'.
    -- Bump on substantive change (Slice PRD §7 versioning rule).
    version_label           TEXT         NOT NULL
                                CHECK (version_label ~ '^v[0-9]+\.[0-9]+(\.[0-9]+)?$'),

    -- Locale of the terms text (BCP 47). A tenant may publish the same
    -- consent_type at the same version_label in multiple locales (e.g.,
    -- 'en-US' and 'en-GH'); the (tenant_id, consent_type, version_label,
    -- locale) tuple is unique.
    locale                  TEXT         NOT NULL DEFAULT 'en-US',

    -- The actual terms text the patient saw. Stored as TEXT (markdown
    -- or plain) — UI rendering is the consumer's concern.
    terms_text              TEXT         NOT NULL,

    -- For jurisdictional consent: the regulatory reference (e.g.,
    -- 'Ghana FDA Adverse Event Reporting'). Null for non-jurisdictional
    -- consent types.
    regulatory_reference    TEXT         NULL,

    -- Effective dates: published_at marks when this version becomes
    -- the canonical version for new consents; superseded_at marks when
    -- a newer version supersedes it (set when a new version of the
    -- same consent_type at the same locale is published).
    published_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    superseded_at           TIMESTAMPTZ  NULL,

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- ---------------------------------------------------------------------
    -- Composite-FK lookup key for downstream consent rows
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_consent_version_tenant_id
        UNIQUE (tenant_id, consent_version_id),

    -- ---------------------------------------------------------------------
    -- Tenant-scoped uniqueness on (consent_type, version, locale)
    -- A tenant cannot publish the same consent_type at the same
    -- version_label and locale twice.
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_consent_version_tenant_type_label_locale
        UNIQUE (tenant_id, consent_type, version_label, locale)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_consent_versions_tenant_type_active
    ON consent_versions (tenant_id, consent_type, locale, published_at DESC)
    WHERE superseded_at IS NULL;

-- RLS
ALTER TABLE consent_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_versions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consent_versions
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Append-only enforcement: REVOKE UPDATE/DELETE from PUBLIC (mirror of
-- audit_records / forms_snapshot pattern). Application code accidentally
-- UPDATE-ing a consent_versions row is a Slice PRD §7.1 violation.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'consent_versions' AND relkind = 'r') THEN
        EXECUTE 'REVOKE UPDATE, DELETE ON consent_versions FROM PUBLIC';
    END IF;
END
$$;

-- =============================================================================
-- TABLE 2: consent
-- Per-patient consent records. Append-only: each grant / revoke creates
-- a NEW row; previous rows remain for audit linkage. The most-recent
-- row by created_at for a (tenant, account, consent_type, scope) tuple
-- is the active row.
-- =============================================================================

CREATE TABLE IF NOT EXISTS consent (

    consent_id              VARCHAR(26)  PRIMARY KEY,

    tenant_id               TEXT         NOT NULL
                                REFERENCES tenants(id),

    -- Composite FK to accounts: cross-tenant binding structurally
    -- impossible (mirror of forms-intake / sessions pattern).
    account_id              VARCHAR(26)  NOT NULL,

    -- Consent type (same enum as consent_versions)
    consent_type            TEXT         NOT NULL
                                CHECK (consent_type IN (
                                    'platform',
                                    'care',
                                    'data_use',
                                    'delegation',
                                    'jurisdictional',
                                    'episode'
                                )),

    -- ---------------------------------------------------------------------
    -- Scope discriminator — Slice PRD §5 + §7 attribute "Scope"
    --
    -- For care consent: program_id (which clinical program)
    -- For data_use consent: data category ('ai_interpretation',
    --   'pharmacy_sharing', 'anonymized_analytics', 'community_data')
    -- For delegation consent: delegate_account_id
    -- For jurisdictional consent: jurisdiction code + regulatory reference
    -- For episode consent: episode_id (deferred until Care Delivery
    --   slice lands; nullable for now)
    -- For platform consent: NULL (scope is the platform itself)
    --
    -- Stored as a generic VARCHAR to support all five forms; the
    -- service layer interprets per consent_type.
    -- ---------------------------------------------------------------------

    scope_id                VARCHAR(64)  NULL,

    -- Reference to the consent_versions row that captures the terms
    -- the patient saw + accepted at consent time. Composite FK to
    -- consent_versions (tenant_id, consent_version_id).
    consent_version_id      VARCHAR(26)  NOT NULL,

    -- ---------------------------------------------------------------------
    -- Status — 'granted' or 'revoked'. Append-only: a 'revoked' row
    -- supersedes the prior 'granted' row by created_at; the prior row
    -- is NEVER updated (Slice PRD §7.1).
    -- ---------------------------------------------------------------------

    status                  TEXT         NOT NULL
                                CHECK (status IN ('granted', 'revoked')),

    -- ---------------------------------------------------------------------
    -- Evidence — the artifact proving consent. Slice PRD §7 attribute
    -- "Evidence". JSONB so the shape can vary per consent type:
    --   - platform: { type: 'in_app', timestamp, device_id, session_id }
    --   - care: { type: 'in_app', timestamp, program_id, terms_text_version }
    --   - data_use: { type: 'in_app', timestamp, decisions: { category: bool } }
    --   - delegation: { type: 'in_app', timestamp, delegate_id,
    --                    relationship_type, scopes: [...] }
    --   - jurisdictional: { type: 'in_app', timestamp, jurisdiction,
    --                        regulatory_reference }
    --   - episode: { type: 'in_app', timestamp, episode_id, clinician_id }
    --
    -- Required: { timestamp } at minimum. Service-layer Zod validates
    -- the per-type shape.
    -- ---------------------------------------------------------------------

    evidence                JSONB        NOT NULL,

    -- For revocations: reason discriminator (Slice PRD §8).
    revocation_reason       TEXT         NULL
                                CHECK (revocation_reason IS NULL OR revocation_reason IN (
                                    'patient_initiated',
                                    'account_closed',
                                    'jurisdictional_change',
                                    'admin_revoked',
                                    'expired'
                                )),

    -- Duration: when the consent expires (NULL = perpetual until revoked
    -- per Slice PRD §7).
    expires_at              TIMESTAMPTZ  NULL,

    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- ---------------------------------------------------------------------
    -- Composite-FK lookup key
    -- ---------------------------------------------------------------------

    CONSTRAINT uq_consent_tenant_id
        UNIQUE (tenant_id, consent_id),

    -- Composite FK to accounts: tenant_id MUST match
    CONSTRAINT fk_consent_account
        FOREIGN KEY (tenant_id, account_id)
        REFERENCES accounts (tenant_id, account_id),

    -- Composite FK to consent_versions: tenant_id MUST match
    CONSTRAINT fk_consent_version
        FOREIGN KEY (tenant_id, consent_version_id)
        REFERENCES consent_versions (tenant_id, consent_version_id),

    -- ---------------------------------------------------------------------
    -- Logical consistency: revocation_reason MUST be set when status=
    -- 'revoked' and MUST be null when status='granted'. (Mirror of
    -- sessions revocation-consistency CHECK.)
    -- ---------------------------------------------------------------------

    CONSTRAINT consent_revocation_consistent
        CHECK (
            (status = 'granted' AND revocation_reason IS NULL) OR
            (status = 'revoked' AND revocation_reason IS NOT NULL)
        ),

    -- Evidence MUST contain a timestamp at minimum
    CONSTRAINT consent_evidence_has_timestamp
        CHECK (evidence ? 'timestamp')
);

-- Indexes
-- Active-consent lookup: latest row by created_at per (tenant, account,
-- consent_type, scope_id). Service-layer code does ORDER BY created_at
-- DESC LIMIT 1 to find the current state.
CREATE INDEX IF NOT EXISTS idx_consent_active_lookup
    ON consent (tenant_id, account_id, consent_type, scope_id, created_at DESC);

-- Per-account consent history (admin / patient-portal Settings view)
CREATE INDEX IF NOT EXISTS idx_consent_tenant_account_history
    ON consent (tenant_id, account_id, created_at DESC);

-- Expiration sweep
CREATE INDEX IF NOT EXISTS idx_consent_expires_at
    ON consent (expires_at)
    WHERE expires_at IS NOT NULL AND status = 'granted';

-- RLS
ALTER TABLE consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON consent
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- Append-only: REVOKE UPDATE/DELETE
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'consent' AND relkind = 'r') THEN
        EXECUTE 'REVOKE UPDATE, DELETE ON consent FROM PUBLIC';
    END IF;
END
$$;
