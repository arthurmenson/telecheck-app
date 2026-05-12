-- =============================================================================
-- File:    migrations/rollback/025_rollback.sql
-- Purpose: Rollback for 025_medication_requests.sql — drop the
--          medication_requests table and all dependent objects (RLS
--          policy + indexes; CHECK constraints + composite UNIQUE +
--          composite FKs drop implicitly with DROP TABLE).
--
-- STATUS:  SPECULATIVE DRAFT pre-SI-001-ratification companion to
--          migrations/025_medication_requests.sql. Will be revised
--          alongside the parent migration if SI-001 ratification
--          adjusts the table.
--
-- Spec:    Companion to migrations/025_medication_requests.sql per
--          migrations/README.md "Every migration has a rollback companion."
-- Warning: DESTRUCTIVE. Every medication_request row will be permanently
--          lost. The append-only / supersession-chain audit trail
--          (Slice 4 PRD §6.4 equivalent) makes prescription destruction
--          a regulated act. Do NOT run in any environment with live
--          prescriptions without explicit sign-off from:
--            - Engineering Lead
--            - Platform Privacy Officer (prescription record destruction)
--            - Platform Clinical Governance (prescription history loss)
--            - Tenant Pharmacist (where state regulation requires it)
--          Permitted environments:
--            - Local development (fresh DB)
--            - Isolated integration test environments with synthetic data
-- =============================================================================

-- Step 1: Drop RLS policy (must precede DROP TABLE).
-- v0.2 Codex Finding (MEDIUM) closure: `DROP POLICY IF EXISTS ... ON
-- <table>` requires the target table to exist; IF EXISTS only guards the
-- policy name. Without the to_regclass guard, a partial-apply state
-- (where 025 failed to create the table — e.g., due to the previously-
-- identified migration-ordering bug) leaves rollback unable to recover.
-- Same pattern as the rollback/024 hardening.
DO $$
BEGIN
    IF to_regclass('medication_requests') IS NOT NULL THEN
        DROP POLICY IF EXISTS tenant_isolation ON medication_requests;
    END IF;
END;
$$;

-- Step 2: Drop indexes explicitly (also dropped implicitly with the
--         table; explicit DROP IF EXISTS makes partial-rollback
--         scenarios cleaner).
DROP INDEX IF EXISTS idx_medication_requests_supersession_chain;
DROP INDEX IF EXISTS idx_medication_requests_tenant_status_active;
DROP INDEX IF EXISTS idx_medication_requests_tenant_consult;
DROP INDEX IF EXISTS idx_medication_requests_tenant_clinician;
DROP INDEX IF EXISTS idx_medication_requests_tenant_patient;

-- Step 3: Drop the table. Composite UNIQUE + composite FKs + CHECK
--         constraints + self-FK supersession-chain constraints drop
--         implicitly.
DROP TABLE IF EXISTS medication_requests;
