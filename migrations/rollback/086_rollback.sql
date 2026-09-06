-- Only an unused classified deployment can roll back; never strand PHI.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.kms_dek_keyring) THEN
    RAISE EXCEPTION 'kms_rollback_requires_verified_data_migration';
  END IF;
END $$;
DROP FUNCTION kms_request_audit_context();
DROP FUNCTION kms_assert_patient_scope(TEXT);
DROP FUNCTION kms_current_actor_context();
REVOKE SELECT ON _session_actor_context FROM kms_context_owner;
REVOKE SELECT (nonce, actor_account_id, actor_account_tenant_id, actor_role, session_id, expires_at) ON _session_actor_context FROM kms_context_owner;
REVOKE SELECT (account_id, tenant_id, account_type, status) ON accounts FROM kms_context_owner;
REVOKE SELECT (session_id, account_id, tenant_id, expires_at, revoked_at) ON sessions FROM kms_context_owner;
REVOKE SELECT (id, status, country_of_care) ON tenants FROM kms_context_owner, kms_service_role;
REVOKE SELECT, INSERT ON audit_records FROM kms_service_role;
-- Shared tenant-context grants to app remain valid for existing modules.
