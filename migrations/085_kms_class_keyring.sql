-- Canonical CDM §4.60; ULID version adaptation follows migration 056.
-- Retain all old versions. No retirement/purge until verified rewrap exists.
CREATE TABLE kms_dek_keyring (
  tenant_id TEXT NOT NULL REFERENCES tenant_kms_bindings(tenant_id),
  data_class TEXT NOT NULL CHECK (data_class IN ('pii_demographic', 'pii_clinical',
    'pii_sensitive_clinical', 'pii_financial', 'pii_conversation', 'pii_audit_payload', 'pii_research_consented')),
  dek_version_id VARCHAR(26) NOT NULL CHECK (dek_version_id ~ '^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  encrypted_dek_blob BYTEA NOT NULL CHECK (octet_length(encrypted_dek_blob) BETWEEN 1 AND 6144),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  retired_at TIMESTAMPTZ NULL CHECK (retired_at IS NULL),
  purged_at TIMESTAMPTZ NULL CHECK (purged_at IS NULL),
  PRIMARY KEY (tenant_id, data_class, dek_version_id),
  UNIQUE (dek_version_id)
);
CREATE TABLE kms_active_class_keys (
  tenant_id TEXT NOT NULL,
  data_class TEXT NOT NULL,
  dek_version_id VARCHAR(26) NOT NULL,
  PRIMARY KEY (tenant_id, data_class),
  FOREIGN KEY (tenant_id, data_class, dek_version_id)
    REFERENCES kms_dek_keyring(tenant_id, data_class, dek_version_id)
);
ALTER TABLE kms_dek_keyring ENABLE ROW LEVEL SECURITY;
ALTER TABLE kms_dek_keyring FORCE ROW LEVEL SECURITY;
ALTER TABLE kms_active_class_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE kms_active_class_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY kms_keyring_tenant ON kms_dek_keyring USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY kms_active_tenant ON kms_active_class_keys USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
REVOKE ALL ON kms_dek_keyring, kms_active_class_keys FROM PUBLIC, telecheck_app_role;
GRANT SELECT ON kms_dek_keyring, kms_active_class_keys TO telecheck_app_role, kms_service_role;
GRANT INSERT ON kms_dek_keyring TO kms_service_role;
GRANT INSERT, UPDATE ON kms_active_class_keys TO kms_service_role;
CREATE TRIGGER kms_dek_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON kms_dek_keyring
  FOR EACH STATEMENT EXECUTE FUNCTION kms_reject_immutable_mutation();
-- The dedicated login cannot be SET ROLE'd into by ordinary app SQL.
-- It is intentionally the only keyring writer, mirroring SI-010's bind pool.
