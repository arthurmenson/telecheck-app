-- =============================================================================
-- File:    migrations/rollback/079_rollback.sql
-- Purpose: Rollback migration 079_ai_provider_credential.sql (SI-025 Phase 1).
--
-- Order (reverse of forward migration):
--   1. DROP the SECDEF read wrapper (owned by ai_provider_credential_owner).
--   2. REVOKE telecheck_app_role membership in writer + reader roles.
--   3. DROP the ai_provider_credential table (owned by the owner role).
--   4. DROP the 3 SI-025 roles (only after all owned objects + memberships
--      are gone -- DROP ROLE fails while a role owns objects or holds grants).
--
-- Idempotent: every step guards existence so a partial-forward-apply can be
-- rolled back cleanly.
-- =============================================================================

-- §1 -- drop the read wrapper.
DROP FUNCTION IF EXISTS read_active_ai_provider_key(TEXT);

-- §2 -- revoke the app-role bridge memberships (must precede DROP ROLE).
DO $$
DECLARE
    v_role TEXT;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['ai_provider_credential_writer', 'ai_service_credential_reader'] LOOP
        IF to_regrole(v_role) IS NOT NULL AND to_regrole('telecheck_app_role') IS NOT NULL THEN
            EXECUTE format('REVOKE %I FROM telecheck_app_role', v_role);
        END IF;
    END LOOP;
END $$;

-- §3 -- drop the table (index + constraint drop with it).
DROP TABLE IF EXISTS ai_provider_credential;

-- §4 -- drop the 3 roles now that no objects/memberships depend on them.
DO $$
DECLARE
    v_role TEXT;
BEGIN
    FOREACH v_role IN ARRAY ARRAY[
        'ai_provider_credential_owner',
        'ai_provider_credential_writer',
        'ai_service_credential_reader'
    ] LOOP
        IF to_regrole(v_role) IS NOT NULL THEN
            EXECUTE format('DROP ROLE %I', v_role);
        END IF;
    END LOOP;
END $$;

-- Verification -- objects + roles gone.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ai_provider_credential') THEN
        RAISE EXCEPTION 'rollback-079-verification: ai_provider_credential table still present';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'read_active_ai_provider_key') THEN
        RAISE EXCEPTION 'rollback-079-verification: read_active_ai_provider_key still present';
    END IF;
    IF to_regrole('ai_provider_credential_owner') IS NOT NULL
       OR to_regrole('ai_provider_credential_writer') IS NOT NULL
       OR to_regrole('ai_service_credential_reader') IS NOT NULL THEN
        RAISE EXCEPTION 'rollback-079-verification: one or more SI-025 roles still present';
    END IF;
END $$;
