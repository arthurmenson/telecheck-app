-- =============================================================================
-- File:    migrations/003_rls_helpers.sql
-- Purpose: Install SECURITY DEFINER helper functions for tenant-scoped Row-
--          Level Security. These functions are the application-layer half of
--          the three-layer tenant isolation mandate (I-023). Every subsequent
--          migration that creates a PHI-touching table will use these helpers
--          in its RLS policy expressions.
-- Spec:    - I-023 (three-layer tenant isolation: DB RLS + app filter + KMS)
--          - I-024 (cross-tenant break-glass requires audit + time-bound session)
--          - I-025 (error responses must not leak cross-tenant existence)
--          - ADR-023 (multi-tenancy Model A — logical isolation by tenant_id)
--          - CDM v1.2 §2 conventions (RLS policy per-table)
--          - Subscriptions CDM example: USING (tenant_id = current_setting('app.tenant_id')::VARCHAR)
-- Summary: Creates three SECURITY DEFINER functions:
--            1. set_tenant_context(tenant_id)  — sets app.current_tenant_id GUC
--            2. current_tenant_id()            — reads GUC; fails closed if unset
--            3. set_break_glass_context(...)   — emits audit record then allows
--                                               cross-tenant query (I-024)
--          Includes template comment block for canonical per-table RLS policy.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITION: 001_tenants.sql must have been applied.
-- PRECONDITION: 002_audit_chain.sql must have been applied (set_break_glass_context
--               inserts into audit_records).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function 1: set_tenant_context
-- Sets the session-level GUC 'app.current_tenant_id' to the given tenant_id.
-- Called by the application-layer middleware at the start of every request.
-- The GUC is session-scoped — it resets when the connection is returned to
-- the pool. Applications using connection pools MUST call this at the start
-- of every request, not just once per connection.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_tenant_context(p_tenant_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Validate the tenant_id exists before setting context.
    -- This prevents an attacker from probing with arbitrary strings.
    -- Per I-025: do NOT differentiate "tenant not found" from "not authorized".
    PERFORM 1
    FROM    tenants
    WHERE   id = p_tenant_id
      AND   status = 'active';

    IF NOT FOUND THEN
        -- Deliberately generic error — does not reveal whether the tenant
        -- exists at all (I-025 information-leak prevention).
        RAISE EXCEPTION 'tenant_context_unavailable'
            USING HINT = 'The requested tenant context could not be established.';
    END IF;

    PERFORM set_config('app.current_tenant_id', p_tenant_id, FALSE);
    -- FALSE = session-local (persists for the duration of the session / transaction).
    -- Connection pool middleware should call this on every acquired connection.
END;
$$;

REVOKE ALL ON FUNCTION set_tenant_context(TEXT) FROM PUBLIC;
-- SPEC ISSUE: Application role not yet created. Grant to app role when
-- 006_roles.sql is authored:
--   GRANT EXECUTE ON FUNCTION set_tenant_context(TEXT) TO telecheck_app_role;

-- ---------------------------------------------------------------------------
-- Function 2: current_tenant_id
-- Reads 'app.current_tenant_id' GUC. Raises EXCEPTION if not set (fails
-- closed per I-023 — no query proceeds without an established tenant context).
-- Used in RLS USING expressions on all PHI-touching tables.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
    v_tenant_id TEXT;
BEGIN
    -- current_setting raises an error if the GUC is unset (third arg = false
    -- means "do not return empty string on missing; error instead").
    -- We catch that error to produce a cleaner, policy-aligned exception.
    BEGIN
        v_tenant_id := current_setting('app.current_tenant_id', FALSE);
    EXCEPTION WHEN undefined_object OR invalid_parameter_value THEN
        RAISE EXCEPTION 'tenant_context_not_set'
            USING HINT = 'A tenant context must be established via set_tenant_context() '
                         'before any tenant-scoped query can execute. '
                         'This is a three-layer isolation requirement per I-023.';
    END;

    IF v_tenant_id IS NULL OR v_tenant_id = '' THEN
        RAISE EXCEPTION 'tenant_context_not_set'
            USING HINT = 'app.current_tenant_id GUC is empty. '
                         'Call set_tenant_context() with a valid tenant_id before querying.';
    END IF;

    RETURN v_tenant_id;
END;
$$;

-- current_tenant_id() is called inside RLS policies, which run as the table
-- owner. Grant to PUBLIC so the RLS USING expression can invoke it.
-- SECURITY DEFINER ensures it always runs with the function owner's privileges,
-- not the invoking session's — preventing privilege escalation.
GRANT EXECUTE ON FUNCTION current_tenant_id() TO PUBLIC;

-- ---------------------------------------------------------------------------
-- Function 3: set_break_glass_context
-- Establishes a cross-tenant break-glass session per I-024.
-- Emits an audit record BEFORE granting the cross-tenant GUC, ensuring that
-- the audit chain captures the access even if the subsequent query fails.
-- Validates that the actor is platform_admin (the only role permitted to
-- initiate break-glass per RBAC v1.1).
--
-- Parameters:
--   p_actor_id       - Platform Admin user ID (ULID)
--   p_target_tenant  - The tenant being accessed under break-glass
--   p_justification  - Required written justification (stored in audit payload)
--   p_authorized_until - ISO 8601 timestamp limiting the break-glass window
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_break_glass_context(
    p_actor_id          TEXT,
    p_target_tenant     TEXT,
    p_justification     TEXT,
    p_authorized_until  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_session_id    TEXT;
    v_payload       JSONB;
BEGIN
    -- Validate target tenant exists (active status).
    -- Again generic error per I-025.
    PERFORM 1
    FROM    tenants
    WHERE   id = p_target_tenant
      AND   status = 'active';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'break_glass_target_unavailable'
            USING HINT = 'The break-glass target tenant context could not be established.';
    END IF;

    -- Require non-empty justification.
    IF p_justification IS NULL OR trim(p_justification) = '' THEN
        RAISE EXCEPTION 'break_glass_justification_required'
            USING HINT = 'A written justification is mandatory for break-glass access per I-024.';
    END IF;

    -- Generate a session ID for the break-glass session.
    v_session_id := uuid_generate_v4()::TEXT;

    -- Build the break-glass audit payload.
    v_payload := jsonb_build_object(
        'break_glass_session_id',           v_session_id,
        'actor_id',                         p_actor_id,
        'target_tenant_id',                 p_target_tenant,
        'justification',                    p_justification,
        'authorized_until',                 p_authorized_until,
        'privacy_officer_review_status',    'pending',
        'initiated_at',                     NOW()::TEXT
    );

    -- EMIT AUDIT RECORD BEFORE granting cross-tenant access (I-024).
    -- The audit record is scoped to the TARGET tenant_id per I-027:
    -- "audit records created by Platform Admin actions on a specific tenant
    -- carry the target tenant's ID, not a null or platform-scope ID."
    INSERT INTO audit_records (
        tenant_id,
        category,
        audit_sensitivity_level,
        action,
        actor_type,
        actor_id,
        resource_type,
        resource_id,
        break_glass,
        payload,
        recorded_at
    ) VALUES (
        p_target_tenant,                    -- target tenant per I-027
        'B',                                -- Category B: governance action per AUDIT_EVENTS v5.2
        'standard',
        'cross_tenant_break_glass_initiated',
        'platform_admin',
        p_actor_id,
        'tenant',
        p_target_tenant,
        jsonb_build_object(
            'session_id',                   v_session_id,
            'reason',                       p_justification,
            'authorized_until',             p_authorized_until,
            'privacy_officer_review_status','pending'
        ),
        v_payload,
        NOW()
    );

    -- Set the cross-tenant GUC after the audit record is committed.
    -- The break-glass GUC includes the session_id for downstream traceability.
    PERFORM set_config('app.current_tenant_id',         p_target_tenant, FALSE);
    PERFORM set_config('app.break_glass_session_id',    v_session_id,    FALSE);
    PERFORM set_config('app.break_glass_actor_id',      p_actor_id,      FALSE);
    PERFORM set_config('app.break_glass_until',         p_authorized_until, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION set_break_glass_context(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
-- SPEC ISSUE: Application role not yet created. Grant to platform-admin role
-- when 006_roles.sql is authored:
--   GRANT EXECUTE ON FUNCTION set_break_glass_context(TEXT,TEXT,TEXT,TEXT)
--     TO telecheck_platform_admin_role;

-- ---------------------------------------------------------------------------
-- RLS POLICY TEMPLATE
-- Apply this block to every PHI-touching table when its slice migration lands.
-- The functions above (current_tenant_id()) power the USING expression.
-- ---------------------------------------------------------------------------

-- Template for tenant-scoped RLS policy (apply per-table when slice migrations land)
-- ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE <table> FORCE ROW LEVEL SECURITY;  -- enforce on table owner too
-- CREATE POLICY tenant_isolation ON <table>
--   USING (tenant_id = current_tenant_id())
--   WITH CHECK (tenant_id = current_tenant_id());
--
-- Notes:
--   - FORCE ROW LEVEL SECURITY ensures even the table owner (typically the
--     migration runner) is subject to RLS during application queries. This
--     is the "belt" that prevents maintenance-script cross-tenant leakage.
--   - tenant_id on every PHI table is NOT NULL REFERENCES tenants(id) (CDM §2).
--   - The RLS policy is the DATABASE LAYER of the three-layer enforcement (I-023).
--     The APPLICATION LAYER (middleware resolving req.tenantContext) and the
--     ENCRYPTION LAYER (per-tenant KMS keys per ADR-024) must also be in place.
--   - Never bypass RLS via SET SESSION AUTHORIZATION or SET ROLE without
--     a corresponding break-glass audit record per I-024.
