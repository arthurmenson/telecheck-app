-- SI-020 subdecision 10: persisted provider intent before consult; only a
-- verified Billing observation advances initiated -> intake. Historical opaque
-- references are retained, explicitly unverified, and cannot pass the new gate.
SET LOCAL search_path = pg_catalog, public, pg_temp;
ALTER TABLE public.consult DROP CONSTRAINT consult_payment_provider_check;
ALTER TABLE public.consult ADD CONSTRAINT consult_payment_provider_check
  CHECK (payment_provider IN ('stripe', 'paystack', 'mtn_momo', 'flutterwave', 'mock_local_dev'));
ALTER TABLE public.consult ADD COLUMN payment_purpose TEXT NOT NULL DEFAULT 'async_consult' CHECK (payment_purpose = 'async_consult');
ALTER TABLE public.consult ADD CONSTRAINT consult_billing_subject_purpose_fk
  FOREIGN KEY (tenant_id, patient_id, payment_intent_id, payment_purpose)
  REFERENCES public.billing_payment_intent(tenant_id, patient_id, id, purpose) NOT VALID;
CREATE UNIQUE INDEX consult_one_per_payment_intent ON public.consult(tenant_id, payment_intent_id);
GRANT SELECT ON public.billing_payment_intent, public.billing_consult_price TO billing_consult_owner;
GRANT SELECT, INSERT ON public.consult TO billing_consult_owner;
GRANT SELECT, INSERT ON public.consult_lifecycle_transition TO billing_consult_owner;
GRANT EXECUTE ON FUNCTION public.record_consult_lifecycle_transition(VARCHAR,TEXT,VARCHAR,TEXT,TEXT,VARCHAR,TEXT,JSONB) TO billing_consult_owner;

-- The old signature accepted caller-controlled money and had no payment FK.
-- Retain it owner-only for schema history; normal human ingress cannot call it.
REVOKE ALL ON FUNCTION public.record_consult_initiation(VARCHAR,TEXT,VARCHAR,VARCHAR,TEXT,TEXT,TEXT,INTEGER,TEXT,VARCHAR,TEXT,TIMESTAMPTZ,VARCHAR,VARCHAR,TEXT)
  FROM PUBLIC, async_consult_patient_initiator, async_consult_delegate_initiator, telecheck_app_role;

CREATE FUNCTION public.record_billed_consult_initiation(p_consult_id VARCHAR, p_payment_id VARCHAR, p_transition_id VARCHAR)
RETURNS TABLE (consult_id VARCHAR, created BOOLEAN, expected_turnaround_at TIMESTAMPTZ)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a RECORD; p RECORD; c RECORD; due TIMESTAMPTZ;
BEGIN
  SELECT * INTO STRICT a FROM public.billing_current_actor();
  IF a.actor_role <> 'patient' THEN RAISE EXCEPTION 'billing_actor_unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM pg_advisory_xact_lock(('x' || substr(md5('billing_intent:' || a.tenant_id || ':' || p_payment_id),1,16))::bit(64)::bigint);
  PERFORM 1 FROM public.billing_current_actor();
  SELECT i.*, pr.consult_type, pr.program_id, pr.amount_minor, pr.currency, pr.provider, pr.turnaround_minutes
    INTO p FROM public.billing_payment_intent i
    JOIN public.billing_consult_price pr ON (pr.tenant_id,pr.id) = (i.tenant_id,i.price_id)
    WHERE i.tenant_id = a.tenant_id AND i.id = p_payment_id AND i.patient_id = a.account_id
      AND i.purpose = 'async_consult' AND i.provider_created_at IS NOT NULL
      AND i.status IN ('requires_payment','paid');
  IF NOT FOUND THEN RAISE EXCEPTION 'billing_payment_unavailable' USING ERRCODE = '42501'; END IF;
  SELECT c0.id, c0.expected_turnaround_at INTO c FROM public.consult c0
    WHERE c0.tenant_id = a.tenant_id AND c0.payment_intent_id = p_payment_id;
  IF FOUND THEN
    PERFORM 1 FROM public.billing_current_actor();
    RETURN QUERY SELECT c.id, FALSE, c.expected_turnaround_at; RETURN;
  END IF;
  due := clock_timestamp() + p.turnaround_minutes * interval '1 minute';
  INSERT INTO public.consult(id,tenant_id,patient_id,delegate_id,consult_type,program_id,initiation_source,
    consult_fee_cents,currency,payment_intent_id,payment_provider,expected_turnaround_at)
    VALUES(p_consult_id,a.tenant_id,a.account_id,NULL,p.consult_type,p.program_id,p.initiation_source,
      p.amount_minor,p.currency,p_payment_id,p.provider,due);
  PERFORM public.record_consult_lifecycle_transition(p_transition_id,a.tenant_id,p_consult_id,'initiated','initiation',a.account_id::VARCHAR,'patient','{}'::JSONB);
  PERFORM 1 FROM public.billing_current_actor();
  RETURN QUERY SELECT p_consult_id, TRUE, due;
