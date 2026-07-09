-- =============================================================================
-- File:    migrations/073_mode1_dashboard_tenant_scope_anchor.sql
-- Purpose: Close Codex Phase-D sweep R1 HIGH finding (2026-07-08): the
--          migration 069 admin_mode1_volume_health_v anchored its final
--          projection on `conversation_volume`, so a tenant whose ONLY
--          Mode 1 activity in the window is audit-emitted crisis responses
--          WITHOUT persisted conversation rows (the chat handler's
--          documented skip path: crisis-positive request with a malformed
--          or unowned ai_chat_session_id still emits the
--          ai_chat_response_emitted audit but persists nothing) returned
--          NO row — hiding the crisis-floor response count from the
--          operator dashboard. A crisis-observability blind spot
--          (I-019-adjacent).
--
--          Fix per the finding's recommendation: CREATE OR REPLACE the
--          view with the final SELECT anchored on `tenant_scope`, LEFT
--          JOINing conversation_volume + crisis_trigger_audit_24h +
--          safety_floor_audit_24h + conversation_duration_24h, with
--          COALESCE-to-zero counts. All CTE bodies + the 069-header
--          adaptations (action-ID adaptation 3; ended_at→archival
--          adaptation 4) are UNCHANGED; only the anchor moved. Ownership,
--          security_invoker posture, and the grant matrix are preserved
--          by CREATE OR REPLACE (069 §1 ownership re-asserted defensively).
--
-- Spec:    P-042 §4.NEW7 (RATIFIED); migration 069 §1; Codex Phase-D sweep
--          R1 (base 8dd6e9a, 2026-07-08) HIGH finding 1.
-- Preconditions: 069 applied.
-- =============================================================================

CREATE OR REPLACE VIEW admin_mode1_volume_health_v
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
-- Adaptation 3 (069): unprefixed `crisis_detection_trigger` is the Cat A
-- action the code repo emits today (spec: `mode1.crisis_detection_trigger`).
crisis_trigger_audit_24h AS (
    SELECT ar.tenant_id, COUNT(*) AS audit_count
      FROM public.audit_records ar
      JOIN tenant_scope ts ON ts.tenant_id = ar.tenant_id
     WHERE ar.action = 'crisis_detection_trigger'
       AND ar.recorded_at > now() - INTERVAL '24 hours'
     GROUP BY ar.tenant_id
),
-- Adaptation 3 (069): no dedicated safety-floor action ID exists today; the
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
-- Adaptation 4 (069): duration = (latest archival_event.archived_at per
-- conversation) - created_at; window anchored on archived_at.
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
-- 073 fix: anchor on tenant_scope (not conversation_volume) so audit-only
-- crisis activity — the chat handler's documented skipped-persistence
-- path — still surfaces. COALESCE keeps counts zero-valued, never absent.
SELECT
    ts.tenant_id,
    COALESCE(cv.active_conversation_count_24h, 0) AS active_conversation_count_24h,
    COALESCE(cta.audit_count, 0) AS crisis_detection_trigger_count_24h,
    COALESCE(sfa.audit_count, 0) AS safety_floor_response_emitted_count_24h,
    cd.conversation_duration_p50_seconds_24h,
    cd.conversation_duration_p95_seconds_24h
FROM tenant_scope ts
LEFT JOIN conversation_volume cv ON cv.tenant_id = ts.tenant_id
LEFT JOIN crisis_trigger_audit_24h cta ON cta.tenant_id = ts.tenant_id
LEFT JOIN safety_floor_audit_24h sfa ON sfa.tenant_id = ts.tenant_id
LEFT JOIN conversation_duration_24h cd ON cd.tenant_id = ts.tenant_id;

COMMENT ON VIEW admin_mode1_volume_health_v IS
    'P-042 §4.NEW7 (Option-2 adapted per migration 041 §1 / 065 §1 conventions '
    '+ the 069-header action-ID and ended_at→archival adaptations; 072 '
    're-anchored the final projection on tenant_scope per the Codex Phase-D '
    'R1 HIGH crisis-observability finding — audit-only crisis activity now '
    'surfaces with zero-valued conversation counts). Tenant-scoped last-24h '
    'Mode 1 volume + safety-floor rollup (SI-023 Surface 3). '
    'security_invoker=true; SOLE application read path is '
    'read_admin_mode1_volume_health() (044 §1 wrapper-only discipline). '
    'Audit filters widen/rename when the ai.mode1.* catalog registration lands.';

-- CREATE OR REPLACE preserves ownership + ACLs; re-assert the 069 §1
-- posture defensively (drift protection).
ALTER VIEW admin_mode1_volume_health_v OWNER TO admin_mode1_volume_health_view_owner;
REVOKE ALL ON admin_mode1_volume_health_v FROM PUBLIC;
GRANT SELECT ON admin_mode1_volume_health_v TO read_admin_mode1_volume_health_wrapper_owner;

-- =============================================================================
-- Verification
-- =============================================================================
DO $$
DECLARE
    v_owner TEXT;
    v_def   TEXT;
BEGIN
    SELECT r.rolname INTO v_owner
      FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
     WHERE c.oid = 'public.admin_mode1_volume_health_v'::regclass;
    IF v_owner <> 'admin_mode1_volume_health_view_owner' THEN
        RAISE EXCEPTION 'migration-073-ownership-mismatch: view owner is %', v_owner;
    END IF;
    v_def := pg_get_viewdef('public.admin_mode1_volume_health_v'::regclass);
    IF v_def NOT LIKE '%tenant_scope ts%LEFT JOIN conversation_volume%' THEN
        RAISE EXCEPTION 'migration-073-anchor-missing: final projection is not tenant_scope-anchored';
    END IF;
    RAISE NOTICE 'migration-073: verification passed (dashboard anchored on tenant_scope)';
END $$;
