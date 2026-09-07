-- Own-patient durable crisis status recovery. This does not associate an event
-- with an unvalidated consultation URL or assert human contact/delivery.
SET LOCAL search_path=pg_catalog,public,pg_temp;
CREATE FUNCTION public.crisis_care_patient_history(p_offset INTEGER) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; result JSONB;
BEGIN
  a:=public.crisis_care_live_patient();
  IF p_offset IS NULL OR p_offset<0 OR p_offset>10000 THEN
    RAISE EXCEPTION 'crisis_page_invalid' USING ERRCODE='22023';
  END IF;
  WITH owned AS MATERIALIZED (
    SELECT c.id,c.detected_at,l.to_state,
      jsonb_build_object('crisis_event_id',c.id,'detected_at',c.detected_at,
        'current_state',COALESCE(l.to_state,'unknown'),'state_changed_at',l.transition_at) AS item
    FROM public.crisis_event c
    LEFT JOIN LATERAL (
      SELECT t.to_state,t.transition_at FROM public.crisis_event_lifecycle_transition t
      WHERE t.tenant_id=c.tenant_id AND t.crisis_event_id=c.id
      ORDER BY t.transition_at DESC,t.id DESC LIMIT 1
    ) l ON TRUE
    WHERE c.tenant_id=a->>'tenant_id' AND c.patient_account_id=a->>'account_id'
  ), page AS (
    SELECT * FROM owned ORDER BY detected_at DESC,id DESC LIMIT 26 OFFSET p_offset
  )
  SELECT jsonb_build_object(
    'items',COALESCE((SELECT jsonb_agg(item ORDER BY detected_at DESC,id DESC) FROM
      (SELECT * FROM page ORDER BY detected_at DESC,id DESC LIMIT 25) limited),'[]'::JSONB),
    'offset',p_offset,'limit',25,'has_more',(SELECT count(*)>25 FROM page),
    'active_event',(SELECT item FROM owned WHERE to_state IS DISTINCT FROM 'resolved'
      ORDER BY detected_at DESC,id DESC LIMIT 1)
  ) INTO result;
  IF public.crisis_care_live_patient() IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'crisis_unauthenticated' USING ERRCODE='PT401';
  END IF;
  RETURN result;
END $$;
ALTER FUNCTION public.crisis_care_patient_history(INTEGER) OWNER TO crisis_care_owner;
REVOKE ALL ON FUNCTION public.crisis_care_patient_history(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crisis_care_patient_history(INTEGER) TO crisis_care_patient;
