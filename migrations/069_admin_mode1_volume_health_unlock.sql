-- =============================================================================
-- File:    migrations/069_admin_mode1_volume_health_unlock.sql
-- Purpose: Land the LAST deferred admin dashboard surface — the
--          mode1-volume-health view + SECDEF read wrapper, the Option-2
--          hygiene migration prescribed by migration 041 §3 + migration
--          044 §4. The foundation dependency that forced the deferral
--          (P-036 `ai_mode1_conversation` entity) landed at migrations
--          066-068, so the deferral reason is gone:
--
--            §1 CREATE VIEW admin_mode1_volume_health_v — from CDM v1.10 →
--               v1.11 Amendment §4.NEW7 (RATIFIED 2026-05-22 P-042) with
--               the SAME Option-2 syntax adaptations migrations 041 §1 +
--               065 §1 applied, PLUS three recorded adaptations specific
--               to this view (documented below).
--            §2 CREATE FUNCTION read_admin_mode1_volume_health() — from
--               CDM §4.NEW8d with the SAME Option-2 adaptations the 044 §1
--               crisis wrapper + 065 §2 consult wrapper applied:
--                 - tenant_id_t → TEXT
--                 - verify_session_jwt_and_extract_claims() → SI-010
--                   current_actor_account_id() +
--                   current_actor_account_tenant_id()
--                 - tenant_account_membership LAYER B → application layer
--                 - emit_audit_event_co_transactional → application layer
--                   (Cat A admin.dashboard_query_executed emission remains a
--                   Sprint-4 admin-backend hardening item; the wrapper's
--                   co-transactional admin_dashboard_query_execution INSERT
--                   is the I-027 read-trail row, exactly like 044 §1 + 065 §2)
--            §3 Verification (044 §5 / 065 §3 pattern).
--
-- Option-2 adaptations specific to THIS view (each a recorded divergence
-- from the ratified §4.NEW7 body; same class as the 041 §1 / 065 §1
-- recorded divergences):
--
--   1. current_tenant_id_strict('admin_mode1_volume_health_v') →
--      current_tenant_id() (code-repo pattern from migration 003; same as
--      041 §1 + 065 §1).
--
--   2. public.audit_event / ae.action_id → public.audit_records /
--      ar.action (code-repo audit table per migration 002; recorded_at
--      unchanged; 065 §1 precedent).
--
--   3. AUDIT ACTION-ID ADAPTATION (this view's WHERE filters count the
--      action IDs the code repo ACTUALLY emits today, not the spec's
--      not-yet-registered `mode1.*` IDs):
--        - Spec `mode1.crisis_detection_trigger` → code-repo
--          `crisis_detection_trigger` (unprefixed Cat A action emitted by
--          src/modules/ai-service/internal/crisis/audit.ts per AUDIT_EVENTS
--          v5.3 canonical union in lib/audit.ts).
--        - Spec `mode1.safety_floor_response_emitted` → NO dedicated action
--          ID exists in the code repo today. The safety-floor (crisis
--          resource referral) response is recorded on the
--          `ai_chat_response_emitted` Cat C envelope (placeholder action per
--          src/modules/ai-service/audit.ts) with detail field
--          `escalation_triggered = true` (set by the Mode 1 chat handler IFF
--          the crisis gate detected + the safety-floor response replaced the
--          LLM output). The view counts
--          `action = 'ai_chat_response_emitted' AND
--           (payload ->> 'escalation_triggered')::BOOLEAN` — the faithful
--          code-repo-today equivalent of the spec's dedicated Cat A count.
--      FOLLOW-UP (named): when the `ai.mode1.*` audit action-ID catalog
--      registration lands at the app layer (AUDIT_EVENTS v5.10, 11 IDs —
--      recorded follow-up per PR #260 / src/modules/ai-service/README.md
--      item 2), a hygiene migration MUST widen/rename BOTH filters to the
--      registered IDs (crisis: add the prefixed ID alongside the unprefixed
--      one for the 24h overlap window; safety-floor: replace the
--      payload-field predicate with the dedicated Cat A action ID).
--
--   4. ENDED_AT → ARCHIVAL ADAPTATION: the spec's `amc.ended_at` column
--      DOES NOT EXIST on the code-repo `ai_mode1_conversation` (migration
--      067) — the ratified P-036 schema models conversation end via
--      `ai_mode1_conversation_archival_event.archived_at` (at most one
--      event per conversation per the 067 UNIQUE (conversation_id); the
--      view still derives MAX(archived_at) per conversation, mirroring the
--      067 §4.NEW6 state-view join shape, so it stays correct if that
--      UNIQUE ever loosens). The p50/p95 duration percentiles therefore
--      compute (latest archival_event.archived_at per conversation) -
--      amc.created_at, filtered to conversations WHOSE ARCHIVAL EVENT
--      LANDED in the last 24h (the spec's `ended_at IS NOT NULL AND
--      created_at > now()-24h` filter is re-anchored on archived_at —
--      a conversation created >24h ago but archived within the window
--      counts toward the last-24h duration percentiles, matching the
--      SI-023 Surface 3 "last-24h aggregate" semantics).
--
--   Additionally (065 §1 precedent): the single-query spec body is
--   decomposed into independent per-tenant CTEs (P-042 R3 HIGH-1
--   anti-join-multiplication discipline), preserving the ratified output
--   columns exactly.
--
-- Data-minimization note: the wrapper-owner base-table grants (§1) cover
-- ai_mode1_conversation + ai_mode1_conversation_archival_event +
-- audit_records ONLY — none carries Mode 1 message text. The
-- message-bearing tables (ai_mode1_conversation_turn_admission /
-- ai_mode1_conversation_turn_result) are NOT granted and the view never
-- touches them. admin_basic_operator is NOT made a member of
-- ai_mode1_reader and gains NO direct read access to any ai_mode1_* table
-- (P-042 R1 HIGH-2 closure preserved) — its sole path is EXECUTE on the
-- §2 SECDEF wrapper.
--
-- Housekeeping note: migrations 044 §5 + 065 §3 carry informational
-- RAISE NOTICE probes ("read_admin_mode1_volume_health() exists; update
-- this verification block") — those are NOTICEs, not errors, and in a
-- fresh 000 → head apply they never fire (044 and 065 run BEFORE this
-- migration creates the wrapper). Merged migrations are not edited
-- (post-cycle rules); this §3 block is the authoritative verification for
-- the new surface.
--
-- Spec:    - SI-023 Admin Backend Basics v1.0 (RATIFIED P-041) §3.5 + §5
--            endpoint 3 (final SI-023 §5 endpoint)
--          - CDM v1.10 → v1.11 Amendment §4.NEW7 + §4.NEW8d (RATIFIED
--            2026-05-22 P-042)
--          - migrations 039 (owner roles pre-created) + 041 §3 + 044 §4
--            (deferral prescriptions this migration executes)
--          - CDM v1.7 → v1.8 Amendment (RATIFIED P-036/P-036a) — the
--            ai_mode1_conversation + archival-event entities (migration 067)
--          - I-023, I-025, I-027
-- Preconditions: 002 (audit_records) + 031 (SI-010 helpers) + 039 (admin
--   RBAC roles incl. admin_mode1_volume_health_view_owner +
--   read_admin_mode1_volume_health_wrapper_owner) + 040
--   (admin_dashboard_query_execution) + 067 (ai_mode1_conversation +
--   ai_mode1_conversation_archival_event) applied.
-- =============================================================================

-- =============================================================================
-- §1 — admin_mode1_volume_health_v (CDM §4.NEW7; Option-2 adapted)
--
-- Per-tenant last-24h Mode 1 rollup with metrics decomposed into
-- independent per-tenant CTEs (P-042 R3 HIGH-1 discipline via the 065 §1
-- precedent). Output columns are EXACTLY the ratified §4.NEW7 five-metric
-- contract (SI-023 Surface 3).
-- =============================================================================

CREATE VIEW admin_mode1_volume_health_v
WITH (security_invoker = true, security_barrier = true)
AS
WITH tenant_scope AS (
    SELECT current_tenant_id() AS tenant_id
),
conversation_volume AS (
    SELECT amc.tenant_id,
           COUNT(*) FILTER (WHERE amc.created_at > now() - INTERVAL '24 hours')
               AS active_conversation_count_24h
      FROM public.ai_mode1_conversation amc
      JOIN tenant_scope ts ON ts.tenant_id = amc.tenant_id
     GROUP BY amc.tenant_id
),
-- Adaptation 3: unprefixed `crisis_detection_trigger` is the Cat A action
-- the code repo emits today (spec: `mode1.crisis_detection_trigger`).
crisis_trigger_audit_24h AS (
    SELECT ar.tenant_id, COUNT(*) AS audit_count
      FROM public.audit_records ar
      JOIN tenant_scope ts ON ts.tenant_id = ar.tenant_id
     WHERE ar.action = 'crisis_detection_trigger'
       AND ar.recorded_at > now() - INTERVAL '24 hours'
     GROUP BY ar.tenant_id
),
-- Adaptation 3: no dedicated safety-floor action ID exists today; the
-- safety-floor response is the `ai_chat_response_emitted` envelope with
-- escalation_triggered = true in its detail payload (spec:
-- `mode1.safety_floor_response_emitted`).
safety_floor_audit_24h AS (
    SELECT ar.tenant_id, COUNT(*) AS audit_count
      FROM public.audit_records ar
      JOIN tenant_scope ts ON ts.tenant_id = ar.tenant_id
     WHERE ar.action = 'ai_chat_response_emitted'
       AND (ar.payload ->> 'escalation_triggered')::BOOLEAN IS TRUE
       AND ar.recorded_at > now() - INTERVAL '24 hours'
     GROUP BY ar.tenant_id
),
-- Adaptation 4: duration = (latest archival_event.archived_at per
-- conversation) - created_at; window anchored on archived_at. The
-- aggregate-only LATERAL always returns exactly one row (JOIN ... ON TRUE
-- keeps 1:1 with the conversation row; a NULL latest_archived_at fails the
-- WHERE comparison), mirroring the 067 §4.NEW6 MAX(archived_at) shape.
conversation_duration_24h AS (
    SELECT amc.tenant_id,
           percentile_cont(0.50) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (arch.latest_archived_at - amc.created_at))
           )::NUMERIC(10,2) AS conversation_duration_p50_seconds_24h,
           percentile_cont(0.95) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (arch.latest_archived_at - amc.created_at))
           )::NUMERIC(10,2) AS conversation_duration_p95_seconds_24h
      FROM public.ai_mode1_conversation amc
      JOIN tenant_scope ts ON ts.tenant_id = amc.tenant_id
      JOIN LATERAL (
          SELECT MAX(a.archived_at) AS latest_archived_at
            FROM public.ai_mode1_conversation_archival_event a
           WHERE a.tenant_id = amc.tenant_id AND a.conversation_id = amc.id
      ) arch ON TRUE
     WHERE arch.latest_archived_at > now() - INTERVAL '24 hours'
     GROUP BY amc.tenant_id
)
SELECT
    cv.tenant_id,
    cv.active_conversation_count_24h,
    COALESCE(cta.audit_count, 0) AS crisis_detection_trigger_count_24h,
    COALESCE(sfa.audit_count, 0) AS safety_floor_response_emitted_count_24h,
    cd.conversation_duration_p50_seconds_24h,
    cd.conversation_duration_p95_seconds_24h
FROM conversation_volume cv
LEFT JOIN crisis_trigger_audit_24h cta ON cta.tenant_id = cv.tenant_id
LEFT JOIN safety_floor_audit_24h sfa ON sfa.tenant_id = cv.tenant_id
LEFT JOIN conversation_duration_24h cd ON cd.tenant_id = cv.tenant_id;

COMMENT ON VIEW admin_mode1_volume_health_v IS
    'P-042 §4.NEW7 (Option-2 adapted per migration 041 §1 / 065 §1 conventions '
    '+ the 069-header action-ID and ended_at→archival adaptations). '
    'Tenant-scoped last-24h Mode 1 volume + safety-floor rollup (SI-023 '
    'Surface 3). security_invoker=true — SELECT runs with querying-role '
    'privileges; the SOLE application read path is '
    'read_admin_mode1_volume_health() (044 §1 wrapper-only discipline). '
    'Unlocked from the 041 §3 deferral after the P-036 Mode 1 entities landed '
    'at migrations 066-068. Audit filters widen/rename when the ai.mode1.* '
    'catalog registration lands (see migration 069 header adaptation 3).';

-- Ownership per 041 §3 deferral step (c); grant matrix per step (d) + §7
-- invariant (no other role holds SELECT).
ALTER VIEW admin_mode1_volume_health_v OWNER TO admin_mode1_volume_health_view_owner;
REVOKE ALL ON admin_mode1_volume_health_v FROM PUBLIC;
GRANT SELECT ON admin_mode1_volume_health_v TO read_admin_mode1_volume_health_wrapper_owner;

-- security_invoker=true → the querying role (the SECDEF wrapper's owner)
-- needs SELECT on the underlying base tables (041 §1 R1 HIGH-1 pattern /
-- 065 §1 precedent). RLS still scopes every read to the GUC-bound tenant
-- (the wrapper-owner is NOBYPASSRLS per migration 039; the ai_mode1_*
-- tables are FORCE RLS per migration 067). Neither ai_mode1 table below
-- carries message text (see header data-minimization note).
GRANT SELECT ON ai_mode1_conversation
    TO read_admin_mode1_volume_health_wrapper_owner;
GRANT SELECT ON ai_mode1_conversation_archival_event
    TO read_admin_mode1_volume_health_wrapper_owner;
GRANT SELECT ON audit_records
    TO read_admin_mode1_volume_health_wrapper_owner;

-- =============================================================================
-- §2 — read_admin_mode1_volume_health() (CDM §4.NEW8d; Option-2 adapted
--      per the 044 §1 crisis-wrapper + 065 §2 consult-wrapper conventions)
-- =============================================================================

CREATE OR REPLACE FUNCTION read_admin_mode1_volume_health(
    p_tenant_id           TEXT,
    p_query_params_jsonb  JSONB
) RETURNS TABLE (
    tenant_id                                TEXT,
    active_conversation_count_24h            BIGINT,
    crisis_detection_trigger_count_24h       BIGINT,
    safety_floor_response_emitted_count_24h  BIGINT,
    conversation_duration_p50_seconds_24h    NUMERIC,
    conversation_duration_p95_seconds_24h    NUMERIC
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
            'read_admin_mode1_volume_health: no actor tenant bound for current backend; authContextPlugin must bind before SECDEF wrapper invocation'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION
            'read_admin_mode1_volume_health: tenant scope mismatch — actor tenant % does not match wrapper p_tenant_id %; cross-tenant read rejected',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    -- Internal executor binding from SI-010 (caller cannot forge).
    v_executor_principal_id := current_actor_account_id();
    IF v_executor_principal_id IS NULL THEN
        RAISE EXCEPTION
            'read_admin_mode1_volume_health: no actor account bound for current backend'
            USING ERRCODE = '42501';
    END IF;

    -- Capture the view body into a TEMP table (044 §1 R1 MED-1 pattern:
    -- DROP IF EXISTS first so repeat calls within one tx are safe;
    -- ON COMMIT DROP for cleanup). TEMP-table name per the ratified
    -- §4.NEW8d body.
    DROP TABLE IF EXISTS pg_temp._admin_mode1_query_result;
    CREATE TEMP TABLE _admin_mode1_query_result ON COMMIT DROP AS
        SELECT * FROM admin_mode1_volume_health_v v
         WHERE v.tenant_id = p_tenant_id;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;

    -- Co-transactional I-027 read-trail row (rolls back with the wrapper).
    INSERT INTO admin_dashboard_query_execution
        (tenant_id, executor_principal_id, dashboard_name, query_params_jsonb, row_count)
    VALUES
        (p_tenant_id, v_executor_principal_id, 'admin_mode1_volume_health_v',
         p_query_params_jsonb, v_row_count);

    RETURN QUERY SELECT * FROM _admin_mode1_query_result;
END;
$$;

ALTER FUNCTION read_admin_mode1_volume_health(TEXT, JSONB)
    OWNER TO read_admin_mode1_volume_health_wrapper_owner;

-- DML grants (044 §2 / 065 §2 pattern): audit-trail INSERT + BIGSERIAL
-- sequence USAGE + SI-010 helper EXECUTE.
GRANT INSERT ON admin_dashboard_query_execution
    TO read_admin_mode1_volume_health_wrapper_owner;
GRANT USAGE ON SEQUENCE admin_dashboard_query_execution_id_seq
    TO read_admin_mode1_volume_health_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id()
    TO read_admin_mode1_volume_health_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()
    TO read_admin_mode1_volume_health_wrapper_owner;

-- LAYER A anti-bypass: ONLY admin_basic_operator can EXECUTE.
REVOKE EXECUTE ON FUNCTION read_admin_mode1_volume_health(TEXT, JSONB)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_admin_mode1_volume_health(TEXT, JSONB)
    TO admin_basic_operator;

COMMENT ON FUNCTION read_admin_mode1_volume_health(TEXT, JSONB) IS
    'P-042 §4.NEW8d + SI-023 Sub-decision 3.5 mode1-volume-health dashboard '
    'read wrapper (Option-2 adapted per 044 §1 / 065 §2 conventions). '
    'SECURITY DEFINER + locked search_path. SOLE caller path into '
    'admin_mode1_volume_health_v. LAYER C tenant scope via SI-010; LAYER A '
    'EXECUTE ONLY admin_basic_operator; LAYER B + Cat A audit emission at '
    'the application layer. Co-transactional admin_dashboard_query_execution '
    'INSERT satisfies I-027 on the read path. Unlocked from the 044 §4 '
    'deferral — the LAST deferred SI-023 §5 dashboard surface.';

-- =============================================================================
-- §3 — Verification (044 §5 / 065 §3 pattern, scoped to the new surface)
-- =============================================================================

DO $$
DECLARE
    v_oid                  OID := to_regprocedure(
        'public.read_admin_mode1_volume_health(text, jsonb)'
    );
    v_owner                TEXT;
    v_security_definer     BOOLEAN;
    v_proconfig            TEXT[];
    v_specific_name        TEXT;
    v_unauthorized_grantee TEXT;
    v_view_owner           TEXT;
BEGIN
    -- ---------- view ----------
    IF to_regclass('public.admin_mode1_volume_health_v') IS NULL THEN
        RAISE EXCEPTION 'migration-069-view-missing: admin_mode1_volume_health_v not created';
    END IF;
    SELECT r.rolname INTO v_view_owner
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
     WHERE c.oid = 'public.admin_mode1_volume_health_v'::regclass;
    IF v_view_owner <> 'admin_mode1_volume_health_view_owner' THEN
        RAISE EXCEPTION
            'migration-069-view-ownership-mismatch: view owner is % but MUST be admin_mode1_volume_health_view_owner',
            v_view_owner;
    END IF;
    -- Grant matrix: ONLY the wrapper-owner (and the owner itself) may SELECT.
    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_table_grants g
         WHERE g.table_schema = 'public'
           AND g.table_name = 'admin_mode1_volume_health_v'
           AND g.privilege_type = 'SELECT'
           AND g.grantee NOT IN ('admin_mode1_volume_health_view_owner',
                                 'read_admin_mode1_volume_health_wrapper_owner')
    LOOP
        RAISE EXCEPTION
            'migration-069-view-grant-violation: SELECT granted to non-canonical role %',
            v_unauthorized_grantee;
    END LOOP;

    -- ---------- wrapper ----------
    IF v_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-069-function-missing: read_admin_mode1_volume_health(text, jsonb) not found by signature';
    END IF;
    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_owner, v_security_definer, v_proconfig
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_oid;
    IF v_owner <> 'read_admin_mode1_volume_health_wrapper_owner' THEN
        RAISE EXCEPTION
            'migration-069-ownership-mismatch: ownership is % but MUST be read_admin_mode1_volume_health_wrapper_owner',
            v_owner;
    END IF;
    IF NOT v_security_definer THEN
        RAISE EXCEPTION 'migration-069-security-definer-missing: wrapper MUST be SECURITY DEFINER';
    END IF;
    IF v_proconfig IS NULL
       OR NOT (v_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-069-search-path-not-locked: proconfig must contain "search_path=pg_catalog, public"; found %',
            v_proconfig;
    END IF;

    SELECT p.proname || '_' || p.oid::TEXT INTO v_specific_name
      FROM pg_proc p WHERE p.oid = v_oid;
    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_routine_grants g
         WHERE g.specific_name = v_specific_name
           AND g.privilege_type = 'EXECUTE'
           AND g.grantee NOT IN ('read_admin_mode1_volume_health_wrapper_owner',
                                 'admin_basic_operator')
    LOOP
        RAISE EXCEPTION
            'migration-069-execute-grant-violation: wrapper EXECUTE granted to non-canonical role %',
            v_unauthorized_grantee;
    END LOOP;

    -- Sequence USAGE (044 §5 runtime-failure guard).
    IF NOT has_sequence_privilege(
        'read_admin_mode1_volume_health_wrapper_owner',
        'public.admin_dashboard_query_execution_id_seq',
        'USAGE'
    ) THEN
        RAISE EXCEPTION
            'migration-069-sequence-usage-missing: wrapper-owner lacks USAGE on admin_dashboard_query_execution_id_seq';
    END IF;

    -- Base-table SELECTs for security_invoker=true execution.
    IF NOT (
        has_table_privilege('read_admin_mode1_volume_health_wrapper_owner', 'public.ai_mode1_conversation', 'SELECT')
        AND has_table_privilege('read_admin_mode1_volume_health_wrapper_owner', 'public.ai_mode1_conversation_archival_event', 'SELECT')
        AND has_table_privilege('read_admin_mode1_volume_health_wrapper_owner', 'public.audit_records', 'SELECT')
    ) THEN
        RAISE EXCEPTION
            'migration-069-base-table-select-missing: wrapper-owner lacks SELECT on one of the 3 view base tables';
    END IF;

    -- Data-minimization negative space: admin_basic_operator gains NO direct
    -- read access to the Mode 1 base tables (P-042 R1 HIGH-2 closure — its
    -- sole path is EXECUTE on the §2 wrapper); and the wrapper-owner is NOT
    -- granted the message-bearing turn tables.
    IF has_table_privilege('admin_basic_operator', 'public.ai_mode1_conversation', 'SELECT')
       OR has_table_privilege('admin_basic_operator', 'public.ai_mode1_conversation_archival_event', 'SELECT') THEN
        RAISE EXCEPTION
            'migration-069-operator-base-table-leak: admin_basic_operator has direct SELECT on a Mode 1 base table (forbidden per P-042 R1 HIGH-2)';
    END IF;
    IF has_table_privilege('read_admin_mode1_volume_health_wrapper_owner', 'public.ai_mode1_conversation_turn_admission', 'SELECT')
       OR has_table_privilege('read_admin_mode1_volume_health_wrapper_owner', 'public.ai_mode1_conversation_turn_result', 'SELECT') THEN
        RAISE EXCEPTION
            'migration-069-message-table-leak: wrapper-owner has SELECT on a message-bearing Mode 1 turn table (view never touches them; forbidden per the 069 data-minimization note)';
    END IF;

    RAISE NOTICE 'migration-069: verification passed (mode1-volume-health view + wrapper unlocked — LAST deferred admin dashboard surface)';
END $$;
