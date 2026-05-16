-- =============================================================================
-- File:    migrations/031_session_actor_context.sql
-- Purpose: Server-derived actor identity infrastructure (SI-010).
--          Creates the trust anchor that SECURITY DEFINER procedures in
--          future migrations (SI-005 record_consult_clinician_decision,
--          SI-008 record_workflow_pointer_swap, SI-009
--          record_consult_escalation_target_swap) need to verify
--          authenticated actor identity WITHOUT trusting caller-supplied
--          parameters or GUC values.
--
--          Specifically, this migration creates:
--            1. `bind_actor_context_role` — a privileged DB role used by
--               authContextPlugin to perform the per-request identity
--               bind. NOT a login role; granted only to the application
--               via `SET ROLE` from a connection started as
--               `telecheck_app_role`.
--            2. `_session_actor_context` — permanent table holding the
--               per-(backend, tx) actor identity row inserted by the
--               binding function. RLS-locked: app role has NO direct
--               access. The row IS the trust anchor for every
--               server-derived actor check.
--            3. `bind_actor_context(...)` — SECURITY DEFINER function;
--               the ONLY write path into `_session_actor_context`.
--               EXECUTE granted only to `bind_actor_context_role`.
--            4. `_current_actor_context_row()` — SECURITY DEFINER read
--               helper. Validates `(pg_backend_pid, txid, nonce, expiry)`
--               and returns the trusted identity row. Used by the
--               public-facing `current_actor_*` helpers.
--            5. `current_actor_account_id()`, `current_actor_role()`,
--               `current_actor_account_tenant_id()`,
--               `current_actor_admin_home_tenant_id()` — public helpers
--               that future SECURITY DEFINER procedures call. Each is
--               a thin wrapper around `_current_actor_context_row()`.
--            6. `assert_request_nonce_bound()` — defensive helper
--               procedures call as their FIRST validation step. Catches
--               inadvertent SET LOCAL inheritance across savepoints,
--               autonomous-tx calls without context, missing
--               authContextPlugin invocation, and stale context past
--               its 5-minute expiry.
--            7. `_session_actor_context_cleanup()` — background sweep
--               function for orphaned rows (defense-in-depth alongside
--               the application's per-request transaction lifecycle).
--
-- Spec:    - docs/SI-010-Session-Actor-Context-DB-Binding.md
--          - Identity & Authentication Spec v1.0 §3 (session lifecycle;
--            actor identity claim derivation)
--          - INVARIANTS v5.2 I-023 (tenant isolation),
--            I-024 (break-glass discipline), I-027 (audit attribution)
--          - SI-005 / SI-008 / SI-009 (each blocked on this infrastructure)
--          - migrations/029_audit_records_actor_tenant_id.sql
--            (canonical SECURITY DEFINER pattern in the codebase)
--          - migrations/rollback/031_rollback.sql
--
-- DESIGN — R5 HIGH closure 2026-05-15 (supersedes the original R2 design):
--   Original design used a TEMPORARY table with ON COMMIT DELETE ROWS.
--   Codex R4 HIGH correctly identified that a temp table is caller-
--   writable: any SQL running on the same backend can INSERT a
--   fabricated identity row, even from app code. The corrected design
--   uses a PERMANENT table with strict GRANT lockdown:
--     - REVOKE ALL on the table from PUBLIC and from telecheck_app_role
--     - REVOKE ALL on bind_actor_context() from PUBLIC
--     - GRANT EXECUTE only to bind_actor_context_role
--   The application's primary connection runs as telecheck_app_role,
--   which cannot mutate `_session_actor_context`. The authContextPlugin
--   bridges to bind_actor_context_role via SET ROLE for the binding
--   statement only, then SET ROLE back. Without the SET-ROLE bridge
--   (or a separate pool), the app cannot spoof identity even with
--   arbitrary SQL injection in non-binding paths.
--
-- HISTORY:
--   This is the first migration of the SI-010 infrastructure. The
--   authContextPlugin wiring + handler integration arrive in
--   subsequent PRs after this migration ratifies the DB-side trust
--   anchor.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Role: bind_actor_context_role (LOGIN — R2 CRITICAL closure 2026-05-15)
--
-- A privileged LOGIN role used by a DEDICATED authContextPlugin pool to
-- invoke bind_actor_context(). The role MUST be LOGIN because the R1
-- closure requires the auth pool to AUTHENTICATE as this role directly
-- — not SET ROLE into it from telecheck_app_role (which would defeat
-- the caller-isolation boundary).
--
-- Credential provisioning is OUT OF BAND of this migration. Operators
-- generate a strong credential (password rotation in Vault, AWS RDS
-- IAM auth, or certificate-based authentication) and configure the
-- authContextPlugin pool to use it. The migration does NOT set a
-- password; the role is created without one and operators must run
--
--     ALTER ROLE bind_actor_context_role PASSWORD '<vault-provisioned>';
--   OR
--     ALTER ROLE bind_actor_context_role WITH LOGIN;  (if env supports cert auth)
--
-- before the role is usable. The deploy runbook captures this as a
-- pre-cutover step. If operators forget, attempts to log in fail and
-- authContextPlugin reports a clear startup error — fail-closed.
--
-- If the role already exists (e.g., migration re-applied in dev),
-- the DO block is a no-op for CREATE. The membership guard at the
-- bottom of this section always runs.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bind_actor_context_role') THEN
        CREATE ROLE bind_actor_context_role LOGIN;
    END IF;
END;
$$;

-- R2 CRITICAL closure 2026-05-15 — membership guard:
-- Even with bind_actor_context_role as a LOGIN role, the caller-
-- isolation requirement only holds if telecheck_app_role is NOT a
-- member of bind_actor_context_role (which would let it SET ROLE in
-- and defeat the session_user gate). The migration fails fast at
-- apply time if such a membership exists, surfacing the config
-- problem before any procedure starts trusting server-derived
-- identity.
DO $$
DECLARE
    v_member_count INTEGER;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telecheck_app_role') THEN
        SELECT COUNT(*) INTO v_member_count
          FROM pg_auth_members am
          JOIN pg_roles r_member ON am.member = r_member.oid
          JOIN pg_roles r_target ON am.roleid = r_target.oid
         WHERE r_member.rolname = 'telecheck_app_role'
           AND r_target.rolname = 'bind_actor_context_role';
        IF v_member_count > 0 THEN
            RAISE EXCEPTION 'SI-010 caller-isolation violation: telecheck_app_role is a member ' ||
                            'of bind_actor_context_role. Revoke the GRANT before applying this ' ||
                            'migration. Membership enables app SQL to SET ROLE into the binder ' ||
                            'and spoof identity (defeats the SECURITY DEFINER trust boundary).';
        END IF;
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Table: _session_actor_context
--
-- The trust anchor. Per-(backend, tx) row inserted by
-- bind_actor_context() and read by _current_actor_context_row().
--
-- Schema:
--   (pg_backend_pid, txid, nonce)    composite PK — nonce is the per-
--                                     request discriminator so multiple
--                                     bindings within the same tx
--                                     (batch processor, nested service
--                                     ops) each get their own row and
--                                     readers select by their own nonce.
--                                     R1 HIGH closure 2026-05-15.
--   actor_account_id                  ULID of the authenticated account
--   actor_account_tenant_id           tenant_id of the account's home
--                                     tenant (audit attribution; F-4)
--   actor_role                        role at JWT-issue time
--                                     (patient | delegate | clinician |
--                                     tenant_admin | platform_admin)
--   actor_admin_home_tenant_id        non-null only for platform_admin
--                                     (cross-tenant attribution)
--   session_id                        session ULID
--   nonce                             per-request UUID — MUST match the
--                                     `app.request_nonce` GUC the
--                                     plugin sets before any procedure
--                                     call. Part of the PK so each
--                                     bind is row-distinct.
--   bound_at                          insertion timestamp
--   expires_at                        bound_at + 5 minutes by default;
--                                     read helpers reject rows past
--                                     this timestamp
-- -----------------------------------------------------------------------------
CREATE TABLE _session_actor_context (
    pg_backend_pid              INTEGER     NOT NULL,
    txid                        BIGINT      NOT NULL,
    nonce                       UUID        NOT NULL,
    actor_account_id            VARCHAR(26) NOT NULL,
    actor_account_tenant_id     TEXT        NOT NULL REFERENCES tenants(id),
    actor_role                  VARCHAR(50) NOT NULL CHECK (actor_role IN (
        'patient', 'clinician', 'tenant_admin', 'platform_admin', 'delegate'
    )),
    actor_admin_home_tenant_id  TEXT NULL REFERENCES tenants(id),
    session_id                  VARCHAR(26) NOT NULL,
    bound_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at                  TIMESTAMPTZ NOT NULL,

    -- R1 HIGH closure 2026-05-15: nonce is part of the PK so transaction-
    -- pool / batching patterns with multiple logical requests per tx
    -- don't have one bind overwrite another. Each request's read
    -- selects by its own nonce; cross-request identity confusion
    -- impossible.
    PRIMARY KEY (pg_backend_pid, txid, nonce),

    -- Platform-admin rows MUST carry an admin_home_tenant_id; non-admin
    -- rows MUST NOT (F-4 audit attribution semantics — clarifies in the
    -- table itself that the column is only meaningful for platform_admin).
    CONSTRAINT _session_actor_context_admin_home_iff_platform_admin
        CHECK (
            (actor_role = 'platform_admin' AND actor_admin_home_tenant_id IS NOT NULL)
            OR
            (actor_role <> 'platform_admin' AND actor_admin_home_tenant_id IS NULL)
        )
);

-- Index for the cleanup sweep (DELETE WHERE expires_at < NOW()).
CREATE INDEX _session_actor_context_expires_at_idx ON _session_actor_context (expires_at);

-- -----------------------------------------------------------------------------
-- Lock down: app role has NO direct access. All writes go through
-- bind_actor_context(); all reads go through _current_actor_context_row()
-- which runs SECURITY DEFINER and therefore bypasses these REVOKES.
-- -----------------------------------------------------------------------------
REVOKE ALL ON TABLE _session_actor_context FROM PUBLIC;
-- The conditional REVOKE handles environments where telecheck_app_role
-- doesn't exist yet (some local dev setups). The role MUST exist in
-- production; the conditional is just for migration-time robustness.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telecheck_app_role') THEN
        REVOKE ALL ON TABLE _session_actor_context FROM telecheck_app_role;
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Function: bind_actor_context
--
-- The ONLY sanctioned write path into `_session_actor_context`. Called
-- by authContextPlugin's onRequest hook after JWT verification.
--
-- SECURITY DEFINER: runs as the function owner (migration role), which
-- has INSERT privilege. EXECUTE on the function itself is GRANTed only
-- to bind_actor_context_role.
--
-- R0 CRITICAL closure 2026-05-15 — caller-isolation requirement:
--   The application's primary DB role (telecheck_app_role) MUST NOT
--   be a member of bind_actor_context_role and MUST NOT have any
--   SET ROLE path into it. If telecheck_app_role can SET ROLE
--   into bind_actor_context_role, arbitrary app SQL can spoof
--   identity. The required deployment topology is therefore:
--     - bind_actor_context_role is a LOGIN role with its own
--       password / certificate, used by a DEDICATED CONNECTION POOL
--       in authContextPlugin (NOT the same pool as the main app).
--     - The main app pool logs in as telecheck_app_role; it cannot
--       SET ROLE bind_actor_context_role because the GRANT is absent.
--     - authContextPlugin uses the dedicated pool only for the
--       binding statement; all other request work runs on the main
--       pool as telecheck_app_role.
--   Defense-in-depth: bind_actor_context() ALSO checks session_user
--   at entry. If session_user IS telecheck_app_role, the function
--   raises before doing any work — this catches the case where a
--   future configuration mistake GRANTs membership.
--
-- UPSERT semantics: nonce is part of the PK so a same-tx duplicate
-- with the same nonce is idempotent (same nonce + identical identity
-- updates only the expires_at). Different nonce in the same tx
-- creates a new row, supporting batch processors / nested service
-- operations. Same nonce + DIFFERENT identity raises — preventing
-- silent identity-overwrite within a single nonce value.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bind_actor_context(
    p_actor_account_id            TEXT,
    p_actor_account_tenant_id     TEXT,
    p_actor_role                  TEXT,
    p_actor_admin_home_tenant_id  TEXT,
    p_session_id                  TEXT,
    p_nonce                       UUID,
    p_ttl_seconds                 INTEGER DEFAULT 300
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    -- R0 CRITICAL closure 2026-05-15: session-user gate.
    -- session_user is the original login role; SECURITY DEFINER does
    -- NOT mask it. If the caller logged in as telecheck_app_role,
    -- raise before doing any work. This catches the case where a
    -- future config mistake GRANTs telecheck_app_role membership in
    -- bind_actor_context_role; the function refuses to mint identity
    -- when called from a role that shouldn't have the privilege.
    IF session_user = 'telecheck_app_role' THEN
        RAISE EXCEPTION 'bind_actor_context: forbidden session_user %', session_user
            USING HINT = 'bind_actor_context must be invoked from a dedicated ' ||
                         'authContextPlugin pool whose session_user is NOT the ' ||
                         'application primary role. Configure the auth pool to ' ||
                         'log in as bind_actor_context_role directly.';
    END IF;

    -- Lazy expired-row sweep (R3 MEDIUM closure 2026-05-15): every
    -- bind cleans up rows past their expires_at. Cleans both the
    -- caller's backend (most common case: prior request's row from
    -- the SAME backend that wasn't deleted at tx-end) and any other
    -- expired rows. Bounded to avoid pathological large sweeps —
    -- LIMIT 100 rows per bind keeps the function fast (~microseconds)
    -- while still draining the table over many bind calls.
    DELETE FROM _session_actor_context
     WHERE (pg_backend_pid, txid, nonce) IN (
         SELECT pg_backend_pid, txid, nonce
           FROM _session_actor_context
          WHERE expires_at < NOW()
          LIMIT 100
     );

    -- Defensive parameter checks: each is a fail-closed assertion.
    -- These do not constitute trust validation (the caller could pass
    -- arbitrary values); they catch programming errors before they
    -- corrupt the table with malformed rows that would defeat downstream
    -- procedure invariants.
    IF p_actor_account_id IS NULL OR p_actor_account_id = '' THEN
        RAISE EXCEPTION 'bind_actor_context: actor_account_id required';
    END IF;
    IF p_actor_account_tenant_id IS NULL OR p_actor_account_tenant_id = '' THEN
        RAISE EXCEPTION 'bind_actor_context: actor_account_tenant_id required';
    END IF;
    IF p_actor_role IS NULL OR p_actor_role NOT IN (
        'patient', 'clinician', 'tenant_admin', 'platform_admin', 'delegate'
    ) THEN
        RAISE EXCEPTION 'bind_actor_context: invalid actor_role %', p_actor_role;
    END IF;
    -- Normalize: empty string → NULL for the admin_home_tenant_id column
    -- so the CHECK constraint's iff-platform_admin invariant is enforced
    -- consistently regardless of caller wire-format conventions.
    IF p_actor_admin_home_tenant_id = '' THEN
        p_actor_admin_home_tenant_id := NULL;
    END IF;
    IF p_session_id IS NULL OR p_session_id = '' THEN
        RAISE EXCEPTION 'bind_actor_context: session_id required';
    END IF;
    IF p_nonce IS NULL THEN
        RAISE EXCEPTION 'bind_actor_context: nonce required';
    END IF;
    IF p_ttl_seconds IS NULL OR p_ttl_seconds <= 0 THEN
        RAISE EXCEPTION 'bind_actor_context: ttl_seconds must be positive';
    END IF;

    -- R1 HIGH closure 2026-05-15: PK includes nonce. ON CONFLICT
    -- (pg_backend_pid, txid, nonce) targets idempotent same-nonce
    -- re-binds. The UPDATE clause's WHERE guards against same-nonce-
    -- with-different-identity (which would be a programming error
    -- worth surfacing, not silently overwriting). Same nonce +
    -- identical identity → idempotent expires_at refresh.
    INSERT INTO _session_actor_context AS s
      (pg_backend_pid, txid, nonce, actor_account_id, actor_account_tenant_id,
       actor_role, actor_admin_home_tenant_id, session_id, expires_at)
    VALUES
      (pg_backend_pid(), txid_current(), p_nonce, p_actor_account_id,
       p_actor_account_tenant_id, p_actor_role, p_actor_admin_home_tenant_id,
       p_session_id, NOW() + (p_ttl_seconds || ' seconds')::INTERVAL)
    ON CONFLICT (pg_backend_pid, txid, nonce) DO UPDATE
      SET expires_at = EXCLUDED.expires_at,
          bound_at = NOW()
      WHERE s.actor_account_id            IS NOT DISTINCT FROM EXCLUDED.actor_account_id
        AND s.actor_account_tenant_id     IS NOT DISTINCT FROM EXCLUDED.actor_account_tenant_id
        AND s.actor_role                  IS NOT DISTINCT FROM EXCLUDED.actor_role
        AND s.actor_admin_home_tenant_id  IS NOT DISTINCT FROM EXCLUDED.actor_admin_home_tenant_id
        AND s.session_id                  IS NOT DISTINCT FROM EXCLUDED.session_id;

    -- Detect a same-nonce duplicate with DIFFERENT identity by counting
    -- whether the UPSERT actually wrote a row. If the SELECT below
    -- finds the (pid, txid, nonce) row but its identity disagrees with
    -- the parameters, the UPDATE's WHERE rejected the change — raise
    -- to surface the programming error.
    PERFORM 1
      FROM _session_actor_context s
     WHERE s.pg_backend_pid = pg_backend_pid()
       AND s.txid           = txid_current()
       AND s.nonce          = p_nonce
       AND s.actor_account_id            = p_actor_account_id
       AND s.actor_account_tenant_id     = p_actor_account_tenant_id
       AND s.actor_role                  = p_actor_role
       AND s.actor_admin_home_tenant_id IS NOT DISTINCT FROM p_actor_admin_home_tenant_id
       AND s.session_id                  = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'bind_actor_context: nonce_collision_with_different_identity'
            USING HINT = 'A row with the same (pg_backend_pid, txid, nonce) already ' ||
                         'exists but with different actor identity. Re-binding the same ' ||
                         'nonce to a different actor is forbidden; generate a fresh nonce.';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION bind_actor_context(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bind_actor_context(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, INTEGER) TO bind_actor_context_role;

-- -----------------------------------------------------------------------------
-- Function: _current_actor_context_row
--
-- Internal read helper. Returns the trusted identity row for the current
-- (backend, tx, nonce) tuple, or raises 'actor_context_unbound' if no
-- live row matches. SECURITY DEFINER so it bypasses the table's REVOKE
-- of SELECT from telecheck_app_role.
--
-- Trust model: an attacker who controls app SQL can set `app.request_nonce`
-- to an arbitrary UUID, but they cannot INSERT a corresponding row into
-- `_session_actor_context` because they lack EXECUTE on
-- bind_actor_context. The (pg_backend_pid, txid, nonce, expires_at)
-- predicate ensures only the genuine authContextPlugin-inserted row is
-- returned.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _current_actor_context_row()
RETURNS TABLE (
    account_id              TEXT,
    account_tenant_id       TEXT,
    actor_role              TEXT,
    admin_home_tenant_id    TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_nonce UUID;
BEGIN
    -- current_setting(name, missing_ok=false) raises if the GUC is unset.
    -- This is the desired behavior: no nonce → no context.
    v_nonce := current_setting('app.request_nonce', false)::UUID;

    RETURN QUERY
    SELECT s.actor_account_id,
           s.actor_account_tenant_id,
           s.actor_role,
           s.actor_admin_home_tenant_id
      FROM _session_actor_context s
     WHERE s.pg_backend_pid = pg_backend_pid()
       AND s.txid           = txid_current()
       AND s.nonce          = v_nonce
       AND s.expires_at     > NOW();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'actor_context_unbound'
            USING HINT = 'No live _session_actor_context row matches current (pg_backend_pid, txid, nonce). ' ||
                         'Either authContextPlugin did not bind, context expired (>5 min), or the ' ||
                         'app.request_nonce GUC was supplied without a corresponding table row.';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION _current_actor_context_row() FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telecheck_app_role') THEN
        GRANT EXECUTE ON FUNCTION _current_actor_context_row() TO telecheck_app_role;
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Public helpers — thin wrappers around _current_actor_context_row().
-- Procedures call these to obtain server-derived identity.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION current_actor_account_id() RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT account_id FROM _current_actor_context_row();
$$;

CREATE OR REPLACE FUNCTION current_actor_account_tenant_id() RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT account_tenant_id FROM _current_actor_context_row();
$$;

CREATE OR REPLACE FUNCTION current_actor_role() RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT actor_role FROM _current_actor_context_row();
$$;

CREATE OR REPLACE FUNCTION current_actor_admin_home_tenant_id() RETURNS TEXT
LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
    SELECT admin_home_tenant_id FROM _current_actor_context_row();
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telecheck_app_role') THEN
        GRANT EXECUTE ON FUNCTION current_actor_account_id() TO telecheck_app_role;
        GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO telecheck_app_role;
        GRANT EXECUTE ON FUNCTION current_actor_role() TO telecheck_app_role;
        GRANT EXECUTE ON FUNCTION current_actor_admin_home_tenant_id() TO telecheck_app_role;
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Function: assert_request_nonce_bound
--
-- Defensive helper procedures call as their FIRST validation step.
-- Returns TRUE if a live context row exists for the current
-- (pg_backend_pid, txid, app.request_nonce) tuple; RAISES otherwise.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_request_nonce_bound() RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_nonce UUID;
BEGIN
    v_nonce := current_setting('app.request_nonce', false)::UUID;
    PERFORM 1 FROM _session_actor_context
     WHERE pg_backend_pid = pg_backend_pid()
       AND txid           = txid_current()
       AND nonce          = v_nonce
       AND expires_at     > NOW();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'request_nonce_unbound_or_expired'
            USING HINT = 'No live _session_actor_context row matches current ' ||
                         '(pg_backend_pid, txid, nonce). Context not bound, expired, or ' ||
                         'inherited from another tx/savepoint.';
    END IF;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION assert_request_nonce_bound() FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'telecheck_app_role') THEN
        GRANT EXECUTE ON FUNCTION assert_request_nonce_bound() TO telecheck_app_role;
    END IF;
END;
$$;

-- -----------------------------------------------------------------------------
-- Function: _session_actor_context_cleanup
--
-- Background sweep removing expired rows. Defense-in-depth alongside
-- the application's per-request transaction lifecycle (which deletes
-- rows at COMMIT/ROLLBACK via an AFTER trigger in a follow-up
-- migration). Operators schedule this via pg_cron or an equivalent
-- mechanism (e.g., every 5 minutes).
--
-- Returns the number of rows deleted, for observability.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _session_actor_context_cleanup() RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM _session_actor_context WHERE expires_at < NOW();
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION _session_actor_context_cleanup() FROM PUBLIC;
-- Cleanup function is for operators/cron, not the app role. Operators
-- run it via a direct privileged connection.

-- =============================================================================
-- Migration complete. SI-010 DB-side infrastructure is now in place;
-- subsequent PRs wire authContextPlugin to invoke bind_actor_context()
-- on every authenticated request, and SI-005/008/009 procedures begin
-- using current_actor_*() helpers as their authoritative identity source.
-- =============================================================================
