-- =============================================================================
-- File:    migrations/019_adapter_configs_tenant_users.sql
-- Purpose: Complete the tenant-management config layer per CDM v1.2:
--            §4.5 AdapterConfig → adapter_configs
--            §4.6 TenantUser    → tenant_users
--          These complete the §4.1-§4.6 tenant-management entity set
--          (tenants + tenant_brands + country_profiles + ccr_configs landed in
--          previous migrations).
--
-- Spec:    - CDM v1.2 §4.5 (AdapterConfig: per-tenant integration adapter
--                            selection — pharmacy / clinician network /
--                            payment / SMS provider routing)
--          - CDM v1.2 §4.6 (TenantUser: platform-admin and tenant-admin
--                           operator accounts; distinct from patient Account)
--          - ADR-024 (per-tenant KMS encryption — adapter_config JSONB
--                     contains per-adapter API keys / account IDs that the
--                     application layer encrypts at rest under
--                     tenants.kms_key_alias)
--          - I-023 / I-027 (RLS + tenant scoping)
--          - I-024 (cross-tenant break-glass: TenantUser with tenant_id IS
--                   NULL is platform admin scope; RLS policy must permit)
--          - RBAC v1.1 (role enum values consumed by tenant_users.role)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   001_tenants.sql       applied (FK targets for both tables)
--   003_rls_helpers.sql   applied (current_tenant_id() function exists)
--   018_tenant_config.sql applied (tenant_brands precedes adapter_configs
--                                  for the foundational layer order)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- TABLE 1: adapter_configs
-- Per-tenant integration adapter selections. A tenant can have multiple
-- adapters of the same type (e.g., Truepill + Honeybee for pharmacy);
-- routing logic between active adapters is per-prescription / per-call.
--
-- The adapter_config JSONB carries adapter-specific API keys and account
-- identifiers. This column is encrypted-at-rest at the application layer
-- using the per-tenant KMS key (tenants.kms_key_alias) per ADR-024 — the
-- DB schema does NOT enforce that encryption (the app layer does); this
-- is documented as the column-level contract.
-- =============================================================================

CREATE TABLE IF NOT EXISTS adapter_configs (

    id              VARCHAR(26) PRIMARY KEY,

    tenant_id       TEXT        NOT NULL REFERENCES tenants(id),

    -- Adapter type — broad category. Constrained CHECK matches the
    -- adapter classes referenced by country_profiles.available_*_adapters
    -- and the per-slice adapter contracts (Pharmacy, Notifications, Payment).
    adapter_type    VARCHAR(50) NOT NULL
                        CHECK (adapter_type IN (
                            'clinician_network',
                            'pharmacy',
                            'payment',
                            'sms',
                            'lab',
                            'video'
                        )),

    -- Adapter name — specific implementation. Validated by the application
    -- layer against country_profiles.available_*_adapters at the time of
    -- config write; the schema allows free-form to support adapters added
    -- post-launch without schema migrations.
    adapter_name    VARCHAR(100) NOT NULL,

    -- Adapter-specific config (encrypted at rest at the application layer
    -- under tenants.kms_key_alias per ADR-024). Schema-level structure is
    -- intentionally JSONB-flexible.
    adapter_config  JSONB        NOT NULL,

    -- Status enum
    status          VARCHAR(20)  NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'inactive', 'testing')),

    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- A tenant has at most one adapter row per (type, name) tuple. Multi-
    -- adapter setups (e.g., two pharmacies) are represented by multiple
    -- distinct (adapter_name) rows for the same adapter_type.
    UNIQUE (tenant_id, adapter_type, adapter_name)
);

CREATE INDEX IF NOT EXISTS idx_adapter_configs_tenant
    ON adapter_configs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_adapter_configs_tenant_type
    ON adapter_configs (tenant_id, adapter_type);

-- updated_at trigger using clock_timestamp() (mirrors migration 018 pattern)
CREATE OR REPLACE FUNCTION adapter_configs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS adapter_configs_updated_at ON adapter_configs;
CREATE TRIGGER adapter_configs_updated_at
    BEFORE UPDATE ON adapter_configs
    FOR EACH ROW EXECUTE FUNCTION adapter_configs_set_updated_at();

-- RLS: tenant-scoped.
ALTER TABLE adapter_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE adapter_configs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON adapter_configs
    USING (tenant_id = current_tenant_id())
    WITH CHECK (tenant_id = current_tenant_id());

