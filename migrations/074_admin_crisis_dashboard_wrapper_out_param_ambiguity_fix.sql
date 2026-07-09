-- =============================================================================
-- File:    migrations/074_admin_crisis_dashboard_wrapper_out_param_ambiguity_fix.sql
-- Purpose: Fix a latent PL/pgSQL 42702 (ambiguous_column) runtime defect in
--          `read_admin_crisis_operational_health()` that makes EVERY live
--          dashboard read fail with an unmapped error as soon as it reaches
--          the view-capture CTAS.
--
--          This is the SECOND instance of the defect class fixed for the
--          crisis sweep wrapper in migration 071, found by the Phase-D
--          corpus-wide sweep that 071's closure notes prescribed ("the
--          42702 class is likely not crisis-unique"). Sweep scope + result:
--          all 6 RETURNS TABLE functions in the chain were audited at their
--          latest-installed bodies —
--
--            - execute_crisis_no_acknowledgement_sweep (071)  FIXED by 071
--            - _current_actor_context_row (062)               clean (s. alias)
--            - get_interaction_signal_current_state (048)     clean (mv. alias;
--              LANGUAGE sql)
--            - read_admin_consult_queue_health (065)          clean (v. alias)
--            - read_admin_mode1_volume_health (069)           clean (v. alias)
--            - read_admin_crisis_operational_health (044)     ** THIS DEFECT **
--
--          (Numbering note: the Phase-D sweep also produced a SEPARATE,
--          non-42702 finding — the migration 069 admin_mode1_volume_health_v
--          crisis-observability blind spot — which landed independently as
--          migration 073 / PR #265. That was a VIEW anchor fix, not a
--          RETURNS TABLE OUT-param collision; it is unrelated to this
--          wrapper. This migration takes slot 074, the next free number
--          above the merged 073 — 072 was never used. read_admin_mode1_
--          volume_health's wrapper body (069 §2) remains clean per the
--          table above; 073 only replaced the underlying view.)
--
--          Root cause: the migration 044 §1 body captures the view with
--
--            CREATE TEMP TABLE _admin_crisis_query_result ON COMMIT DROP AS
--                SELECT * FROM admin_crisis_operational_health_v
--                 WHERE tenant_id = p_tenant_id;
--
--          `tenant_id` is UNQUALIFIED and names BOTH a view column AND the
--          function's first RETURNS TABLE OUT parameter. PL/pgSQL variable
--          substitution applies inside CREATE TABLE ... AS SELECT (it is a
--          command containing an optimizable SELECT), and under the default
--          `#variable_conflict error` the collision raises SQLSTATE 42702
--          at runtime on every invocation. The later copies of this wrapper
--          (065 §2, 069 §2) already alias-qualify (`v.tenant_id`) and are
--          unaffected — 044 predates that convention.
--
--          Why it survived Codex review + the unit suite: same latent-defect
--          class as 071 — CREATE OR REPLACE succeeds (the body is only
--          parsed, not planned, at definition time), the handler unit tests
--          (get-crisis-operational-health.test.ts) mock all SQL, and no
--          live-PG integration test exercises this wrapper. The companion
--          integration suite added with this migration
--          (tests/integration/admin-dashboards-http.test.ts) closes that
--          blind spot for all THREE dashboard wrappers.
--
--          Fix (belt + braces, identical posture to 071):
--            (a) `#variable_conflict use_column` pragma — inside embedded
--                SQL, name collisions resolve to the COLUMN, the intended
--                meaning at the collision site.
--            (b) Explicit view alias qualification (`v.tenant_id`) anyway,
--                matching the 065/069 convention, so no reader has to
--                reason about the pragma.
--
--          Semantics are otherwise IDENTICAL to the migration 044 §1 body:
--          LAYER C tenant-scope guard, SI-010 internal executor binding,
--          R1 MED-1 DROP-IF-EXISTS temp-table pattern, co-transactional
--          I-027 read-trail INSERT, RETURN QUERY shape — all unchanged.
--          No schema objects change; signature unchanged; CREATE OR REPLACE
--          preserves ownership (read_admin_crisis_operational_health_wrapper_owner)
--          + the EXECUTE grant matrix (admin_basic_operator only) from 044 §2.
--
-- Spec references:
--   - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED P-041) §3.5
--     (wrapper-only canonical read-path discipline) + §5 endpoint contract
--   - CDM v1.10 → v1.11 Amendment §4.NEW8b (RATIFIED P-042)
--   - migration 044 §1 (original wrapper; defect present since creation)
--   - migration 071 (first instance of the class; fix posture mirrored here)
--   - I-027 (audit completeness on the read path — a 500ing dashboard
--     wrapper never reaches its read-trail INSERT)
--
-- Rollback: rollback/074_rollback.sql (restores the 044 §1 body verbatim —
-- including the defect — for chain-consistency; see note there).
-- =============================================================================

