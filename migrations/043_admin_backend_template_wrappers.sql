-- =============================================================================
-- File:    migrations/043_admin_backend_template_wrappers.sql
-- Purpose: Create the 2 template SECURITY DEFINER wrappers for SI-023
--          Sub-decision 4 + CDM §4.NEW8e + §4.NEW8f (RATIFIED 2026-05-22
--          P-042):
--            (a) submit_forms_template_for_admin_review() — initial submission
--                + revision-resubmission paths
--            (b) record_forms_template_admin_decision() — approve / reject /
--                request_revision with idempotency-key contract
--
--          PR 4 of the Admin Backend Basics implementation series. PR 5 lands
--          the 3 dashboard read-wrappers; PR 6 lands the Fastify module
--          scaffold (currently at v0.1 skeleton from PR 6 of Crisis Response
--          per the BLOCKED-aware pattern — Admin Backend Fastify scaffold
--          will live alongside it).
--
--          PER RATIFIER OPTION 2 (carryforward from Crisis Response
--          migrations 035-038):
--
--          - LAYER A authorization: EXECUTE grant matrix. Submit → ONLY
--            admin_basic_operator; decision → ONLY admin_template_reviewer.
--            REVOKE EXECUTE FROM PUBLIC. The CDM spec §4.NEW8e/f uses LAYER A
--            + LAYER B + LAYER C; Option 2 keeps A + C inside the wrapper
--            and defers B to the application layer (the Fastify route in
--            PR 6 checks the calling principal's role before invoking the
--            wrapper; this matches the spec's "JWT principal does NOT hold
--            <role>" check semantically). The wrapper-internal LAYER A +
--            LAYER C are sufficient against the SECDEF surface; LAYER B is
--            a defense-in-depth check that lands when the route handler
--            ships.
--          - LAYER C authorization: tenant scope match via SI-010
--            `current_actor_account_tenant_id()` helper. Reject with 42501
--            if NULL (no actor bound) OR mismatched p_tenant_id.
--          - Internal actor binding (submitter_principal_id /
--            decider_principal_id / actor_principal_id at the raw writer):
--            BOUND from SI-010 `current_actor_account_id()` — caller cannot
--            forge. This is the same canonical defense-in-depth pattern
--            applied to Crisis Response migrations 036-038.
--          - Audit emission DEFERRED to application layer. The Fastify
--            route in PR 6 wraps the SECDEF call + the audit_records
--            INSERT in a single DB transaction per FLOOR-020 fail-closed
--            discipline. The spec's `emit_audit_event_co_transactional()`
--            helper doesn't exist in code repo at this checkpoint.
--          - LAYER B (`verify_session_jwt_and_extract_claims()` +
--            `tenant_account_membership` lookup) DEFERRED. The spec's JWT
--            trust anchor (SI-024.1) is not in the code repo at this
--            checkpoint. The SI-010 actor binding + LAYER A grant matrix
--            is the equivalent.
--          - tenant_id_t → TEXT; UUID principal-ids → TEXT/VARCHAR(26)
--            for accounts(account_id) refs; forms_template_id UUID → TEXT
--            for forms_template(template_id) refs.
--          - Decision wrapper body is VERBATIM lift of SI-023 v1.0
--            RATIFIED Sub-decision 4 idempotency ordering (per CDM §4.NEW8f
--            banner: ratifier-closed at P-042 R2 hard-floor item 6
--            escalation — "We go with A"; idempotency_key INSERT after
--            lifecycle transition + conditional publish UPDATE; canonical
--            caller contract = single-tx + propagate 40001 → HTTP retry).
--            Future Codex passes that re-raise the ordering finding are
--            duplicate-of-R2 + closed per ratifier decision; reviewers
--            should not re-litigate without proposing a Track 6 hygiene
--            cycle (SI-023 v1.1).
--          - BIGSERIAL implicit-sequence USAGE: granted preemptively to
--            decision_wrapper_owner for admin_template_decision_idempotency_key_id_seq
--            (per Admin Backend PR 3 R3 closure pattern; INSERT alone does
--            NOT confer nextval USAGE).
--
-- Spec:    - SI-023 Admin Backend Basics Slice v1.0 Sub-decision 4
--            (RATIFIED 2026-05-22 P-041;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_SI_023_Admin_Backend_Basics_v1_0.md §4 + §6 normative
--            state-machine transition triples)
--          - CDM v1.10 → v1.11 Amendment §4.NEW8e + §4.NEW8f + §4.NEW8g
--            (canonical executable wrapper-body source; RATIFIED 2026-05-22
--            P-042; telecheckONE/Telecheck Master Bundle FINAL US REGION
--            BASELINE/Telecheck_CDM_v1_10_to_v1_11_Amendment.md)
--          - I-023, I-025, I-027, I-035 (tenant isolation; tenant-blind
--            errors; audit completeness; append-only state machine)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   006_forms_intake.sql                         applied (forms_template + status column)
--   031_session_actor_context.sql                applied (SI-010 helpers)
--   039_admin_backend_rbac_roles.sql             applied (12 admin RBAC roles)
--   040_admin_backend_entities.sql               applied (4 admin entities +
--                                                  unified lifecycle-invariants trigger +
--                                                  one-active-review LAYER 2 trigger)
--   042_admin_backend_raw_lifecycle_writer.sql   applied (raw writer SECDEF +
--                                                  anti-bypass grant to 2 wrapper-owners +
--                                                  BIGSERIAL sequence USAGE)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — submit_forms_template_for_admin_review() (CDM §4.NEW8e; SI-023 §4)
--
-- TWO paths under a shared parent-template FOR UPDATE LAYER 1 serialization:
--   - REVISION RESUBMISSION (transition triple #5: revision_requested →
--     pending_review / revision_resubmission): reuses existing review_id.
--   - INITIAL SUBMISSION (transition triple #1: none → pending_review /
--     initial_submission): creates new forms_template_admin_review row +
--     initial lifecycle_transition row.
--
-- Internal actor binding from SI-010 `current_actor_account_id()` (caller
-- cannot forge). LAYER C tenant scope match via
-- `current_actor_account_tenant_id()`.
-- =============================================================================

CREATE OR REPLACE FUNCTION submit_forms_template_for_admin_review(
    p_tenant_id   TEXT,
    p_template_id TEXT    -- VARCHAR(26) at the forms_template(template_id) column
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
    -- ---------------------------------------------------------------------
    -- LAYER B (role authorization) DEFERRED to application layer per Option 2.
    -- The Fastify route handler in PR 6 will check the calling principal
    -- holds admin_basic_operator before invoking this wrapper. The wrapper-
    -- internal LAYER A (EXECUTE granted to admin_basic_operator only) is
    -- sufficient against the SECDEF surface.
    -- ---------------------------------------------------------------------

    -- ---------------------------------------------------------------------
    -- LAYER C — tenant scope match. SI-010 trust anchor binds the actor's
    -- tenant_id at request time; reject if mismatched (defense-in-depth
    -- alongside LAYER A EXECUTE-grant).
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
    -- template grain. NOT FOUND → tenant-blind 02000 (no_data).
    -- ---------------------------------------------------------------------
    PERFORM 1 FROM forms_template
     WHERE tenant_id = p_tenant_id AND template_id = p_template_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'admin-template-submit-template-not-found: forms_template id % not found for tenant %',
            p_template_id, p_tenant_id
            USING ERRCODE = '02000';
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
        -- Reject if an in-flight pending_review (or revision_requested,
        -- though the previous block already handled revision_requested)
        -- review already exists. Returns 40001 (serialization_failure) so
        -- the HTTP layer can surface 409 Conflict.
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

        -- Insert the new review root. ai_guardrail_snapshot_jsonb is
        -- omitted (NULL) at v0.1 — the column exists on forms_template per
        -- the spec but the snapshot capture path is application-layer logic
        -- not yet wired in code repo. The schema accepts NULL.
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
    -- The Fastify route handler in PR 6 wraps THIS wrapper call + the
    -- audit_records INSERT for 'admin.template_submitted_for_review' Cat A
    -- in a single DB transaction per FLOOR-020 fail-closed discipline.

    RETURN v_review_id;
END;
$$;

-- =============================================================================
-- §2 — submit-wrapper ownership + privilege grants (LAYER A + DML)
-- =============================================================================

ALTER FUNCTION submit_forms_template_for_admin_review(TEXT, TEXT)
    OWNER TO forms_template_admin_review_submit_wrapper_owner;

-- Submit wrapper-owner DML grants per CDM §4.NEW8g R8 + R11 + R12 closures:
GRANT SELECT, UPDATE ON forms_template
    TO forms_template_admin_review_submit_wrapper_owner;
    -- SELECT FOR UPDATE on parent template (UPDATE privilege required for
    -- the row-lock per R8 HIGH-1; no actual mutation from this wrapper).

GRANT SELECT, INSERT, UPDATE ON forms_template_admin_review
    TO forms_template_admin_review_submit_wrapper_owner;
    -- SELECT for LATERAL latest-state checks (both paths) + INSERT for new
    -- review row + UPDATE privilege required for FOR UPDATE OF ftar row-lock
    -- per R8 HIGH-1 (append-only trigger blocks any actual UPDATE/DELETE
    -- at runtime — these are the only-LOCK-not-mutate privileges).
    -- R12 HIGH-1: SELECT also required by the SECURITY INVOKER
    -- enforce_one_active_review_per_template() trigger which fires BEFORE
    -- INSERT and reads forms_template_admin_review via LATERAL latest-state
    -- derivation (runs under the inserting SECDEF context = submit wrapper-
    -- owner).

GRANT SELECT ON forms_template_admin_review_lifecycle_transition
    TO forms_template_admin_review_submit_wrapper_owner;
    -- (1) LATERAL JOIN latest-state derivation in wrapper body
    -- (2) R12 HIGH-1: SELECT also required by SECURITY INVOKER
    --     enforce_one_active_review_per_template() trigger LATERAL.

GRANT EXECUTE ON FUNCTION current_actor_account_id()
    TO forms_template_admin_review_submit_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()
    TO forms_template_admin_review_submit_wrapper_owner;
    -- SI-010 trust-anchor reads for LAYER C tenant scope + internal actor
    -- binding (caller cannot forge submitter_principal_id).

-- EXECUTE on the raw lifecycle writer is already granted at migration 042
-- §3 (anti-bypass grant matrix); no additional grant needed here.

-- LAYER A anti-bypass: ONLY admin_basic_operator can EXECUTE.
REVOKE EXECUTE ON FUNCTION submit_forms_template_for_admin_review(TEXT, TEXT)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION submit_forms_template_for_admin_review(TEXT, TEXT)
    TO admin_basic_operator;

COMMENT ON FUNCTION submit_forms_template_for_admin_review(TEXT, TEXT) IS
    'P-042 §4.NEW8e + SI-023 Sub-decision 4 submit wrapper. SECURITY DEFINER + '
    'locked search_path. Two paths under shared parent-template FOR UPDATE: '
    'INITIAL_SUBMISSION (transition triple #1) + REVISION_RESUBMISSION '
    '(transition triple #5). Internal actor bound from SI-010 (caller cannot '
    'forge). LAYER C tenant scope match via current_actor_account_tenant_id(). '
    'LAYER A EXECUTE granted ONLY to admin_basic_operator (anti-bypass). '
    'LAYER B (role check) + audit emission deferred to Fastify route handler in PR 6.';

-- =============================================================================
-- §3 — record_forms_template_admin_decision() (CDM §4.NEW8f; SI-023 §4)
--
-- Decision wrapper. THREE decision values mapped to lifecycle triples:
--   approve            → triple #2 (pending_review → approved /
--                                    clinician_decision_approve)
--   reject             → triple #3 (pending_review → rejected /
--                                    clinician_decision_reject)
--   request_revision   → triple #4 (pending_review → revision_requested /
--                                    clinician_decision_request_revision)
--
-- Wrapper body is VERBATIM lift of SI-023 v1.0 RATIFIED Sub-decision 4
-- idempotency-ordering (per CDM §4.NEW8f banner: ratifier-closed at P-042
-- R2 hard-floor item 6 escalation — "We go with A"; idempotency_key INSERT
-- AFTER lifecycle_transition + conditional publish UPDATE). Canonical
-- caller contract: single DB transaction + propagate 40001 errors →
-- HTTP-layer retry.
-- =============================================================================

