-- rollback/063_rollback.sql — revoke the slice-role helper grants from 063.
-- telecheck_app_role's own grants (031/062) are untouched.

DO $$
DECLARE
    v_role TEXT;
BEGIN
    FOR v_role IN
        SELECT r.rolname
          FROM pg_auth_members m
          JOIN pg_roles r ON r.oid = m.roleid
          JOIN pg_roles mem ON mem.oid = m.member
         WHERE mem.rolname = 'telecheck_app_role'
    LOOP
        EXECUTE format('REVOKE EXECUTE ON FUNCTION _current_actor_context_row() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_account_id() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_role() FROM %I', v_role);
        EXECUTE format('REVOKE EXECUTE ON FUNCTION current_actor_admin_home_tenant_id() FROM %I', v_role);
    END LOOP;
    RAISE NOTICE 'rollback-063: slice-role helper grants revoked';
END $$;
