-- =============================================================================
-- rollback/080_rollback.sql — unwind 080_pilot_1_cohort_classification
--
-- Removes the cohort_classification column + related indexes + comment
-- from accounts. Safe because no downstream code depends on the column
-- (pilot-1-env-purge fails-closed if the column is absent, per PII spec
-- §Purge preconditions §Manifest inventory).
--
-- NOTE: dropping the column DOES discard the classification data for
-- every existing row. If Pilot 1 has run and participant rows exist,
-- run pilot-1-close-wipe.sh BEFORE rolling this migration back so no
-- participant data survives without its purge-scope classification.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_accounts_cohort_participant;
DROP INDEX IF EXISTS idx_accounts_cohort_unclassified;

ALTER TABLE accounts
    DROP COLUMN IF EXISTS cohort_classification;

COMMIT;
