-- =============================================================================
-- 062_si010_actor_context_repair.sql
--
-- SI-010 actor-context read-back repair — three defects found by the FIRST
-- end-to-end execution of the bound actor-context path (staging E2E smoke,
-- 2026-07-07; no prior environment ever executed it: CI runs without a bind
-- pool, so handlers take the unbound branch and unit tests mock the DB).
--
--   DEFECT 1 — _current_actor_context_row() RETURN QUERY type mismatch.
--     Migration 031 declared RETURNS TABLE (... TEXT ...) but selects
--     VARCHAR(26)/VARCHAR(50) columns from _session_actor_context without
--     casts. plpgsql RETURN QUERY requires exact type identity, so ANY
--     bound-context read raised "structure of query does not match function
--     result type" — since 031, in every environment. Fixed by re-creating
--     the function with explicit ::TEXT casts (signature unchanged).
--
--   DEFECT 2 — wrapper owners lack EXECUTE on the helper functions.
--     current_actor_*() helpers are SECURITY INVOKER: inside a SECURITY
--     DEFINER wrapper the caller is the wrapper OWNER, so every owner role
--     needs EXECUTE on the outer helpers AND on the inner
--     _current_actor_context_row() (calling a SECDEF function still
--     requires EXECUTE on it). Migration 036 granted the outer helpers to
--     the crisis owner (R2 HIGH-1 closure) and 043/044/057 followed, but
--     NOBODY granted the inner function, and 049/050/058/059 granted
--     nothing at all. Fixed by granting inner + outer helpers to every
--     SECURITY DEFINER owner-class role.
--
--   DEFECT 3 — environment-conditional grants silently skipped.
--     031's grants to telecheck_app_role are wrapped in
--     IF EXISTS(telecheck_app_role) blocks. On any database where the
--     role is created after 031 applies (the staging first-deploy hit
--     exactly this), the grants are skipped forever. Re-asserted here
--     unconditionally (the role is guaranteed by the apply-migrations.sh
--     bootstrap since PR #236; GRANT is idempotent).
--
-- Verification: functional round-trip (INSERT context row → SET LOCAL
-- nonce → read back through the helpers → compare → clean up) + a
-- has_function_privilege() sweep over every owner role.
--
-- Rollback: rollback/062_rollback.sql (restores the 031 function body,
-- revokes the owner-role grants; telecheck_app_role grants retained as
-- they merely re-assert 031's declared intent).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- §1. DEFECT 1 — re-create _current_actor_context_row with ::TEXT casts.
--     Signature and security posture identical to 031 (SECURITY DEFINER,
--     locked search_path, STABLE); only the SELECT list gains casts.
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
    SELECT s.actor_account_id::TEXT,
           s.actor_account_tenant_id::TEXT,
           s.actor_role::TEXT,
           s.actor_admin_home_tenant_id::TEXT
      FROM _session_actor_context s
     WHERE s.nonce      = v_nonce
       AND s.expires_at > NOW();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'actor_context_unbound'
            USING HINT = 'No live _session_actor_context row matches the current app.request_nonce. Either authContextPlugin did not bind, context expired (>5 min), or the GUC was supplied without a corresponding table row.';
    END IF;
END;
$$;

-- CREATE OR REPLACE preserves existing ACLs; re-assert the lockdown anyway
-- (defense-in-depth; both statements are idempotent).
REVOKE ALL ON FUNCTION _current_actor_context_row() FROM PUBLIC;

-- -----------------------------------------------------------------------------
-- §2. DEFECT 3 — unconditional telecheck_app_role grants (031 re-assertion).
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION _current_actor_context_row()          TO telecheck_app_role;
GRANT EXECUTE ON FUNCTION current_actor_account_id()            TO telecheck_app_role;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()     TO telecheck_app_role;
GRANT EXECUTE ON FUNCTION current_actor_role()                  TO telecheck_app_role;
GRANT EXECUTE ON FUNCTION current_actor_admin_home_tenant_id()  TO telecheck_app_role;

-- -----------------------------------------------------------------------------
-- §3. DEFECT 2 — inner + outer helper EXECUTE for every SECURITY DEFINER
--     owner-class role that implements LAYER-C actor checks. Enumerated by
--     the repo's owner-role naming classes rather than a hardcoded list so
--     the sweep covers all five slices' owners uniformly; each grant is
--     guarded by role existence (fresh chains create all of these before
--     062, but partial environments must not error).
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_role TEXT;
BEGIN
    FOR v_role IN
        SELECT rolname FROM pg_roles
         WHERE rolname LIKE '%wrapper_owner'
            OR rolname LIKE '%writer_owner'
            OR rolname IN ('async_consult_view_owner', 'mv_refresh_owner')
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION _current_actor_context_row() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_account_id() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_role() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_admin_home_tenant_id() TO %I', v_role);
        RAISE NOTICE 'migration-062-grant: helper EXECUTE granted to %', v_role;
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- §4. Verification — functional round-trip + privilege sweep.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_nonce   UUID := gen_random_uuid();
    v_account TEXT;
    v_tenant  TEXT;
    v_missing INTEGER;
BEGIN
    -- 4a. Functional round-trip: prove the RETURN QUERY types now match by
    --     actually returning a row (the 031 defect only fired on row return).
    INSERT INTO _session_actor_context
        (nonce, actor_account_id, actor_account_tenant_id, actor_role,
         actor_admin_home_tenant_id, session_id, bound_at, expires_at)
    VALUES
        (v_nonce, '01JZZZ0000000000000VERIFY1', 'Telecheck-US', 'patient',
         NULL, '01JZZZ0000000000000VERIFY2', NOW(), NOW() + INTERVAL '60 seconds');

    PERFORM set_config('app.request_nonce', v_nonce::TEXT, true);

    v_account := current_actor_account_id();
    v_tenant  := current_actor_account_tenant_id();

    IF v_account IS DISTINCT FROM '01JZZZ0000000000000VERIFY1'
       OR v_tenant IS DISTINCT FROM 'Telecheck-US' THEN
        RAISE EXCEPTION
            'migration-062-verify: round-trip mismatch — account %, tenant %',
            v_account, v_tenant;
    END IF;

    DELETE FROM _session_actor_context WHERE nonce = v_nonce;
    RAISE NOTICE 'migration-062-verify: functional round-trip clean';

    -- 4b. Privilege sweep: every owner-class role holds EXECUTE on the
    --     inner function AND the tenant helper (the two the E2E failure
    --     path proved necessary).
    SELECT COUNT(*) INTO v_missing
      FROM pg_roles r
     WHERE (r.rolname LIKE '%wrapper_owner'
            OR r.rolname LIKE '%writer_owner'
            OR r.rolname IN ('async_consult_view_owner', 'mv_refresh_owner'))
       AND NOT (
            has_function_privilege(r.rolname, '_current_actor_context_row()', 'EXECUTE')
            AND has_function_privilege(r.rolname, 'current_actor_account_tenant_id()', 'EXECUTE')
       );
    IF v_missing > 0 THEN
        RAISE EXCEPTION
            'migration-062-verify: % owner-class role(s) still missing helper EXECUTE',
            v_missing;
    END IF;

    IF NOT (
        has_function_privilege('telecheck_app_role', '_current_actor_context_row()', 'EXECUTE')
        AND has_function_privilege('telecheck_app_role', 'current_actor_account_tenant_id()', 'EXECUTE')
    ) THEN
        RAISE EXCEPTION 'migration-062-verify: telecheck_app_role missing helper EXECUTE';
    END IF;

    RAISE NOTICE 'migration-062-verify: clean — helper grants present for all owner-class roles + telecheck_app_role';
END $$;
