SET LOCAL search_path=pg_catalog,public,pg_temp;
DROP TRIGGER IF EXISTS forms_publication_evidence ON public.forms_published_definition;
CREATE OR REPLACE FUNCTION public.record_forms_template_admin_decision(
    p_tenant_id        TEXT,
    p_review_id        UUID,
    p_decision         TEXT,
    p_decision_payload JSONB,
    p_idempotency_key  TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_decider_principal_id      TEXT;
    v_actor_tenant_id           TEXT;
    v_existing_decision         TEXT;
    v_latest_state              TEXT;
    v_review_forms_template_id  TEXT;
BEGIN
    -- ---------------------------------------------------------------------
    -- Input validation.
    -- ---------------------------------------------------------------------
    IF p_decision NOT IN ('approve', 'reject', 'request_revision') THEN
        RAISE EXCEPTION
            'admin-template-decision-invalid-decision-value: % is not a valid decision',
            p_decision
            USING ERRCODE = '22023';
    END IF;

    IF p_idempotency_key IS NULL THEN
        RAISE EXCEPTION
            'admin-template-decision-null-idempotency-key: '
            'p_idempotency_key MUST be non-null per R2 MED-1 IDEMPOTENCY contract'
            USING ERRCODE = '23502';
    END IF;

    -- ---------------------------------------------------------------------
    -- LAYER C — tenant scope match (SI-010 trust anchor).
    -- ---------------------------------------------------------------------
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION
            'record_forms_template_admin_decision: no actor tenant bound for current backend'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION
            'record_forms_template_admin_decision: tenant scope mismatch — actor tenant % does not match wrapper p_tenant_id %; cross-tenant decision rejected',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    -- ---------------------------------------------------------------------
    -- Internal actor binding from SI-010 (caller cannot forge).
    -- ---------------------------------------------------------------------
    v_decider_principal_id := current_actor_account_id();
    IF v_decider_principal_id IS NULL THEN
        RAISE EXCEPTION
            'record_forms_template_admin_decision: no actor account bound for current backend'
            USING ERRCODE = '42501';
    END IF;

    -- ---------------------------------------------------------------------
    -- R11 HIGH-1: parent-template serialization. Step 0 read template_id
    -- without lock; Step 1 parent forms_template FOR UPDATE; Step 2 review
    -- row FOR UPDATE. Consistent template→review acquisition order prevents
    -- deadlock with the submit wrapper.
    -- ---------------------------------------------------------------------
    SELECT forms_template_id INTO v_review_forms_template_id
      FROM forms_template_admin_review
     WHERE tenant_id = p_tenant_id AND review_id = p_review_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'admin-template-decision-review-not-found: review_id % not found for tenant %',
            p_review_id, p_tenant_id
            USING ERRCODE = '02000';
    END IF;

    PERFORM 1 FROM forms_template
     WHERE tenant_id = p_tenant_id AND template_id = v_review_forms_template_id
       FOR UPDATE;

    PERFORM 1 FROM forms_template_admin_review
     WHERE tenant_id = p_tenant_id AND review_id = p_review_id
       FOR UPDATE;

    -- ---------------------------------------------------------------------
    -- R2 MED-1 idempotency check (under lock). If a row with the same
    -- (tenant, review, idempotency_key) exists, return early on same
    -- decision (idempotent replay) or raise 40001 on different decision
    -- (caller bug).
    -- ---------------------------------------------------------------------
    SELECT decision INTO v_existing_decision
      FROM admin_template_decision_idempotency_key
     WHERE tenant_id = p_tenant_id
       AND review_id = p_review_id
       AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_existing_decision = p_decision THEN
            RETURN;  -- idempotent replay
        ELSE
            RAISE EXCEPTION
                'idempotency-key-decision-mismatch: existing key has decision=% but request has decision=%; not safe to retry',
                v_existing_decision, p_decision
                USING ERRCODE = '40001';
        END IF;
    END IF;

    -- ---------------------------------------------------------------------
    -- R1 HIGH-3 latest-state derivation under lock. Only pending_review
    -- accepts a decision.
    -- ---------------------------------------------------------------------
    SELECT to_state INTO v_latest_state
      FROM forms_template_admin_review_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND review_id = p_review_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;
    IF v_latest_state IS DISTINCT FROM 'pending_review' THEN
        RAISE EXCEPTION
            'admin-template-decision-non-pending-latest-state: latest state is %; only pending_review accepts decision',
            COALESCE(v_latest_state, '<NULL/no-transitions>')
            USING ERRCODE = '40001';
    END IF;

    -- ---------------------------------------------------------------------
    -- Record the lifecycle transition via the raw writer (sole INSERT path).
    -- ---------------------------------------------------------------------
    PERFORM record_forms_template_admin_review_transition(
        p_tenant_id, p_review_id,
        'pending_review',
        CASE p_decision
            WHEN 'approve'          THEN 'approved'
            WHEN 'reject'           THEN 'rejected'
            WHEN 'request_revision' THEN 'revision_requested'
        END,
        CASE p_decision
            WHEN 'approve'          THEN 'clinician_decision_approve'
            WHEN 'reject'           THEN 'clinician_decision_reject'
            WHEN 'request_revision' THEN 'clinician_decision_request_revision'
        END,
        v_decider_principal_id, p_decision_payload
    );

    -- ---------------------------------------------------------------------
    -- Conditional publish on approve. The forms_template.status enum is
    -- (draft, published, superseded, archived) per migration 006; published
    -- is the live-serving status.
    -- ---------------------------------------------------------------------
    IF p_decision = 'approve' THEN
        UPDATE forms_template SET status = 'published'
         WHERE tenant_id = p_tenant_id AND template_id = v_review_forms_template_id;
        -- admin.template_published_via_review_workflow Cat A audit emission
        -- DEFERRED to application layer.
    END IF;

    -- ---------------------------------------------------------------------
    -- R13 HIGH-2: explicit unique_violation handler for concurrent same-
    -- idempotency-key race. The pre-INSERT check above resolved any
    -- previously-committed row; this handler catches the race where two
    -- concurrent calls with the same key arrive between the pre-INSERT
    -- check and the INSERT.
    -- ---------------------------------------------------------------------
    BEGIN
        INSERT INTO admin_template_decision_idempotency_key
            (tenant_id, review_id, idempotency_key, decision, decision_payload_jsonb, decider_principal_id)
        VALUES
            (p_tenant_id, p_review_id, p_idempotency_key, p_decision, p_decision_payload, v_decider_principal_id);
    EXCEPTION
        WHEN unique_violation THEN
            SELECT decision INTO v_existing_decision
              FROM admin_template_decision_idempotency_key
             WHERE tenant_id = p_tenant_id
               AND review_id = p_review_id
               AND idempotency_key = p_idempotency_key;
            IF v_existing_decision = p_decision THEN
                RAISE EXCEPTION
                    'admin-template-decision-concurrent-same-key-retry-safe: '
                    'concurrent identical-key call already committed decision %; '
                    'retry on the client side', v_existing_decision
                    USING ERRCODE = '40001';
            ELSE
                RAISE EXCEPTION
                    'idempotency-key-decision-mismatch: concurrent call committed decision % but this request had decision %',
                    v_existing_decision, p_decision
                    USING ERRCODE = '40001';
            END IF;
    END;

    -- admin.template_review_decision Cat A audit emission DEFERRED to
    -- application layer per Option 2.
END;
$$;
CREATE OR REPLACE FUNCTION public.submit_forms_template_for_admin_review(
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
DROP FUNCTION IF EXISTS public.forms_admin_submission_receipt(UUID);
DROP FUNCTION IF EXISTS public.forms_require_publication_evidence();
DROP FUNCTION IF EXISTS public.forms_publication_receipt(TEXT);
DROP FUNCTION IF EXISTS public.forms_current_transaction_write(XID);
