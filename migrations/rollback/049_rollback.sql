-- =============================================================================
-- File:    migrations/rollback/049_rollback.sql
-- Purpose: Rollback migration 049_med_interaction_raw_lifecycle_writer.sql.
--
--          Drops record_interaction_signal_lifecycle_transition() SECDEF
--          function. Owner-role grants on the lifecycle_transition TABLE
--          (INSERT + SELECT) belong to migration 047's rollback, not this
--          one — we don't touch them here.
--
--          Same DO-block-guarded discipline as PR 3 + PR 4 rollbacks in
--          Crisis Response + Admin Backend:
--            - Resolve target signature OID via to_regprocedure first
--              (R1 MED-1 pattern from Admin Backend PR 3)
--            - REVOKE EXECUTE + DROP FUNCTION run only when OID IS NOT NULL
--            - Signature-exact verify-absent via to_regprocedure IS NOT NULL
--              (R2 MED-1 pattern from Admin Backend PR 3)
--            - Idempotent against fresh / retry / target-absent / same-name-
--              overload states
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - 6 reason-specific wrappers from migration 050 (PR 5) must be
--              dropped first if they have been deployed (they reference
--              the raw writer via EXECUTE permission).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Raw lifecycle writer SECDEF function.
--    OID-gated REVOKE EXECUTE + DROP FUNCTION + verify-absent.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_target_oid              OID := to_regprocedure(
        'public.record_interaction_signal_lifecycle_transition('
        || 'character varying, text, character varying, text, text, '
        || 'character varying, text, jsonb)'
    );
    v_function_still_present  BOOLEAN;
BEGIN
    IF v_target_oid IS NOT NULL THEN
        -- REVOKE EXECUTE grants from each of the 6 wrapper-owner roles.
        REVOKE EXECUTE ON FUNCTION record_interaction_signal_lifecycle_transition(
            VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
        ) FROM interaction_signal_expiry_wrapper_owner;
        REVOKE EXECUTE ON FUNCTION record_interaction_signal_lifecycle_transition(
            VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
        ) FROM interaction_signal_resolution_wrapper_owner;
        REVOKE EXECUTE ON FUNCTION record_interaction_signal_lifecycle_transition(
            VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
        ) FROM interaction_signal_supersession_wrapper_owner;
        REVOKE EXECUTE ON FUNCTION record_interaction_signal_lifecycle_transition(
            VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
        ) FROM interaction_signal_override_wrapper_owner;
        REVOKE EXECUTE ON FUNCTION record_interaction_signal_lifecycle_transition(
            VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
        ) FROM interaction_signal_activation_wrapper_owner;
        REVOKE EXECUTE ON FUNCTION record_interaction_signal_lifecycle_transition(
            VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
        ) FROM interaction_signal_emission_wrapper_owner;

        -- DROP the function. If dependent wrappers from PR 5 still reference
        -- it, this DROP fails (CASCADE intentionally not used).
        DROP FUNCTION IF EXISTS record_interaction_signal_lifecycle_transition(
            VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
        );
    END IF;

    v_function_still_present := to_regprocedure(
        'public.record_interaction_signal_lifecycle_transition('
        || 'character varying, text, character varying, text, text, '
        || 'character varying, text, jsonb)'
    ) IS NOT NULL;

    IF v_function_still_present THEN
        RAISE EXCEPTION
            'migration-049-rollback-raw-writer-blocked: '
            'DROP FUNCTION record_interaction_signal_lifecycle_transition left '
            'the function in place (dependent wrappers from PR 5 migration 050 '
            'still reference it). Roll back migration 050 first.';
    END IF;
END $$;

-- =============================================================================
-- Post-rollback verification: signature-exact function should be absent.
-- =============================================================================
DO $$
DECLARE
    v_function_present  BOOLEAN := to_regprocedure(
        'public.record_interaction_signal_lifecycle_transition('
        || 'character varying, text, character varying, text, text, '
        || 'character varying, text, jsonb)'
    ) IS NOT NULL;
BEGIN
    IF v_function_present THEN
        RAISE WARNING
            'migration-049-rollback-incomplete: '
            'record_interaction_signal_lifecycle_transition() unexpectedly '
            'remains. The DO-block guard above should have aborted before '
            'reaching this verification — investigate.';
    END IF;
END $$;
