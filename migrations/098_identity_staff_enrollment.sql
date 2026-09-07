-- Identity-owned operator enrollment. This creates a pending clinician, never
-- a verified license, active clinical account, session, or prescribing grant.
SET LOCAL search_path=pg_catalog,public,pg_temp;
CREATE ROLE identity_staff_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA public TO identity_staff_owner;
GRANT EXECUTE ON FUNCTION public.current_tenant_id(),public.kms_current_actor_context(),
  public.consent_care_current_write(XID) TO identity_staff_owner;
GRANT SELECT ON public.accounts,public.audit_records,public.domain_events_outbox TO identity_staff_owner;
GRANT INSERT(account_id,tenant_id,phone_e164,email,first_name,last_name,account_type,
  country_of_care,locale) ON public.accounts TO identity_staff_owner;

-- Staff do not need invented patient demographics to have a real identity.
-- Patient/delegate registration retains the original required fields.
ALTER TABLE public.accounts ALTER COLUMN date_of_birth DROP NOT NULL;
ALTER TABLE public.accounts ALTER COLUMN gender DROP NOT NULL;
ALTER TABLE public.accounts ALTER COLUMN country_of_residence DROP NOT NULL;
ALTER TABLE public.accounts ADD CONSTRAINT account_patient_demographics_required CHECK (
  account_type NOT IN ('patient','delegate') OR (date_of_birth IS NOT NULL AND gender IS NOT NULL AND country_of_residence IS NOT NULL));

CREATE TABLE public.identity_staff_membership (
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  account_id VARCHAR(26) NOT NULL,
  capability TEXT NOT NULL CHECK(capability='clinician_enroller'),
  granted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  granted_by VARCHAR(26) NOT NULL,
  evidence_sha256 TEXT NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  provisioning_reference TEXT NOT NULL CHECK(length(provisioning_reference) BETWEEN 1 AND 160),
  revoked_at TIMESTAMPTZ,
  revocation_reference TEXT,
  PRIMARY KEY(tenant_id,account_id,capability),
  FOREIGN KEY(tenant_id,account_id) REFERENCES public.accounts(tenant_id,account_id),
  FOREIGN KEY(tenant_id,granted_by) REFERENCES public.accounts(tenant_id,account_id),
  CHECK((revoked_at IS NULL AND revocation_reference IS NULL) OR
    (revoked_at>=granted_at AND length(revocation_reference) BETWEEN 1 AND 160))
);
CREATE TABLE public.identity_staff_enrollment (
  tenant_id TEXT NOT NULL REFERENCES public.tenants(id),
  account_id VARCHAR(26) NOT NULL CHECK(account_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  enrolled_by VARCHAR(26) NOT NULL,
  enrolled_session VARCHAR(26) NOT NULL,
  country_of_care TEXT NOT NULL CHECK(country_of_care IN ('US','GH')),
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,account_id),
  FOREIGN KEY(tenant_id,account_id) REFERENCES public.accounts(tenant_id,account_id),
  FOREIGN KEY(tenant_id,enrolled_by) REFERENCES public.accounts(tenant_id,account_id),
  CHECK(account_id<>enrolled_by)
);
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['identity_staff_membership','identity_staff_enrollment'] LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO identity_staff_owner',t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON public.%I USING (tenant_id=public.current_tenant_id()) WITH CHECK(tenant_id=public.current_tenant_id())',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,telecheck_app_role,identity_service_role',t);
  END LOOP;
END $$;

CREATE FUNCTION public.identity_staff_immutable() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'staff_evidence_immutable' USING ERRCODE='23514'; END $$;
REVOKE ALL ON FUNCTION public.identity_staff_immutable() FROM PUBLIC;
CREATE TRIGGER identity_staff_enrollment_immutable BEFORE UPDATE OR DELETE ON public.identity_staff_enrollment
  FOR EACH ROW EXECUTE FUNCTION public.identity_staff_immutable();
CREATE FUNCTION public.identity_staff_membership_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL OR
    (to_jsonb(NEW)-ARRAY['revoked_at','revocation_reference']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['revoked_at','revocation_reference']) THEN
    RAISE EXCEPTION 'staff_membership_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.identity_staff_membership_guard() FROM PUBLIC;
CREATE TRIGGER identity_staff_membership_guard BEFORE UPDATE OR DELETE ON public.identity_staff_membership
  FOR EACH ROW EXECUTE FUNCTION public.identity_staff_membership_guard();

