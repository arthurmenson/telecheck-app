-- Immutable per-tenant key-material / IAM-role / residency identity.
-- Credentials and AWS resources are provisioned outside migrations.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kms_context_owner') THEN
    CREATE ROLE kms_context_owner NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kms_service_role') THEN
    CREATE ROLE kms_service_role LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'kms_provisioner_role') THEN
    CREATE ROLE kms_provisioner_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF pg_catalog.pg_has_role('telecheck_app_role', 'kms_service_role', 'MEMBER') OR
     pg_catalog.pg_has_role('telecheck_app_role', 'kms_provisioner_role', 'MEMBER') OR
     pg_catalog.pg_has_role('telecheck_app_role', 'kms_context_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'kms_role_separation_required';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO kms_context_owner, kms_service_role, kms_provisioner_role;

CREATE TABLE public.tenant_kms_bindings (
  tenant_id TEXT PRIMARY KEY REFERENCES public.tenants(id),
  cmk_arn TEXT NOT NULL UNIQUE CHECK (cmk_arn ~ '^arn:aws:kms:us-east-1:[0-9]{12}:key/(mrk-[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$'),
  -- Regional MRK ARNs with the same normalized identity share material.
  key_material_identity TEXT GENERATED ALWAYS AS (
    pg_catalog.split_part(cmk_arn, ':', 2) || ':' || pg_catalog.split_part(cmk_arn, ':', 5) || ':' || pg_catalog.split_part(cmk_arn, ':', 6)
  ) STORED UNIQUE,
  service_role_arn TEXT NOT NULL UNIQUE CHECK (pg_catalog.length(service_role_arn) <= 550 AND service_role_arn ~ '^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$'),
  primary_region TEXT NOT NULL DEFAULT 'us-east-1' CHECK (primary_region = 'us-east-1'),
  residency_policy TEXT NOT NULL CHECK (residency_policy IN ('us_only', 'us_with_dr_fallback')),
  replica_arn TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CHECK (pg_catalog.split_part(cmk_arn, ':', 5) = pg_catalog.split_part(service_role_arn, ':', 5)),
  CHECK ((residency_policy = 'us_only' AND replica_arn IS NULL) OR
    (residency_policy = 'us_with_dr_fallback' AND cmk_arn LIKE '%:key/mrk-%' AND
      replica_arn IS NOT NULL AND replica_arn = pg_catalog.replace(cmk_arn, ':us-east-1:', ':us-west-2:')))
);
ALTER TABLE public.tenant_kms_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_kms_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY kms_binding_tenant_read ON public.tenant_kms_bindings FOR SELECT
  USING (tenant_id = public.current_tenant_id());
CREATE POLICY kms_binding_provision ON public.tenant_kms_bindings FOR INSERT TO kms_provisioner_role
  WITH CHECK (true);
REVOKE ALL ON public.tenant_kms_bindings FROM PUBLIC, telecheck_app_role;
GRANT SELECT ON public.tenant_kms_bindings TO telecheck_app_role, kms_service_role;
GRANT INSERT ON public.tenant_kms_bindings TO kms_provisioner_role;

CREATE FUNCTION public.kms_reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN RAISE EXCEPTION 'kms_immutable_record'; END $$;
REVOKE ALL ON FUNCTION public.kms_reject_immutable_mutation() FROM PUBLIC;
CREATE TRIGGER kms_binding_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.tenant_kms_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION public.kms_reject_immutable_mutation();
