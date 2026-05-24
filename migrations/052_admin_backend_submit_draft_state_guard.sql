-- =============================================================================
-- File:    migrations/052_admin_backend_submit_draft_state_guard.sql
-- Purpose: Codex R1 PR #205 Finding 1 closure — enforce draft-only submission
--          state guard on submit_forms_template_for_admin_review().
--
--          The wrapper as ratified at P-041/P-042 (migration 043 §1) takes
--          FOR UPDATE on forms_template + checks the lifecycle-transition
--          table for in-flight reviews, but does NOT check the parent
--          template's `status` column. A template in `published`,
--          `superseded`, or `archived` status (with no in-flight review)
--          could therefore be re-submitted for admin review — the wrapper
--          would happily INSERT a new forms_template_admin_review row and
--          emit triple #1 (none → pending_review / initial_submission),
--          violating the implicit state-machine semantics where the submit
--          action is only valid on a draft template.
--
--          Codex R1 verdict on PR #205: "Block merge until the
--          wrapper/handler enforces draft-only submission ..." Per the
--          forms-intake F2 pattern (Codex-validated at telecheck-forms-intake
--          PR #11 commit 001dbbd), the canonical guard is a same-tx UPDATE/
--          SELECT clause `AND status = 'draft' AND deleted_at IS NULL` with
--          a typed conflict on rowCount = 0 mapped to 409.
--
--          This migration CREATE-OR-REPLACEs the wrapper body to add the
--          status check INSIDE the same FOR UPDATE statement that already
--          serializes parent-template access. This preserves atomicity
--          (no TOCTOU window between the existence check and the in-flight-
--          review check) and consolidates the guard at the only place the
--          SECDEF-owned role holds SELECT on forms_template.
--
--          The guard distinguishes three failure modes via SQLSTATE:
--            - 02000 (no_data) — template does not exist (preserved from
--              the original wrapper body; tenant-blind 404).
--            - 42P17 (invalid_object_state) — template exists but its
--              status is NOT 'draft' or it has been soft-deleted; mapped
--              to 409 at the handler with a tenant-blind body (no
--              templateId / tenantId leak per I-025).
--            - 40001 (serialization_failure) — an in-flight pending_review
--              or revision_requested review exists for this template
--              (preserved from the original wrapper body; mapped to 409 at
--              the handler).
--
--          The revision-resubmission path (transition triple #5:
--          revision_requested → pending_review) is UNCHANGED by this
--          migration — that path is entered when an existing
--          revision_requested review is found AFTER the FOR UPDATE
--          succeeds. The new status guard does NOT apply to the revision
--          path because:
--            (a) the template status is `draft` throughout a
--                revision_requested review's lifetime (status only flips
--                to `published` on approve at the decision wrapper); the
--                guard's `status = 'draft'` predicate is satisfied for
--                BOTH initial submission and revision resubmission.
--            (b) keeping the predicate in the shared FOR UPDATE statement
--                ensures both paths are gated by the same atomicity
--                boundary; no need for path-specific branching.
--
--          Wrapper signature is UNCHANGED (TEXT, TEXT → UUID). Only the
--          body is replaced via CREATE OR REPLACE. No schema, grant, or
--          ownership changes — the rollback restores the original wrapper
--          body from migration 043 §1.
--
-- Spec:    - SI-023 Admin Backend Basics Slice v1.0 §4 + §6 transition
--            triples #1 (initial_submission) + #5 (revision_resubmission)
--          - CDM v1.10 → v1.11 Amendment §4.NEW8e
--          - migrations/043_admin_backend_template_wrappers.sql §1
--          - I-025 (tenant-blind error envelopes)
--          - telecheck-forms-intake commit 001dbbd (F2 pattern; Codex R2
--            APPROVE verdict)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   043_admin_backend_template_wrappers.sql       applied (submit wrapper +
--                                                  owner + grants)
-- ---------------------------------------------------------------------------

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
    v_template_status                        TEXT;
    v_template_deleted_at                    TIMESTAMPTZ;
