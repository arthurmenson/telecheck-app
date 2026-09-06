-- Remove only this read capability; retain all medication records.
SET LOCAL search_path = pg_catalog, public, pg_temp;
DROP FUNCTION public.async_consult_assert_live_patient();
REVOKE SELECT (nonce, actor_account_id, actor_account_tenant_id, actor_role, session_id, expires_at)
  ON public._session_actor_context FROM async_consult_history_read_owner;
REVOKE SELECT (account_id, tenant_id, account_type, status, deleted_at, country_of_care)
  ON public.accounts FROM async_consult_history_read_owner;
REVOKE SELECT (session_id, account_id, tenant_id, expires_at, revoked_at)
  ON public.sessions FROM async_consult_history_read_owner;
REVOKE SELECT (id, status, country_of_care) ON public.tenants FROM async_consult_history_read_owner;
REVOKE EXECUTE ON FUNCTION public.current_tenant_id() FROM async_consult_history_read_owner;
REVOKE USAGE ON SCHEMA public FROM async_consult_history_read_owner;
DROP ROLE async_consult_history_read_owner;
DROP FUNCTION public.read_patient_medication_requests(TEXT, TEXT, INTEGER);
DROP FUNCTION public.pharmacy_assert_live_patient();
REVOKE pharmacy_patient_reader FROM telecheck_app_role;
REVOKE SELECT (id, tenant_id, patient_account_id, country_of_care, created_at,
  medication_name, strength, formulation, dose_instructions, quantity, quantity_unit,
  refills_allowed, status, prescribed_at, activated_at, expires_at)
  ON public.medication_requests FROM pharmacy_patient_read_owner;
REVOKE SELECT (nonce, actor_account_id, actor_account_tenant_id, actor_role, session_id, expires_at)
  ON public._session_actor_context FROM pharmacy_patient_read_owner;
REVOKE SELECT (account_id, tenant_id, account_type, status, deleted_at, country_of_care)
  ON public.accounts FROM pharmacy_patient_read_owner;
REVOKE SELECT (session_id, account_id, tenant_id, expires_at, revoked_at)
  ON public.sessions FROM pharmacy_patient_read_owner;
REVOKE SELECT (id, status, country_of_care) ON public.tenants FROM pharmacy_patient_read_owner;
REVOKE EXECUTE ON FUNCTION public.current_tenant_id() FROM pharmacy_patient_read_owner;
REVOKE USAGE ON SCHEMA public FROM pharmacy_patient_reader, pharmacy_patient_read_owner;
DROP ROLE pharmacy_patient_reader;
DROP ROLE pharmacy_patient_read_owner;
