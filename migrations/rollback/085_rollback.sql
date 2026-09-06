DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.kms_dek_keyring) THEN
    RAISE EXCEPTION 'kms_rollback_requires_verified_data_migration';
  END IF;
END $$;
DROP TABLE kms_active_class_keys;
DROP TABLE kms_dek_keyring;
