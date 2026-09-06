DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.tenant_kms_bindings) THEN
    RAISE EXCEPTION 'kms_rollback_requires_verified_data_migration';
  END IF;
END $$;
DROP TABLE public.tenant_kms_bindings;
DROP FUNCTION public.kms_reject_immutable_mutation();
-- PostgreSQL roles are cluster-scoped and may serve other databases; do not
-- delete them automatically. Credential revocation is an operator action.
