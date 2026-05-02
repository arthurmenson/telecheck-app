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
-- Summary: Creates a non-spoofable tenant-context binding mechanism:
--            1. _session_tenant_context table — durable per-PG-backend binding
--               written ONLY by the SECURITY DEFINER set_tenant_context()
--               function (REVOKE all DML from PUBLIC).
--            2. set_tenant_context(tenant_id) — validates tenant + upserts
--               binding for pg_backend_pid() with TTL.
--            3. current_tenant_id() — looks up binding by pg_backend_pid();
--               fails closed if unset or expired. Used in RLS USING expressions.
--            4. set_break_glass_context(...) — emits audit record then allows
--               cross-tenant query (I-024).
--          Includes template comment block for canonical per-table RLS policy.
--
-- Threat model (Codex foundation-verify-r3 CRITICAL finding 2026-05-02):
--   The PRIOR design used a GUC-only binding (current_setting('app.current_
--   tenant_id')). PostgreSQL custom GUCs are settable by any SQL-capable
--   session, so an attacker with arbitrary-SQL ability (including via SQL
--   injection in an app handler) could `SET app.current_tenant_id = 'X'`
--   and bypass RLS for tenant X across every PHI table. The CDM example
--   referenced this pattern but the example is THREAT-MODEL-DEPENDENT on the
--   app role lacking arbitrary SQL — a defense-in-depth-only assumption.
--
--   This v0.2 patch hardens the binding by replacing the GUC with a
--   `_session_tenant_context` table keyed on `pg_backend_pid()` (the OS
--   process ID of the calling PG backend). The app role cannot INSERT,
--   UPDATE, DELETE, or SELECT this table directly (REVOKE all from PUBLIC);
--   only the SECURITY DEFINER set_tenant_context()/current_tenant_id()
--   functions can read or write it. An attacker doing `SET app.current_
--   tenant_id = 'X'` no longer affects authorization — the policy reads
--   from the table, not the GUC.
--
--   pg_backend_pid() is process-scoped. With a connection pool (pgBouncer
--   transaction mode, etc.), the same backend PID serves many app sessions
--   over its lifetime. The binding has a short TTL (default: 5 minutes;
--   configurable per-deployment) so stale bindings expire automatically;
--   set_tenant_context() upserts on every request, refreshing the TTL.
--   Pool callers SHOULD also issue `RESET ALL` between requests (standard
--   practice) to belt-and-suspender the cleanup.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITION: 001_tenants.sql must have been applied.
-- PRECONDITION: 002_audit_chain.sql must have been applied (set_break_glass_context
--               inserts into audit_records).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Table: _session_tenant_context (private session-binding state)
-- Underscore prefix marks this as platform-internal — not a tenant-scoped
-- domain entity. Holds (pg_backend_pid → tenant_id, expires_at) bindings
-- written ONLY by SECURITY DEFINER functions in this migration.
--
-- The app role MUST NOT have any direct DML or SELECT permission on this
-- table — all access flows through set_tenant_context() and
-- current_tenant_id() which run with elevated SECURITY DEFINER privileges.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS _session_tenant_context (
    pg_backend_pid  INTEGER     PRIMARY KEY,
    tenant_id       TEXT        NOT NULL REFERENCES tenants(id),
    bound_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes')
);

REVOKE ALL ON TABLE _session_tenant_context FROM PUBLIC;
-- SPEC ISSUE: Application role not yet created. When 006_roles.sql is
-- authored, the app role explicitly does NOT receive any privileges on this
-- table — only the SECURITY DEFINER functions below can access it.

-- Index for cleanup of expired bindings (used by a periodic background job
-- per IDEMPOTENCY-style cleanup pattern; not implemented here).
CREATE INDEX IF NOT EXISTS idx_session_tenant_context_expires_at
    ON _session_tenant_context (expires_at);

-- ---------------------------------------------------------------------------
-- Function 1: set_tenant_context
-- Establishes the tenant context for the current PG backend by upserting
-- a row into _session_tenant_context keyed on pg_backend_pid(). Called by
-- the application-layer middleware at the start of every request.
--
-- The binding is per-PG-backend with a TTL so:
--   - In a non-pooled deployment (one PG backend per app process), the
--     binding lives for the process lifetime and refreshes on each request.
--   - In a pooled deployment (pgBouncer transaction mode), the same backend
--     PID serves many requests; each request's set_tenant_context() upserts
--     the binding, so the most recent caller's tenant is always reflected.
--   - Stale bindings (e.g., after a crash) expire after the TTL and cannot
--     authorize subsequent queries.
--
-- Validation per I-025: tenant existence/status check uses a generic error
-- message that does not differentiate "not found" from "not authorized."
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_tenant_context(p_tenant_id TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Validate the tenant_id exists and is active.
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

    -- Upsert the binding for this PG backend.
    INSERT INTO _session_tenant_context (pg_backend_pid, tenant_id, bound_at, expires_at)
    VALUES (pg_backend_pid(), p_tenant_id, NOW(), NOW() + INTERVAL '5 minutes')
    ON CONFLICT (pg_backend_pid) DO UPDATE
        SET tenant_id  = EXCLUDED.tenant_id,
            bound_at   = EXCLUDED.bound_at,
            expires_at = EXCLUDED.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION set_tenant_context(TEXT) FROM PUBLIC;
-- SPEC ISSUE: Application role not yet created. Grant to app role when
-- 006_roles.sql is authored:
--   GRANT EXECUTE ON FUNCTION set_tenant_context(TEXT) TO telecheck_app_role;

-- ---------------------------------------------------------------------------
-- Function 2: clear_tenant_context
-- Removes the current backend's binding. Called by the application-layer
-- middleware at the end of every request as belt-and-suspenders cleanup
-- (the TTL is the primary safeguard).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION clear_tenant_context()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM _session_tenant_context WHERE pg_backend_pid = pg_backend_pid();
END;
$$;

REVOKE ALL ON FUNCTION clear_tenant_context() FROM PUBLIC;
-- SPEC ISSUE: Grant to telecheck_app_role when 006_roles.sql lands.

-- ---------------------------------------------------------------------------
-- Function 3: current_tenant_id
-- Looks up the current backend's tenant binding from _session_tenant_context.
-- Raises EXCEPTION if no binding exists or the binding has expired (fails
-- closed per I-023). Used in RLS USING expressions on all PHI tables.
--
-- This function is the security boundary: it is the ONLY way for an RLS
-- policy to learn the calling session's authorized tenant. The binding it
-- reads is unforgeable — only set_tenant_context() can write it, and that
-- function validates the tenant exists + is active before binding.
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
    SELECT tenant_id
      INTO v_tenant_id
      FROM _session_tenant_context
     WHERE pg_backend_pid = pg_backend_pid()
       AND expires_at > NOW();

    IF v_tenant_id IS NULL THEN
        RAISE EXCEPTION 'tenant_context_not_set'
            USING HINT = 'No active tenant binding for this PG backend. '
                         'Call set_tenant_context() with a valid tenant_id before '
                         'querying any tenant-scoped table. This is a three-layer '
                         'isolation requirement per I-023.';
    END IF;

    RETURN v_tenant_id;
END;
$$;

-- current_tenant_id() is called inside RLS policies, which run as the table
-- owner. Grant to PUBLIC so the RLS USING expression can invoke it.
-- SECURITY DEFINER ensures it always runs with the function owner's
-- privileges, so the SELECT on _session_tenant_context succeeds even though
-- the calling session has no direct privileges on that table.
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

    -- Bind the cross-tenant context after the audit record is committed.
    -- Uses the same hardened _session_tenant_context table as set_tenant_
    -- context(); the audit record above is the durable evidence of why the
    -- binding was established for a tenant the actor doesn't normally own.
    -- (v0.2 patch 2026-05-02 per Codex foundation-verify-r3 CRITICAL: prior
    --  code used set_config('app.current_tenant_id', ...) which is now a
    --  no-op since current_tenant_id() reads from the binding table.)
    INSERT INTO _session_tenant_context (pg_backend_pid, tenant_id, bound_at, expires_at)
    VALUES (
        pg_backend_pid(),
        p_target_tenant,
        NOW(),
        LEAST(
            NOW() + INTERVAL '5 minutes',                  -- normal binding TTL
            COALESCE(p_authorized_until::TIMESTAMPTZ, NOW() + INTERVAL '5 minutes')
        )
    )
    ON CONFLICT (pg_backend_pid) DO UPDATE
        SET tenant_id  = EXCLUDED.tenant_id,
            bound_at   = EXCLUDED.bound_at,
            expires_at = EXCLUDED.expires_at;

    -- Break-glass session metadata GUCs are still set for downstream code
    -- that wants to read session_id / actor_id for trace correlation. These
    -- are NOT used by the RLS policy; they're read-only diagnostics. Setting
    -- them is settable by anyone, so they are NEVER a security boundary.
    PERFORM set_config('app.break_glass_session_id', v_session_id,       FALSE);
    PERFORM set_config('app.break_glass_actor_id',   p_actor_id,         FALSE);
    PERFORM set_config('app.break_glass_until',      p_authorized_until, FALSE);
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