-- =============================================================================
-- TABLE 2: tenant_users
-- Platform-admin and tenant-admin operator accounts. DISTINCT from the
-- patient Account entity (`accounts` table from migration 012). Patient
-- auth uses OTP + JWT; operator auth uses email/password + MFA + SSO
-- (the SSO bits are deferred but the column shape supports them).
--
-- Multi-tenancy specifics:
--   - tenant_id IS NULL ⇒ platform admin (cross-tenant scope; cf. ADR-023
--     break-glass discipline + I-024)
--   - tenant_id NOT NULL ⇒ tenant-scoped operator (admin / clinical_lead /
--     billing / operator)
--
-- The RLS policy permits a row to be visible if EITHER:
--   - tenant_id IS NULL (platform admin row, visible from any tenant ctx
--     because they operate cross-tenant by design), OR
--   - tenant_id = current_tenant_id() (tenant-scoped operator)
-- =============================================================================

CREATE TABLE IF NOT EXISTS tenant_users (

    id              VARCHAR(26) PRIMARY KEY,

    -- A platform admin has tenant_id = NULL; a tenant admin has tenant_id set.
    tenant_id       TEXT        REFERENCES tenants(id),

    email           VARCHAR(255) NOT NULL,
    display_name    VARCHAR(200) NOT NULL,

    -- Auth
    password_hash   TEXT        NULL,                     -- bcrypt; null if SSO-only
    mfa_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,

    -- Encrypted at the application layer per ADR-024 if non-null
    mfa_secret_encrypted TEXT   NULL,

    -- Role per RBAC v1.1
    role            VARCHAR(50) NOT NULL
                        CHECK (role IN (
                            'platform_admin',
                            'platform_clinical_governance',
                            'platform_privacy_officer',
                            'platform_ai_safety',
                            'tenant_admin',
                            'tenant_operator',
                            'tenant_billing',
                            'tenant_clinical_lead'
                        )),

    -- Status
    status          VARCHAR(20) NOT NULL DEFAULT 'invited'
                        CHECK (status IN ('active', 'invited', 'suspended', 'deactivated')),
    invited_at      TIMESTAMPTZ NULL,
    activated_at    TIMESTAMPTZ NULL,
    last_login_at   TIMESTAMPTZ NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Email is globally unique across both platform admins and tenant
    -- operators per CDM §4.6. SSO with the same email across tenants is
    -- not supported at v1.0 — admin org would have to use distinct
    -- emails (admin+tenantA@ vs admin+tenantB@) if cross-tenant access
    -- is needed; alternatively use a single platform_admin row.
    UNIQUE (email),

    -- Logical consistency: platform_* roles have tenant_id IS NULL;
    -- tenant_* roles have tenant_id NOT NULL.
    CONSTRAINT tenant_user_role_scope_consistent
        CHECK (
            (role LIKE 'platform_%' AND tenant_id IS NULL) OR
            (role LIKE 'tenant_%'   AND tenant_id IS NOT NULL)
        ),

    -- Status-timestamp consistency (mirrors delegations §3 pattern):
    --   - status='active' requires activated_at IS NOT NULL
    --   - status='invited' allows invited_at IS NOT NULL
    CONSTRAINT tenant_user_status_timestamp_consistent
        CHECK (
            (status = 'active'   AND activated_at IS NOT NULL) OR
            (status = 'invited') OR
            (status IN ('suspended', 'deactivated'))
        )
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_role   ON tenant_users (role);
CREATE INDEX IF NOT EXISTS idx_tenant_users_email_lower
    ON tenant_users (LOWER(email));

-- updated_at trigger
CREATE OR REPLACE FUNCTION tenant_users_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = clock_timestamp();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenant_users_updated_at ON tenant_users;
CREATE TRIGGER tenant_users_updated_at
    BEFORE UPDATE ON tenant_users
    FOR EACH ROW EXECUTE FUNCTION tenant_users_set_updated_at();

-- RLS: visibility rule per the comment on the table — platform admins
-- are visible from any tenant context; tenant-scoped operators are
-- visible only from their own tenant.
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_users_visibility ON tenant_users
    USING (tenant_id IS NULL OR tenant_id = current_tenant_id())
    WITH CHECK (tenant_id IS NULL OR tenant_id = current_tenant_id());

-- =============================================================================
-- Migration 019 complete.
-- =============================================================================
