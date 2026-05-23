-- =============================================================================
-- File:    migrations/044_admin_backend_dashboard_wrappers.sql
-- Purpose: Create the dashboard read SECURITY DEFINER wrappers for SI-023
--          Sub-decision 3.5 + CDM §4.NEW8b/c/d (RATIFIED 2026-05-22 P-042).
--
--          PR 5 of the Admin Backend Basics implementation series. PR 6
--          lands the Fastify module scaffold (skeleton with BLOCKED-aware
--          /health + /ready endpoints; full route handlers gated on Option-2
--          foundation work landing).
--
--          PER RATIFIER OPTION 2 (carryforward from PR 2 + Crisis Response):
--          - admin_crisis_operational_health() wrapper → CREATED at v0.1
--            (underlying view admin_crisis_operational_health_v exists post
--            migration 041 §1).
--          - admin_consult_queue_health() wrapper → DEFERRED at v0.1 (the
--            underlying view admin_consult_queue_health_v is deferred per
--            migration 041 §2 — consult entities missing from code repo).
--          - admin_mode1_volume_health() wrapper → DEFERRED at v0.1 (the
--            underlying view admin_mode1_volume_health_v is deferred per
--            migration 041 §3 — Mode 1 entities + audit emitters missing).
--
--          The 2 deferred wrappers' owner-roles + EXECUTE-target role
--          (admin_basic_operator) were created in migration 039 so the §6
--          RBAC table is internally consistent; only the wrapper bodies
--          are deferred. A future Option-2 hygiene migration that lands
--          the consult + Mode 1 views must also land the matching
--          wrappers, verbatim from CDM §4.NEW8c / §4.NEW8d adapted to
--          Option 2 (per the same syntax adaptations applied to §1 here).
--
-- Spec:    - SI-023 Admin Backend Basics Slice v1.0 Sub-decision 3.5
--            (RATIFIED 2026-05-22 P-041; telecheckONE/Telecheck Master
--            Bundle FINAL US REGION BASELINE/
--            Telecheck_SI_023_Admin_Backend_Basics_v1_0.md §3.5)
--          - CDM v1.10 → v1.11 Amendment §4.NEW8b (RATIFIED 2026-05-22
--            P-042; telecheckONE/Telecheck Master Bundle FINAL US REGION
--            BASELINE/Telecheck_CDM_v1_10_to_v1_11_Amendment.md)
--          - I-023, I-025, I-027 (tenant isolation; tenant-blind errors;
--            audit completeness via co-transactional INSERT)
--          - I-019 (crisis-detection-always-on platform-floor)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   031_session_actor_context.sql                applied (SI-010 helpers)
--   039_admin_backend_rbac_roles.sql             applied (12 admin RBAC roles)
--   040_admin_backend_entities.sql               applied (admin_dashboard_query_execution
--                                                  table)
--   041_admin_backend_derived_views.sql          applied (admin_crisis_operational_health_v +
--                                                  wrapper-owner base-table SELECT grants)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — read_admin_crisis_operational_health() (CDM §4.NEW8b)
--
-- Per-tenant per-severity rollup of crisis operational metrics. SOLE caller
-- path into admin_crisis_operational_health_v from application code per the
-- canonical wrapper-only read-path discipline (SI-023 §3.5 R1 HIGH-1).
--
-- Body:
--   1. LAYER C tenant scope match (SI-010 trust anchor)
--   2. Internal executor binding from SI-010 (caller cannot forge)
--   3. SELECT the view body into TEMP table (atomic with audit row capture)
--   4. INSERT admin_dashboard_query_execution row (I-027 audit completeness;
--      same-transaction co-locality so a wrapper failure rolls back the
--      query-execution audit row too)
--   5. RETURN QUERY from TEMP table
--
-- LAYER B (role authorization) DEFERRED to application layer per Option 2.
-- Audit-event Cat A emission (admin.dashboard_query_executed) DEFERRED to
-- application layer (Fastify route in PR 6 wraps the wrapper call + the
-- audit_records INSERT in a single DB transaction). The dashboard_query
-- audit row inserted here is the I-027 read-trail row; the Cat A audit
-- event is a separate AUDIT_EVENTS contract record.
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
    -- Capture the view body into a TEMP table so the row count is known at
    -- audit-INSERT time + the same rows are returned to the caller. The
    -- temp table is auto-dropped on commit per ON COMMIT DROP.
    --
    -- R1 MED-1 closure 2026-05-22 (Codex R1): the prior CREATE TEMP TABLE
    -- without a preceding DROP would fail with "relation already exists"
    -- on a second invocation within the same Fastify-managed transaction
    -- (ON COMMIT DROP only fires at tx commit, not at function exit).
    -- Use ON COMMIT DROP + drop pg_temp version IF EXISTS first so repeat
    -- calls within one tx are safe (Fastify route retry, composed dashboard
    -- reads, integration tests calling the wrapper twice).
    -- ---------------------------------------------------------------------
    DROP TABLE IF EXISTS pg_temp._admin_crisis_query_result;
    CREATE TEMP TABLE _admin_crisis_query_result ON COMMIT DROP AS
        SELECT * FROM admin_crisis_operational_health_v
         WHERE tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    -- ---------------------------------------------------------------------
    -- Co-transactional INSERT into the I-027 audit-trail entity. Atomic
    -- with the wrapper's RETURN — a wrapper failure rolls back the audit
    -- row too. The application-layer Cat A audit emission (Fastify route
    -- in PR 6) is a separate AUDIT_EVENTS contract record.
    -- ---------------------------------------------------------------------
    INSERT INTO admin_dashboard_query_execution
        (tenant_id, executor_principal_id, dashboard_name, query_params_jsonb, row_count)
    VALUES
        (p_tenant_id, v_executor_principal_id, 'admin_crisis_operational_health_v',
         p_query_params_jsonb, v_row_count);

    RETURN QUERY SELECT * FROM _admin_crisis_query_result;
