-- =============================================================================
-- File:    migrations/021_async_consult_tenant_boundary_constraints.sql
-- Purpose: Idempotently add the cross-tenant safety composite UNIQUE +
--          composite FKs to consults + consult_events. Fix-forward for
--          migration 020 per Codex async-consult-r2 HIGH closure
--          2026-05-05.
--
-- Why a separate migration (not editing 020 in place):
--   Codex async-consult-r1 (2 HIGH + 1 MEDIUM) flagged that migration
--   020 created consults + consult_events without composite FKs to
--   structurally enforce same-tenant relationships at the DB layer.
--   The initial fix-forward edited migration 020 in place to add inline
--   constraints, but Codex async-consult-r2 HIGH correctly noted that
--   editing a numbered CREATE TABLE IF NOT EXISTS migration is a hazard
--   for any environment that already applied the pre-fix version: the
--   IF NOT EXISTS clause makes the rerun a no-op, leaving the upgraded
--   schema without the constraints while the docs claim the DB layer
--   enforces them.
--
--   This migration provides the safe fix-forward path: idempotent ALTER
--   statements that add the constraints to existing tables, with
--   catalog checks before each add so reapplication is a no-op.
--
-- Constraints added (4):
--   1. consults UNIQUE (tenant_id, id) — required to support consult_events
--      composite FK target.
--   2. consults composite FK (tenant_id, patient_id) → accounts
--      (tenant_id, account_id) — patient ownership cross-tenant binding
--      prevention.
--   3. consults composite FK (tenant_id, intake_form_submission_id) →
--      forms_submission (tenant_id, submission_id) — intake binding
--      cross-tenant prevention.
--   4. consult_events composite FK (tenant_id, consult_id) → consults
--      (tenant_id, id) — event history cross-tenant prevention.
--
-- Spec:    - Codex async-consult-r1 (2 HIGH + 1 MEDIUM) closure 2026-05-05
--          - Codex async-consult-r2 (1 HIGH) closure 2026-05-05
--          - I-023 / I-027 (cross-tenant data isolation; structural defense in depth)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   020_async_consult.sql applied (consults + consult_events tables exist)
--   012_accounts.sql      applied (UNIQUE (tenant_id, account_id) target;
--                                   migration 012:181)
--   006_forms_intake.sql  applied (UNIQUE (tenant_id, submission_id) target;
--                                   migration 006:503)
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Step 1: consults UNIQUE (tenant_id, id)
-- Required to support consult_events composite FK target.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'consults_tenant_id_id_unique'
          AND conrelid = 'consults'::regclass
    ) THEN
        ALTER TABLE consults
            ADD CONSTRAINT consults_tenant_id_id_unique UNIQUE (tenant_id, id);
    END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Step 2: consults composite FK on (tenant_id, patient_id) → accounts
-- Patient ownership cross-tenant binding prevention.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'consults_tenant_patient_fk'
          AND conrelid = 'consults'::regclass
    ) THEN
        ALTER TABLE consults
            ADD CONSTRAINT consults_tenant_patient_fk
            FOREIGN KEY (tenant_id, patient_id)
            REFERENCES accounts (tenant_id, account_id);
    END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Step 3: consults composite FK on (tenant_id, intake_form_submission_id) →
-- forms_submission. Intake binding cross-tenant prevention. Composite FK
-- against a NULLable column: PostgreSQL treats NULL as no-match, so this
-- only enforces when intake_form_submission_id is populated (per the
-- intent — populated at INTAKE → SUBMITTED transition).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'consults_tenant_intake_fk'
          AND conrelid = 'consults'::regclass
    ) THEN
        ALTER TABLE consults
            ADD CONSTRAINT consults_tenant_intake_fk
            FOREIGN KEY (tenant_id, intake_form_submission_id)
            REFERENCES forms_submission (tenant_id, submission_id);
    END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Step 4: consult_events composite FK on (tenant_id, consult_id) → consults
-- Event history cross-tenant prevention.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'consult_events_tenant_consult_fk'
          AND conrelid = 'consult_events'::regclass
    ) THEN
        ALTER TABLE consult_events
            ADD CONSTRAINT consult_events_tenant_consult_fk
            FOREIGN KEY (tenant_id, consult_id)
            REFERENCES consults (tenant_id, id);
    END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Validation: pre-existing rows
-- All ALTER TABLE ... ADD CONSTRAINT FOREIGN KEY default to validating
-- existing rows. If a pre-existing row violates the constraint (e.g.,
-- a consult with patient_id pointing to a different tenant), the ALTER
-- will fail. That failure is the correct behavior — surfacing the
-- pre-existing data integrity violation rather than masking it.
-- ---------------------------------------------------------------------------

-- =============================================================================
-- Migration 021 complete. consults + consult_events composite FK constraints
-- in place across all environments — fresh-DB applies (via migration 020's
-- inline definitions) AND upgraded-DB applies (via this migration's ALTER).
-- =============================================================================
