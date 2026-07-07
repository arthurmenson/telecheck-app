-- =============================================================================
-- File:    migrations/064_ai_service_actor_and_ai_prep_wiring.sql
-- Purpose: Wire the AI-service caller class for the P-038 AI-preparation
--          endpoint (POST /v1/async-consults/:consult_id/ai-preparation —
--          OpenAPI v0.4 endpoint #4, caller "AI Service (internal)").
--          Closes the migration 059 §3 documented TODO: "EXECUTE on
--          record_consult_ai_preparation_completed is OWNER-ONLY at this
--          migration; the AI-service handler PR grants EXECUTE to its slice
--          role when that role is wired." THIS is that handler PR.
--
--          Four pieces:
--            §1 Widen the SI-010 actor-role enum to admit 'ai_service' —
--               both the `_session_actor_context.actor_role` CHECK and the
--               bind_actor_context() defensive validation. 'ai_service' is
--               a RATIFIED actor-role value: State Machines v1.3 (P-038)
--               enumerates it in the consult_lifecycle_transition
--               `transition_by_actor_role` CHECK (migration 056 §4), and
--               RBAC Matrix v1.2 §3 Group B ratifies AI Service workload
--               service identities (R-3 ai_service_mode1 / R-4
--               ai_service_mode2). This migration adds no new canonical
--               entity or invariant — it admits the ratified actor class
--               into the SI-010 implementation surface so the AI-service
--               principal can bind request-scoped identity like every
--               other caller class.
--            §2 Create the `ai_service_account` slice application role —
--               name VERBATIM from P-038 §3 wrapper table ("EXECUTE granted
--               to" column for record_consult_ai_preparation_completed).
--               NOLOGIN + NOBYPASSRLS per the 055 canonical pattern.
--            §3 GRANT EXECUTE on record_consult_ai_preparation_completed
--               TO ai_service_account (the deferred 059 §3 grant).
--            §4 Bridge ai_service_account into the Option B app-role
--               acquisition foundation (051 §2 / 061 pattern: NOINHERIT
--               membership grant to telecheck_app_role) + the SI-010
--               helper EXECUTE grants (063 pattern) so wrapper Layer C
--               tenant guards can read the bound actor context.
--
-- Spec:    - CDM v1.8 → v1.9 Amendment (RATIFIED P-038 2026-05-21) §3 row 4
--            (wrapper caller role `ai_service_account`) + §7 OpenAPI v0.4
--            endpoint #4 + §4 AUDIT_EVENTS v5.11 rows 4-6 (ai_preparation_*)
--          - State Machines v1.3 consult_lifecycle: ai_processing_started /
--            ai_processing_completed transitions with actor_role
--            'ai_service' (migration 056 §4 CHECK; migration 058 raw writer)
--          - RBAC Permissions Matrix v1.2 §3 Group B (AI Service workload
--            service identities)
--          - migrations 031 (SI-010 trust anchor) + 051/061 (app-role
--            acquisition bridge) + 055 (role pattern) + 059 §3 (wrapper +
--            deferred grant TODO) + 062/063 (helper grants)
-- Preconditions: 031 + 051 + 055 + 059 + 062 + 063 applied.
-- Invariants: I-023 (wrapper Layer C tenant guard unchanged), I-025
--   (tenant-blind errors unchanged), I-035 (transitions still flow only
--   through the raw writer via the SECDEF wrapper). The 051 §3 anti-bypass
--   posture is preserved: telecheck_app_role gains privilege ONLY via
--   NOINHERIT membership + SET LOCAL ROLE, never direct grants.
-- =============================================================================

-- =============================================================================
-- §1 — Widen the SI-010 actor-role enum: + 'ai_service'
-- =============================================================================

-- §1.1 Table CHECK. The 031 constraint is the inline column CHECK
-- (auto-named `_session_actor_context_actor_role_check`). Locate it
-- defensively by definition rather than trusting the auto-name. NOTE:
-- pg_get_constraintdef renders `IN (...)` as `= ANY (ARRAY[...])`, so
-- the locator matches on the column name + excludes the
-- iff-platform_admin constraint by ITS column name.
DO $$
DECLARE
    v_conname TEXT;
BEGIN
    SELECT conname INTO v_conname
      FROM pg_constraint
     WHERE conrelid = '_session_actor_context'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%actor_role%'
       AND pg_get_constraintdef(oid) NOT LIKE '%actor_admin_home_tenant_id%';
    IF v_conname IS NULL THEN
        RAISE EXCEPTION 'migration-064-precondition-failed: could not locate '
            'the actor_role CHECK constraint on _session_actor_context '
            '(expected the migration 031 inline column CHECK).';
    END IF;
    EXECUTE format('ALTER TABLE _session_actor_context DROP CONSTRAINT %I', v_conname);
    RAISE NOTICE 'migration-064: dropped actor_role CHECK %', v_conname;
END $$;

ALTER TABLE _session_actor_context
    ADD CONSTRAINT _session_actor_context_actor_role_check
    CHECK (actor_role IN (
        'patient', 'clinician', 'tenant_admin', 'platform_admin', 'delegate',
        'ai_service'
    ));

-- §1.2 bind_actor_context() defensive validation. Full-body CREATE OR
-- REPLACE carried verbatim from migration 031 (R0/R2/R3 closures intact);
-- the ONLY change is '+ ai_service' in the role validation list.
-- CREATE OR REPLACE preserves ownership and ACLs; the 031 REVOKE/GRANT
-- posture is re-asserted below anyway (defense-in-depth).
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
            USING HINT = 'bind_actor_context must be invoked from a dedicated authContextPlugin pool whose session_user is NOT the application primary role. Configure the auth pool to log in as bind_actor_context_role directly.';
    END IF;

    -- Lazy expired-row sweep (R3 MEDIUM closure 2026-05-15): every
    -- bind cleans up rows past their expires_at. Bounded to avoid
    -- pathological large sweeps — LIMIT 100 rows per bind keeps the
    -- function fast (~microseconds) while still draining the table
    -- over many bind calls.
    DELETE FROM _session_actor_context
     WHERE nonce IN (
         SELECT nonce
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
    -- migration 064: + 'ai_service' (ratified actor class per State
    -- Machines v1.3 / P-038; see file header).
    IF p_actor_role IS NULL OR p_actor_role NOT IN (
        'patient', 'clinician', 'tenant_admin', 'platform_admin', 'delegate',
        'ai_service'
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

    -- R2 closure 2026-05-15: nonce-only PK. ON CONFLICT (nonce)
    -- targets idempotent same-nonce re-binds. Same nonce + identical
    -- identity → idempotent expires_at refresh (a retry case in
    -- pgbouncer / network blip). Same nonce + DIFFERENT identity
    -- raises after the UPDATE's WHERE rejects — silent identity
    -- overwrite is impossible.
    INSERT INTO _session_actor_context AS s
      (nonce, actor_account_id, actor_account_tenant_id,
       actor_role, actor_admin_home_tenant_id, session_id, expires_at)
    VALUES
      (p_nonce, p_actor_account_id,
       p_actor_account_tenant_id, p_actor_role, p_actor_admin_home_tenant_id,
       p_session_id, NOW() + (p_ttl_seconds * INTERVAL '1 second'))
    ON CONFLICT (nonce) DO UPDATE
      SET expires_at = EXCLUDED.expires_at,
          bound_at = NOW()
      WHERE s.actor_account_id            IS NOT DISTINCT FROM EXCLUDED.actor_account_id
        AND s.actor_account_tenant_id     IS NOT DISTINCT FROM EXCLUDED.actor_account_tenant_id
        AND s.actor_role                  IS NOT DISTINCT FROM EXCLUDED.actor_role
        AND s.actor_admin_home_tenant_id  IS NOT DISTINCT FROM EXCLUDED.actor_admin_home_tenant_id
        AND s.session_id                  IS NOT DISTINCT FROM EXCLUDED.session_id;

    -- Detect a same-nonce duplicate with DIFFERENT identity. If the
    -- post-INSERT/UPDATE state's row identity disagrees with the
    -- caller's parameters, the UPDATE's WHERE rejected the change;
    -- the row still has its prior identity. Raise to surface the
    -- programming error rather than silently accept the spoof.
    PERFORM 1
      FROM _session_actor_context s
     WHERE s.nonce                        = p_nonce
       AND s.actor_account_id             = p_actor_account_id
       AND s.actor_account_tenant_id      = p_actor_account_tenant_id
       AND s.actor_role                   = p_actor_role
       AND s.actor_admin_home_tenant_id  IS NOT DISTINCT FROM p_actor_admin_home_tenant_id
       AND s.session_id                   = p_session_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'bind_actor_context: nonce_collision_with_different_identity'
            USING HINT = 'A row with the same nonce already exists but with different actor identity. Re-binding the same nonce to a different actor is forbidden; generate a fresh UUID for each request.';
    END IF;
END;
$$;

-- Re-assert the 031 privilege posture (CREATE OR REPLACE preserves ACLs,
-- but the posture is cheap to re-state and protects against drift).
REVOKE ALL ON FUNCTION bind_actor_context(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bind_actor_context(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, INTEGER) TO bind_actor_context_role;

-- =============================================================================
-- §2 — ai_service_account slice application role (P-038 §3 verbatim name)
-- =============================================================================

DO $$
BEGIN
    IF to_regrole('ai_service_account') IS NULL THEN
        CREATE ROLE ai_service_account NOLOGIN NOBYPASSRLS;
    END IF;
END $$;

COMMENT ON ROLE ai_service_account IS
    'P-038 §3 application role: the AI-service caller class for '
    'record_consult_ai_preparation_completed() (migration 059 §3 deferred '
    'grant, closed at 064). Bound at request time via authContextPlugin '
    '(SI-010) for actors whose JWT role claim is ai_service; acquired via '
    'SET LOCAL ROLE per the 051 Option B pattern. NOLOGIN + NOBYPASSRLS '
    'per the 055 canonical pattern.';

-- =============================================================================
-- §3 — The deferred 059 §3 grant: wrapper EXECUTE
-- =============================================================================

GRANT EXECUTE ON FUNCTION record_consult_ai_preparation_completed(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TEXT, TEXT, TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, JSONB, TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT
) TO ai_service_account;

-- =============================================================================
-- §4 — App-role acquisition bridge (051 §2 / 061 pattern) + SI-010 helper
--      EXECUTE grants (063 pattern)
-- =============================================================================

DO $$
DECLARE
    v_pg_major INTEGER := current_setting('server_version_num')::INTEGER / 10000;
    v_already  BOOLEAN;
BEGIN
    IF to_regrole('telecheck_app_role') IS NULL THEN
        RAISE EXCEPTION 'migration-064-precondition-failed: telecheck_app_role '
            'does not exist; apply migration 051 before 064.';
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM pg_auth_members m
          JOIN pg_roles r   ON r.oid = m.roleid
          JOIN pg_roles mem ON mem.oid = m.member
         WHERE r.rolname = 'ai_service_account'
           AND mem.rolname = 'telecheck_app_role'
    ) INTO v_already;

    IF v_pg_major >= 16 THEN
        -- PG 16+: explicit per-membership INHERIT FALSE + SET TRUE
        -- (051 R2 HIGH-1 closure carryforward; normalizes pre-existing
        -- membership too).
        EXECUTE 'GRANT ai_service_account TO telecheck_app_role WITH INHERIT FALSE, SET TRUE';
    ELSIF NOT v_already THEN
        -- PG 15: plain GRANT; the role-level NOINHERIT on
        -- telecheck_app_role provides the no-inherit posture.
        EXECUTE 'GRANT ai_service_account TO telecheck_app_role';
    END IF;
    RAISE NOTICE 'migration-064: telecheck_app_role membership in ai_service_account granted (pre-existing: %)', v_already;
END $$;

-- SI-010 helper EXECUTE (063 pattern): the wrapper's Layer C tenant guard
-- runs as the wrapper OWNER (SECDEF), but any tenant-scoped view predicate
-- or future direct helper read under this slice role executes as the
-- QUERYING role. Grant the same 5-helper set 063 granted to every bridged
-- slice role.
GRANT EXECUTE ON FUNCTION _current_actor_context_row() TO ai_service_account;
GRANT EXECUTE ON FUNCTION current_actor_account_id() TO ai_service_account;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO ai_service_account;
GRANT EXECUTE ON FUNCTION current_actor_role() TO ai_service_account;
GRANT EXECUTE ON FUNCTION current_actor_admin_home_tenant_id() TO ai_service_account;

-- =============================================================================
-- Verification
-- =============================================================================

DO $$
DECLARE
    v_wrapper_oid OID;
BEGIN
    -- §1: widened enum accepted by the table CHECK (constraint text check —
    -- cheap static assertion; runtime accept/reject is covered by the
    -- integration suite).
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conrelid = '_session_actor_context'::regclass
           AND conname  = '_session_actor_context_actor_role_check'
           AND pg_get_constraintdef(oid) LIKE '%ai_service%'
    ) THEN
        RAISE EXCEPTION 'migration-064-verification-failed: widened actor_role CHECK missing ai_service';
    END IF;

    -- §2/§3: role exists + holds wrapper EXECUTE. OID-based privilege
    -- check — has_function_privilege's signature-text form rejects
    -- typmods (VARCHAR(26)), so resolve via pg_proc instead.
    IF to_regrole('ai_service_account') IS NULL THEN
        RAISE EXCEPTION 'migration-064-verification-failed: ai_service_account not created';
    END IF;
    SELECT oid INTO v_wrapper_oid
      FROM pg_proc
     WHERE proname = 'record_consult_ai_preparation_completed'
       AND pronamespace = 'public'::regnamespace;
    IF v_wrapper_oid IS NULL THEN
        RAISE EXCEPTION 'migration-064-verification-failed: wrapper function not found';
    END IF;
    IF NOT has_function_privilege('ai_service_account', v_wrapper_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'migration-064-verification-failed: ai_service_account lacks wrapper EXECUTE';
    END IF;

    -- §4: bridge membership + helper EXECUTE.
    IF NOT EXISTS (
        SELECT 1
          FROM pg_auth_members m
          JOIN pg_roles r   ON r.oid = m.roleid
          JOIN pg_roles mem ON mem.oid = m.member
         WHERE r.rolname = 'ai_service_account'
           AND mem.rolname = 'telecheck_app_role'
    ) THEN
        RAISE EXCEPTION 'migration-064-verification-failed: telecheck_app_role lacks ai_service_account membership';
    END IF;
    IF NOT (
        has_function_privilege('ai_service_account', '_current_actor_context_row()', 'EXECUTE')
        AND has_function_privilege('ai_service_account', 'current_actor_account_id()', 'EXECUTE')
        AND has_function_privilege('ai_service_account', 'current_actor_account_tenant_id()', 'EXECUTE')
        AND has_function_privilege('ai_service_account', 'current_actor_role()', 'EXECUTE')
        AND has_function_privilege('ai_service_account', 'current_actor_admin_home_tenant_id()', 'EXECUTE')
    ) THEN
        RAISE EXCEPTION 'migration-064-verification-failed: ai_service_account lacks SI-010 helper EXECUTE';
    END IF;

    RAISE NOTICE 'migration-064: verification passed (actor enum widened; ai_service_account wired end-to-end)';
END $$;
