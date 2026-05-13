-- =============================================================================
-- File:    migrations/rollback/026_rollback.sql
-- Purpose: Rollback for 026_medication_requests_supersession_reciprocity.sql —
--          drop the constraint trigger and its underlying PL/pgSQL function.
-- Spec:    Companion to migrations/026_medication_requests_supersession_reciprocity.sql.
-- Note:    Idempotent — uses `IF EXISTS` so the rollback is safe to re-run
--          after a successful rollback or against a partial-apply state.
-- Warning: Rolling back this migration removes reciprocity enforcement at
--          the durable boundary. Existing one-sided edges become silent;
--          new one-sided edges become possible from any direct-SQL path
--          that bypasses the application layer's repo guards. Only roll
--          back if the schema is being re-baselined; never roll back in
--          production while:
--            - any medication_requests row has non-null superseded_by_id
--              or supersedes_id
--            - the pharmacy supersession write path is live in any tenant
-- =============================================================================

DROP TRIGGER IF EXISTS medication_requests_supersession_reciprocity_trigger
    ON medication_requests;

DROP FUNCTION IF EXISTS medication_requests_supersession_reciprocity_check();
