-- Disable new patient admission capability while preserving clinical evidence.
-- Deliberately retain events, lifecycle, audit, pending outbox, private dedup
-- rows, vocabulary extensions and the legacy patient anti-bypass wrappers.
-- Re-enabling the old weaker patient path is not a valid rollback.
BEGIN;
REVOKE crisis_care_patient FROM telecheck_app_role;
REVOKE EXECUTE ON FUNCTION public.crisis_care_record(TEXT,TEXT,TEXT),
  public.crisis_care_live_patient() FROM crisis_care_patient;
COMMIT;
