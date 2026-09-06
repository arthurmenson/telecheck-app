BEGIN;
REVOKE SELECT ON public.tenants FROM telecheck_app_role;
REVOKE EXECUTE ON FUNCTION public.set_tenant_context(TEXT) FROM telecheck_app_role;
REVOKE EXECUTE ON FUNCTION public.clear_tenant_context() FROM telecheck_app_role;
REVOKE SELECT, INSERT, UPDATE ON
    public.accounts, public.sessions, public.otp_challenges,
    public.auth_devices, public.account_pin_credentials, public.email_passcodes
FROM telecheck_app_role;
REVOKE SELECT, INSERT ON public.audit_records, public.domain_events_outbox FROM telecheck_app_role;
REVOKE SELECT, INSERT, UPDATE, DELETE ON public.idempotency_keys, public.audit_dedupe_markers
FROM telecheck_app_role;
-- Retain public-schema USAGE and current_tenant_id(), already available to
-- PUBLIC in the baseline. Do not revoke grants belonging to other migrations.
COMMIT;
