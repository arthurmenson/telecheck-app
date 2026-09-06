-- Patient-own medication reads without exposing the base table to application SQL.
SET LOCAL search_path = pg_catalog, public, pg_temp;

CREATE ROLE pharmacy_patient_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE pharmacy_patient_read_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA public TO pharmacy_patient_reader, pharmacy_patient_read_owner;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'telecheck_app_role' AND NOT rolinherit AND NOT rolsuper AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'pharmacy requires the restricted NOINHERIT application role';
  END IF;
END $$;
GRANT pharmacy_patient_reader TO telecheck_app_role;

GRANT SELECT (id, tenant_id, patient_account_id, country_of_care, created_at,
  medication_name, strength, formulation, dose_instructions, quantity, quantity_unit,
  refills_allowed, status, prescribed_at, activated_at, expires_at)
  ON public.medication_requests TO pharmacy_patient_read_owner;
GRANT SELECT (nonce, actor_account_id, actor_account_tenant_id, actor_role, session_id, expires_at)
  ON public._session_actor_context TO pharmacy_patient_read_owner;
GRANT SELECT (account_id, tenant_id, account_type, status, deleted_at, country_of_care)
  ON public.accounts TO pharmacy_patient_read_owner;
GRANT SELECT (session_id, account_id, tenant_id, expires_at, revoked_at)
  ON public.sessions TO pharmacy_patient_read_owner;
GRANT SELECT (id, status, country_of_care) ON public.tenants TO pharmacy_patient_read_owner;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO pharmacy_patient_read_owner;

