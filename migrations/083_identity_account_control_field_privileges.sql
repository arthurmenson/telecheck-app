-- Separate the authentication trust boundary from ordinary application SQL.
-- This migration is part of the unmerged Identity bootstrap package.
BEGIN;
CREATE ROLE identity_service_role NOLOGIN NOSUPERUSER NOBYPASSRLS
    NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT USAGE ON SCHEMA public TO identity_service_role;
GRANT EXECUTE ON FUNCTION public.set_tenant_context(TEXT),
    public.clear_tenant_context(), public.current_tenant_id()
TO identity_service_role;
GRANT SELECT ON public.tenants, public.accounts TO identity_service_role;

REVOKE INSERT, UPDATE ON public.accounts, public.sessions FROM telecheck_app_role;
REVOKE ALL ON public.account_pin_credentials, public.otp_challenges,
    public.email_passcodes, public.auth_devices FROM telecheck_app_role;

GRANT INSERT (
    account_id, tenant_id, phone_e164, email, first_name, last_name,
    date_of_birth, gender, national_id, country_of_residence,
    country_of_care, locale
) ON public.accounts TO identity_service_role;
GRANT UPDATE (status, activated_at) ON public.accounts TO identity_service_role;
-- account_type defaults to patient; cohort_classification defaults to
-- unclassified. Both remain governed by separate privileged provisioning.
-- updated_at is maintained by the existing trigger, not direct app writes.
GRANT SELECT, INSERT, UPDATE ON public.sessions, public.auth_devices,
    public.account_pin_credentials, public.otp_challenges, public.email_passcodes
TO identity_service_role;
GRANT SELECT, INSERT ON public.audit_records, public.domain_events_outbox
TO identity_service_role;
CREATE TABLE public.identity_idempotency_keys
    (LIKE public.idempotency_keys INCLUDING ALL);
ALTER TABLE public.identity_idempotency_keys
    ADD FOREIGN KEY (tenant_id) REFERENCES public.tenants(id);
ALTER TABLE public.identity_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.identity_idempotency_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.identity_idempotency_keys
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON public.identity_idempotency_keys
TO identity_service_role;

-- Retain existing auth retry results and original TTLs while relocating secrets.
-- Includes suspended tenants whose context setter intentionally rejects binding.
-- Table ownership alone cannot bypass FORCE RLS: require the trusted migration
-- principal's explicit bypass power for this one-time secret relocation.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user
                   AND (rolsuper OR rolbypassrls)) THEN
        RAISE EXCEPTION 'identity_cache_relocation_requires_migration_rls_bypass';
    END IF;
END $$;
INSERT INTO public.identity_idempotency_keys
    SELECT * FROM public.idempotency_keys
     WHERE lower(endpoint) ~ '^/v0/identity(/|$)';
DELETE FROM public.idempotency_keys
 WHERE lower(endpoint) ~ '^/v0/identity(/|$)'
    OR response_body ?| ARRAY['access_token','refresh_token','dev_otp','dev_passcode'];

-- Auth replay contains bearer tokens and low-entropy credential fingerprints.
-- Restrictive policy composes with tenant RLS and protects reads, deletes,
-- and both old/new rows of UPDATE (including endpoint relabeling attempts).
CREATE POLICY identity_cache_boundary ON public.idempotency_keys
    AS RESTRICTIVE FOR ALL TO PUBLIC
    USING (
        lower(endpoint) !~ '^/v0/identity(/|$)'
        OR pg_has_role(current_user, 'identity_service_role', 'USAGE')
    )
    WITH CHECK (
        lower(endpoint) !~ '^/v0/identity(/|$)'
        OR pg_has_role(current_user, 'identity_service_role', 'USAGE')
    );

-- Authentication is a separate login identity, never a SET ROLE capability
-- granted to application SQL or the narrow actor-binding connection.
DO $$ BEGIN
    IF pg_has_role('telecheck_app_role', 'identity_service_role', 'MEMBER')
       OR pg_has_role('bind_actor_context_role', 'identity_service_role', 'MEMBER') THEN
        RAISE EXCEPTION 'identity_role_must_be_isolated';
    END IF;
END $$;
COMMIT;
