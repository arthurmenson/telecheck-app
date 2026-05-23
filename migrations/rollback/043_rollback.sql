-- =============================================================================
-- File:    migrations/rollback/043_rollback.sql
-- Purpose: Rollback migration 043_admin_backend_template_wrappers.sql.
--
--          Drops the 2 template SECDEF wrappers (submit + decision) +
--          revokes all wrapper-owner table/sequence/function grants. Same
--          DO-block-guarded discipline as PR 3 rollback:
--            - Resolve target signature OID via to_regprocedure first
--              (R1 MED-1 pattern); REVOKE EXECUTE + DROP FUNCTION run
--              only when v_target_oid IS NOT NULL.
--            - Signature-exact verify-absent via to_regprocedure IS NOT NULL
--              (R2 MED-1 pattern); strands no privileges under same-name
--              overload state.
--            - Idempotent against fresh / retry / target-absent /
--              same-name-overload states.
--
--          PRE-ROLLBACK CHECK (manual / operator):
--            - Fastify routes (PR 6) calling these wrappers may be running
--              in production. Roll back the route handlers first if so.
--            - No DB-level objects depend on these wrappers (they are
--              terminal in the wrapper chain — application layer calls
--              them); the DROP itself will succeed even if PR 6 is deployed.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Decision wrapper + decision-wrapper-owner grants.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_target_oid              OID := to_regprocedure(
        'public.record_forms_template_admin_decision(text, uuid, text, jsonb, text)'
    );
    v_function_still_present  BOOLEAN;
BEGIN
    IF v_target_oid IS NOT NULL THEN
        REVOKE EXECUTE ON FUNCTION record_forms_template_admin_decision(
            TEXT, UUID, TEXT, JSONB, TEXT
        ) FROM admin_template_reviewer;

        DROP FUNCTION IF EXISTS record_forms_template_admin_decision(
            TEXT, UUID, TEXT, JSONB, TEXT
        );
    END IF;

    v_function_still_present := to_regprocedure(
        'public.record_forms_template_admin_decision(text, uuid, text, jsonb, text)'
    ) IS NOT NULL;

    IF v_function_still_present THEN
        RAISE EXCEPTION
            'migration-043-rollback-decision-wrapper-blocked: '
            'DROP FUNCTION record_forms_template_admin_decision left the function in '
            'place. REVOKE of decision-wrapper-owner''s table/sequence/function grants '
            'ABORTED to preserve runtime executability. Investigate dependencies, then retry.';
    END IF;

    -- Safe to revoke decision-wrapper-owner grants now (function is gone).
    REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id()
        FROM forms_template_admin_review_decision_wrapper_owner;
    REVOKE EXECUTE ON FUNCTION current_actor_account_id()
        FROM forms_template_admin_review_decision_wrapper_owner;
    REVOKE USAGE ON SEQUENCE admin_template_decision_idempotency_key_id_seq
        FROM forms_template_admin_review_decision_wrapper_owner;
    REVOKE SELECT, INSERT ON admin_template_decision_idempotency_key
        FROM forms_template_admin_review_decision_wrapper_owner;
    REVOKE SELECT ON forms_template_admin_review_lifecycle_transition
        FROM forms_template_admin_review_decision_wrapper_owner;
    REVOKE SELECT, UPDATE ON forms_template_admin_review
        FROM forms_template_admin_review_decision_wrapper_owner;
    REVOKE SELECT, UPDATE ON forms_template
        FROM forms_template_admin_review_decision_wrapper_owner;
END $$;

-- -----------------------------------------------------------------------------
-- 2. Submit wrapper + submit-wrapper-owner grants.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    v_target_oid              OID := to_regprocedure(
        'public.submit_forms_template_for_admin_review(text, text)'
    );
    v_function_still_present  BOOLEAN;
BEGIN
    IF v_target_oid IS NOT NULL THEN
        REVOKE EXECUTE ON FUNCTION submit_forms_template_for_admin_review(TEXT, TEXT)
            FROM admin_basic_operator;

        DROP FUNCTION IF EXISTS submit_forms_template_for_admin_review(TEXT, TEXT);
    END IF;

    v_function_still_present := to_regprocedure(
        'public.submit_forms_template_for_admin_review(text, text)'
    ) IS NOT NULL;

    IF v_function_still_present THEN
        RAISE EXCEPTION
            'migration-043-rollback-submit-wrapper-blocked: '
            'DROP FUNCTION submit_forms_template_for_admin_review left the function in '
            'place. REVOKE of submit-wrapper-owner''s table/function grants ABORTED to '
            'preserve runtime executability. Investigate dependencies, then retry.';
    END IF;

    -- Safe to revoke submit-wrapper-owner grants now (function is gone).
    REVOKE EXECUTE ON FUNCTION current_actor_account_tenant_id()
        FROM forms_template_admin_review_submit_wrapper_owner;
    REVOKE EXECUTE ON FUNCTION current_actor_account_id()
        FROM forms_template_admin_review_submit_wrapper_owner;
    REVOKE SELECT ON forms_template_admin_review_lifecycle_transition
        FROM forms_template_admin_review_submit_wrapper_owner;
    REVOKE SELECT, INSERT, UPDATE ON forms_template_admin_review
        FROM forms_template_admin_review_submit_wrapper_owner;
    REVOKE SELECT, UPDATE ON forms_template
        FROM forms_template_admin_review_submit_wrapper_owner;
END $$;

-- =============================================================================
-- Post-rollback verification: EXACT target signatures should be absent.
-- =============================================================================
DO $$
DECLARE
    v_submit_present    BOOLEAN := to_regprocedure(
        'public.submit_forms_template_for_admin_review(text, text)'
    ) IS NOT NULL;
    v_decision_present  BOOLEAN := to_regprocedure(
        'public.record_forms_template_admin_decision(text, uuid, text, jsonb, text)'
    ) IS NOT NULL;
BEGIN
    IF v_submit_present OR v_decision_present THEN
        RAISE WARNING
            'migration-043-rollback-incomplete: submit_present=% decision_present=%. '
            'The DO-block guards above should have aborted before reaching this '
            'verification — investigate.', v_submit_present, v_decision_present;
    END IF;
END $$;