CREATE FUNCTION public.pharmacy_assert_live_patient()
RETURNS TABLE (tenant_id TEXT, account_id TEXT, session_id TEXT, country_of_care TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE request_nonce UUID;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'PT503', MESSAGE = 'pharmacy_patient_read_unavailable';
  END IF;
  BEGIN
    request_nonce := NULLIF(pg_catalog.current_setting('app.request_nonce', true), '')::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'PT401', MESSAGE = 'pharmacy_patient_read_unauthenticated';
  END;
  RETURN QUERY
  SELECT n.actor_account_tenant_id::TEXT, n.actor_account_id::TEXT, n.session_id::TEXT, t.country_of_care::TEXT
  FROM public._session_actor_context n
  JOIN public.accounts a ON a.account_id = n.actor_account_id AND a.tenant_id = n.actor_account_tenant_id
  JOIN public.sessions s ON s.session_id = n.session_id AND s.account_id = a.account_id AND s.tenant_id = a.tenant_id
  JOIN public.tenants t ON t.id = a.tenant_id
  WHERE n.nonce = request_nonce AND n.actor_account_tenant_id = public.current_tenant_id()
    AND n.actor_role = 'patient' AND a.account_type = 'patient'
    AND n.expires_at > pg_catalog.clock_timestamp() AND s.expires_at > pg_catalog.clock_timestamp()
    AND s.revoked_at IS NULL AND a.status = 'active' AND a.deleted_at IS NULL AND t.status = 'active'
    AND a.country_of_care = t.country_of_care;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PT401', MESSAGE = 'pharmacy_patient_read_unauthenticated';
  END IF;
END $$;
ALTER FUNCTION public.pharmacy_assert_live_patient() OWNER TO pharmacy_patient_read_owner;
REVOKE ALL ON FUNCTION public.pharmacy_assert_live_patient() FROM PUBLIC;

CREATE FUNCTION public.read_patient_medication_requests(
  p_medication_request_id TEXT DEFAULT NULL, p_status TEXT DEFAULT NULL, p_limit INTEGER DEFAULT 50
) RETURNS TABLE (
  id TEXT, medication_name TEXT, strength TEXT, formulation TEXT, dose_instructions TEXT,
  quantity INTEGER, quantity_unit TEXT, refills_allowed INTEGER, status TEXT,
  prescribed_at TIMESTAMPTZ, activated_at TIMESTAMPTZ, expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE initial_actor RECORD; final_actor RECORD;
BEGIN
  SELECT * INTO STRICT initial_actor FROM public.pharmacy_assert_live_patient();
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR
     (p_status IS NOT NULL AND p_status NOT IN ('draft', 'pending_interaction_check', 'pending_clinician_review', 'active', 'discontinued', 'superseded', 'expired', 'rejected')) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'pharmacy_patient_read_invalid_query';
  END IF;
  RETURN QUERY
  SELECT mr.id::TEXT, mr.medication_name::TEXT, mr.strength::TEXT, mr.formulation::TEXT,
    mr.dose_instructions, mr.quantity, mr.quantity_unit::TEXT, mr.refills_allowed, mr.status::TEXT,
    mr.prescribed_at, mr.activated_at, mr.expires_at
  FROM public.medication_requests mr
  WHERE mr.tenant_id = initial_actor.tenant_id AND mr.patient_account_id = initial_actor.account_id
    AND mr.country_of_care = initial_actor.country_of_care
    AND (p_medication_request_id IS NULL OR mr.id = p_medication_request_id)
    AND (p_status IS NULL OR mr.status = p_status)
  ORDER BY mr.created_at DESC, mr.id DESC LIMIT p_limit;
  -- RETURN QUERY buffers rows; a failed final check discards them before disclosure.
  SELECT * INTO STRICT final_actor FROM public.pharmacy_assert_live_patient();
  IF final_actor IS DISTINCT FROM initial_actor THEN
    RAISE EXCEPTION USING ERRCODE = 'PT401', MESSAGE = 'pharmacy_patient_read_unauthenticated';
  END IF;
END $$;
ALTER FUNCTION public.read_patient_medication_requests(TEXT, TEXT, INTEGER) OWNER TO pharmacy_patient_read_owner;
REVOKE ALL ON FUNCTION public.read_patient_medication_requests(TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.read_patient_medication_requests(TEXT, TEXT, INTEGER) TO pharmacy_patient_reader;

-- History has its own minimal assertion owner. It cannot read medication or
-- consultation tables. No ordinary application access to nonce rows is added.
CREATE ROLE async_consult_history_read_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA public TO async_consult_history_read_owner;
GRANT SELECT (nonce, actor_account_id, actor_account_tenant_id, actor_role, session_id, expires_at)
  ON public._session_actor_context TO async_consult_history_read_owner;
GRANT SELECT (account_id, tenant_id, account_type, status, deleted_at, country_of_care)
  ON public.accounts TO async_consult_history_read_owner;
GRANT SELECT (session_id, account_id, tenant_id, expires_at, revoked_at)
  ON public.sessions TO async_consult_history_read_owner;
GRANT SELECT (id, status, country_of_care) ON public.tenants TO async_consult_history_read_owner;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO async_consult_history_read_owner;

CREATE FUNCTION public.async_consult_assert_live_patient()
RETURNS TABLE (tenant_id TEXT, account_id TEXT, session_id TEXT, country_of_care TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE request_nonce UUID;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE = 'PT503', MESSAGE = 'async_consult_history_unavailable';
  END IF;
  BEGIN
    request_nonce := NULLIF(pg_catalog.current_setting('app.request_nonce', true), '')::UUID;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION USING ERRCODE = 'PT401', MESSAGE = 'async_consult_history_unauthenticated';
  END;
  RETURN QUERY
  SELECT n.actor_account_tenant_id::TEXT, n.actor_account_id::TEXT, n.session_id::TEXT, t.country_of_care::TEXT
  FROM public._session_actor_context n
  JOIN public.accounts a ON a.account_id = n.actor_account_id AND a.tenant_id = n.actor_account_tenant_id
  JOIN public.sessions s ON s.session_id = n.session_id AND s.account_id = a.account_id AND s.tenant_id = a.tenant_id
  JOIN public.tenants t ON t.id = a.tenant_id
  WHERE n.nonce = request_nonce AND n.actor_account_tenant_id = public.current_tenant_id()
    AND n.actor_role = 'patient' AND a.account_type = 'patient'
    AND n.expires_at > pg_catalog.clock_timestamp() AND s.expires_at > pg_catalog.clock_timestamp()
    AND s.revoked_at IS NULL AND a.status = 'active' AND a.deleted_at IS NULL AND t.status = 'active'
    AND a.country_of_care = t.country_of_care;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'PT401', MESSAGE = 'async_consult_history_unauthenticated';
  END IF;
END $$;
ALTER FUNCTION public.async_consult_assert_live_patient() OWNER TO async_consult_history_read_owner;
REVOKE ALL ON FUNCTION public.async_consult_assert_live_patient() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.async_consult_assert_live_patient() TO async_consult_patient_reader;