END;
$$;

-- =============================================================================
-- §2 — Crisis read-wrapper ownership + privilege grants (LAYER A + DML)
-- =============================================================================

ALTER FUNCTION read_admin_crisis_operational_health(TEXT, JSONB)
    OWNER TO read_admin_crisis_operational_health_wrapper_owner;

-- The view-level SELECT grant to the wrapper-owner already exists at
-- migration 041 §1 (REVOKE FROM PUBLIC + GRANT to wrapper-owner). The
-- 5 base-table SELECT grants required by security_invoker=true also
-- already exist at migration 041 §1 R1 HIGH-1 closure.

-- DML grants per CDM §4.NEW8g (Option 2 adapted): wrapper-owner needs
-- INSERT on the audit trail + USAGE on its BIGSERIAL sequence (per Admin
-- Backend PR 3 R3 closure pattern; INSERT alone does NOT confer nextval
-- USAGE — without this the first wrapper invocation would fail with
-- "permission denied for sequence" at runtime).
GRANT INSERT ON admin_dashboard_query_execution
    TO read_admin_crisis_operational_health_wrapper_owner;
GRANT USAGE ON SEQUENCE admin_dashboard_query_execution_id_seq
    TO read_admin_crisis_operational_health_wrapper_owner;

-- SI-010 trust-anchor reads for LAYER C + internal executor binding
-- (same pattern as Crisis Response migrations 036-038 + Admin Backend
-- migrations 042 + 043).
GRANT EXECUTE ON FUNCTION current_actor_account_id()
    TO read_admin_crisis_operational_health_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()
    TO read_admin_crisis_operational_health_wrapper_owner;

-- LAYER A anti-bypass: ONLY admin_basic_operator can EXECUTE.
REVOKE EXECUTE ON FUNCTION read_admin_crisis_operational_health(TEXT, JSONB)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_admin_crisis_operational_health(TEXT, JSONB)
    TO admin_basic_operator;

