-- =============================================================================
-- rollback/073_rollback.sql — restore the migration 069 §1 view body
-- (conversation_volume-anchored final projection). Restores the pre-073
-- behavior INCLUDING the Codex-flagged crisis-observability blind spot —
-- rollback is for chain hygiene only, not an endorsed operational state.
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
crisis_trigger_audit_24h AS (
    SELECT ar.tenant_id, COUNT(*) AS audit_count
      FROM public.audit_records ar
      JOIN tenant_scope ts ON ts.tenant_id = ar.tenant_id
     WHERE ar.action = 'crisis_detection_trigger'
       AND ar.recorded_at > now() - INTERVAL '24 hours'
     GROUP BY ar.tenant_id
),
safety_floor_audit_24h AS (
    SELECT ar.tenant_id, COUNT(*) AS audit_count
      FROM public.audit_records ar
      JOIN tenant_scope ts ON ts.tenant_id = ar.tenant_id
     WHERE ar.action = 'ai_chat_response_emitted'
       AND (ar.payload ->> 'escalation_triggered')::BOOLEAN IS TRUE
       AND ar.recorded_at > now() - INTERVAL '24 hours'
     GROUP BY ar.tenant_id
),
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

ALTER VIEW admin_mode1_volume_health_v OWNER TO admin_mode1_volume_health_view_owner;
REVOKE ALL ON admin_mode1_volume_health_v FROM PUBLIC;
GRANT SELECT ON admin_mode1_volume_health_v TO read_admin_mode1_volume_health_wrapper_owner;
