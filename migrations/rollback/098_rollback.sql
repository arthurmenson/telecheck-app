-- Preserve real staff identities and immutable onboarding evidence.
DO $$ BEGIN
  RAISE EXCEPTION 'staff_enrollment_requires_forward_repair' USING ERRCODE='0A000';
END $$;
