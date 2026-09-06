-- Ordinary application privileges for foundation and Identity handlers.
-- ADR-023 / I-023: runtime sessions never need SUPERUSER or BYPASSRLS.
-- Completes the explicitly deferred app-role grants in migrations 002/003.
-- Restricted clinical wrappers retain their existing NOINHERIT role model.
BEGIN;

DO $$
DECLARE
    unsafe BOOLEAN;
    table_name TEXT;
BEGIN
    SELECT rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole
      INTO unsafe FROM pg_roles WHERE rolname = 'telecheck_app_role';
    IF unsafe IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'application_role_privilege_configuration_invalid';
    END IF;
    FOREACH table_name IN ARRAY ARRAY[
        'accounts', 'sessions', 'otp_challenges', 'auth_devices',
        'account_pin_credentials', 'email_passcodes', 'audit_records',
        'domain_events_outbox', 'idempotency_keys'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relname = table_name
               AND c.relrowsecurity AND c.relforcerowsecurity
        ) THEN
            RAISE EXCEPTION 'application_table_rls_required';
        END IF;
    END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO telecheck_app_role;
GRANT SELECT ON public.tenants TO telecheck_app_role;
GRANT EXECUTE ON FUNCTION public.set_tenant_context(TEXT) TO telecheck_app_role;
GRANT EXECUTE ON FUNCTION public.clear_tenant_context() TO telecheck_app_role;
GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO telecheck_app_role;

-- Only the operations performed by current Identity repositories. Deletion
-- and role administration are not part of ordinary self-service handlers.
GRANT SELECT, INSERT, UPDATE ON
    public.accounts, public.sessions, public.otp_challenges,
    public.auth_devices, public.account_pin_credentials, public.email_passcodes
TO telecheck_app_role;

-- Durable same-transaction audit and outbox emission; immutable records
-- cannot be rewritten or removed by this application role.
GRANT SELECT, INSERT ON public.audit_records, public.domain_events_outbox
TO telecheck_app_role;

-- Idempotency completion and expiry cleanup are explicit foundation duties.
-- Migration 022 intentionally exempts opaque audit dedupe markers from RLS;
-- its caller contract requires explicit tenant predicates. Preserve that
-- existing non-PHI marker contract; never exempt identity/audit/event data.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.idempotency_keys, public.audit_dedupe_markers
TO telecheck_app_role;

-- No direct grants to trust-anchor tables, clinical base tables, key stores,
-- break-glass helpers, or role administration are introduced here.
COMMIT;
