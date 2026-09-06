-- Classified KMS derives the live actor from SI-010 and the real session.
SET LOCAL search_path = pg_catalog, public, pg_temp;
GRANT SELECT (nonce, actor_account_id, actor_account_tenant_id, actor_role, session_id, expires_at)
  ON public._session_actor_context TO kms_context_owner;
GRANT SELECT (account_id, tenant_id, account_type, status, deleted_at) ON public.accounts TO kms_context_owner;
GRANT SELECT (session_id, account_id, tenant_id, expires_at, revoked_at) ON public.sessions TO kms_context_owner;
GRANT SELECT (id, status, country_of_care) ON public.tenants TO kms_context_owner;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO kms_context_owner, kms_service_role;
GRANT EXECUTE ON FUNCTION public.set_tenant_context(TEXT), public.clear_tenant_context() TO kms_service_role, telecheck_app_role;
GRANT SELECT (id, country_of_care, status) ON public.tenants TO kms_service_role;
GRANT SELECT, INSERT ON public.audit_records TO kms_service_role;

CREATE FUNCTION public.kms_current_actor_context()
RETURNS TABLE (tenant_id TEXT, account_id TEXT, session_id TEXT, actor_role TEXT,
  country_of_care TEXT, request_nonce TEXT, transaction_id TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RETURN QUERY
  SELECT n.actor_account_tenant_id::TEXT, n.actor_account_id::TEXT,
    n.session_id::TEXT, n.actor_role::TEXT, t.country_of_care::TEXT,
    n.nonce::TEXT, pg_catalog.txid_current()::TEXT
  FROM public._session_actor_context n
  JOIN public.accounts a ON a.account_id = n.actor_account_id AND a.tenant_id = n.actor_account_tenant_id
  JOIN public.sessions s ON s.session_id = n.session_id AND s.account_id = n.actor_account_id AND s.tenant_id = n.actor_account_tenant_id
  JOIN public.tenants t ON t.id = n.actor_account_tenant_id
  WHERE n.nonce = NULLIF(pg_catalog.current_setting('app.request_nonce', true), '')::UUID
    AND n.actor_account_tenant_id = public.current_tenant_id()
    AND n.expires_at > pg_catalog.clock_timestamp() AND s.expires_at > pg_catalog.clock_timestamp()
    AND s.revoked_at IS NULL AND a.status = 'active' AND a.deleted_at IS NULL AND t.status = 'active'
    AND n.actor_role = a.account_type
    AND n.actor_role IN ('patient', 'clinician', 'tenant_admin');
  IF NOT FOUND THEN RAISE EXCEPTION 'kms_actor_unavailable'; END IF;
END $$;
ALTER FUNCTION public.kms_current_actor_context() OWNER TO kms_context_owner;
REVOKE ALL ON FUNCTION public.kms_current_actor_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kms_current_actor_context() TO telecheck_app_role, kms_service_role;

-- A KMS writer may read a patient identifier/status for attribution without
-- gaining access to patient profile or authentication secrets.
CREATE FUNCTION public.kms_assert_patient_scope(p_patient_id TEXT) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE a RECORD;
BEGIN
  SELECT * INTO STRICT a FROM public.kms_current_actor_context();
  IF a.actor_role = 'patient' AND p_patient_id IS DISTINCT FROM a.account_id THEN
    RAISE EXCEPTION 'kms_scope_unavailable';
  END IF;
  IF p_patient_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.accounts p WHERE p.tenant_id = a.tenant_id AND p.account_id = p_patient_id AND p.account_type = 'patient'
  ) THEN RAISE EXCEPTION 'kms_scope_unavailable'; END IF;
END $$;
ALTER FUNCTION public.kms_assert_patient_scope(TEXT) OWNER TO kms_context_owner;
REVOKE ALL ON FUNCTION public.kms_assert_patient_scope(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kms_assert_patient_scope(TEXT) TO telecheck_app_role, kms_service_role;

-- Attribution-only read for a denied decrypt (e.g. committed session
-- revocation). This never authorizes key access and requires a still-live,
-- unforgeable request nonce in the correct tenant. No credential fields.
CREATE FUNCTION public.kms_request_audit_context()
RETURNS TABLE (tenant_id TEXT, account_id TEXT, session_id TEXT, actor_role TEXT,
  country_of_care TEXT, request_nonce TEXT, transaction_id TEXT)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT n.actor_account_tenant_id::TEXT, n.actor_account_id::TEXT,
    n.session_id::TEXT, n.actor_role::TEXT, t.country_of_care::TEXT,
    n.nonce::TEXT, pg_catalog.txid_current()::TEXT
  FROM public._session_actor_context n JOIN public.tenants t ON t.id = n.actor_account_tenant_id
  WHERE n.nonce = NULLIF(pg_catalog.current_setting('app.request_nonce', true), '')::UUID
    AND n.actor_account_tenant_id = public.current_tenant_id()
    AND n.expires_at > pg_catalog.clock_timestamp()
    AND n.actor_role IN ('patient', 'clinician', 'tenant_admin')
$$;
ALTER FUNCTION public.kms_request_audit_context() OWNER TO kms_context_owner;
REVOKE ALL ON FUNCTION public.kms_request_audit_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kms_request_audit_context() TO telecheck_app_role;
