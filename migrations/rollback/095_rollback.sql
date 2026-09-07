-- Clinical evidence and its authorization boundary must not be downgraded by
-- a generic migration reversal. Recovery is a reviewed forward migration.
DO $$ BEGIN
  RAISE EXCEPTION 'care_intake_rollback_requires_reviewed_forward_migration' USING ERRCODE='0A000';
END $$;