END $$;
ALTER FUNCTION public.record_billed_consult_initiation(VARCHAR,VARCHAR,VARCHAR) OWNER TO billing_consult_owner;
REVOKE ALL ON FUNCTION public.record_billed_consult_initiation(VARCHAR,VARCHAR,VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_billed_consult_initiation(VARCHAR,VARCHAR,VARCHAR) TO async_consult_patient_initiator;

-- Caller rechecks after the entire local audit/outbox/cache operation, including
-- a blocked cache replay. This function reveals no private Billing contents.
CREATE FUNCTION public.billing_assert_live_patient() RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a RECORD;
BEGIN
  SELECT * INTO STRICT a FROM public.billing_current_actor();
  IF a.actor_role <> 'patient' THEN RAISE EXCEPTION 'billing_actor_unavailable' USING ERRCODE = '42501'; END IF;
END $$;
ALTER FUNCTION public.billing_assert_live_patient() OWNER TO billing_consult_owner;
REVOKE ALL ON FUNCTION public.billing_assert_live_patient() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_assert_live_patient() TO async_consult_patient_initiator;

CREATE FUNCTION public.billing_guard_paid_intake() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.to_state = 'intake' AND NOT EXISTS (
    SELECT 1 FROM public.consult c JOIN public.billing_payment_intent p
      ON (p.tenant_id,p.id,p.patient_id,p.purpose) = (c.tenant_id,c.payment_intent_id,c.patient_id,c.payment_purpose)
    WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.consult_id
      AND p.status = 'paid' AND p.verified_at IS NOT NULL AND p.provider_created_at IS NOT NULL
  ) THEN RAISE EXCEPTION 'billing_payment_required' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.billing_guard_paid_intake() OWNER TO billing_consult_owner;
REVOKE ALL ON FUNCTION public.billing_guard_paid_intake() FROM PUBLIC;
CREATE TRIGGER billing_guard_paid_intake BEFORE INSERT ON public.consult_lifecycle_transition
  FOR EACH ROW EXECUTE FUNCTION public.billing_guard_paid_intake();

CREATE FUNCTION public.billing_apply_verified_payment(p_payment_id VARCHAR,p_transition_id VARCHAR)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE c RECORD; prior RECORD; t TEXT;
BEGIN
  -- No request nonce is invented for a signed provider event. Only the isolated
  -- Billing service login can invoke this narrowly constrained system operation.
  IF session_user <> 'billing_service_role' THEN RAISE EXCEPTION 'billing_service_required' USING ERRCODE = '42501'; END IF;
  t := public.current_tenant_id();
  PERFORM pg_advisory_xact_lock(('x' || substr(md5('billing_intent:' || t || ':' || p_payment_id),1,16))::bit(64)::bigint);
  SELECT c0.* INTO c FROM public.consult c0 JOIN public.billing_payment_intent p
    ON (p.tenant_id,p.id,p.patient_id,p.purpose) = (c0.tenant_id,c0.payment_intent_id,c0.patient_id,c0.payment_purpose)
    WHERE c0.tenant_id = t AND p.id = p_payment_id AND p.status = 'paid'
      AND p.verified_at IS NOT NULL AND p.provider_created_at IS NOT NULL;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  PERFORM pg_advisory_xact_lock(('x' || substr(md5('consult_lifecycle_transition:' || t || ':' || c.id),1,16))::bit(64)::bigint);
  SELECT l.to_state,l.transition_at INTO prior FROM public.consult_lifecycle_transition l
    WHERE l.tenant_id = t AND l.consult_id = c.id ORDER BY l.transition_at DESC,l.id DESC LIMIT 1;
  IF prior.to_state IS DISTINCT FROM 'initiated' THEN RETURN FALSE; END IF;
  INSERT INTO public.consult_lifecycle_transition(id,tenant_id,consult_id,from_state,to_state,transition_reason,
    transition_at,transition_by_actor_id,transition_by_actor_role,metadata)
    VALUES(p_transition_id,t,c.id,'initiated','intake','intake_started',
      GREATEST(clock_timestamp(),prior.transition_at + interval '1 microsecond'),NULL,'system',
      jsonb_build_object('payment_intent_id',p_payment_id,'verified_by','billing'));
  RETURN TRUE;
END $$;
ALTER FUNCTION public.billing_apply_verified_payment(VARCHAR,VARCHAR) OWNER TO billing_consult_owner;
REVOKE ALL ON FUNCTION public.billing_apply_verified_payment(VARCHAR,VARCHAR) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_apply_verified_payment(VARCHAR,VARCHAR) TO billing_service_role;
