-- =============================================================================
-- File:    migrations/065_admin_consult_queue_health_unlock.sql
-- Purpose: Land the DEFERRED admin consult-queue-health dashboard surface —
--          the Option-2 hygiene migration prescribed by migration 041 §2 +
--          migration 044 §3. The foundation dependency that forced the
--          deferral (P-038 consult entities) landed at migrations 055-061,
--          so the deferral reason is gone:
--
--            §1 CREATE VIEW admin_consult_queue_health_v — verbatim from
--               CDM v1.10 → v1.11 Amendment §4.NEW6 (RATIFIED 2026-05-22
--               P-042) with the SAME Option-2 syntax adaptations migration
--               041 §1 applied to the crisis view:
--                 - current_tenant_id_strict('...') → current_tenant_id()
--                 - public.audit_event / action_id → public.audit_records /
--                   action (code-repo audit table; recorded_at unchanged)
--                 - claim_at → claimed_at (code-repo consult_review_claim
--                   column name per migration 056 §4)
--            §2 CREATE FUNCTION read_admin_consult_queue_health() — verbatim
--               from CDM §4.NEW8c with the SAME Option-2 adaptations
--               migration 044 §1 applied to the crisis wrapper:
--                 - tenant_id_t → TEXT
--                 - verify_session_jwt_and_extract_claims() → SI-010
--                   current_actor_account_id() +
--                   current_actor_account_tenant_id()
--                 - tenant_account_membership LAYER B → application layer
--                 - emit_audit_event_co_transactional → application layer
--                   (Cat A admin.dashboard_query_executed emission remains a
--                   Sprint-4 admin-backend hardening item; the wrapper's
--                   co-transactional admin_dashboard_query_execution INSERT
--                   is the I-027 read-trail row, exactly like 044 §1)
--            §3 Verification (044 §5 pattern).
--
--          NOT landed here: admin_mode1_volume_health_v + its wrapper
--          (migration 041 §3 / 044 §4 deferral) — the foundation dependency
--          (P-036 `ai_mode1_conversation` entity + Mode 1 audit emitters)
--          is STILL absent from the code repo. That deferral stands.
--
--          The already-shipped Fastify handler
--          (src/modules/admin-backend/internal/handlers/
--          get-consult-queue-health.ts) requires NO change by design — its
--          42883-undefined-function → 503 mapping becomes dead code once
--          this migration applies.
--
-- Spec:    - SI-023 Admin Backend Basics v1.0 (RATIFIED P-041) §3.5 + §5
--            endpoint 2
--          - CDM v1.10 → v1.11 Amendment §4.NEW6 + §4.NEW8c (RATIFIED
--            2026-05-22 P-042)
--          - migrations 039 (owner roles pre-created) + 041 §2 + 044 §3
--            (deferral prescriptions this migration executes)
--          - I-023, I-025, I-027
-- Preconditions: 002 (audit_records) + 031 (SI-010 helpers) + 039 (admin
--   RBAC roles) + 040 (admin_dashboard_query_execution) + 056 (consult
--   entities) applied.
-- =============================================================================

-- =============================================================================
-- §1 — admin_consult_queue_health_v (CDM §4.NEW6; Option-2 adapted)
--
-- Per-(program_id, current_state) rollup with metrics decomposed into
-- independent per-tenant CTEs (P-042 R3 HIGH-1 closure — avoids 1:N join
-- multiplication corrupting consult_count and orphan_claim_backlog).
-- =============================================================================