COMMENT ON FUNCTION read_admin_crisis_operational_health(TEXT, JSONB) IS
    'P-042 §4.NEW8b + SI-023 Sub-decision 3.5 crisis-operational-health '
    'dashboard read wrapper. SECURITY DEFINER + locked search_path. SOLE '
    'caller path into admin_crisis_operational_health_v (wrapper-only '
    'canonical read-path discipline per SI-023 §3.5 R1 HIGH-1). Internal '
    'executor bound from SI-010 (caller cannot forge). LAYER C tenant scope '
    'match via current_actor_account_tenant_id. LAYER A EXECUTE granted '
    'ONLY to admin_basic_operator (anti-bypass). LAYER B (role check) + '
    'Cat A audit emission deferred to Fastify route handler in PR 6. '
    'Co-transactional INSERT into admin_dashboard_query_execution satisfies '
    'I-027 audit completeness on the read path.';

-- =============================================================================
-- §3 — read_admin_consult_queue_health()   (DEFERRED per Option 2)
--
-- Source: CDM §4.NEW8c + SI-023 Sub-decision 3.5.
--
-- Foundation dependency missing: the underlying view admin_consult_queue_health_v
-- is deferred per migration 041 §2 (consult entities not in code repo).
-- Per the Option 2 carryforward, the wrapper cannot be created without its
-- view body — CREATE FUNCTION would succeed syntactically but the function
-- would error at first invocation with "relation admin_consult_queue_health_v
-- does not exist", which fails the verification block of this migration.
--
-- A future Option-2 hygiene migration that lands the consult view must
-- also land this wrapper, verbatim from CDM §4.NEW8c with the same Option-2
-- syntax adaptations applied here:
--   - tenant_id_t → TEXT
--   - verify_session_jwt_and_extract_claims() → current_actor_account_id()
--     + current_actor_account_tenant_id() (SI-010 trust anchor)
--   - tenant_account_membership lookup → application-layer LAYER B
--   - emit_audit_event_co_transactional → deferred to application layer
--   - GRANT INSERT on admin_dashboard_query_execution + USAGE on its
--     BIGSERIAL sequence to read_admin_consult_queue_health_wrapper_owner
--   - GRANT EXECUTE on SI-010 helpers
--   - LAYER A EXECUTE granted ONLY to admin_basic_operator
--
-- DELIBERATELY NOT CREATED at v0.1.
-- =============================================================================

-- =============================================================================
-- §4 — read_admin_mode1_volume_health()    (DEFERRED per Option 2)
--
-- Source: CDM §4.NEW8d + SI-023 Sub-decision 3.5.
--
-- Foundation dependency missing: the underlying view admin_mode1_volume_health_v
-- is deferred per migration 041 §3 (Mode 1 ai_mode1_conversation entity +
-- Mode 1 audit emitters not in code repo).
--
-- A future Option-2 hygiene migration that lands the Mode 1 view must
-- also land this wrapper, verbatim from CDM §4.NEW8d with the same Option-2
-- syntax adaptations.
--
-- DELIBERATELY NOT CREATED at v0.1.
-- =============================================================================

-- =============================================================================
-- §5 — Verification
-- =============================================================================

DO $$
DECLARE
    v_crisis_oid                OID := to_regprocedure(
        'public.read_admin_crisis_operational_health(text, jsonb)'
    );
    v_owner                     TEXT;
    v_security_definer          BOOLEAN;
    v_proconfig                 TEXT[];
    v_specific_name             TEXT;
    v_grantee_count             INTEGER;
    v_unauthorized_grantee      TEXT;