CREATE OR REPLACE FUNCTION record_forms_template_admin_decision(
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

-- =============================================================================
-- §4 — decision-wrapper ownership + privilege grants (LAYER A + DML)
-- =============================================================================

ALTER FUNCTION record_forms_template_admin_decision(TEXT, UUID, TEXT, JSONB, TEXT)
    OWNER TO forms_template_admin_review_decision_wrapper_owner;

-- Decision wrapper-owner DML grants per CDM §4.NEW8g R8 closure:
GRANT SELECT, UPDATE ON forms_template
    TO forms_template_admin_review_decision_wrapper_owner;
    -- SELECT FOR UPDATE on parent template + UPDATE status='published' on approve.

GRANT SELECT, UPDATE ON forms_template_admin_review
    TO forms_template_admin_review_decision_wrapper_owner;
    -- SELECT to derive forms_template_id + SELECT FOR UPDATE row lock
    -- (UPDATE privilege required for FOR UPDATE; append-only trigger blocks
    -- any actual UPDATE/DELETE at runtime).

GRANT SELECT ON forms_template_admin_review_lifecycle_transition
    TO forms_template_admin_review_decision_wrapper_owner;
    -- Latest-state derivation under lock.

GRANT SELECT, INSERT ON admin_template_decision_idempotency_key
    TO forms_template_admin_review_decision_wrapper_owner;
    -- Idempotency pre-check + reservation INSERT.

-- BIGSERIAL implicit-sequence USAGE for admin_template_decision_idempotency_key.id
-- (preemptive per Admin Backend PR 3 R3 closure pattern: INSERT alone does NOT
-- confer nextval USAGE; without this the decision wrapper would fail at runtime
-- with "permission denied for sequence" on the first INSERT).
GRANT USAGE ON SEQUENCE admin_template_decision_idempotency_key_id_seq
    TO forms_template_admin_review_decision_wrapper_owner;

GRANT EXECUTE ON FUNCTION current_actor_account_id()
    TO forms_template_admin_review_decision_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()
    TO forms_template_admin_review_decision_wrapper_owner;
    -- SI-010 trust-anchor reads for LAYER C + internal decider_principal_id binding.

-- EXECUTE on the raw lifecycle writer is already granted at migration 042 §3.

-- LAYER A anti-bypass: ONLY admin_template_reviewer can EXECUTE.
REVOKE EXECUTE ON FUNCTION record_forms_template_admin_decision(TEXT, UUID, TEXT, JSONB, TEXT)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_forms_template_admin_decision(TEXT, UUID, TEXT, JSONB, TEXT)
    TO admin_template_reviewer;

COMMENT ON FUNCTION record_forms_template_admin_decision(TEXT, UUID, TEXT, JSONB, TEXT) IS
    'P-042 §4.NEW8f + SI-023 Sub-decision 4 decision wrapper. SECURITY DEFINER + '
    'locked search_path. Three decision values (approve / reject / request_revision) '
    'mapped to lifecycle triples #2 / #3 / #4. Idempotency-ordering verbatim per '
    'SI-023 v1.0 RATIFIED (ratifier-closed at P-042 R2 hard-floor item 6 — Option A). '
    'Internal decider bound from SI-010 (caller cannot forge). LAYER C tenant scope '
    'match. LAYER A EXECUTE granted ONLY to admin_template_reviewer (anti-bypass). '
    'LAYER B (role check) + audit emission deferred to Fastify route handler in PR 6.';

-- =============================================================================
-- §5 — Verification
-- =============================================================================

DO $$
DECLARE
    v_submit_oid                OID := to_regprocedure(
        'public.submit_forms_template_for_admin_review(text, text)'
    );
    v_decision_oid              OID := to_regprocedure(
        'public.record_forms_template_admin_decision(text, uuid, text, jsonb, text)'
    );
    v_owner                     TEXT;
    v_security_definer          BOOLEAN;
    v_proconfig                 TEXT[];
    v_specific_name             TEXT;
    v_grantee_count             INTEGER;
    v_unauthorized_grantee      TEXT;
BEGIN
    -- ---------- submit wrapper ----------
    IF v_submit_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-043-submit-function-missing: '
            'submit_forms_template_for_admin_review(text, text) not found by signature';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_owner, v_security_definer, v_proconfig
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_submit_oid;

    IF v_owner <> 'forms_template_admin_review_submit_wrapper_owner' THEN
        RAISE EXCEPTION
            'migration-043-submit-ownership-mismatch: submit wrapper ownership is % '
            'but MUST be forms_template_admin_review_submit_wrapper_owner', v_owner;
    END IF;

    IF NOT v_security_definer THEN
        RAISE EXCEPTION
            'migration-043-submit-security-definer-missing: submit wrapper MUST be SECURITY DEFINER';
    END IF;

    IF v_proconfig IS NULL
       OR NOT (v_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-043-submit-search-path-not-locked: submit wrapper MUST have '
            'proconfig containing "search_path=pg_catalog, public"; found %', v_proconfig;
    END IF;

    SELECT p.proname || '_' || p.oid::TEXT INTO v_specific_name
      FROM pg_proc p WHERE p.oid = v_submit_oid;

    -- Submit wrapper EXECUTE grants: owner + admin_basic_operator only.
    SELECT COUNT(*) INTO v_grantee_count
      FROM information_schema.role_routine_grants g
     WHERE g.specific_name = v_specific_name
       AND g.privilege_type = 'EXECUTE'
       AND g.grantee <> 'forms_template_admin_review_submit_wrapper_owner';

    IF v_grantee_count <> 1 THEN
        RAISE EXCEPTION
            'migration-043-submit-execute-grant-count: '
            'expected exactly 1 EXECUTE grant (admin_basic_operator) excluding owner, found %',
            v_grantee_count;
    END IF;

    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_routine_grants g
         WHERE g.specific_name = v_specific_name
           AND g.privilege_type = 'EXECUTE'
           AND g.grantee NOT IN ('forms_template_admin_review_submit_wrapper_owner',
                                 'admin_basic_operator')
    LOOP
        RAISE EXCEPTION
            'migration-043-submit-execute-grant-violation: '
            'submit wrapper EXECUTE granted to non-canonical role %', v_unauthorized_grantee;
    END LOOP;

    PERFORM 1 FROM information_schema.role_routine_grants
     WHERE specific_name = v_specific_name
       AND privilege_type = 'EXECUTE' AND grantee = 'PUBLIC';
    IF FOUND THEN
        RAISE EXCEPTION
            'migration-043-submit-anti-bypass-violation: PUBLIC has EXECUTE on submit wrapper';
    END IF;

    -- ---------- decision wrapper ----------
    IF v_decision_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-043-decision-function-missing: '
            'record_forms_template_admin_decision(text, uuid, text, jsonb, text) not found by signature';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_owner, v_security_definer, v_proconfig
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_decision_oid;

    IF v_owner <> 'forms_template_admin_review_decision_wrapper_owner' THEN
        RAISE EXCEPTION
            'migration-043-decision-ownership-mismatch: decision wrapper ownership is % '
            'but MUST be forms_template_admin_review_decision_wrapper_owner', v_owner;
    END IF;

    IF NOT v_security_definer THEN
        RAISE EXCEPTION
            'migration-043-decision-security-definer-missing: decision wrapper MUST be SECURITY DEFINER';
    END IF;

    IF v_proconfig IS NULL
       OR NOT (v_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-043-decision-search-path-not-locked: decision wrapper MUST have '
            'proconfig containing "search_path=pg_catalog, public"; found %', v_proconfig;
    END IF;

    SELECT p.proname || '_' || p.oid::TEXT INTO v_specific_name
      FROM pg_proc p WHERE p.oid = v_decision_oid;

    SELECT COUNT(*) INTO v_grantee_count
      FROM information_schema.role_routine_grants g
     WHERE g.specific_name = v_specific_name
       AND g.privilege_type = 'EXECUTE'
       AND g.grantee <> 'forms_template_admin_review_decision_wrapper_owner';

    IF v_grantee_count <> 1 THEN
        RAISE EXCEPTION
            'migration-043-decision-execute-grant-count: '
            'expected exactly 1 EXECUTE grant (admin_template_reviewer) excluding owner, found %',
            v_grantee_count;
    END IF;

    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_routine_grants g
         WHERE g.specific_name = v_specific_name
           AND g.privilege_type = 'EXECUTE'
           AND g.grantee NOT IN ('forms_template_admin_review_decision_wrapper_owner',
                                 'admin_template_reviewer')
    LOOP
        RAISE EXCEPTION
            'migration-043-decision-execute-grant-violation: '
            'decision wrapper EXECUTE granted to non-canonical role %', v_unauthorized_grantee;
    END LOOP;

    PERFORM 1 FROM information_schema.role_routine_grants
     WHERE specific_name = v_specific_name
       AND privilege_type = 'EXECUTE' AND grantee = 'PUBLIC';
    IF FOUND THEN
        RAISE EXCEPTION
            'migration-043-decision-anti-bypass-violation: PUBLIC has EXECUTE on decision wrapper';
    END IF;

    -- ---------- Sequence USAGE assertion (decision wrapper-owner) ----------
    IF NOT has_sequence_privilege(
        'forms_template_admin_review_decision_wrapper_owner',
        'public.admin_template_decision_idempotency_key_id_seq',
        'USAGE'
    ) THEN
        RAISE EXCEPTION
            'migration-043-decision-sequence-usage-missing: '
            'decision wrapper-owner does NOT have USAGE on '
            'admin_template_decision_idempotency_key_id_seq; BIGSERIAL nextval in '
            'the SECDEF wrapper will fail at runtime with permission denied for sequence';
    END IF;
END $$;
