-- =============================================================================
-- File:    migrations/rollback/044_rollback.sql
-- Purpose: Rollback migration 044_admin_backend_dashboard_wrappers.sql.
--
--          Drops read_admin_crisis_operational_health() + revokes wrapper-
--          owner's INSERT + USAGE + SI-010-helper-EXECUTE grants. The 2
--          deferred wrappers never existed at v0.1 so no rollback needed
--          for them.
--
--          Same DO-block-guarded discipline as PR 3 + PR 4 rollbacks:
--            - Resolve target signature OID via to_regprocedure first.
--            - REVOKE EXECUTE + DROP FUNCTION run only when OID IS NOT NULL.
--            - Signature-exact verify-absent via to_regprocedure IS NOT NULL.
--            - Idempotent against fresh / retry / target-absent / same-name-
--              overload states.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Crisis dashboard read wrapper + wrapper-owner grants.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_target_oid              OID := to_regprocedure(
        'public.read_admin_crisis_operational_health(text, jsonb)'
    );
    v_function_still_present  BOOLEAN;
BEGIN
    IF v_target_oid IS NOT NULL THEN
        REVOKE EXECUTE ON FUNCTION read_admin_crisis_operational_health(TEXT, JSONB)
            FROM admin_basic_operator;

        DROP FUNCTION IF EXISTS read_admin_crisis_operational_health(TEXT, JSONB);
    END IF;

    v_function_still_present := to_regprocedure(
        'public.read_admin_crisis_operational_health(text, jsonb)'
    ) IS NOT NULL;

    IF v_function_still_present THEN
        RAISE EXCEPTION
            'migration-044-rollback-crisis-wrapper-blocked: '
            'DROP FUNCTION read_admin_crisis_operational_health left the function '
            'in place. REVOKE of wrapper-owner grants ABORTED to preserve runtime '
            'executability. Investigate dependencies, then retry.';
    END IF;

    -- Safe to revoke wrapper-owner grants now (function is gone). Note: the
    -- view-level + base-table SELECT grants from migration 041 §1 are NOT
    -- revoked here — they belong to migration 041's rollback, not this one.
    --
    -- R1 MED-2 closure 2026-05-22 (Codex R1): each REVOKE is existence-gated
    -- via to_regprocedure / to_regclass / to_regrole so the rollback is
    -- idempotent against fresh / forward-applied / partially-applied /
    -- prior-migrations-already-rolled-back states. Without these gates,
    -- a REVOKE against a missing function/sequence/table/role would abort
    -- the rollback. Dynamic EXECUTE is used because static REVOKE syntax
    -- doesn't support IF EXISTS in PostgreSQL 15+.
    IF to_regrole('read_admin_crisis_operational_health_wrapper_owner') IS NOT NULL THEN
        IF to_regprocedure('public.current_actor_account_tenant_id()') IS NOT NULL THEN
            EXECUTE 'REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id() '
                 || 'FROM read_admin_crisis_operational_health_wrapper_owner';
        END IF;
        IF to_regprocedure('public.current_actor_account_id()') IS NOT NULL THEN
            EXECUTE 'REVOKE EXECUTE ON FUNCTION current_actor_account_id() '
                 || 'FROM read_admin_crisis_operational_health_wrapper_owner';
        END IF;
        IF to_regclass('public.admin_dashboard_query_execution_id_seq') IS NOT NULL THEN
            EXECUTE 'REVOKE USAGE ON SEQUENCE admin_dashboard_query_execution_id_seq '
                 || 'FROM read_admin_crisis_operational_health_wrapper_owner';
        END IF;
        IF to_regclass('public.admin_dashboard_query_execution') IS NOT NULL THEN
            EXECUTE 'REVOKE INSERT ON admin_dashboard_query_execution '
                 || 'FROM read_admin_crisis_operational_health_wrapper_owner';
        END IF;
    END IF;
END $$;

-- =============================================================================
-- Post-rollback verification: crisis wrapper EXACT signature should be absent.
-- =============================================================================
DO $$
DECLARE
    v_present  BOOLEAN := to_regprocedure(
        'public.read_admin_crisis_operational_health(text, jsonb)'
    ) IS NOT NULL;
BEGIN
    IF v_present THEN
        RAISE WARNING
            'migration-044-rollback-incomplete: '
            'read_admin_crisis_operational_health(text, jsonb) unexpectedly '
            'remains in public schema. The DO-block guard above should have '
            'aborted before reaching this verification — investigate.';
    END IF;
END $$;