CREATE FUNCTION public.identity_staff_operator(p_lock BOOLEAN DEFAULT FALSE) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a RECORD; refreshed RECORD;
BEGIN
  BEGIN SELECT * INTO STRICT a FROM public.kms_current_actor_context();
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'staff_unauthenticated' USING ERRCODE='PT401'; END;
  IF a.actor_role<>'tenant_admin' THEN RAISE EXCEPTION 'staff_unavailable' USING ERRCODE='42501'; END IF;
  -- A row share lock serializes privileged capability revocation. No KMS work
  -- follows this lock; this enrollment surface has no protected evidence yet.
  IF p_lock THEN
    PERFORM 1 FROM public.identity_staff_membership m WHERE m.tenant_id=a.tenant_id
      AND m.account_id=a.account_id AND m.capability='clinician_enroller'
      AND m.granted_at<=clock_timestamp() AND m.revoked_at IS NULL FOR SHARE;
  ELSE
    PERFORM 1 FROM public.identity_staff_membership m WHERE m.tenant_id=a.tenant_id
      AND m.account_id=a.account_id AND m.capability='clinician_enroller'
      AND m.granted_at<=clock_timestamp() AND m.revoked_at IS NULL;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'staff_unavailable' USING ERRCODE='42501'; END IF;
  BEGIN SELECT * INTO STRICT refreshed FROM public.kms_current_actor_context();
  EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'staff_unauthenticated' USING ERRCODE='PT401'; END;
  IF refreshed IS DISTINCT FROM a THEN RAISE EXCEPTION 'staff_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN jsonb_build_object('tenant_id',a.tenant_id,'account_id',a.account_id,
    'session_id',a.session_id,'country_of_care',a.country_of_care);
