-- Patient-owned discovery of already accepted consultation payments. Provider
-- credentials and raw Billing rows remain inaccessible to the app login.
SET LOCAL search_path=pg_catalog,public,pg_temp;
CREATE FUNCTION public.billing_patient_consult_payments(p_offset INTEGER) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a RECORD; after_actor RECORD; page JSONB; unresolved BOOLEAN;
BEGIN
  SELECT * INTO STRICT a FROM public.billing_current_actor();
  IF a.actor_role<>'patient' THEN RAISE EXCEPTION 'billing_actor_unavailable' USING ERRCODE='42501'; END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_offset>10000 THEN RAISE EXCEPTION 'billing_page_invalid' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(jsonb_agg(item ORDER BY accepted_at DESC,id DESC),'[]'::JSONB) INTO page FROM (
    SELECT i.accepted_at,i.id,jsonb_build_object('payment_intent_id',i.id,'consult_id',c.id,
      'payment_status',i.status,'accepted_at',i.accepted_at,
      'price',jsonb_build_object('amount_minor',p.amount_minor,'currency',p.currency,'provider',p.provider,'mode',p.provider_mode),
      'resume_available',i.status IN ('creating','creation_unknown','requires_payment','paid')) AS item
    FROM public.billing_payment_intent i
    JOIN public.billing_consult_price p ON (p.tenant_id,p.id)=(i.tenant_id,i.price_id)
    LEFT JOIN public.consult c ON (c.tenant_id,c.payment_intent_id,c.patient_id)=(i.tenant_id,i.id,i.patient_id)
    WHERE i.tenant_id=a.tenant_id AND i.patient_id=a.account_id AND i.purpose='async_consult' AND p.country_of_care=a.country_of_care
    ORDER BY i.accepted_at DESC,i.id DESC LIMIT 26 OFFSET p_offset
  ) rows;
  SELECT EXISTS (
    SELECT 1 FROM public.billing_payment_intent i
    JOIN public.billing_consult_price p ON (p.tenant_id,p.id)=(i.tenant_id,i.price_id)
    LEFT JOIN public.consult c ON (c.tenant_id,c.payment_intent_id,c.patient_id)=(i.tenant_id,i.id,i.patient_id)
    WHERE i.tenant_id=a.tenant_id AND i.patient_id=a.account_id AND i.purpose='async_consult'
      AND p.country_of_care=a.country_of_care
      AND (i.status IN ('creating','creation_unknown','requires_payment') OR (i.status='paid' AND c.id IS NULL))
  ) INTO unresolved;
  SELECT * INTO STRICT after_actor FROM public.billing_current_actor();
  IF after_actor IS DISTINCT FROM a THEN RAISE EXCEPTION 'billing_actor_unavailable' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('items',CASE WHEN jsonb_array_length(page)>25 THEN page-25 ELSE page END,
    'offset',p_offset,'limit',25,'has_more',jsonb_array_length(page)>25,'has_unresolved_payment',unresolved);
END $$;
ALTER FUNCTION public.billing_patient_consult_payments(INTEGER) OWNER TO billing_consult_owner;
REVOKE ALL ON FUNCTION public.billing_patient_consult_payments(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_patient_consult_payments(INTEGER) TO billing_service_role;
