-- Engineering amendment: keyword detection does not establish clinical imminence.
-- See docs/SI-026-Patient-Crisis-Admission.md. No trigger text is retained.
SET LOCAL search_path = pg_catalog, public, pg_temp;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crisis_care_owner') THEN CREATE ROLE crisis_care_owner NOLOGIN NOINHERIT; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='crisis_care_patient') THEN CREATE ROLE crisis_care_patient NOLOGIN NOINHERIT; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO crisis_care_owner, crisis_care_patient;
GRANT crisis_care_patient TO telecheck_app_role;
GRANT EXECUTE ON FUNCTION public.current_tenant_id(), public.kms_current_actor_context() TO crisis_care_owner;
GRANT SELECT (tenant_id,account_id,country_of_care) ON public.accounts TO crisis_care_owner;

ALTER TABLE public.crisis_event DROP CONSTRAINT crisis_event_crisis_type_check;
ALTER TABLE public.crisis_event ADD CONSTRAINT crisis_event_crisis_type_check CHECK (crisis_type IN (
  'suicidal_ideation','self_harm','violence_threat','medical_emergency',
  'severe_psychological_distress','protocol_safety_floor_breach','abuse_disclosure','general_crisis'));
ALTER TABLE public.crisis_event DROP CONSTRAINT crisis_event_severity_check;
ALTER TABLE public.crisis_event ADD CONSTRAINT crisis_event_severity_check CHECK (severity IN (
  'non_imminent','imminent','life_threatening','unassessed'));

CREATE TABLE public.crisis_care_admission (
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  patient_account_id VARCHAR(26) NOT NULL,
  crisis_event_id UUID NOT NULL,
  source_surface TEXT NOT NULL CHECK(source_surface IN ('forms','messaging')),
  detector_version TEXT NOT NULL CHECK(detector_version='keyword_engineering_v1'),
  request_key_hash TEXT NOT NULL CHECK(request_key_hash ~ '^[a-f0-9]{64}$'),
  detected_type TEXT NOT NULL CHECK(detected_type IN ('suicidal_ideation','self_harm','abuse_disclosure','medical_emergency','general_crisis')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,crisis_event_id),
  UNIQUE(tenant_id,patient_account_id,source_surface,detected_type,request_key_hash),
  FOREIGN KEY(tenant_id,patient_account_id) REFERENCES public.accounts(tenant_id,account_id),
  FOREIGN KEY(tenant_id,crisis_event_id) REFERENCES public.crisis_event(tenant_id,id)
);
ALTER TABLE public.crisis_care_admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crisis_care_admission FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.crisis_care_admission USING(tenant_id=public.current_tenant_id()) WITH CHECK(tenant_id=public.current_tenant_id());
CREATE TRIGGER crisis_care_admission_immutable BEFORE UPDATE OR DELETE ON public.crisis_care_admission
  FOR EACH ROW EXECUTE FUNCTION public.crisis_event_block_mutation();
GRANT SELECT,INSERT ON public.crisis_care_admission,public.crisis_event TO crisis_care_owner;
GRANT SELECT ON public.crisis_event_lifecycle_transition,public.audit_records,public.domain_events_outbox TO crisis_care_owner;
GRANT EXECUTE ON FUNCTION public.record_crisis_event_lifecycle_transition(TEXT,UUID,TEXT,TEXT,TEXT,TEXT,JSONB) TO crisis_care_owner;

