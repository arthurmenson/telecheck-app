-- =============================================================================
-- File:    migrations/008_forms_submission_in_progress_uniqueness.sql
-- Purpose: Enforce at most one `in_progress` forms_submission per
--          (tenant_id, deployment_id, patient_id) tuple so save-and-resume
--          restoration cannot ambiguously pick among multiple matching
--          submissions.
-- Spec:    Slice PRD v2.1 §8 (save-and-resume); INVARIANT I-023 (PHI scope);
--          Codex resume-restore-r1 HIGH closure 2026-05-03.
-- =============================================================================
--
-- Why this exists
-- ---------------
-- Migration 006 created `forms_resume_state` WITHOUT a `submission_id`
-- column. The save-and-resume restore flow therefore has to RECONSTRUCT the
-- (resume_state ↔ submission) binding at restore time via:
--
--   SELECT * FROM forms_submission
--    WHERE tenant_id = $1 AND deployment_id = $2 AND patient_id = $3
--      AND status = 'in_progress' AND deleted_at IS NULL
--    ORDER BY created_at DESC LIMIT 1
--
-- That works UNAMBIGUOUSLY only when at most one `in_progress` row exists
-- for the tuple. Otherwise the LIMIT 1 picks "most recent" which can be a
-- DIFFERENT submission than the one the patient paused — restore would
-- then write the decrypted paused responses on top of a fresh-start
-- submission, silently corrupting the fresh-start's progress.
--
-- The proper fix is to add `submission_id` to forms_resume_state with a
-- composite tenant-scoped FK. That's a future migration. As an immediate
-- structural mitigation per Codex resume-restore-r1 recommendation, this
-- migration adds a partial unique index that prevents the ambiguity from
-- arising in the first place: at most one `in_progress` submission per
-- (tenant_id, deployment_id, patient_id) tuple.
--
-- The application layer in `submission-repo.createSubmission` translates
-- the `23505` SQLSTATE into the `IN_PROGRESS_SUBMISSION_EXISTS` sentinel
-- which the handler maps to a tenant-blind 400 envelope per I-025.
--
-- Why partial (`WHERE status = 'in_progress' AND deleted_at IS NULL`)
-- -------------------------------------------------------------------
-- A patient may legitimately have multiple `submitted` / `withdrawn` rows
-- for the same deployment over time (one submission per visit). The
-- uniqueness constraint applies ONLY to the not-yet-completed working
-- copy. `deleted_at IS NULL` excludes the soft-delete tombstones that
-- would otherwise re-enable the conflict if a deleted-then-undeleted
-- row existed (defensive — soft-delete recovery isn't wired today, but
-- the predicate composes correctly when it lands).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Preflight check (Codex resume-restore-r2 HIGH closure 2026-05-03):
--
-- Refuse to create the unique index if existing rows would already
-- violate it. CREATE UNIQUE INDEX would otherwise fail with a generic
-- pg error that buries the affected tuples; the operator-facing
-- experience would be "migration failed, why?" with no remediation hint.
--
-- This DO block runs BEFORE the index creation, counts violators per
-- tuple, and RAISEs an exception with a clear message + the count. The
-- operator runs a remediation query (see comment block below the DO)
-- to resolve duplicates, then re-runs the migration. On greenfield /
-- empty environments the check passes silently because COUNT(*) = 0.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    duplicate_tuple_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO duplicate_tuple_count
      FROM (
        SELECT 1
          FROM forms_submission
         WHERE status = 'in_progress'
           AND deleted_at IS NULL
         GROUP BY tenant_id, deployment_id, patient_id
        HAVING COUNT(*) > 1
      ) AS dup_tuples;

    IF duplicate_tuple_count > 0 THEN
        RAISE EXCEPTION
            'Migration 008 cannot create uq_forms_submission_one_in_progress_per_tuple: % distinct (tenant_id, deployment_id, patient_id) tuples already have multiple in_progress forms_submission rows. '
            'Remediate before re-running this migration. Suggested remediation query: '
            'SELECT tenant_id, deployment_id, patient_id, COUNT(*), array_agg(submission_id ORDER BY created_at DESC) FROM forms_submission WHERE status = ''in_progress'' AND deleted_at IS NULL GROUP BY tenant_id, deployment_id, patient_id HAVING COUNT(*) > 1; '
            'Decide which submission_id is canonical for each tuple (typically the most-recent one) and either soft-delete (set deleted_at = NOW()) or transition the others to ''withdrawn'' status. The slice PRD §8 narrative implies 1:1 binding so duplicates are a data defect, not legitimate state.',
            duplicate_tuple_count;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_forms_submission_one_in_progress_per_tuple
    ON forms_submission (tenant_id, deployment_id, patient_id)
    WHERE status = 'in_progress' AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Spec note for the next reader: when forms_resume_state.submission_id is
-- added, this partial unique index can be RELAXED (or kept as an additional
-- defensive constraint). Removing it would require a corresponding update
-- in submission-repo.createSubmission so the application layer no longer
-- relies on the 23505 translation.
-- ---------------------------------------------------------------------------
