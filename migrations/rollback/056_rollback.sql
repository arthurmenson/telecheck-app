-- =============================================================================
-- File:    migrations/rollback/056_rollback.sql
-- Purpose: Rollback migration 056_async_consult_entities.sql.
--
-- Drops the 7 Async Consult entities + their trigger functions in reverse
-- dependency order. RLS policies, triggers, indexes, and constraints drop
-- with their tables (CASCADE not required for table-local objects; explicit
-- DROP FUNCTION for the standalone trigger functions).
--
-- Greenfield safety: this system has no production patient data. Rollback
-- destroys consult rows irrecoverably — acceptable ONLY pre-pilot. After
-- first real patient data, forward-fix migrations replace rollbacks per the
-- F4 deploy runbook discipline.
--
-- Roles from migration 055 are NOT dropped here (055 has its own rollback).
-- =============================================================================

-- Children before parents (FK dependency order)
DROP TABLE IF EXISTS consult_follow_up_message;
DROP TABLE IF EXISTS consult_lifecycle_transition;
DROP TABLE IF EXISTS consult_clinician_decision;
DROP TABLE IF EXISTS consult_review_claim;
DROP TABLE IF EXISTS consult_clinical_summary;
DROP TABLE IF EXISTS consult_intake_submission;
DROP TABLE IF EXISTS consult;

-- Standalone trigger functions
DROP FUNCTION IF EXISTS consult_block_mutation();
DROP FUNCTION IF EXISTS consult_intake_submission_block_mutation();
DROP FUNCTION IF EXISTS consult_clinical_summary_block_mutation();
DROP FUNCTION IF EXISTS consult_review_claim_one_way_released_at();
DROP FUNCTION IF EXISTS consult_review_claim_block_delete();
DROP FUNCTION IF EXISTS consult_clinician_decision_block_mutation();
DROP FUNCTION IF EXISTS consult_clinician_decision_validate_claim_active();
DROP FUNCTION IF EXISTS consult_lifecycle_transition_block_mutation();
DROP FUNCTION IF EXISTS consult_lifecycle_transition_continuity();
DROP FUNCTION IF EXISTS consult_follow_up_message_block_mutation();

-- Verification: none of the 7 tables remain
DO $$
DECLARE
    v_remaining INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname IN (
           'consult', 'consult_intake_submission', 'consult_clinical_summary',
           'consult_review_claim', 'consult_clinician_decision',
           'consult_lifecycle_transition', 'consult_follow_up_message'
       );
    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'migration-056-rollback-incomplete: % async-consult table(s) remain', v_remaining
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
