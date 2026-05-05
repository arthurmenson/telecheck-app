-- =============================================================================
-- File:    migrations/rollback/008_rollback.sql
-- Purpose: Rollback for 008_forms_submission_in_progress_uniqueness.sql —
--          drop the partial unique index that enforces "at most one
--          in_progress submission per (tenant_id, deployment_id, patient_id)".
-- Spec:    Companion to migrations/008_forms_submission_in_progress_uniqueness.sql.
-- Warning: NON-DESTRUCTIVE. No rows are touched. After rollback, the
--          ambiguity that motivated 008 returns: save-and-resume
--          restoration may pick non-deterministically among multiple
--          matching in_progress rows. Do not run in any environment
--          serving live patient submissions without a remediation plan
--          for the resulting ambiguity (per Codex resume-restore-r1).
-- =============================================================================

DROP INDEX IF EXISTS uq_forms_submission_one_in_progress_per_tuple;
