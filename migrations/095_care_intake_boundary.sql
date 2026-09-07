-- Encrypted care intake. 094 is reserved for persisted platform crisis admission.
-- Public module capabilities compose Billing, Forms and Consent; the care owner
-- receives no raw access to their policies, grants, payment or key material.
SET LOCAL search_path=pg_catalog,public,pg_temp;
CREATE ROLE care_intake_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA public TO care_intake_owner;
GRANT EXECUTE ON FUNCTION public.current_tenant_id(),public.consent_care_live_actor(TEXT),
  public.consent_care_status(TEXT),public.consent_care_current_write(XID),
  public.forms_resolve_consult_definition(TEXT,TEXT,TEXT,TEXT,TEXT,BOOLEAN) TO care_intake_owner;
GRANT SELECT ON public.consult,public.consult_lifecycle_transition,public.consult_intake_submission,
  public.audit_records,public.domain_events_outbox TO care_intake_owner;
-- PostgreSQL row share locks require UPDATE on at least one column. This
-- private Billing owner exposes no payment update callable to care/application.
GRANT UPDATE(id) ON public.billing_payment_intent TO billing_consult_owner;

-- Billing-owned authorization operation. No caller-selected patient/payment.
CREATE FUNCTION public.billing_assert_paid_care_consult(p_consult TEXT) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a RECORD; after_actor RECORD; found_payment TEXT;
BEGIN
  SELECT * INTO STRICT a FROM public.billing_current_actor();
  IF a.actor_role<>'patient' THEN RAISE EXCEPTION 'care_scope_unavailable' USING ERRCODE='42501'; END IF;
  SELECT p.id INTO found_payment FROM public.consult c JOIN public.billing_payment_intent p
    ON (p.tenant_id,p.id,p.patient_id,p.purpose)=(c.tenant_id,c.payment_intent_id,c.patient_id,c.payment_purpose)
    WHERE c.tenant_id=a.tenant_id AND c.id=p_consult AND c.patient_id=a.account_id AND c.delegate_id IS NULL
      AND p.status='paid' AND p.verified_at IS NOT NULL AND p.provider_created_at IS NOT NULL
    FOR SHARE OF p;
  SELECT * INTO STRICT after_actor FROM public.billing_current_actor();
  IF after_actor IS DISTINCT FROM a THEN RAISE EXCEPTION 'care_unauthenticated' USING ERRCODE='PT401'; END IF;
  IF found_payment IS NULL THEN RAISE EXCEPTION 'care_payment_required' USING ERRCODE='PT409'; END IF;