CREATE VIEW admin_consult_queue_health_v
WITH (security_invoker = true, security_barrier = true)
AS
WITH tenant_scope AS (
    SELECT current_tenant_id() AS tenant_id
),
consult_state_rollup AS (
    SELECT c.tenant_id, c.program_id, latest.to_state AS current_state,
           COUNT(*) AS consult_count,
           AVG(EXTRACT(EPOCH FROM (first_claim.claimed_at - c.created_at)))::NUMERIC(10,2)
               AS avg_time_to_first_claim_seconds
      FROM public.consult c
      JOIN tenant_scope ts ON ts.tenant_id = c.tenant_id
      LEFT JOIN LATERAL (
          SELECT to_state FROM public.consult_lifecycle_transition
          WHERE tenant_id = c.tenant_id AND consult_id = c.id
          ORDER BY transition_at DESC, id DESC LIMIT 1
      ) latest ON TRUE
      LEFT JOIN LATERAL (
          SELECT claimed_at FROM public.consult_review_claim
          WHERE tenant_id = c.tenant_id AND consult_id = c.id
          ORDER BY claimed_at ASC LIMIT 1
      ) first_claim ON TRUE
     GROUP BY c.tenant_id, c.program_id, latest.to_state
),
orphan_claims_by_program AS (
    SELECT c.tenant_id, c.program_id, COUNT(*) AS orphan_count
      FROM public.consult_review_claim crc
      JOIN public.consult c ON c.tenant_id = crc.tenant_id AND c.id = crc.consult_id
      JOIN tenant_scope ts ON ts.tenant_id = crc.tenant_id
     WHERE crc.claim_expires_at < now()
       AND crc.released_at IS NULL
     GROUP BY c.tenant_id, c.program_id
),
async_consult_audit_24h AS (
    SELECT ar.tenant_id, COUNT(*) AS audit_count
      FROM public.audit_records ar
      JOIN tenant_scope ts ON ts.tenant_id = ar.tenant_id
     WHERE ar.action LIKE 'async_consult.%'
       AND ar.recorded_at > now() - INTERVAL '24 hours'
     GROUP BY ar.tenant_id
)
SELECT
    csr.tenant_id,
    csr.program_id,
    csr.current_state,
    csr.consult_count,
    csr.avg_time_to_first_claim_seconds,
    COALESCE(ocp.orphan_count, 0) AS orphan_claim_backlog_count,
    COALESCE(aca.audit_count, 0) AS async_consult_audit_24h_count
FROM consult_state_rollup csr
LEFT JOIN orphan_claims_by_program ocp
    ON ocp.tenant_id = csr.tenant_id AND ocp.program_id IS NOT DISTINCT FROM csr.program_id
LEFT JOIN async_consult_audit_24h aca
    ON aca.tenant_id = csr.tenant_id;

COMMENT ON VIEW admin_consult_queue_health_v IS
    'P-042 §4.NEW6 (Option-2 adapted per migration 041 §1 conventions). '
    'Tenant-scoped per-(program_id, current_state) consult-queue rollup. '
    'security_invoker=true — SELECT runs with querying-role privileges; the '
    'SOLE application read path is read_admin_consult_queue_health() (044 §1 '
    'wrapper-only discipline). Unlocked from the 041 §2 deferral after the '
    'P-038 consult entities landed at migrations 055-061.';

-- Ownership per 041 §2 deferral step (c); grant matrix per step (d) + §7
-- invariant (no other role holds SELECT).
ALTER VIEW admin_consult_queue_health_v OWNER TO admin_consult_queue_health_view_owner;
REVOKE ALL ON admin_consult_queue_health_v FROM PUBLIC;
GRANT SELECT ON admin_consult_queue_health_v TO read_admin_consult_queue_health_wrapper_owner;

