-- =============================================================================
-- File:    migrations/rollback/052_rollback.sql
-- Purpose: Rollback migration 052_admin_backend_submit_draft_state_guard.sql.
--
--          Restores submit_forms_template_for_admin_review() body to the
--          pre-052 form (migration 043 §1) — drops the PR #205 Codex R1
--          Finding 1 draft-only state guard. Wrapper signature, ownership,
--          and grants are unchanged across forward + rollback (only the
--          body is replaced via CREATE OR REPLACE).
--
--          Idempotent: CREATE OR REPLACE handles the case where the
--          function is already at the rolled-back body (or absent — which
--          would also indicate a migration-043 rollback was applied first,
--          in which case this rollback is a no-op).
-- =============================================================================

CREATE OR REPLACE FUNCTION submit_forms_template_for_admin_review(
    p_tenant_id   TEXT,
    p_template_id TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_review_id                              UUID;
    v_submitter_principal_id                 TEXT;
    v_existing_revision_requested_review_id  UUID;
    v_actor_tenant_id                        TEXT;
BEGIN
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION
            'submit_forms_template_for_admin_review: no actor tenant bound for current backend; authContextPlugin must bind before SECDEF wrapper invocation'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION
            'submit_forms_template_for_admin_review: tenant scope mismatch — actor tenant % does not match wrapper p_tenant_id %; cross-tenant submission rejected',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    v_submitter_principal_id := current_actor_account_id();
    IF v_submitter_principal_id IS NULL THEN
        RAISE EXCEPTION
            'submit_forms_template_for_admin_review: no actor account bound for current backend'
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1 FROM forms_template
     WHERE tenant_id = p_tenant_id AND template_id = p_template_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'admin-template-submit-template-not-found: forms_template id % not found for tenant %',
            p_template_id, p_tenant_id
            USING ERRCODE = '02000';
    END IF;

    SELECT ftar.review_id INTO v_existing_revision_requested_review_id
      FROM forms_template_admin_review ftar
      JOIN LATERAL (
          SELECT to_state
            FROM forms_template_admin_review_lifecycle_transition lt
           WHERE lt.tenant_id = ftar.tenant_id AND lt.review_id = ftar.review_id
           ORDER BY lt.transition_at DESC, lt.id DESC
           LIMIT 1
      ) latest ON TRUE
     WHERE ftar.tenant_id = p_tenant_id
       AND ftar.forms_template_id = p_template_id
       AND latest.to_state = 'revision_requested'
       FOR UPDATE OF ftar;

    IF v_existing_revision_requested_review_id IS NOT NULL THEN
        v_review_id := v_existing_revision_requested_review_id;
        PERFORM record_forms_template_admin_review_transition(
            p_tenant_id, v_review_id,
            'revision_requested', 'pending_review', 'revision_resubmission',
            v_submitter_principal_id, NULL
        );
    ELSE
        PERFORM 1
          FROM forms_template_admin_review ftar
          JOIN LATERAL (
              SELECT to_state
                FROM forms_template_admin_review_lifecycle_transition lt
               WHERE lt.tenant_id = ftar.tenant_id AND lt.review_id = ftar.review_id
               ORDER BY lt.transition_at DESC, lt.id DESC
               LIMIT 1
          ) latest ON TRUE
         WHERE ftar.tenant_id = p_tenant_id
           AND ftar.forms_template_id = p_template_id
           AND latest.to_state IN ('pending_review', 'revision_requested');
        IF FOUND THEN
            RAISE EXCEPTION
                'admin-template-submit-already-in-flight: '
                'template % already has an in-flight admin review; '
                'resolve or cancel it before re-submitting', p_template_id
                USING ERRCODE = '40001';
        END IF;

        INSERT INTO forms_template_admin_review
            (tenant_id, forms_template_id, submitter_principal_id, ai_guardrail_snapshot_jsonb)
        VALUES
            (p_tenant_id, p_template_id, v_submitter_principal_id, NULL)
        RETURNING review_id INTO v_review_id;

        PERFORM record_forms_template_admin_review_transition(
            p_tenant_id, v_review_id,
            'none', 'pending_review', 'initial_submission',
            v_submitter_principal_id, NULL
        );
    END IF;

    RETURN v_review_id;
END;
$$;

COMMENT ON FUNCTION submit_forms_template_for_admin_review(TEXT, TEXT) IS
    'P-042 §4.NEW8e + SI-023 Sub-decision 4 submit wrapper. SECURITY DEFINER + '
    'locked search_path. Two paths under shared parent-template FOR UPDATE: '
    'INITIAL_SUBMISSION (transition triple #1) + REVISION_RESUBMISSION '
    '(transition triple #5). Internal actor bound from SI-010 (caller cannot '
    'forge). LAYER C tenant scope match via current_actor_account_tenant_id(). '
    'LAYER A EXECUTE granted ONLY to admin_basic_operator (anti-bypass). '
    'LAYER B (role check) + audit emission deferred to Fastify route handler in PR 6.';
