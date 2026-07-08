-- =============================================================================
-- File:    migrations/rollback/067_rollback.sql
-- Purpose: Rollback migration 067_ai_mode1_conversation_entities.sql.
--
-- Drops the ai_mode1_conversation_state derived view first (it is owned by
-- ai_mode1_view_owner and reads the base tables), then the 5 Mode 1
-- conversation entities in reverse dependency order, then the standalone
-- trigger functions. RLS policies, triggers, indexes, and constraints drop
-- with their tables. Column-level grants to ai_mode1_view_owner and the view
-- grant to ai_mode1_reader drop with their objects, leaving the migration 066
-- roles grant-free (a precondition for 066's rollback DROP ROLE).
--
-- Greenfield safety: this system has no production patient data. Rollback
-- destroys Mode 1 conversation rows irrecoverably -- acceptable ONLY
-- pre-pilot. After first real patient data, forward-fix migrations replace
-- rollbacks per the F4 deploy runbook discipline.
--
-- Roles from migration 066 are NOT dropped here (066 has its own rollback).
-- =============================================================================

-- View before base tables (owner-privileged reads of the base tables)
DROP VIEW IF EXISTS ai_mode1_conversation_state;

-- Children before parents (FK dependency order)
DROP TABLE IF EXISTS ai_mode1_conversation_turn_result;
DROP TABLE IF EXISTS ai_mode1_conversation_turn_detector_result;
DROP TABLE IF EXISTS ai_mode1_conversation_turn_admission;
DROP TABLE IF EXISTS ai_mode1_conversation_archival_event;
DROP TABLE IF EXISTS ai_mode1_conversation;

-- Standalone trigger functions
DROP FUNCTION IF EXISTS ai_mode1_conversation_block_mutation();
DROP FUNCTION IF EXISTS ai_mode1_conversation_archival_event_block_mutation();
DROP FUNCTION IF EXISTS ai_mode1_conversation_turn_admission_block_mutation();
DROP FUNCTION IF EXISTS ai_mode1_conversation_turn_detector_result_block_mutation();
DROP FUNCTION IF EXISTS ai_mode1_conversation_turn_result_block_mutation();

-- Verification: none of the 5 tables nor the view remain
DO $$
DECLARE
    v_remaining INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_remaining
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'v')
       AND c.relname IN (
           'ai_mode1_conversation',
           'ai_mode1_conversation_archival_event',
           'ai_mode1_conversation_turn_admission',
           'ai_mode1_conversation_turn_detector_result',
           'ai_mode1_conversation_turn_result',
           'ai_mode1_conversation_state'
       );
    IF v_remaining > 0 THEN
        RAISE EXCEPTION 'migration-067-rollback-incomplete: % Mode 1 object(s) remain', v_remaining
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