BEGIN
    -- ---------- crisis read wrapper ----------
    IF v_crisis_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-044-crisis-function-missing: '
            'read_admin_crisis_operational_health(text, jsonb) not found by signature';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_owner, v_security_definer, v_proconfig
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_crisis_oid;

    IF v_owner <> 'read_admin_crisis_operational_health_wrapper_owner' THEN
        RAISE EXCEPTION
            'migration-044-crisis-ownership-mismatch: ownership is % '
            'but MUST be read_admin_crisis_operational_health_wrapper_owner', v_owner;
    END IF;

    IF NOT v_security_definer THEN
        RAISE EXCEPTION
            'migration-044-crisis-security-definer-missing: '
            'crisis read wrapper MUST be SECURITY DEFINER';
    END IF;

    IF v_proconfig IS NULL
       OR NOT (v_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-044-crisis-search-path-not-locked: '
            'crisis read wrapper MUST have proconfig containing '
            '"search_path=pg_catalog, public"; found %', v_proconfig;
    END IF;

    SELECT p.proname || '_' || p.oid::TEXT INTO v_specific_name
      FROM pg_proc p WHERE p.oid = v_crisis_oid;

    SELECT COUNT(*) INTO v_grantee_count
      FROM information_schema.role_routine_grants g
     WHERE g.specific_name = v_specific_name
       AND g.privilege_type = 'EXECUTE'
       AND g.grantee <> 'read_admin_crisis_operational_health_wrapper_owner';

    IF v_grantee_count <> 1 THEN
        RAISE EXCEPTION
            'migration-044-crisis-execute-grant-count: '
            'expected exactly 1 EXECUTE grant (admin_basic_operator) '
            'excluding owner, found %', v_grantee_count;
    END IF;

    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_routine_grants g
         WHERE g.specific_name = v_specific_name
           AND g.privilege_type = 'EXECUTE'
           AND g.grantee NOT IN ('read_admin_crisis_operational_health_wrapper_owner',
                                 'admin_basic_operator')
    LOOP
        RAISE EXCEPTION
            'migration-044-crisis-execute-grant-violation: '
            'crisis read wrapper EXECUTE granted to non-canonical role %',
            v_unauthorized_grantee;
    END LOOP;

    PERFORM 1 FROM information_schema.role_routine_grants
     WHERE specific_name = v_specific_name
       AND privilege_type = 'EXECUTE' AND grantee = 'PUBLIC';
    IF FOUND THEN
        RAISE EXCEPTION
            'migration-044-crisis-anti-bypass-violation: '
            'PUBLIC has EXECUTE on crisis read wrapper';
    END IF;

    -- BIGSERIAL implicit-sequence USAGE for the audit-trail entity.
    IF NOT has_sequence_privilege(
        'read_admin_crisis_operational_health_wrapper_owner',
        'public.admin_dashboard_query_execution_id_seq',
        'USAGE'
    ) THEN
        RAISE EXCEPTION
            'migration-044-crisis-sequence-usage-missing: '
            'wrapper-owner does NOT have USAGE on '
            'admin_dashboard_query_execution_id_seq; BIGSERIAL nextval in '
            'the SECDEF wrapper will fail at runtime with permission denied for sequence';
    END IF;

    -- ---------- Verify 2 deferred wrappers are NOT created ----------
    -- Documents the deferral; if a future migration creates either, this
    -- block must be updated as part of that hygiene cycle.
    IF to_regprocedure('public.read_admin_consult_queue_health(text, jsonb)') IS NOT NULL THEN
        RAISE NOTICE
            'migration-044-consult-wrapper-unexpected: '
            'read_admin_consult_queue_health() exists. If a follow-on hygiene '
            'migration created it, update this verification block.';
    END IF;

    IF to_regprocedure('public.read_admin_mode1_volume_health(text, jsonb)') IS NOT NULL THEN
        RAISE NOTICE
            'migration-044-mode1-wrapper-unexpected: '
            'read_admin_mode1_volume_health() exists. If a follow-on hygiene '
            'migration created it, update this verification block.';
    END IF;
END $$;
