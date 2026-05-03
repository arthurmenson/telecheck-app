-- =============================================================================
-- File:    migrations/rollback/006_rollback.sql
-- Purpose: Rollback for 006_forms_intake.sql — drop all Forms / Intake Engine
--          objects in dependency-safe order.
-- Warning: DESTRUCTIVE. All form definitions, deployment records, patient
--          submissions, snapshots, A/B variant configurations, and encrypted
--          resume states will be permanently lost. Running this migration in
--          any environment that has live patient data will violate clinical
--          audit obligations and may constitute a data retention violation.
--
--          NEVER run this script in production without explicit sign-off from:
--            - Engineering Lead
--            - Platform Clinical Governance (submission + snapshot data loss)
--            - Platform Privacy Officer (PHI destruction in resume_state)
--
--          Safe environments: local development, isolated integration test
--          environments with synthetic data only.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Drop order: child objects before parents; policies before tables.
-- Dependency chain (FK order):
--   forms_resume_state  → forms_variant, forms_deployment
--   forms_variant       → forms_deployment, forms_template
--   forms_submission    → forms_deployment, forms_variant (FK added by ALTER)
--   forms_snapshot      → forms_submission, forms_template
--   forms_deployment    → forms_template
--   forms_template      (root)
-- ---------------------------------------------------------------------------

-- Step 1: Drop the FK added by ALTER TABLE after forms_variant was created.
-- Must do this before dropping forms_variant or forms_submission.
ALTER TABLE IF EXISTS forms_submission
    DROP CONSTRAINT IF EXISTS fk_submission_variant;

-- ---------------------------------------------------------------------------
-- Step 2: Drop RLS policies (must precede DROP TABLE for each table).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation ON forms_resume_state;
DROP POLICY IF EXISTS tenant_isolation ON forms_variant;
DROP POLICY IF EXISTS tenant_isolation ON forms_snapshot;
DROP POLICY IF EXISTS tenant_isolation ON forms_submission;
DROP POLICY IF EXISTS tenant_isolation ON forms_deployment;
DROP POLICY IF EXISTS tenant_isolation ON forms_template;

-- ---------------------------------------------------------------------------
-- Step 3: Drop triggers (before dropping the tables they fire on).
-- The trigger functions are dropped in step 4.
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS forms_snapshot_block_update ON forms_snapshot;
DROP TRIGGER IF EXISTS forms_snapshot_block_delete ON forms_snapshot;

-- ---------------------------------------------------------------------------
-- Step 4: Drop tables in dependency order (children first).
-- CASCADE is intentionally NOT used — explicit ordering is safer and surfaces
-- unexpected downstream dependencies rather than silently cascading them.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS forms_resume_state;
DROP TABLE IF EXISTS forms_variant;
DROP TABLE IF EXISTS forms_snapshot;
DROP TABLE IF EXISTS forms_submission;
DROP TABLE IF EXISTS forms_deployment;
DROP TABLE IF EXISTS forms_template;

-- ---------------------------------------------------------------------------
-- Step 5: Drop functions introduced by this migration.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS forms_snapshot_block_mutation();