CREATE FUNCTION public.crisis_care_live_patient() RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a RECORD; refreshed RECORD;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'crisis_unavailable' USING ERRCODE='PT503'; END IF;
  BEGIN SELECT * INTO STRICT a FROM public.kms_current_actor_context();
  EXCEPTION WHEN raise_exception OR no_data_found OR invalid_text_representation THEN RAISE EXCEPTION 'crisis_unauthenticated' USING ERRCODE='PT401'; END;
  IF a.actor_role <> 'patient' THEN RAISE EXCEPTION 'crisis_forbidden' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.accounts p WHERE p.tenant_id=a.tenant_id AND p.account_id=a.account_id AND p.country_of_care=a.country_of_care) THEN
    RAISE EXCEPTION 'crisis_unauthenticated' USING ERRCODE='PT401'; END IF;
  BEGIN SELECT * INTO STRICT refreshed FROM public.kms_current_actor_context();
  EXCEPTION WHEN raise_exception OR no_data_found OR invalid_text_representation THEN RAISE EXCEPTION 'crisis_unauthenticated' USING ERRCODE='PT401'; END;
  IF to_jsonb(a) IS DISTINCT FROM to_jsonb(refreshed) THEN RAISE EXCEPTION 'crisis_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN jsonb_build_object('tenant_id',a.tenant_id,'account_id',a.account_id,'session_id',a.session_id,'country_of_care',a.country_of_care);
END $$;
ALTER FUNCTION public.crisis_care_live_patient() OWNER TO crisis_care_owner;
REVOKE ALL ON FUNCTION public.crisis_care_live_patient() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crisis_care_live_patient() TO crisis_care_patient;

CREATE FUNCTION public.crisis_care_record(p_type TEXT,p_source TEXT,p_key_hash TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; event_id UUID; signal_id UUID;
BEGIN
  a:=public.crisis_care_live_patient();
  IF p_type IS NULL OR p_type NOT IN ('suicidal_ideation','self_harm','abuse_disclosure','medical_emergency','general_crisis')
    OR p_source IS NULL OR p_source NOT IN ('forms','messaging') OR p_key_hash IS NULL OR p_key_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'crisis_invalid' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('crisis-care:' || (a->>'tenant_id') || ':' || (a->>'account_id') || ':' || p_source || ':' || p_type || ':' || p_key_hash,0));
  IF public.crisis_care_live_patient() IS DISTINCT FROM a THEN RAISE EXCEPTION 'crisis_unauthenticated' USING ERRCODE='PT401'; END IF;
  SELECT d.crisis_event_id INTO event_id FROM public.crisis_care_admission d
    WHERE d.tenant_id=a->>'tenant_id' AND d.patient_account_id=a->>'account_id'
      AND d.source_surface=p_source AND d.detected_type=p_type AND d.request_key_hash=p_key_hash;
  -- The table lookup can wait after its initial identity snapshot.
  IF public.crisis_care_live_patient() IS DISTINCT FROM a THEN RAISE EXCEPTION 'crisis_unauthenticated' USING ERRCODE='PT401'; END IF;
  IF event_id IS NOT NULL THEN
    IF public.crisis_care_live_patient() IS DISTINCT FROM a THEN RAISE EXCEPTION 'crisis_unauthenticated' USING ERRCODE='PT401'; END IF;
    RETURN jsonb_build_object('crisis_event_id',event_id,'created',false);
  END IF;
  event_id:=gen_random_uuid(); signal_id:=gen_random_uuid();
  INSERT INTO public.crisis_event(id,tenant_id,patient_account_id,server_signal_id,crisis_type,severity,regulatory_reporting_enabled)
    VALUES(event_id,a->>'tenant_id',a->>'account_id',signal_id,p_type,'unassessed',false);
  PERFORM public.record_crisis_event_lifecycle_transition(a->>'tenant_id',event_id,'none','detected','initial_detection',a->>'account_id',
    jsonb_build_object('actor_type','patient','detection_method','keyword_engineering_v1','severity','unassessed','source_surface',p_source));
  INSERT INTO public.crisis_care_admission(tenant_id,patient_account_id,crisis_event_id,source_surface,detector_version,request_key_hash,detected_type)
    VALUES(a->>'tenant_id',a->>'account_id',event_id,p_source,'keyword_engineering_v1',p_key_hash,p_type);
  IF public.crisis_care_live_patient() IS DISTINCT FROM a THEN RAISE EXCEPTION 'crisis_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN jsonb_build_object('crisis_event_id',event_id,'server_signal_id',signal_id,'created',true);
