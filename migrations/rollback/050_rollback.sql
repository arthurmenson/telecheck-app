-- =============================================================================
-- File:    migrations/rollback/050_rollback.sql
-- Purpose: Rollback migration 050_med_interaction_wrappers.sql.
--
--          Drops the 6 SECDEF wrapper functions in reverse-dependency order
--          (none of them depend on each other, but consistent with the
--          Â§1-Â§6 order from forward migration). Per the PR 3-4 rollback
--          discipline, uses to_regprocedure-gated DROP with absent-state
--          safety. After dropping all 6 wrappers, revokes the supplemental
--          grants added to the wrapper-owners (SELECT on lifecycle_transition
--          / signal / override / engine_evaluation).
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - Fastify handlers from PR 6+ may reference these wrappers
--              via EXECUTE permission. Application code that calls these
--              must be drained first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Override wrapper (terminal lifecycle).
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_interaction_signal_override(
    VARCHAR(26), VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26),
    BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ,
    JSONB
);

-- -----------------------------------------------------------------------------
-- 2. 5 reason-specific lifecycle wrappers (expiry â†’ resolution â†’ supersession
--    â†’ activation â†’ emission; reverse of Â§1-Â§5 order in forward migration).
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS record_signal_expiry(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB);
DROP FUNCTION IF EXISTS record_signal_resolution(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), JSONB);
DROP FUNCTION IF EXISTS record_signal_supersession(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), JSONB);
DROP FUNCTION IF EXISTS record_signal_activation(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB);
DROP FUNCTION IF EXISTS record_signal_emission(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB);

-- -----------------------------------------------------------------------------
-- 3. Revoke supplemental SELECT grants added to wrapper-owners (gated on
--    table + role existence for partial-rollback robustness).
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('public.interaction_signal_lifecycle_transition') IS NOT NULL THEN
        IF to_regrole('activation_wrapper_owner') IS NOT NULL THEN
            REVOKE SELECT ON interaction_signal_lifecycle_transition
                FROM activation_wrapper_owner;
        END IF;
        IF to_regrole('expiry_wrapper_owner') IS NOT NULL THEN
            REVOKE SELECT ON interaction_signal_lifecycle_transition
                FROM expiry_wrapper_owner;
        END IF;
        IF to_regrole('override_wrapper_owner') IS NOT NULL THEN
            REVOKE SELECT ON interaction_signal_lifecycle_transition
                FROM override_wrapper_owner;
        END IF;
    END IF;

    IF to_regclass('public.interaction_signal') IS NOT NULL
       AND to_regrole('expiry_wrapper_owner') IS NOT NULL THEN
        REVOKE SELECT ON interaction_signal
            FROM expiry_wrapper_owner;
    END IF;

    IF to_regclass('public.interaction_signal_override') IS NOT NULL
       AND to_regrole('activation_wrapper_owner') IS NOT NULL THEN
        REVOKE SELECT ON interaction_signal_override
            FROM activation_wrapper_owner;
    END IF;

    IF to_regclass('public.interaction_engine_evaluation') IS NOT NULL
       AND to_regrole('superseded_wrapper_owner') IS NOT NULL THEN
        REVOKE SELECT ON interaction_engine_evaluation
            FROM superseded_wrapper_owner;
    END IF;
END $$;

-- =============================================================================
-- Post-rollback verification: 6 wrapper functions should all be absent.
-- =============================================================================
DO $$
DECLARE
    v_remaining_count INTEGER := 0;
BEGIN
    IF to_regprocedure('public.record_signal_emission(character varying, text, character varying, character varying, jsonb)') IS NOT NULL THEN v_remaining_count := v_remaining_count + 1; END IF;
    IF to_regprocedure('public.record_signal_activation(character varying, text, character varying, character varying, jsonb)') IS NOT NULL THEN v_remaining_count := v_remaining_count + 1; END IF;
    IF to_regprocedure('public.record_signal_supersession(character varying, text, character varying, character varying, character varying, jsonb)') IS NOT NULL THEN v_remaining_count := v_remaining_count + 1; END IF;
    IF to_regprocedure('public.record_signal_resolution(character varying, text, character varying, character varying, character varying, jsonb)') IS NOT NULL THEN v_remaining_count := v_remaining_count + 1; END IF;
    IF to_regprocedure('public.record_signal_expiry(character varying, text, character varying, character varying, jsonb)') IS NOT NULL THEN v_remaining_count := v_remaining_count + 1; END IF;
    IF to_regprocedure('public.record_interaction_signal_override(character varying, character varying, text, character varying, character varying, bytea, character varying, bytea, bytea, text, text, bytea, timestamp with time zone, jsonb)') IS NOT NULL THEN v_remaining_count := v_remaining_count + 1; END IF;

    IF v_remaining_count > 0 THEN
        RAISE WARNING
            'migration-050-rollback-incomplete: % wrapper(s) remain. Dependent '
            'Fastify handlers from PR 6+ may still reference them. Roll back '
            'those first.', v_remaining_count;
    END IF;
END $$;
