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
-- The old cache stored the raw path. Fastify also accepts percent-encoded
-- ASCII in route segments, including failed authentication requests whose
-- response contains no token but whose request hash fingerprints a PIN/OTP.
-- Decode exactly one layer for classification only; retain the original
-- endpoint, key, fingerprint and expiry so existing retries keep their scope.
CREATE FUNCTION pg_temp.identity_legacy_endpoint(p_path TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE STRICT AS $decode$
DECLARE
    v_result TEXT := '';
    v_position INTEGER := 1;
    v_token TEXT;
    v_byte INTEGER;
BEGIN
    -- Match find-my-way's accepted absolute-form prefix, including an empty
    -- authority. This is routing normalization, not standards URL validation.
    p_path := regexp_replace(p_path, '^https?://[^/]*/', '/');
    WHILE v_position <= length(p_path) LOOP
        v_token := substring(p_path FROM v_position FOR 3);
        IF v_token ~ '^%[0-9a-fA-F]{2}$' THEN
            v_byte := get_byte(decode(substring(v_token FROM 2), 'hex'), 0);
            -- Non-ASCII and NUL cannot spell this ASCII route namespace.
            v_result := v_result || CASE WHEN v_byte BETWEEN 1 AND 127
                THEN chr(v_byte) ELSE v_token END;
            v_position := v_position + 3;
        ELSE
            v_result := v_result || substring(p_path FROM v_position FOR 1);
            v_position := v_position + 1;
        END IF;
    END LOOP;
    RETURN lower(v_result);
END $decode$;
-- Legacy key construction split at the first '?' even inside an absolute
-- authority. Its original route is then unrecoverable. Do not trust/replay it
-- as Identity or delete it and risk repeating a non-Identity side effect.
-- Preserve a nonsecret reconciliation tombstone in BOTH cache capabilities.
-- The reserved zero fingerprint is recognized before normal hash comparison.
UPDATE public.idempotency_keys
   SET request_hash = decode(repeat('00', 32), 'hex'),
       response_status = 409,
       response_body = '{"error":{"code":"internal.idempotency.legacy_result_unavailable","message":"The legacy operation result is unavailable. Reconcile its status before retrying."}}'::jsonb,
       processing_state = 'completed'
 WHERE endpoint ~ '^https?://[^/]*$';
INSERT INTO public.identity_idempotency_keys
    SELECT * FROM public.idempotency_keys
     WHERE pg_temp.identity_legacy_endpoint(endpoint) ~ '^/v0/identity(/|$)'
        OR endpoint ~ '^https?://[^/]*$';
DELETE FROM public.idempotency_keys
 WHERE pg_temp.identity_legacy_endpoint(endpoint) ~ '^/v0/identity(/|$)'
    OR response_body ?| ARRAY['access_token','refresh_token','dev_otp','dev_passcode'];
DROP FUNCTION pg_temp.identity_legacy_endpoint(TEXT);

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
