BEGIN;
REVOKE SELECT ON public.tenant_brands, public.country_profiles,
    public.ccr_configs, public.adapter_configs, public.tenant_users
FROM telecheck_app_role;
COMMIT;