END $$;
ALTER FUNCTION public.identity_staff_operator(BOOLEAN) OWNER TO identity_staff_owner;
REVOKE ALL ON FUNCTION public.identity_staff_operator(BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.identity_staff_operator(BOOLEAN) TO identity_service_role;

CREATE FUNCTION public.identity_enroll_clinician(p_id TEXT,p_first TEXT,p_last TEXT,p_phone TEXT,p_email TEXT) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB;
BEGIN
  a:=public.identity_staff_operator(TRUE);
  IF p_id IS NULL OR p_id !~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' OR
    p_first IS NULL OR length(p_first) NOT BETWEEN 1 AND 100 OR btrim(p_first)<>p_first OR p_first ~ '[[:cntrl:]]' OR
    p_last IS NULL OR length(p_last) NOT BETWEEN 1 AND 100 OR btrim(p_last)<>p_last OR p_last ~ '[[:cntrl:]]' OR
    p_phone IS NULL OR p_phone !~ '^\+[1-9][0-9]{7,14}$' OR
    (p_email IS NOT NULL AND (length(p_email)>254 OR p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' OR p_email<>lower(p_email))) THEN
    RAISE EXCEPTION 'staff_input_invalid' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.accounts(account_id,tenant_id,phone_e164,email,first_name,last_name,
    account_type,country_of_care,locale)
    VALUES(p_id,a->>'tenant_id',p_phone,p_email,p_first,p_last,'clinician',a->>'country_of_care',
      'en-'||(a->>'country_of_care'));
  INSERT INTO public.identity_staff_enrollment(tenant_id,account_id,enrolled_by,enrolled_session,country_of_care)
    VALUES(a->>'tenant_id',p_id,a->>'account_id',a->>'session_id',a->>'country_of_care');
  IF public.identity_staff_operator(FALSE) IS DISTINCT FROM a THEN RAISE EXCEPTION 'staff_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN jsonb_build_object('account_id',p_id,'status','pending_verification');
END $$;
ALTER FUNCTION public.identity_enroll_clinician(TEXT,TEXT,TEXT,TEXT,TEXT) OWNER TO identity_staff_owner;
REVOKE ALL ON FUNCTION public.identity_enroll_clinician(TEXT,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.identity_enroll_clinician(TEXT,TEXT,TEXT,TEXT,TEXT) TO identity_service_role;

-- Pending governed clinicians cannot be activated by the existing patient
-- OTP or PIN path. A later dedicated staff-auth capability must replace this
-- gate with actual password+OTP evidence before it can activate the account.
CREATE FUNCTION public.identity_staff_activation_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.status='active' AND EXISTS(
    SELECT 1 FROM public.identity_staff_enrollment e WHERE e.tenant_id=OLD.tenant_id AND e.account_id=OLD.account_id) THEN
    RAISE EXCEPTION 'staff_authentication_required' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.identity_staff_activation_guard() OWNER TO identity_staff_owner;
REVOKE ALL ON FUNCTION public.identity_staff_activation_guard() FROM PUBLIC;
CREATE TRIGGER identity_staff_activation_guard BEFORE UPDATE OF status ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.identity_staff_activation_guard();

CREATE FUNCTION public.identity_staff_session_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.identity_staff_enrollment e
    WHERE e.tenant_id=NEW.tenant_id AND e.account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'staff_authentication_required' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.identity_staff_session_guard() OWNER TO identity_staff_owner;
REVOKE ALL ON FUNCTION public.identity_staff_session_guard() FROM PUBLIC;
CREATE TRIGGER identity_staff_session_guard BEFORE INSERT OR UPDATE OF account_id,tenant_id ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.identity_staff_session_guard();

CREATE FUNCTION public.identity_staff_enrollment_evidence() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB;
BEGIN
  a:=public.identity_staff_operator(FALSE);
  IF (a->>'tenant_id',a->>'account_id',a->>'session_id',a->>'country_of_care') IS DISTINCT FROM
    (NEW.tenant_id,NEW.enrolled_by::TEXT,NEW.enrolled_session::TEXT,NEW.country_of_care) OR NOT EXISTS(
    SELECT 1 FROM public.accounts c WHERE c.tenant_id=NEW.tenant_id AND c.account_id=NEW.account_id
      AND c.account_type='clinician' AND c.status='pending_verification' AND c.deleted_at IS NULL
      AND public.consent_care_current_write(c.xmin)) THEN
    RAISE EXCEPTION 'staff_enrollment_admission_required' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audit_records r JOIN public.domain_events_outbox e
    ON e.tenant_id=r.tenant_id AND e.payload->>'audit_id'=r.audit_id::TEXT
    WHERE r.tenant_id=NEW.tenant_id AND r.resource_id=NEW.account_id
      AND r.resource_type='identity_staff_enrollment' AND r.action='config_change_validated'
      AND r.category='B' AND r.actor_id=NEW.enrolled_by AND r.actor_type='operator'
      AND r.actor_tenant_id=NEW.tenant_id AND r.country_of_care=NEW.country_of_care
      AND r.audit_sensitivity_level='standard'
      AND r.target_patient_id IS NULL AND r.payload=jsonb_build_object('intent','identity.clinician.enrolled',
        'account_id',NEW.account_id,'status','pending_verification')
      AND e.aggregate_type='IdentityStaffEnrollment' AND e.aggregate_id=NEW.account_id
      AND e.event_type='identity.clinician.enrolled' AND e.partition_key=NEW.tenant_id||':'||NEW.account_id
      AND e.payload-'occurred_at'=r.payload||jsonb_build_object('audit_id',r.audit_id)
      AND public.consent_care_current_write(r.xmin) AND public.consent_care_current_write(e.xmin)) THEN
    RAISE EXCEPTION 'staff_enrollment_evidence_required' USING ERRCODE='23514';
  END IF;
  PERFORM public.identity_staff_operator(FALSE);
  RETURN NEW;
END $$;
ALTER FUNCTION public.identity_staff_enrollment_evidence() OWNER TO identity_staff_owner;
REVOKE ALL ON FUNCTION public.identity_staff_enrollment_evidence() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER identity_staff_enrollment_evidence AFTER INSERT ON public.identity_staff_enrollment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.identity_staff_enrollment_evidence();

CREATE FUNCTION public.identity_staff_roster(p_offset INTEGER) RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE a JSONB; result JSONB;
BEGIN
  a:=public.identity_staff_operator(FALSE);
  IF p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'staff_input_invalid' USING ERRCODE='22023'; END IF;
  WITH candidates AS MATERIALIZED(
    SELECT e.account_id,c.first_name,c.last_name,c.status,e.enrolled_at
    FROM public.identity_staff_enrollment e JOIN public.accounts c USING(tenant_id,account_id)
    WHERE e.tenant_id=a->>'tenant_id' AND e.country_of_care=a->>'country_of_care'
      AND c.account_type='clinician' AND c.deleted_at IS NULL
    ORDER BY e.enrolled_at DESC,e.account_id DESC OFFSET p_offset LIMIT 26)
  SELECT jsonb_build_object('offset',p_offset,'limit',25,'has_more',count(*)>25,'items',COALESCE(
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.enrolled_at DESC,p.account_id DESC)
      FROM(SELECT * FROM candidates ORDER BY enrolled_at DESC,account_id DESC LIMIT 25)p),'[]'::JSONB))
    INTO result FROM candidates;
  IF public.identity_staff_operator(FALSE) IS DISTINCT FROM a THEN RAISE EXCEPTION 'staff_unauthenticated' USING ERRCODE='PT401'; END IF;
  RETURN result;
END $$;
ALTER FUNCTION public.identity_staff_roster(INTEGER) OWNER TO identity_staff_owner;
REVOKE ALL ON FUNCTION public.identity_staff_roster(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.identity_staff_roster(INTEGER) TO identity_service_role;
