-- =============================================================================
-- File:    migrations/007_audit_records_platform_check_backfill.sql
-- Purpose: Idempotent backfill of `chk_target_patient_not_platform` on
--          public.audit_records for environments that ran migration 002
--          before the inline column CHECK was added (2026-05-03).
-- Spec:    AUDIT_EVENTS v5.2 §hash-chain partition; I-023 cryptographic
--          tenant isolation; Codex CI-fix verify-r6 HIGH-7 + MEDIUM-6.
-- =============================================================================
--
-- Why a separate migration instead of editing migration 002 in place:
--
--   1. Migration 002 contains non-idempotent DDL (CREATE POLICY, CREATE TRIGGER
--      without IF NOT EXISTS support before PG 15+). On a pre-existing
--      environment that ran 002 before this constraint was added, replaying
--      002 in a wrapping transaction would fail on the duplicate-policy /
--      duplicate-trigger statements and roll back any constraint addition
--      done earlier in the same transaction. Shipping the backfill as a
--      separate forward migration runs the constraint addition in its own
--      transaction, isolated from 002's non-idempotent later DDL. (verify-r6
--      MEDIUM-6 closure.)
--
--   2. The probe and ALTER are schema-qualified to public.audit_records
--      explicitly. A relname-only probe could match an audit_records table
--      in another schema and skip the public one, leaving a real I-023
--      hazard while reporting the migration as applied. (verify-r6 HIGH-7
--      closure.)
--
-- Behavior:
--   - On fresh-create environments where migration 002's inline column
--     CHECK already attached `chk_target_patient_not_platform`, this DO
--     block is a no-op (the existence probe finds the constraint and
--     skips the ADD).
--   - On pre-existing environments that ran 002 before 2026-05-03, the
--     ALTER attaches the constraint and VALIDATEs inline. If a row with
--     target_patient_id = 'PLATFORM' somehow exists, the ALTER RAISEs —
--     the operator must reconcile that row before the migration can
--     complete, because that row is an I-023 hash-chain violation that
--     needs explicit attention rather than silent backfill.
-- ---------------------------------------------------------------------------

-- Provenance marker for rollback safety (verify-r8 HIGH-8 closure):
-- when this DO block is the agent that ADDs the constraint, it tags the
-- constraint with COMMENT ON CONSTRAINT '...added_by_migration_007...'.
-- The rollback companion (migrations/rollback/007_rollback.sql) only
-- DROPs the constraint when this exact comment is present, so on a
-- fresh-create environment where 002's inline column CHECK already
-- attached the constraint (without this comment), 007's rollback is a
-- no-op — preserving the baseline I-023 invariant rather than weakening
-- the schema below the pre-007 state.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint c
        WHERE  c.conname  = 'chk_target_patient_not_platform'
          AND  c.conrelid = 'public.audit_records'::regclass
          AND  c.contype  = 'c'
    ) THEN
        ALTER TABLE public.audit_records
            ADD CONSTRAINT chk_target_patient_not_platform
            CHECK (target_patient_id IS NULL OR target_patient_id <> 'PLATFORM');
        COMMENT ON CONSTRAINT chk_target_patient_not_platform
            ON public.audit_records
            IS 'added_by_migration_007_audit_records_platform_check_backfill';
    END IF;
END
$$;
