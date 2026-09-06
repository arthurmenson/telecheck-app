-- Reverse before 081 when reverting the Identity runtime package.
BEGIN;
DROP POLICY identity_cache_boundary ON public.idempotency_keys;
-- Auth retries are intentionally invalidated on rollback; never move bearer
-- tokens back to a cache that the ordinary application role can read.
DROP TABLE public.identity_idempotency_keys;
REVOKE INSERT (
    account_id, tenant_id, phone_e164, email, first_name, last_name,
    date_of_birth, gender, national_id, country_of_residence,
    country_of_care, locale
) ON public.accounts FROM identity_service_role;
REVOKE UPDATE (status, activated_at) ON public.accounts FROM identity_service_role;
REVOKE ALL ON public.tenants, public.accounts, public.sessions,
    public.auth_devices, public.account_pin_credentials, public.otp_challenges,
    public.email_passcodes, public.audit_records, public.domain_events_outbox
FROM identity_service_role;
REVOKE EXECUTE ON FUNCTION public.set_tenant_context(TEXT),
    public.clear_tenant_context(), public.current_tenant_id() FROM identity_service_role;
REVOKE USAGE ON SCHEMA public FROM identity_service_role;
DROP ROLE identity_service_role;
GRANT INSERT, UPDATE ON public.accounts, public.sessions TO telecheck_app_role;
GRANT SELECT, INSERT, UPDATE ON public.auth_devices, public.account_pin_credentials,
    public.otp_challenges, public.email_passcodes TO telecheck_app_role;
COMMIT;
