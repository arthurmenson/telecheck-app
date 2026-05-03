-- =============================================================================
-- File:    migrations/rollback/007_rollback.sql
-- Purpose: Rollback for 007_audit_records_platform_check_backfill.sql — drops
--          chk_target_patient_not_platform on public.audit_records BUT ONLY
--          when migration 007's forward DO block is the agent that ADDed it
--          (provenance-checked via COMMENT ON CONSTRAINT marker).
-- Spec:    Companion to migrations/007_audit_records_platform_check_backfill.sql
--          per migrations/README.md "Every migration has a rollback companion."
-- Warning: NON-DESTRUCTIVE. This rollback only drops a CHECK constraint; no
--          rows are touched. After rollback, public.audit_records will once
--          again accept target_patient_id = 'PLATFORM' literal — which
--          weakens I-023 hash-chain partition independence. Do not run in
--          any environment where the chain has already been built without
--          a follow-up plan to remediate any subsequently-inserted PLATFORM
--          rows.
-- =============================================================================
--
-- Provenance-safe rollback (verify-r8 HIGH-8 closure 2026-05-03):
--
-- The constraint chk_target_patient_not_platform attaches to public.audit_records
-- via two distinct paths:
--
--   (a) Migration 002's inline column CHECK — applies on fresh-create
--       environments. NO comment is set in this path.
--   (b) Migration 007's idempotent DO block — applies on pre-existing
--       environments where (a) didn't run before this commit series. The
--       forward migration sets COMMENT ON CONSTRAINT to the marker
--       'added_by_migration_007_audit_records_platform_check_backfill' so
--       rollback can identify its own work.
--
-- An unconditional DROP CONSTRAINT IF EXISTS would happily destroy the
-- baseline (a) constraint too, leaving fresh-create schemas WEAKER than
-- the pre-007 state — Codex flagged this as HIGH (no-ship) on round 8.
--
-- This rollback only drops the constraint when the marker comment is
-- present, so:
--   - Fresh-create environments: comment absent → DROP skipped → baseline
--     I-023 invariant preserved.
--   - Pre-existing environments where 007 added the constraint: comment
--     present → DROP runs → schema returns to its pre-007 state.
--   - Environments where neither 002 nor 007 attached the constraint:
--     no constraint to drop, comment absent — DROP skipped (no-op).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM   pg_constraint c
        WHERE  c.conname  = 'chk_target_patient_not_platform'
          AND  c.conrelid = 'public.audit_records'::regclass
          AND  c.contype  = 'c'
          AND  obj_description(c.oid, 'pg_constraint')
                 = 'added_by_migration_007_audit_records_platform_check_backfill'
    ) THEN
        ALTER TABLE public.audit_records
            DROP CONSTRAINT chk_target_patient_not_platform;
    END IF;
END
$$;