END $$;
ALTER FUNCTION public.billing_assert_paid_care_consult(TEXT) OWNER TO billing_consult_owner;
REVOKE ALL ON FUNCTION public.billing_assert_paid_care_consult(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_assert_paid_care_consult(TEXT) TO care_intake_owner;

-- Safe patient progress projection remains available before payment and after
-- consent withdrawal. It is status recovery, not admission to clinical work.
CREATE FUNCTION public.billing_care_consult_progress(p_consult TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a RECORD; after_actor RECORD; result JSONB;
BEGIN
  SELECT * INTO STRICT a FROM public.billing_current_actor();
  IF a.actor_role<>'patient' THEN RAISE EXCEPTION 'care_scope_unavailable' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('payment_intent_id',p.id,'payment_status',p.status,
    'price',jsonb_build_object('amount_minor',pr.amount_minor,'currency',pr.currency,'provider',pr.provider,'mode',pr.provider_mode))
    INTO result FROM public.consult c JOIN public.billing_payment_intent p
      ON (p.tenant_id,p.id,p.patient_id,p.purpose)=(c.tenant_id,c.payment_intent_id,c.patient_id,c.payment_purpose)
    JOIN public.billing_consult_price pr ON (pr.tenant_id,pr.id)=(p.tenant_id,p.price_id)
    WHERE c.tenant_id=a.tenant_id AND c.id=p_consult AND c.patient_id=a.account_id AND c.delegate_id IS NULL
      AND pr.country_of_care=a.country_of_care;
  SELECT * INTO STRICT after_actor FROM public.billing_current_actor();
  IF after_actor IS DISTINCT FROM a THEN RAISE EXCEPTION 'care_unauthenticated' USING ERRCODE='PT401'; END IF;
  IF result IS NULL THEN RAISE EXCEPTION 'care_progress_unavailable' USING ERRCODE='PT404'; END IF;
  RETURN result;
END $$;
ALTER FUNCTION public.billing_care_consult_progress(TEXT) OWNER TO billing_consult_owner;
REVOKE ALL ON FUNCTION public.billing_care_consult_progress(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.billing_care_consult_progress(TEXT) TO care_intake_owner;

CREATE TABLE public.consult_care_binding (
  tenant_id TEXT NOT NULL,
  consult_id VARCHAR(26) NOT NULL,
  patient_id VARCHAR(26) NOT NULL,
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition)='object' AND octet_length(definition::TEXT)<=70000),
  bound_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,consult_id),
  FOREIGN KEY(tenant_id,consult_id,patient_id) REFERENCES public.consult(tenant_id,id,patient_id)
);
CREATE TABLE public.consult_care_submission (
  tenant_id TEXT NOT NULL,
  submission_id VARCHAR(26) NOT NULL,
  consult_id VARCHAR(26) NOT NULL,
  patient_id VARCHAR(26) NOT NULL,
  session_id VARCHAR(26) NOT NULL,
  data_class TEXT NOT NULL DEFAULT 'pii_sensitive_clinical' CHECK(data_class='pii_sensitive_clinical'),
  dek_version_id VARCHAR(26) NOT NULL,
  admission JSONB NOT NULL CHECK (jsonb_typeof(admission)='object' AND octet_length(admission::TEXT)<=16000),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,submission_id),
  FOREIGN KEY(tenant_id,submission_id) REFERENCES public.consult_intake_submission(tenant_id,id),
  FOREIGN KEY(tenant_id,consult_id) REFERENCES public.consult_care_binding(tenant_id,consult_id),
  FOREIGN KEY(tenant_id,data_class,dek_version_id) REFERENCES public.kms_dek_keyring(tenant_id,data_class,dek_version_id),
  FOREIGN KEY(tenant_id,consult_id,patient_id) REFERENCES public.consult(tenant_id,id,patient_id)
);
ALTER TABLE public.consult_care_binding OWNER TO care_intake_owner;
ALTER TABLE public.consult_care_submission OWNER TO care_intake_owner;
ALTER TABLE public.consult_care_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consult_care_binding FORCE ROW LEVEL SECURITY;
ALTER TABLE public.consult_care_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.consult_care_submission FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.consult_care_binding USING(tenant_id=public.current_tenant_id()) WITH CHECK(tenant_id=public.current_tenant_id());
CREATE POLICY tenant_isolation ON public.consult_care_submission USING(tenant_id=public.current_tenant_id()) WITH CHECK(tenant_id=public.current_tenant_id());
REVOKE ALL ON public.consult_care_binding,public.consult_care_submission FROM PUBLIC,telecheck_app_role;
CREATE FUNCTION public.care_intake_immutable() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'care_intake_is_immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.care_intake_immutable() FROM PUBLIC;
CREATE TRIGGER care_binding_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.consult_care_binding
  FOR EACH STATEMENT EXECUTE FUNCTION public.care_intake_immutable();
CREATE TRIGGER care_submission_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.consult_care_submission
  FOR EACH STATEMENT EXECUTE FUNCTION public.care_intake_immutable();

