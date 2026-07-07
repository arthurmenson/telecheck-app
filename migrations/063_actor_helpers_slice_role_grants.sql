-- =============================================================================
-- 063_actor_helpers_slice_role_grants.sql
--
-- Companion to 062: grant the SI-010 actor-context helper functions to the
-- SLICE APPLICATION/READER roles. 062 covered the SECURITY DEFINER
-- owner-class roles (wrappers execute as their owner), but tenant-scoped
-- VIEWS are a second consumer class: functions in a view's predicate
-- (e.g. 057's patient-view `current_actor_account_id()` filter) execute as
-- the QUERYING role — the slice application/reader role installed by the
-- handler's SET LOCAL ROLE — not as the view owner. Staging E2E smoke step 8
-- (patient GET /v1/async-consults/:id) surfaced this as a 42501 → 403.
--
-- The grant target set is derived live from pg_auth_members: exactly the
-- roles telecheck_app_role holds membership in (the SLICE_ROLES set that
-- with-db-role.ts can SET LOCAL ROLE to — 18 roles as of migration 061).
-- Pattern-derived rather than hardcoded so future slice-role bridge
-- migrations (051-pattern §2) inherit the grants by re-running this class
-- of migration or adding their own.
-- =============================================================================

DO $$
DECLARE
    v_role TEXT;
    v_count INTEGER := 0;
BEGIN
    FOR v_role IN
        SELECT r.rolname
          FROM pg_auth_members m
          JOIN pg_roles r ON r.oid = m.roleid
          JOIN pg_roles mem ON mem.oid = m.member
         WHERE mem.rolname = 'telecheck_app_role'
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION _current_actor_context_row() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_account_id() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_role() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_admin_home_tenant_id() TO %I', v_role);
        v_count := v_count + 1;
        RAISE NOTICE 'migration-063-grant: helper EXECUTE granted to slice role %', v_role;
    END LOOP;
    IF v_count = 0 THEN
        RAISE EXCEPTION 'migration-063: telecheck_app_role has no slice-role memberships — expected the 051/061 bridge grants to precede this migration';
    END IF;
    RAISE NOTICE 'migration-063: % slice roles granted', v_count;
END $$;

-- Verification: every slice role telecheck_app_role can SET LOCAL ROLE to
-- holds EXECUTE on the two helpers the view predicates + wrapper Layer C
-- checks require.
DO $$
DECLARE
    v_missing INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_missing
      FROM pg_auth_members m
      JOIN pg_roles r ON r.oid = m.roleid
      JOIN pg_roles mem ON mem.oid = m.member
     WHERE mem.rolname = 'telecheck_app_role'
       AND NOT (
            has_function_privilege(r.rolname, '_current_actor_context_row()', 'EXECUTE')
            AND has_function_privilege(r.rolname, 'current_actor_account_id()', 'EXECUTE')
       );
    IF v_missing > 0 THEN
        RAISE EXCEPTION 'migration-063-verify: % slice role(s) missing helper EXECUTE', v_missing;
    END IF;
    RAISE NOTICE 'migration-063-verify: clean — all slice roles hold helper EXECUTE';
END $$;
