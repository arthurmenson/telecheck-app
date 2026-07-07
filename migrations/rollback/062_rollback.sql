-- rollback/062_rollback.sql — reverse 062_si010_actor_context_repair.sql.
--
-- Restores the 031 function body (no casts — NOTE: this reinstates the
-- RETURN QUERY type-mismatch defect by design; rollback is fidelity to the
-- prior state, not a fix) and revokes the owner-class helper grants added
-- in 062 §3. The telecheck_app_role grants from §2 are RETAINED: they
-- re-assert migration 031's declared intent and revoking them would break
-- environments where 031's conditional grant DID fire.

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
    v_nonce := current_setting('app.request_nonce', false)::UUID;

    RETURN QUERY
    SELECT s.actor_account_id,
           s.actor_account_tenant_id,
           s.actor_role,
           s.actor_admin_home_tenant_id
      FROM _session_actor_context s
     WHERE s.nonce      = v_nonce
       AND s.expires_at > NOW();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'actor_context_unbound'
            USING HINT = 'No live _session_actor_context row matches the current app.request_nonce. Either authContextPlugin did not bind, context expired (>5 min), or the GUC was supplied without a corresponding table row.';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION _current_actor_context_row() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION _current_actor_context_row() TO telecheck_app_role;

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
        EXECUTE format('REVOKE EXECUTE ON FUNCTION _current_actor_context_row() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_account_id() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_role() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_admin_home_tenant_id() FROM %I', v_role);
    END LOOP;
    RAISE NOTICE 'rollback-062: owner-class helper grants revoked';
END $$;

-- Re-assert the 036/043/044/057 crisis+admin+view outer-helper grants that
-- §3's blanket revoke above would otherwise strip (those migrations granted
-- them independently of 062 and remain applied).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crisis_initiation_wrapper_owner') THEN
        GRANT EXECUTE ON FUNCTION current_actor_account_id() TO crisis_initiation_wrapper_owner;
        GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO crisis_initiation_wrapper_owner;
    END IF;
END $$;

DO $$
BEGIN
    RAISE NOTICE 'rollback-062-verify: function body restored to 031 shape; NOTE the 031 type-mismatch defect is reinstated by design';
END $$;