CREATE FUNCTION public.care_consult_progress(p_consult TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; result JSONB; progress JSONB;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  progress:=public.billing_care_consult_progress(p_consult);
  SELECT jsonb_build_object('consult_id',c.id,'current_state',t.to_state,
    'intake_status',CASE WHEN s.submission_id IS NOT NULL THEN 'submitted' WHEN b.consult_id IS NOT NULL THEN 'in_progress' ELSE 'not_started' END,
    'latest_submission_id',s.submission_id) INTO result
    FROM public.consult c
    JOIN LATERAL (SELECT l.to_state FROM public.consult_lifecycle_transition l WHERE l.tenant_id=c.tenant_id AND l.consult_id=c.id ORDER BY l.transition_at DESC,l.id DESC LIMIT 1) t ON TRUE
    LEFT JOIN public.consult_care_binding b ON (b.tenant_id,b.consult_id,b.patient_id)=(c.tenant_id,c.id,c.patient_id)
    LEFT JOIN LATERAL (SELECT x.submission_id FROM public.consult_care_submission x WHERE x.tenant_id=c.tenant_id AND x.consult_id=c.id AND x.patient_id=c.patient_id ORDER BY x.recorded_at DESC,x.submission_id DESC LIMIT 1) s ON TRUE
    WHERE c.tenant_id=a->>'tenant_id' AND c.id=p_consult AND c.patient_id=a->>'account_id' AND c.delegate_id IS NULL;
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a THEN RAISE EXCEPTION 'care_unauthenticated' USING ERRCODE='PT401'; END IF;
  IF result IS NULL THEN RAISE EXCEPTION 'care_progress_unavailable' USING ERRCODE='PT404'; END IF;
  RETURN result||progress;
END $$;
ALTER FUNCTION public.care_consult_progress(TEXT) OWNER TO care_intake_owner;
REVOKE ALL ON FUNCTION public.care_consult_progress(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.care_consult_progress(TEXT) TO telecheck_app_role;

-- Only the owning helpers can request non-intake states (deferred evidence).
CREATE FUNCTION public.care_intake_case(p_consult TEXT,p_require_intake BOOLEAN) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; c public.consult; current_state TEXT;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  SELECT * INTO c FROM public.consult x WHERE x.tenant_id=a->>'tenant_id' AND x.id=p_consult
    AND x.patient_id=a->>'account_id' AND x.delegate_id IS NULL;
  IF c.id IS NULL THEN RAISE EXCEPTION 'care_intake_unavailable' USING ERRCODE='PT404'; END IF;
  SELECT t.to_state INTO current_state FROM public.consult_lifecycle_transition t
    WHERE t.tenant_id=c.tenant_id AND t.consult_id=c.id ORDER BY t.transition_at DESC,t.id DESC LIMIT 1;
  IF p_require_intake AND COALESCE(current_state,'') NOT IN ('initiated','intake','awaiting_data')
    THEN RAISE EXCEPTION 'care_intake_unavailable' USING ERRCODE='PT409'; END IF;
  PERFORM public.billing_assert_paid_care_consult(p_consult);
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a
    THEN RAISE EXCEPTION 'care_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN jsonb_build_object('consult_id',c.id,'patient_id',c.patient_id,'consult_type',c.consult_type,'program_id',c.program_id);
END $$;
ALTER FUNCTION public.care_intake_case(TEXT,BOOLEAN) OWNER TO care_intake_owner;
REVOKE ALL ON FUNCTION public.care_intake_case(TEXT,BOOLEAN) FROM PUBLIC;

CREATE FUNCTION public.care_bind_intake(p_consult TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; c JSONB; definition JSONB; existing public.consult_care_binding;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  c:=public.care_intake_case(p_consult,TRUE);
  PERFORM pg_advisory_xact_lock(hashtextextended('care-binding:'||(a->>'tenant_id')||':'||p_consult,0));
  c:=public.care_intake_case(p_consult,TRUE);
  SELECT * INTO existing FROM public.consult_care_binding b WHERE b.tenant_id=a->>'tenant_id' AND b.consult_id=p_consult;
  definition:=public.forms_resolve_consult_definition(a->>'account_id',a->>'session_id',existing.definition->>'deployment_id',
    CASE WHEN c->>'consult_type'='general' THEN 'general_consult' ELSE 'program' END,
    CASE WHEN existing.consult_id IS NULL THEN c->>'program_id' ELSE existing.definition->>'program_id' END,existing.consult_id IS NOT NULL);
  IF existing.consult_id IS NOT NULL AND existing.definition IS DISTINCT FROM definition
    THEN RAISE EXCEPTION 'care_form_review_required' USING ERRCODE='PT409'; END IF;
  IF existing.consult_id IS NULL THEN
    INSERT INTO public.consult_care_binding(tenant_id,consult_id,patient_id,definition)
      VALUES(a->>'tenant_id',p_consult,a->>'account_id',definition);
  END IF;
  PERFORM public.care_intake_case(p_consult,TRUE);
  RETURN c||jsonb_build_object('definition',definition,'created',existing.consult_id IS NULL);
END $$;
ALTER FUNCTION public.care_bind_intake(TEXT) OWNER TO care_intake_owner;
REVOKE ALL ON FUNCTION public.care_bind_intake(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.care_bind_intake(TEXT) TO telecheck_app_role;

CREATE FUNCTION public.care_require_binding_evidence() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; c JSONB; definition JSONB;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  IF NEW.tenant_id IS DISTINCT FROM a->>'tenant_id' OR NEW.patient_id IS DISTINCT FROM a->>'account_id'
    THEN RAISE EXCEPTION 'care_scope_unavailable' USING ERRCODE='42501'; END IF;
  c:=public.care_intake_case(NEW.consult_id,FALSE);
  definition:=public.forms_resolve_consult_definition(a->>'account_id',a->>'session_id',NEW.definition->>'deployment_id',
    CASE WHEN c->>'consult_type'='general' THEN 'general_consult' ELSE 'program' END,NEW.definition->>'program_id',TRUE);
  IF definition IS DISTINCT FROM NEW.definition THEN RAISE EXCEPTION 'care_form_review_required' USING ERRCODE='PT409'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audit_records r JOIN public.domain_events_outbox e
    ON e.tenant_id=r.tenant_id AND e.payload->>'audit_id'=r.audit_id::TEXT
    WHERE r.tenant_id=NEW.tenant_id AND r.resource_id=NEW.consult_id AND r.resource_type='consult_care_binding'
      AND r.actor_id=NEW.patient_id AND r.target_patient_id=NEW.patient_id AND r.action='async_consult.intake_definition_bound'
      AND r.payload->>'schema_hash'=NEW.definition->>'schema_hash'
      AND r.payload->>'deployment_id'=NEW.definition->>'deployment_id'
      AND e.aggregate_id=NEW.consult_id AND e.event_type='async_consult.intake_definition_bound.v1'
      AND e.payload->>'schema_hash'=NEW.definition->>'schema_hash'
      AND public.consent_care_current_write(r.xmin) AND public.consent_care_current_write(e.xmin))
    THEN RAISE EXCEPTION 'care_binding_evidence_required' USING ERRCODE='23514'; END IF;
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a
    THEN RAISE EXCEPTION 'care_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION public.care_require_binding_evidence() OWNER TO care_intake_owner;
REVOKE ALL ON FUNCTION public.care_require_binding_evidence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER care_binding_evidence AFTER INSERT ON public.consult_care_binding
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.care_require_binding_evidence();

CREATE FUNCTION public.care_validate_intake_binding(p_consult TEXT,p_require_intake BOOLEAN) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; c JSONB; definition JSONB; existing public.consult_care_binding; admission JSONB;
BEGIN
  a:=public.consent_care_live_actor(NULL); c:=public.care_intake_case(p_consult,p_require_intake);
  SELECT * INTO existing FROM public.consult_care_binding b WHERE b.tenant_id=a->>'tenant_id' AND b.consult_id=p_consult;
  IF existing.consult_id IS NULL THEN RAISE EXCEPTION 'care_form_review_required' USING ERRCODE='PT409'; END IF;
  definition:=public.forms_resolve_consult_definition(a->>'account_id',a->>'session_id',existing.definition->>'deployment_id',
    CASE WHEN c->>'consult_type'='general' THEN 'general_consult' ELSE 'program' END,existing.definition->>'program_id',TRUE);
  IF definition IS DISTINCT FROM existing.definition THEN RAISE EXCEPTION 'care_form_review_required' USING ERRCODE='PT409'; END IF;
  admission:=public.consent_care_status(c->>'program_id');
  IF admission->'required_care_active' IS DISTINCT FROM 'true'::JSONB
    THEN RAISE EXCEPTION 'care_consent_required' USING ERRCODE='PT409'; END IF;
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a
    THEN RAISE EXCEPTION 'care_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN c||jsonb_build_object('definition',definition,'admission',admission);
END $$;
ALTER FUNCTION public.care_validate_intake_binding(TEXT,BOOLEAN) OWNER TO care_intake_owner;
REVOKE ALL ON FUNCTION public.care_validate_intake_binding(TEXT,BOOLEAN) FROM PUBLIC;
CREATE FUNCTION public.care_authorize_intake(p_consult TEXT) RETURNS JSONB
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
  SELECT public.care_validate_intake_binding(p_consult,TRUE)-'admission';
$$;
ALTER FUNCTION public.care_authorize_intake(TEXT) OWNER TO care_intake_owner;
REVOKE ALL ON FUNCTION public.care_authorize_intake(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.care_authorize_intake(TEXT) TO telecheck_app_role;

-- The former ciphertext-only callable path is private to this validated owner.
REVOKE EXECUTE ON FUNCTION public.record_consult_intake_submission(VARCHAR,TEXT,VARCHAR,VARCHAR,VARCHAR,TEXT,BYTEA,VARCHAR,BYTEA,BYTEA,TEXT,TEXT,BYTEA,TIMESTAMPTZ,VARCHAR,VARCHAR,VARCHAR,TEXT)
  FROM async_consult_patient_initiator,async_consult_delegate_initiator;
GRANT EXECUTE ON FUNCTION public.record_consult_intake_submission(VARCHAR,TEXT,VARCHAR,VARCHAR,VARCHAR,TEXT,BYTEA,VARCHAR,BYTEA,BYTEA,TEXT,TEXT,BYTEA,TIMESTAMPTZ,VARCHAR,VARCHAR,VARCHAR,TEXT)
  TO care_intake_owner;

CREATE FUNCTION public.care_append_intake(p_submission TEXT,p_consult TEXT,p_ciphertext BYTEA,p_dek TEXT,p_iv BYTEA,p_tag BYTEA,
  p_alg TEXT,p_version TEXT,p_aad BYTEA,p_encrypted_at TIMESTAMPTZ,p_lead_transition TEXT,p_submitted_transition TEXT,p_admission JSONB)
RETURNS VOID LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; bound JSONB; expected_aad JSONB;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  -- Compatible with Consent's patient mutation lock. KMS has already completed.
  PERFORM pg_advisory_xact_lock(hashtextextended('consent-patient:'||(a->>'tenant_id')||':'||(a->>'account_id'),0));
  PERFORM pg_advisory_xact_lock(('x'||substr(md5('consult_lifecycle_transition:'||(a->>'tenant_id')||':'||p_consult),1,16))::BIT(64)::BIGINT);
  bound:=public.care_validate_intake_binding(p_consult,TRUE);
  IF bound->'admission' IS DISTINCT FROM p_admission THEN RAISE EXCEPTION 'care_consent_changed' USING ERRCODE='PT409'; END IF;
  expected_aad:=jsonb_build_array('telecheck-classified',2,a->>'tenant_id','pii_sensitive_clinical',a->>'account_id',
    'consult_intake_submission',p_submission,'intake_payload',p_dek,'AES-256-GCM',to_char(p_encrypted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF p_submission IS NULL OR p_submission!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$' OR p_dek IS NULL OR p_dek!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
    OR p_alg IS DISTINCT FROM 'AES-256-GCM' OR p_version IS DISTINCT FROM '2' OR p_encrypted_at IS NULL
    OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 68 AND 65604
    OR substring(p_ciphertext FROM 1 FOR 8)<>convert_to('TCROW002','UTF8')
    OR p_iv IS NULL OR octet_length(p_iv)<>12 OR p_tag IS NULL OR octet_length(p_tag)<>16
    OR p_aad IS NULL OR octet_length(p_aad)>1024 OR convert_from(p_aad,'UTF8')::JSONB IS DISTINCT FROM expected_aad
    THEN RAISE EXCEPTION 'care_invalid_envelope' USING ERRCODE='23514'; END IF;
  PERFORM public.record_consult_intake_submission(p_submission::VARCHAR,a->>'tenant_id',p_consult::VARCHAR,(a->>'account_id')::VARCHAR,
    (bound->'definition'->>'template_id')::VARCHAR,bound->'definition'->>'template_version',p_ciphertext,p_dek::VARCHAR,p_iv,p_tag,p_alg,p_version,p_aad,p_encrypted_at,
    p_lead_transition::VARCHAR,p_submitted_transition::VARCHAR,(a->>'account_id')::VARCHAR,'patient');
  INSERT INTO public.consult_care_submission(tenant_id,submission_id,consult_id,patient_id,session_id,dek_version_id,admission)
    VALUES(a->>'tenant_id',p_submission,p_consult,a->>'account_id',a->>'session_id',p_dek,p_admission);
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a
    THEN RAISE EXCEPTION 'care_unauthenticated' USING ERRCODE='PT401'; END IF;
END $$;
ALTER FUNCTION public.care_append_intake(TEXT,TEXT,BYTEA,TEXT,BYTEA,BYTEA,TEXT,TEXT,BYTEA,TIMESTAMPTZ,TEXT,TEXT,JSONB) OWNER TO care_intake_owner;
REVOKE ALL ON FUNCTION public.care_append_intake(TEXT,TEXT,BYTEA,TEXT,BYTEA,BYTEA,TEXT,TEXT,BYTEA,TIMESTAMPTZ,TEXT,TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.care_append_intake(TEXT,TEXT,BYTEA,TEXT,BYTEA,BYTEA,TEXT,TEXT,BYTEA,TIMESTAMPTZ,TEXT,TEXT,JSONB) TO telecheck_app_role;

CREATE FUNCTION public.care_require_intake_evidence() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; bound JSONB;
BEGIN
  a:=public.consent_care_live_actor(NULL);
  IF NEW.tenant_id IS DISTINCT FROM a->>'tenant_id' OR NEW.patient_id IS DISTINCT FROM a->>'account_id'
    OR NEW.session_id IS DISTINCT FROM a->>'session_id' THEN RAISE EXCEPTION 'care_scope_unavailable' USING ERRCODE='42501'; END IF;
  bound:=public.care_validate_intake_binding(NEW.consult_id,FALSE);
  IF bound->'admission' IS DISTINCT FROM NEW.admission THEN RAISE EXCEPTION 'care_consent_changed' USING ERRCODE='PT409'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audit_records r JOIN public.domain_events_outbox e
    ON e.tenant_id=r.tenant_id AND e.payload->>'audit_id'=r.audit_id::TEXT
    WHERE r.tenant_id=NEW.tenant_id AND r.resource_id=NEW.submission_id AND r.resource_type='consult_intake_submission'
      AND r.actor_id=NEW.patient_id AND r.target_patient_id=NEW.patient_id AND r.action='async_consult.intake_submitted'
      AND r.payload->>'consult_id'=NEW.consult_id AND r.payload->>'template_id'=bound->'definition'->>'template_id'
      AND r.payload->>'template_version'=bound->'definition'->>'template_version'
      AND e.aggregate_id=NEW.consult_id AND e.event_type='async_consult.intake_submitted.v1'
      AND e.payload->>'submission_id'=NEW.submission_id AND e.payload->>'policy_hash'=NEW.admission->>'policy_hash'
      AND public.consent_care_current_write(r.xmin) AND public.consent_care_current_write(e.xmin))
    THEN RAISE EXCEPTION 'care_intake_evidence_required' USING ERRCODE='23514'; END IF;
  IF public.consent_care_live_actor(NULL) IS DISTINCT FROM a
    THEN RAISE EXCEPTION 'care_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN NULL;
END $$;
ALTER FUNCTION public.care_require_intake_evidence() OWNER TO care_intake_owner;
REVOKE ALL ON FUNCTION public.care_require_intake_evidence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER care_intake_evidence AFTER INSERT ON public.consult_care_submission
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.care_require_intake_evidence();
