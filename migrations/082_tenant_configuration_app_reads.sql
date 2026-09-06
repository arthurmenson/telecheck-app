-- Patient brand/country bootstrap and authorized configuration reads.
-- Tenant-owned configuration remains behind forced RLS and application
-- authorization; country_profiles is the canonical shared country catalog.
BEGIN;
DO $$
DECLARE table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['tenant_brands', 'ccr_configs', 'adapter_configs', 'tenant_users'] LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname=table_name
               AND c.relrowsecurity AND c.relforcerowsecurity
        ) THEN RAISE EXCEPTION 'configuration_table_rls_required'; END IF;
    END LOOP;
END $$;
GRANT SELECT ON public.tenant_brands, public.country_profiles,
    public.ccr_configs, public.adapter_configs, public.tenant_users
TO telecheck_app_role;
COMMIT;
