-- =============================================================================
-- File:    migrations/rollback/068_rollback.sql
-- Purpose: Rollback migration 068_ai_mode1_service_writer_grants.sql.
--
--          Revokes the Mode 1 service writer grants, removes the
--          telecheck_app_role bridge membership, and drops the
--          `ai_service_mode1` role.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - The Mode 1 chat handler persistence wiring (chat.ts) elevates
--              to ai_service_mode1 per request. Rolling this migration back
--              while that handler build is deployed will make every
--              POST /v0/ai/chat fail at SET LOCAL ROLE. Roll back (or gate)
--              the application deploy FIRST.
--
--          DROP ROLE IF EXISTS is used (not bare DROP ROLE) so a partial-
--          prior-rollback state does not abort this script before the
--          post-rollback verification runs. Matches migration 046/055/066
--          rollback hygiene.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Revoke table grants (must precede DROP ROLE; PG refuses to drop a role
--    that still holds grants).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regrole('ai_service_mode1') IS NOT NULL THEN
        REVOKE ALL ON ai_mode1_conversation                      FROM ai_service_mode1;
        REVOKE ALL ON ai_mode1_conversation_turn_admission       FROM ai_service_mode1;
        REVOKE ALL ON ai_mode1_conversation_turn_detector_result FROM ai_service_mode1;
        REVOKE ALL ON ai_mode1_conversation_turn_result          FROM ai_service_mode1;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Remove the app-role bridge membership.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regrole('ai_service_mode1') IS NOT NULL
       AND to_regrole('telecheck_app_role') IS NOT NULL THEN
        REVOKE ai_service_mode1 FROM telecheck_app_role;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- 3. Drop the role.
-- -----------------------------------------------------------------------------
DROP ROLE IF EXISTS ai_service_mode1;

-- =============================================================================
-- Post-rollback verification: role gone. WARNING (not EXCEPTION) so a
-- partial-state operator gets a diagnostic surface without blocking
-- subsequent rollback steps (matches migration 039/045/046/055/066
-- rollback-hygiene precedent).
-- =============================================================================
DO $$
BEGIN
    IF to_regrole('ai_service_mode1') IS NOT NULL THEN
        RAISE WARNING 'rollback-068-verification: ai_service_mode1 still exists '
            '(likely still owns objects or holds grants elsewhere -- inspect pg_shdepend).';
    END IF;
END $$;
