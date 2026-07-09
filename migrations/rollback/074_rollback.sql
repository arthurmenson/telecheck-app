-- =============================================================================
-- rollback/074_rollback.sql — unwind 074_admin_crisis_dashboard_wrapper_out_param_ambiguity_fix
--
-- Restores the migration 044 §1 body of
-- `read_admin_crisis_operational_health()` VERBATIM — including the
-- latent 42702 OUT-param/column ambiguity that 074 fixed. Rollback means
-- chain-consistency (the DB state equals "through 071"), not "keep the
-- fix": a rolled-back 074 leaves the crisis-operational-health dashboard
-- endpoint failing on every call, exactly as it did before 074. Do not
-- roll back unless you are rolling the whole chain past 044's wrapper.
--
-- NOTE: admin_dashboard_query_execution rows written while 074 was live
-- are NOT touched — the read-trail is durable per I-027; rollback of DDL
-- never implies destruction of committed rows.
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