END $$;
ALTER FUNCTION public.crisis_care_record(TEXT,TEXT,TEXT) OWNER TO crisis_care_owner;
REVOKE ALL ON FUNCTION public.crisis_care_record(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.crisis_care_record(TEXT,TEXT,TEXT) TO crisis_care_patient;

-- Direct application-role SQL cannot commit an unaudited or unqueued admission.
CREATE FUNCTION public.crisis_care_require_evidence() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB;
BEGIN
  a:=public.crisis_care_live_patient();
  IF NEW.tenant_id IS DISTINCT FROM a->>'tenant_id' OR NEW.patient_account_id IS DISTINCT FROM a->>'account_id'
    OR NOT EXISTS(SELECT 1 FROM public.crisis_event c WHERE c.tenant_id=NEW.tenant_id AND c.id=NEW.crisis_event_id
      AND c.patient_account_id=NEW.patient_account_id AND c.crisis_type=NEW.detected_type AND c.severity='unassessed'
      AND c.intake_payload_ciphertext IS NULL)
    OR NOT EXISTS(SELECT 1 FROM public.crisis_event_lifecycle_transition l WHERE l.tenant_id=NEW.tenant_id
      AND l.crisis_event_id=NEW.crisis_event_id AND l.actor_principal_id=NEW.patient_account_id
      AND l.from_state='none' AND l.to_state='detected' AND l.transition_reason='initial_detection')
    OR NOT EXISTS(SELECT 1 FROM public.audit_records r JOIN public.domain_events_outbox e
      ON e.tenant_id=r.tenant_id AND e.payload->>'audit_id'=r.audit_id::TEXT
      WHERE r.tenant_id=NEW.tenant_id AND r.resource_type='crisis_event' AND r.resource_id=NEW.crisis_event_id::TEXT
        AND r.action='crisis.detected' AND r.category='A' AND r.actor_type='patient' AND r.actor_id=NEW.patient_account_id
        AND r.target_patient_id=NEW.patient_account_id AND r.payload->>'severity'='unassessed'
        AND r.payload->>'crisis_type'=NEW.detected_type AND r.payload->>'source_surface'=NEW.source_surface
        AND r.payload->>'detector_version'=NEW.detector_version
        AND e.aggregate_type='CrisisEvent' AND e.aggregate_id=NEW.crisis_event_id::TEXT
        AND e.event_type='crisis.detected.v1' AND e.payload->>'escalation_status'='pending'
        AND e.payload->>'crisis_event_id'=NEW.crisis_event_id::TEXT
        AND (r.xmin::TEXT)::BIGINT=(txid_current()%4294967296) AND (e.xmin::TEXT)::BIGINT=(txid_current()%4294967296)) THEN
    RAISE EXCEPTION 'crisis_evidence_required' USING ERRCODE='23514'; END IF;
  IF public.crisis_care_live_patient() IS DISTINCT FROM a THEN RAISE EXCEPTION 'crisis_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.crisis_care_require_evidence() OWNER TO crisis_care_owner;
REVOKE ALL ON FUNCTION public.crisis_care_require_evidence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER crisis_care_evidence AFTER INSERT ON public.crisis_care_admission
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.crisis_care_require_evidence();

-- Legacy SECDEF role switches do not turn an authenticated patient into staff.
CREATE FUNCTION public.crisis_care_legacy_patient_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a RECORD;
BEGIN
  -- This guard only closes patient access to legacy staff writers. Existing
  -- staff admission remains governed by its separate HTTP/SI-022 contract.
  IF public.current_actor_role() IS DISTINCT FROM 'patient' THEN RETURN NEW; END IF;
  SELECT * INTO STRICT a FROM public.kms_current_actor_context();
  IF a.actor_role='patient' THEN
    IF TG_TABLE_NAME='crisis_event' THEN
      IF current_user<>'crisis_care_owner' THEN RAISE EXCEPTION 'crisis_forbidden' USING ERRCODE='42501'; END IF;
    ELSE
      IF NEW.from_state<>'none' OR NEW.to_state<>'detected'
        OR NEW.transition_payload->>'actor_type' IS DISTINCT FROM 'patient'
        OR NEW.actor_principal_id IS DISTINCT FROM a.account_id THEN
        RAISE EXCEPTION 'crisis_forbidden' USING ERRCODE='42501'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.crisis_care_legacy_patient_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kms_current_actor_context() TO crisis_initiation_wrapper_owner,crisis_event_lifecycle_transition_writer_owner;
GRANT EXECUTE ON FUNCTION public.current_actor_role() TO crisis_initiation_wrapper_owner,crisis_event_lifecycle_transition_writer_owner,crisis_care_owner;
GRANT EXECUTE ON FUNCTION public._current_actor_context_row() TO crisis_care_owner;
CREATE TRIGGER crisis_care_legacy_event_guard BEFORE INSERT ON public.crisis_event FOR EACH ROW EXECUTE FUNCTION public.crisis_care_legacy_patient_guard();
CREATE TRIGGER crisis_care_legacy_lifecycle_guard BEFORE INSERT ON public.crisis_event_lifecycle_transition FOR EACH ROW EXECUTE FUNCTION public.crisis_care_legacy_patient_guard();

-- Close patient replay/no-op access as well as writes. Original functions stay
-- private to their owners; public signatures and staff behavior are preserved.
DO $wrap$
DECLARE f RECORD; forwarded TEXT; result_call TEXT;
BEGIN
  FOR f IN SELECT p.oid,p.proname,p.pronargs,p.proretset,r.rolname AS owner,
    pg_get_function_identity_arguments(p.oid) AS identity_args,
    pg_get_function_arguments(p.oid) AS args,pg_get_function_result(p.oid) AS result
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='public' AND p.proname IN ('record_crisis_initiation','record_crisis_acknowledgement_claim',
      'record_crisis_response','record_crisis_resolution','execute_crisis_no_acknowledgement_sweep')
  LOOP
    SELECT string_agg('$' || s::TEXT,',' ORDER BY s) INTO forwarded FROM generate_series(1,f.pronargs) s;
    EXECUTE format('ALTER FUNCTION public.%I(%s) RENAME TO %I',f.proname,f.identity_args,'private_care_' || f.proname);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC,crisis_initiator,crisis_acknowledger,crisis_responder,crisis_resolver,crisis_sweep_scheduler',
      'private_care_' || f.proname,f.identity_args);
    result_call:=CASE WHEN f.proretset THEN 'RETURN QUERY SELECT * FROM' ELSE 'RETURN' END;
    EXECUTE format('CREATE FUNCTION public.%I(%s) RETURNS %s LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$ BEGIN IF public.current_actor_role() = ''patient'' THEN RAISE EXCEPTION ''crisis_forbidden'' USING ERRCODE=''42501''; END IF; %s public.%I(%s); END $body$',
      f.proname,f.args,f.result,result_call,'private_care_' || f.proname,forwarded);
    EXECUTE format('ALTER FUNCTION public.%I(%s) OWNER TO %I',f.proname,f.identity_args,f.owner);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.current_actor_role() TO %I',f.owner);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%I(%s) FROM PUBLIC',f.proname,f.identity_args);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%I(%s) TO %I',f.proname,f.identity_args,
      CASE f.proname WHEN 'record_crisis_initiation' THEN 'crisis_initiator'
        WHEN 'record_crisis_acknowledgement_claim' THEN 'crisis_acknowledger'
        WHEN 'record_crisis_response' THEN 'crisis_responder'
        WHEN 'record_crisis_resolution' THEN 'crisis_resolver' ELSE 'crisis_sweep_scheduler' END);
  END LOOP;
END $wrap$;