CREATE OR REPLACE FUNCTION read_admin_crisis_operational_health(
    p_tenant_id           TEXT,
    p_query_params_jsonb  JSONB
) RETURNS TABLE (
    tenant_id                            TEXT,
    severity                             TEXT,
    active_event_count                   BIGINT,
    escalation_obligation_backlog_count  BIGINT,
    stale_sweep_count                    BIGINT,
    active_obligation_avg_tier           NUMERIC,
    crisis_audit_24h_count               BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
    v_actor_tenant_id          TEXT;
    v_executor_principal_id    TEXT;
    v_row_count                INTEGER;
BEGIN
    -- ---------------------------------------------------------------------
    -- LAYER C — tenant scope match (SI-010 trust anchor).
    -- ---------------------------------------------------------------------
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION
            'read_admin_crisis_operational_health: no actor tenant bound for current backend; authContextPlugin must bind before SECDEF wrapper invocation'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION
            'read_admin_crisis_operational_health: tenant scope mismatch — actor tenant % does not match wrapper p_tenant_id %; cross-tenant read rejected',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    -- ---------------------------------------------------------------------
    -- Internal executor binding from SI-010 (caller cannot forge).
    -- ---------------------------------------------------------------------
    v_executor_principal_id := current_actor_account_id();
    IF v_executor_principal_id IS NULL THEN
        RAISE EXCEPTION
            'read_admin_crisis_operational_health: no actor account bound for current backend'
            USING ERRCODE = '42501';
    END IF;

    -- ---------------------------------------------------------------------
    -- Capture the view body into a TEMP table (044 §1 R1 MED-1 pattern:
    -- DROP IF EXISTS first so repeat calls within one tx are safe;
    -- ON COMMIT DROP for cleanup).
    --
    -- 074 fix site: `v` alias added — the previous unqualified
    -- `WHERE tenant_id = p_tenant_id` collided with the tenant_id OUT
    -- param and raised 42702 on every execution reaching here.
    -- ---------------------------------------------------------------------
    DROP TABLE IF EXISTS pg_temp._admin_crisis_query_result;
    CREATE TEMP TABLE _admin_crisis_query_result ON COMMIT DROP AS
        SELECT * FROM admin_crisis_operational_health_v v
         WHERE v.tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    -- ---------------------------------------------------------------------
    -- Co-transactional INSERT into the I-027 audit-trail entity. Atomic
    -- with the wrapper's RETURN — a wrapper failure rolls back the audit
    -- row too. The application-layer Cat A audit emission (Fastify route)
    -- is a separate AUDIT_EVENTS contract record.
    -- ---------------------------------------------------------------------
    INSERT INTO admin_dashboard_query_execution
        (tenant_id, executor_principal_id, dashboard_name, query_params_jsonb, row_count)
    VALUES
        (p_tenant_id, v_executor_principal_id, 'admin_crisis_operational_health_v',
         p_query_params_jsonb, v_row_count);

    RETURN QUERY SELECT * FROM _admin_crisis_query_result;
END;
$$;

COMMENT ON FUNCTION read_admin_crisis_operational_health(TEXT, JSONB) IS
    'P-042 §4.NEW8b + SI-023 Sub-decision 3.5 crisis-operational-health '
    'dashboard read wrapper. SECURITY DEFINER + locked search_path. SOLE '
    'caller path into admin_crisis_operational_health_v (wrapper-only '
    'canonical read-path discipline per SI-023 §3.5 R1 HIGH-1). Internal '
    'executor bound from SI-010 (caller cannot forge). LAYER C tenant scope '
    'match via current_actor_account_tenant_id. LAYER A EXECUTE granted '
    'ONLY to admin_basic_operator (anti-bypass). LAYER B (role check) + '
    'Cat A audit emission at the application layer. Co-transactional '
    'admin_dashboard_query_execution INSERT satisfies I-027 on the read '
    'path. Migration 074: fixes latent 42702 OUT-param/column ambiguity '
    'at the CTAS WHERE site (same class as 071); #variable_conflict '
    'use_column + explicit view alias. Semantics identical to 044 §1.';

-- =============================================================================
-- Verification — the wrapper must still be SECDEF, owned by
-- read_admin_crisis_operational_health_wrapper_owner, with EXECUTE locked
-- to admin_basic_operator (CREATE OR REPLACE preserves owner + ACL; assert
-- anyway per the migration 036 §4 / 071 verification pattern).
-- =============================================================================

DO $$
DECLARE
    v_target_oid OID := to_regprocedure(
        'public.read_admin_crisis_operational_health(text, jsonb)'
    );
    v_owner                TEXT;
    v_secdef               BOOLEAN;
    v_config               TEXT[];
    v_prosrc               TEXT;
    v_specific_name        TEXT;
    v_unauthorized_grantee TEXT;
BEGIN
    IF v_target_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-074-function-missing: read_admin_crisis_operational_health(text, jsonb) not found by signature';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig, p.prosrc
      INTO v_owner, v_secdef, v_config, v_prosrc
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_target_oid;

    IF v_owner <> 'read_admin_crisis_operational_health_wrapper_owner' THEN
        RAISE EXCEPTION
            'migration-074-ownership-mismatch: wrapper owner is % but MUST be read_admin_crisis_operational_health_wrapper_owner (CREATE OR REPLACE should have preserved it)',
            v_owner;
    END IF;

    IF NOT v_secdef THEN
        RAISE EXCEPTION 'migration-074-security-definer-missing: wrapper MUST be SECURITY DEFINER';
    END IF;

    IF v_config IS NULL
       OR NOT (v_config @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-074-search-path-not-locked: wrapper MUST have proconfig containing "search_path=pg_catalog, public"; found %',
            v_config;
    END IF;

    -- The fix markers: the pragma AND the alias-qualified WHERE MUST be
    -- present in the installed body.
    IF v_prosrc NOT LIKE '%#variable_conflict use_column%' THEN
        RAISE EXCEPTION
            'migration-074-fix-not-applied: installed wrapper body lacks the #variable_conflict use_column pragma';
    END IF;
    IF v_prosrc NOT LIKE '%v.tenant_id = p_tenant_id%' THEN
        RAISE EXCEPTION
            'migration-074-fix-not-applied: installed wrapper body lacks the alias-qualified CTAS WHERE clause';
    END IF;

    -- Grant matrix re-assertion (044 §2): ONLY admin_basic_operator (and
    -- the owner itself) may EXECUTE.
    SELECT p.proname || '_' || p.oid::TEXT
      INTO v_specific_name
      FROM pg_proc p
     WHERE p.oid = v_target_oid;

    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.routine_privileges g
         WHERE g.specific_schema = 'public'
           AND g.specific_name = v_specific_name
           AND g.privilege_type = 'EXECUTE'
           AND g.grantee NOT IN ('admin_basic_operator',
                                 'read_admin_crisis_operational_health_wrapper_owner')
    LOOP
        RAISE EXCEPTION
            'migration-074-grant-violation: EXECUTE granted to non-canonical role %',
            v_unauthorized_grantee;
    END LOOP;
END $$;
