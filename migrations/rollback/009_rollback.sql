-- =============================================================================
-- File:    migrations/rollback/009_rollback.sql
-- Purpose: Rollback for 009_forms_snapshot_one_per_submission.sql — drop
--          the unique constraint enforcing "at most one snapshot per
--          (tenant_id, submission_id)".
-- Spec:    Companion to migrations/009_forms_snapshot_one_per_submission.sql.
-- Warning: NON-DESTRUCTIVE. No rows are touched. After rollback, the
--          ambiguity that motivated 009 returns: a buggy retry / parallel
--          call / backfill could persist multiple immutable snapshot rows
--          per submission, and `findSnapshotBySubmissionId` (LIMIT 1, no
--          ORDER BY) would non-deterministically pick among them. Do not
--          run in any environment serving live clinician + audit reads
--          without a remediation plan (per Codex snapshot-write-r1).
-- =============================================================================

DROP INDEX IF EXISTS uq_forms_snapshot_one_per_submission;