BEGIN
    -- ---------------------------------------------------------------------
    -- LAYER B (role authorization) DEFERRED to application layer per Option 2.
    -- ---------------------------------------------------------------------

    -- ---------------------------------------------------------------------
    -- LAYER C — tenant scope match. SI-010 trust anchor binds the actor's
    -- tenant_id at request time; reject if mismatched.
    -- ---------------------------------------------------------------------
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

    -- ---------------------------------------------------------------------
    -- Internal actor binding from SI-010 (caller cannot forge).
    -- ---------------------------------------------------------------------
    v_submitter_principal_id := current_actor_account_id();
    IF v_submitter_principal_id IS NULL THEN
        RAISE EXCEPTION
            'submit_forms_template_for_admin_review: no actor account bound for current backend'
            USING ERRCODE = '42501';
    END IF;

    -- ---------------------------------------------------------------------
    -- LAYER 1 (R8 HIGH-1 from SI-023): shared parent-template FOR UPDATE
    -- serialization point. Acquired BEFORE any review-row reads so the
    -- submit + decision wrappers race-safe against each other at the
    -- template grain.
    --
    -- PR #205 Codex R1 Finding 1 closure: derive status + deleted_at under
    -- the FOR UPDATE so the draft-only guard is atomic with the row lock.
    -- NOT FOUND → tenant-blind 02000 (no_data); existing-but-not-draft (or
    -- soft-deleted) → 42P17 (invalid_object_state). Same FOR UPDATE
    -- statement = no TOCTOU between the existence check and the state
    -- guard.
    -- ---------------------------------------------------------------------
    SELECT status, deleted_at
      INTO v_template_status, v_template_deleted_at
      FROM forms_template
     WHERE tenant_id = p_tenant_id AND template_id = p_template_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'admin-template-submit-template-not-found: forms_template id % not found for tenant %',
            p_template_id, p_tenant_id
            USING ERRCODE = '02000';
    END IF;

    -- PR #205 Codex R1 Finding 1: state guard. Template MUST be in
    -- `draft` status AND not soft-deleted to be eligible for admin-review
    -- submission. Per SI-023 §4 + §6 transition triple #1 (initial
    -- submission) and triple #5 (revision resubmission), the template is
    -- expected to be `draft` throughout the review lifecycle — the
    -- `published` flip only happens at the decision wrapper on approve.
    -- A template in `published`, `superseded`, or `archived` status (or
    -- one with deleted_at NOT NULL) is NOT a valid submit target. The
    -- 42P17 ERRCODE is mapped to 409 at the Fastify handler with a
    -- tenant-blind body (no template_id / tenant_id leak per I-025).
    IF v_template_status IS DISTINCT FROM 'draft'
       OR v_template_deleted_at IS NOT NULL THEN
        RAISE EXCEPTION
            'admin-template-submit-invalid-state: template % is not in draft state (status=%, deleted_at=%); only draft templates may be submitted for admin review',
            p_template_id, v_template_status, v_template_deleted_at
            USING ERRCODE = '42P17';
    END IF;

    -- ---------------------------------------------------------------------
    -- R7 HIGH-1 (SI-023): derive existing in-flight revision_requested
    -- review (if any) under the parent-template lock.
    -- ---------------------------------------------------------------------
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
        -- REVISION RESUBMISSION PATH (transition triple #5).
        v_review_id := v_existing_revision_requested_review_id;
        PERFORM record_forms_template_admin_review_transition(
            p_tenant_id, v_review_id,
            'revision_requested', 'pending_review', 'revision_resubmission',
            v_submitter_principal_id, NULL
        );
    ELSE
        -- INITIAL SUBMISSION PATH (transition triple #1).
        -- Reject if an in-flight pending_review review already exists.
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

        -- Insert the new review root.
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

    -- Audit emission DEFERRED to application layer (per Option 2 carryforward).

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
    'LAYER B (role check) + audit emission deferred to Fastify route handler. '
    'PR #205 Codex R1 Finding 1: state guard atomic with FOR UPDATE — template '
    'MUST be in `draft` status AND not soft-deleted; non-draft/soft-deleted '
    'raises 42P17 (invalid_object_state) → handler maps to 409 tenant-blind.';