-- security_invoker=true → the querying role (the SECDEF wrapper's owner)
-- needs SELECT on the underlying base tables (041 §1 R1 HIGH-1 pattern).
-- RLS still scopes every read to the GUC-bound tenant (the wrapper-owner
-- is NOBYPASSRLS per migration 039).
GRANT SELECT ON consult
    TO read_admin_consult_queue_health_wrapper_owner;
GRANT SELECT ON consult_lifecycle_transition
    TO read_admin_consult_queue_health_wrapper_owner;
GRANT SELECT ON consult_review_claim
    TO read_admin_consult_queue_health_wrapper_owner;
GRANT SELECT ON audit_records
    TO read_admin_consult_queue_health_wrapper_owner;

-- =============================================================================
-- §2 — read_admin_consult_queue_health() (CDM §4.NEW8c; Option-2 adapted
--      per the 044 §1 crisis-wrapper conventions)
-- =============================================================================

CREATE OR REPLACE FUNCTION read_admin_consult_queue_health(
    p_tenant_id           TEXT,
    p_query_params_jsonb  JSONB
) RETURNS TABLE (
    tenant_id                        TEXT,
    program_id                       TEXT,
    current_state                    TEXT,
    consult_count                    BIGINT,
    avg_time_to_first_claim_seconds  NUMERIC,
    orphan_claim_backlog_count       BIGINT,
    async_consult_audit_24h_count    BIGINT
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
    -- LAYER C — tenant scope match (SI-010 trust anchor).
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION
            'read_admin_consult_queue_health: no actor tenant bound for current backend; authContextPlugin must bind before SECDEF wrapper invocation'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION
            'read_admin_consult_queue_health: tenant scope mismatch — actor tenant % does not match wrapper p_tenant_id %; cross-tenant read rejected',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    -- Internal executor binding from SI-010 (caller cannot forge).
    v_executor_principal_id := current_actor_account_id();
    IF v_executor_principal_id IS NULL THEN
        RAISE EXCEPTION
            'read_admin_consult_queue_health: no actor account bound for current backend'
            USING ERRCODE = '42501';
    END IF;

    -- Capture the view body into a TEMP table (044 §1 R1 MED-1 pattern:
    -- DROP IF EXISTS first so repeat calls within one tx are safe;
    -- ON COMMIT DROP for cleanup).
    DROP TABLE IF EXISTS pg_temp._admin_consult_queue_query_result;
    CREATE TEMP TABLE _admin_consult_queue_query_result ON COMMIT DROP AS
        SELECT * FROM admin_consult_queue_health_v v
         WHERE v.tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    -- Co-transactional I-027 read-trail row (rolls back with the wrapper).
    INSERT INTO admin_dashboard_query_execution
        (tenant_id, executor_principal_id, dashboard_name, query_params_jsonb, row_count)
    VALUES
        (p_tenant_id, v_executor_principal_id, 'admin_consult_queue_health_v',
         p_query_params_jsonb, v_row_count);

    RETURN QUERY SELECT * FROM _admin_consult_queue_query_result;
END;
$$;

ALTER FUNCTION read_admin_consult_queue_health(TEXT, JSONB)
    OWNER TO read_admin_consult_queue_health_wrapper_owner;

-- DML grants (044 §2 pattern): audit-trail INSERT + BIGSERIAL sequence
-- USAGE + SI-010 helper EXECUTE.
GRANT INSERT ON admin_dashboard_query_execution
    TO read_admin_consult_queue_health_wrapper_owner;
GRANT USAGE ON SEQUENCE admin_dashboard_query_execution_id_seq
    TO read_admin_consult_queue_health_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id()
    TO read_admin_consult_queue_health_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()
    TO read_admin_consult_queue_health_wrapper_owner;

-- LAYER A anti-bypass: ONLY admin_basic_operator can EXECUTE.
REVOKE EXECUTE ON FUNCTION read_admin_consult_queue_health(TEXT, JSONB)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_admin_consult_queue_health(TEXT, JSONB)
    TO admin_basic_operator;

COMMENT ON FUNCTION read_admin_consult_queue_health(TEXT, JSONB) IS
    'P-042 §4.NEW8c + SI-023 Sub-decision 3.5 consult-queue-health dashboard '
    'read wrapper (Option-2 adapted per 044 §1 conventions). SECURITY DEFINER '
    '+ locked search_path. SOLE caller path into admin_consult_queue_health_v. '
    'LAYER C tenant scope via SI-010; LAYER A EXECUTE ONLY admin_basic_operator; '
    'LAYER B + Cat A audit emission at the application layer. Co-transactional '
    'admin_dashboard_query_execution INSERT satisfies I-027 on the read path. '
    'Unlocked from the 044 §3 deferral.';

-- =============================================================================
-- §3 — Verification (044 §5 pattern, scoped to the new surface)
-- =============================================================================

DO $$
DECLARE
    v_oid                  OID := to_regprocedure(
        'public.read_admin_consult_queue_health(text, jsonb)'
    );
    v_owner                TEXT;
    v_security_definer     BOOLEAN;
    v_proconfig            TEXT[];
    v_specific_name        TEXT;
    v_unauthorized_grantee TEXT;
    v_view_owner           TEXT;
BEGIN
    -- ---------- view ----------
    IF to_regclass('public.admin_consult_queue_health_v') IS NULL THEN
        RAISE EXCEPTION 'migration-065-view-missing: admin_consult_queue_health_v not created';
    END IF;
    SELECT r.rolname INTO v_view_owner
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
     WHERE c.oid = 'public.admin_consult_queue_health_v'::regclass;
    IF v_view_owner <> 'admin_consult_queue_health_view_owner' THEN
        RAISE EXCEPTION
            'migration-065-view-ownership-mismatch: view owner is % but MUST be admin_consult_queue_health_view_owner',
            v_view_owner;
    END IF;
    -- Grant matrix: ONLY the wrapper-owner (and the owner itself) may SELECT.
    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_table_grants g
         WHERE g.table_schema = 'public'
           AND g.table_name = 'admin_consult_queue_health_v'
           AND g.privilege_type = 'SELECT'
           AND g.grantee NOT IN ('admin_consult_queue_health_view_owner',
                                 'read_admin_consult_queue_health_wrapper_owner')
    LOOP
        RAISE EXCEPTION
            'migration-065-view-grant-violation: SELECT granted to non-canonical role %',
            v_unauthorized_grantee;
    END LOOP;

    -- ---------- wrapper ----------
    IF v_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-065-function-missing: read_admin_consult_queue_health(text, jsonb) not found by signature';
    END IF;
    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_owner, v_security_definer, v_proconfig
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_oid;
    IF v_owner <> 'read_admin_consult_queue_health_wrapper_owner' THEN
        RAISE EXCEPTION
            'migration-065-ownership-mismatch: ownership is % but MUST be read_admin_consult_queue_health_wrapper_owner',
            v_owner;
    END IF;
    IF NOT v_security_definer THEN
        RAISE EXCEPTION 'migration-065-security-definer-missing: wrapper MUST be SECURITY DEFINER';
    END IF;
    IF v_proconfig IS NULL
       OR NOT (v_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-065-search-path-not-locked: proconfig must contain "search_path=pg_catalog, public"; found %',
            v_proconfig;
    END IF;

    SELECT p.proname || '_' || p.oid::TEXT INTO v_specific_name
      FROM pg_proc p WHERE p.oid = v_oid;
    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_routine_grants g
         WHERE g.specific_name = v_specific_name
           AND g.privilege_type = 'EXECUTE'
           AND g.grantee NOT IN ('read_admin_consult_queue_health_wrapper_owner',
                                 'admin_basic_operator')
    LOOP
        RAISE EXCEPTION
            'migration-065-execute-grant-violation: wrapper EXECUTE granted to non-canonical role %',
            v_unauthorized_grantee;
    END LOOP;

    -- Sequence USAGE (044 §5 runtime-failure guard).
    IF NOT has_sequence_privilege(
        'read_admin_consult_queue_health_wrapper_owner',
        'public.admin_dashboard_query_execution_id_seq',
        'USAGE'
    ) THEN
        RAISE EXCEPTION
            'migration-065-sequence-usage-missing: wrapper-owner lacks USAGE on admin_dashboard_query_execution_id_seq';
    END IF;

    -- Base-table SELECTs for security_invoker=true execution.
    IF NOT (
        has_table_privilege('read_admin_consult_queue_health_wrapper_owner', 'public.consult', 'SELECT')
        AND has_table_privilege('read_admin_consult_queue_health_wrapper_owner', 'public.consult_lifecycle_transition', 'SELECT')
        AND has_table_privilege('read_admin_consult_queue_health_wrapper_owner', 'public.consult_review_claim', 'SELECT')
        AND has_table_privilege('read_admin_consult_queue_health_wrapper_owner', 'public.audit_records', 'SELECT')
    ) THEN
        RAISE EXCEPTION
            'migration-065-base-table-select-missing: wrapper-owner lacks SELECT on one of the 4 view base tables';
    END IF;

    -- The mode1 deferral (041 §3 / 044 §4) still stands.
    IF to_regprocedure('public.read_admin_mode1_volume_health(text, jsonb)') IS NOT NULL THEN
        RAISE NOTICE
            'migration-065-mode1-wrapper-unexpected: read_admin_mode1_volume_health() exists; '
            'if a follow-on hygiene migration created it, update this verification block.';
    END IF;

    RAISE NOTICE 'migration-065: verification passed (consult-queue-health view + wrapper unlocked)';
END $$;
