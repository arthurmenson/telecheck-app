-- =============================================================================
-- File:    migrations/rollback/007_rollback.sql
-- Purpose: Rollback for 007_audit_records_platform_check_backfill.sql — drops
--          the chk_target_patient_not_platform constraint on
--          public.audit_records if it was added by 007 (or by 002's inline
--          column CHECK on a fresh-create environment).
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
-- Idempotent: schema-qualified DROP CONSTRAINT IF EXISTS so this rollback
-- can run safely on any environment regardless of whether 007 has been
-- applied. The 'public.audit_records' qualification matches the forward
-- migration's probe and ALTER target.
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS public.audit_records
    DROP CONSTRAINT IF EXISTS chk_target_patient_not_platform;
