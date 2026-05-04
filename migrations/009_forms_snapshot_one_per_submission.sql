-- =============================================================================
-- File:    migrations/009_forms_snapshot_one_per_submission.sql
-- Purpose: Enforce at most one forms_snapshot per (tenant_id, submission_id)
--          tuple so clinician + audit reconstruction reads have an
--          unambiguous one-to-one mapping from a submission to its
--          immutable view.
-- Spec:    Slice PRD v2.1 §4 (snapshot layer); INVARIANT I-013 (immutable
--          published versions, analogous floor for snapshots);
--          Codex snapshot-write-r1 HIGH closure 2026-05-03.
-- =============================================================================
--
-- Why this exists
-- ---------------
-- Migration 006 created `forms_snapshot` with a NON-UNIQUE index on
-- `(tenant_id, submission_id)` (idx_forms_snapshot_submission). The
-- application layer's createSnapshot generates a fresh ULID for every
-- INSERT — so a buggy retry, parallel-call, or backfill can persist
-- MULTIPLE immutable rows for one submission.
--
-- `findSnapshotBySubmissionId` selects with LIMIT 1 and no ORDER BY,
-- which means clinician + audit reconstruction reads an ARBITRARY one
-- of the duplicate snapshots. Two reads of the same submission can
-- return different presented_content blobs, undermining the immutability
-- invariant the snapshot is supposed to provide.
--
-- This migration adds a true UNIQUE constraint on
-- `(tenant_id, submission_id)`. The application's createSnapshot already
-- catches `23505` and translates to SNAPSHOT_ALREADY_EXISTS, so callers
-- will see a clear sentinel + tenant-blind 400 instead of silently
-- creating a phantom row.
--
-- The non-unique idx_forms_snapshot_submission is kept for query
-- performance (some lookups don't need the uniqueness check). Postgres
-- happily uses either one for the same predicate.
--
-- Preflight
-- ---------
-- Identical pattern to migration 008's preflight: count violators per
-- tuple, raise an exception with a copy-pasteable remediation query if
-- any exist. On greenfield environments the count is zero and the
-- migration proceeds silently.
-- =============================================================================

DO $$
DECLARE
    duplicate_tuple_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO duplicate_tuple_count
      FROM (
        SELECT 1
          FROM forms_snapshot
         GROUP BY tenant_id, submission_id
        HAVING COUNT(*) > 1
      ) AS dup_tuples;

    IF duplicate_tuple_count > 0 THEN
        RAISE EXCEPTION
            'Migration 009 cannot create uq_forms_snapshot_one_per_submission: % distinct (tenant_id, submission_id) tuples already have multiple forms_snapshot rows. '
            'Remediate before re-running this migration. Suggested remediation query: '
            'SELECT tenant_id, submission_id, COUNT(*), array_agg(snapshot_id ORDER BY created_at) FROM forms_snapshot GROUP BY tenant_id, submission_id HAVING COUNT(*) > 1; '
            'Decide which snapshot_id is canonical for each tuple (typically the EARLIEST created_at — the snapshot at the original submit time before any retry/backfill). Snapshots are append-only at the migration level (REVOKE UPDATE/DELETE) so duplicates cannot be removed via the application path; an operator with platform-admin DB privileges must purge non-canonical rows manually after archiving them, then re-run this migration.',
            duplicate_tuple_count;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_forms_snapshot_one_per_submission
    ON forms_snapshot (tenant_id, submission_id);

-- ---------------------------------------------------------------------------
-- Spec note for the next reader: this constraint is one-directional
-- (snapshot -> submission). The reverse direction (submission -> at-most-one
-- snapshot) is now implicit via the same constraint. If a future migration
-- adds idempotency-key support for snapshot creation, the constraint should
-- be RELAXED to allow tombstones / soft-deletes — at which point this index
-- can be made partial via WHERE deleted_at IS NULL (forms_snapshot doesn't
-- have a deleted_at column today; that would require its own forward
-- migration).
-- ---------------------------------------------------------------------------
