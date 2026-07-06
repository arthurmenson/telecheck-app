-- =============================================================================
-- File:    migrations/059_async_consult_wrappers.sql
-- Purpose: Create the 6 Async Consult SECURITY DEFINER wrapper functions per
--          CDM v1.8 → v1.9 amendment (RATIFIED P-038 2026-05-21) §3:
--
--          1. record_consult_initiation()            (consult_initiation_wrapper_owner)
--          2. record_consult_intake_submission()     (consult_intake_wrapper_owner)
--          3. record_consult_ai_preparation_completed() (consult_ai_preparation_wrapper_owner)
--          4. claim_consult_for_review()             (consult_claim_wrapper_owner)
--          5. reassign_consult_claim()               (consult_claim_wrapper_owner)
--          6. record_consult_clinician_decision()    (record_consult_decision_wrapper_owner)
--
--          PR 5 of the Async Consult Sprint-10 series (055 roles → 056
--          entities → 057 views → 058 raw writer). Subsequent: Fastify
--          handlers + Cat A/B/C audit emission + integration tests (PR 6+).
--          Follows the Med-Interaction migration 050 wrapper cadence.
--
-- Common wrapper shape (050 pattern):
--   SECDEF + locked search_path = pg_catalog, public; SI-010 tenant guard;
--   per-consult advisory lock(s); business validation; entity INSERT;
--   lifecycle transitions delegated to the raw writer (migration 058).
--
-- Lock-order discipline (deadlock avoidance; see 056/058 headers): when a
-- wrapper touches consult_review_claim AND writes a transition, it acquires
-- 'consult_review_claim:<t>:<c>' BEFORE the raw writer's
-- 'consult_lifecycle_transition:<t>:<c>' lock (re-entrant within the tx).
--
-- Option 2 adaptations from spec (recorded divergences; 050 carryforward):
--   - PROCEDURE → FUNCTION (claim wrapper RETURNS VARCHAR(26) — the
--     auto-released prior claim id or NULL — so the handler can emit the
--     required Cat B async_consult.claim_expired_auto_released audit
--     app-side; all others RETURN VOID).
--   - SI-024.1 JWT verification → SI-010 actor binding
--     (current_actor_account_id / current_actor_account_tenant_id); LAYER B
--     role-membership checks deferred to Fastify handlers (043/050 pattern).
--   - tenant_id_t → TEXT; ULIDs → VARCHAR(26), caller-supplied ids.
--   - Billing payment-intent validation in record_consult_initiation is
--     DEFERRED (billing_payment_intent entity absent; P-038 marks Billing
--     out of scope); handler-layer validation until the Billing slice
--     lands. Documented TODO.
--   - Spec's ai_service_account caller role for wrapper 3 does NOT exist in
--     the code repo. EXECUTE on record_consult_ai_preparation_completed is
--     OWNER-ONLY at this migration; the AI-service handler PR grants
--     EXECUTE to its slice role when that role is wired. Documented TODO —
--     avoids inventing an unratified role (hard-floor discipline).
--   - Audit emission (async_consult.* Cat A/B/C IDs per AUDIT_EVENTS v5.11)
--     happens app-side in the handler PRs (canonical write composition:
--     wrapper call + same-tx emitAudit under restored app role) — matching
--     the Admin Backend + Med-Interaction handler pattern, NOT inside these
--     wrappers.
--
-- Preconditions: 031 + 055 + 056 + 057 + 058 applied.
-- Invariants: I-023 (tenant guards), I-025 (no cross-tenant existence
--   leaks — lookups are tenant-scoped and raise tenant-blind errors),
--   I-035 (transitions only via raw writer; claim release one-way).
-- =============================================================================

-- =============================================================================
-- §0 — Supplemental grants required by wrapper bodies
-- =============================================================================

-- Initiation wrapper validates delegate authorization (active book_consults
-- delegation) when p_delegate_id is supplied.
GRANT SELECT (tenant_id, delegation_id, grantor_account_id, delegate_account_id, status)
    ON delegations TO consult_initiation_wrapper_owner;
GRANT SELECT (tenant_id, delegation_id, scope, revoked_at)
    ON delegation_scopes TO consult_initiation_wrapper_owner;

-- Decision wrapper releases the claim (one-way release_reason='decision_recorded')
-- in the same transaction as the decision INSERT. The 056 grant matrix gave
-- UPDATE only to the claim owner; the decision owner needs it too. The
-- one-way trigger (056 §4) constrains ANY updater to the release-field
-- NULL→non-NULL surface, so this grant does not widen mutation semantics.
GRANT UPDATE ON consult_review_claim TO record_consult_decision_wrapper_owner;

-- =============================================================================
-- §1 — record_consult_initiation (P-038 §3 row 2)
--
-- Atomic: INSERT consult row + initial lifecycle transition (none →
-- initiated). Delegate-initiated consults validated against an active
-- book_consults delegation from the patient to the delegate.
-- =============================================================================

CREATE OR REPLACE FUNCTION record_consult_initiation(
    p_consult_id            VARCHAR(26),
    p_tenant_id             TEXT,
    p_patient_id            VARCHAR(26),
    p_delegate_id           VARCHAR(26),    -- NULL when patient-initiated
    p_consult_type          TEXT,
    p_program_id            TEXT,           -- NULL unless program_pathway
    p_initiation_source     TEXT,
    p_consult_fee_cents     INTEGER,
    p_currency              TEXT,
    p_payment_intent_id     VARCHAR(26),
    p_payment_provider      TEXT,
    p_expected_turnaround_at TIMESTAMPTZ,
    p_transition_id         VARCHAR(26),
    p_actor_id              VARCHAR(26),
    p_actor_role            TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id TEXT;
BEGIN
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_consult_initiation: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    -- Delegate authorization: active delegation from the patient (grantor)
    -- to the delegate carrying an unrevoked book_consults scope (fail
    -- closed; mirrors the 057 patient-view delegate predicate).
    IF p_delegate_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1
              FROM public.delegations dg
              JOIN public.delegation_scopes ds
                ON ds.tenant_id = dg.tenant_id
               AND ds.delegation_id = dg.delegation_id
             WHERE dg.tenant_id = p_tenant_id
               AND dg.grantor_account_id = p_patient_id
               AND dg.delegate_account_id = p_delegate_id
               AND dg.status = 'active'
               AND ds.scope = 'book_consults'
               AND ds.revoked_at IS NULL
        ) THEN
            RAISE EXCEPTION 'record_consult_initiation: delegate not authorized for book_consults on this patient'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    -- DEFERRED (Billing slice absent): p_payment_intent_id tenant-coherence
    -- validation. Handler layer validates the payment-intent handle until
    -- billing_payment_intent lands, at which point 056's deferred FK +
    -- a wrapper-level EXISTS check replace this TODO.

    INSERT INTO public.consult (
        id, tenant_id, patient_id, delegate_id, consult_type, program_id,
        initiation_source, consult_fee_cents, currency, payment_intent_id,
        payment_provider, expected_turnaround_at
    ) VALUES (
        p_consult_id, p_tenant_id, p_patient_id, p_delegate_id, p_consult_type, p_program_id,
        p_initiation_source, p_consult_fee_cents, p_currency, p_payment_intent_id,
        p_payment_provider, p_expected_turnaround_at
    );

    PERFORM record_consult_lifecycle_transition(
        p_transition_id, p_tenant_id, p_consult_id,
        'initiated', 'initiation', p_actor_id, p_actor_role, '{}'::jsonb
    );
END;
$$;

ALTER FUNCTION record_consult_initiation(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TEXT, TEXT, TEXT, INTEGER, TEXT, VARCHAR(26), TEXT, TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), TEXT
) OWNER TO consult_initiation_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_consult_initiation(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TEXT, TEXT, TEXT, INTEGER, TEXT, VARCHAR(26), TEXT, TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_consult_initiation(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TEXT, TEXT, TEXT, INTEGER, TEXT, VARCHAR(26), TEXT, TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), TEXT
) TO async_consult_patient_initiator, async_consult_delegate_initiator;

-- =============================================================================
-- §2 — record_consult_intake_submission (P-038 §3 row 3)
--
-- Atomic: (state-dependent lead-in transition) + INSERT intake_submission +
-- submitted transition. Handles three ratified entry states:
--   initiated     → intake_started, then intake → submitted (intake_submitted)
--   intake        → intake → submitted (intake_submitted)
--   awaiting_data → submitted (patient_data_resubmitted; single transition)
-- =============================================================================

CREATE OR REPLACE FUNCTION record_consult_intake_submission(
    p_submission_id         VARCHAR(26),
    p_tenant_id             TEXT,
    p_consult_id            VARCHAR(26),
    p_patient_id            VARCHAR(26),
    p_template_id           VARCHAR(26),
    p_template_version      TEXT,
    p_ciphertext            BYTEA,
    p_dek_id                VARCHAR(26),
    p_iv                    BYTEA,
    p_tag                   BYTEA,
    p_alg                   TEXT,
    p_alg_version           TEXT,
    p_aad                   BYTEA,
    p_encrypted_at          TIMESTAMPTZ,
    p_lead_in_transition_id VARCHAR(26),    -- used only on the initiated / awaiting_data paths
    p_submitted_transition_id VARCHAR(26),  -- used on the initiated / intake paths
    p_actor_id              VARCHAR(26),
    p_actor_role            TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id TEXT;
    v_current_state   TEXT;
    v_lock_key        BIGINT;
BEGIN
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_consult_intake_submission: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    -- Serialize with other transition writers for this consult so the
    -- state read below is stable through both raw-writer calls.
    v_lock_key := ('x' || substr(md5('consult_lifecycle_transition:' || p_tenant_id || ':' || p_consult_id), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT to_state INTO v_current_state
      FROM public.consult_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND consult_id = p_consult_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    IF v_current_state = 'initiated' THEN
        PERFORM record_consult_lifecycle_transition(
            p_lead_in_transition_id, p_tenant_id, p_consult_id,
            'intake', 'intake_started', p_actor_id, p_actor_role, '{}'::jsonb);
        v_current_state := 'intake';
    END IF;

    IF v_current_state = 'intake' THEN
        INSERT INTO public.consult_intake_submission (
            id, tenant_id, consult_id, patient_id, template_id, template_version,
            intake_payload_ciphertext, intake_payload_kms_envelope_dek_id,
            intake_payload_kms_envelope_iv, intake_payload_kms_envelope_tag,
            intake_payload_kms_envelope_alg, intake_payload_kms_envelope_alg_version,
            intake_payload_kms_envelope_aad, intake_payload_kms_envelope_encrypted_at
        ) VALUES (
            p_submission_id, p_tenant_id, p_consult_id, p_patient_id, p_template_id, p_template_version,
            p_ciphertext, p_dek_id, p_iv, p_tag, p_alg, p_alg_version, p_aad, p_encrypted_at
        );
        PERFORM record_consult_lifecycle_transition(
            p_submitted_transition_id, p_tenant_id, p_consult_id,
            'submitted', 'intake_submitted', p_actor_id, p_actor_role, '{}'::jsonb);
    ELSIF v_current_state = 'awaiting_data' THEN
        INSERT INTO public.consult_intake_submission (
            id, tenant_id, consult_id, patient_id, template_id, template_version,
            intake_payload_ciphertext, intake_payload_kms_envelope_dek_id,
            intake_payload_kms_envelope_iv, intake_payload_kms_envelope_tag,
            intake_payload_kms_envelope_alg, intake_payload_kms_envelope_alg_version,
            intake_payload_kms_envelope_aad, intake_payload_kms_envelope_encrypted_at
        ) VALUES (
            p_submission_id, p_tenant_id, p_consult_id, p_patient_id, p_template_id, p_template_version,
            p_ciphertext, p_dek_id, p_iv, p_tag, p_alg, p_alg_version, p_aad, p_encrypted_at
        );
        PERFORM record_consult_lifecycle_transition(
            p_lead_in_transition_id, p_tenant_id, p_consult_id,
            'submitted', 'patient_data_resubmitted', p_actor_id, p_actor_role, '{}'::jsonb);
    ELSE
        -- Tenant-blind: same error whether the consult is absent, in another
        -- tenant, or in a non-intake-capable state (I-025).
        RAISE EXCEPTION 'record_consult_intake_submission: consult not in an intake-capable state'
            USING ERRCODE = 'check_violation';
    END IF;
END;
$$;

ALTER FUNCTION record_consult_intake_submission(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT
) OWNER TO consult_intake_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_consult_intake_submission(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_consult_intake_submission(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT
) TO async_consult_patient_initiator, async_consult_delegate_initiator;

-- =============================================================================
-- §3 — record_consult_ai_preparation_completed (P-038 §3 row 4)
--
-- Atomic: (ai_processing_started when entering from submitted) + INSERT
-- clinical_summary + ai_processing_completed (processing → queued).
--
-- EXECUTE: OWNER-ONLY at this migration. Spec's caller role
-- (ai_service_account) does not exist in the code repo; the AI-service
-- handler PR grants EXECUTE to its slice role when wired (recorded TODO —
-- see header; avoids inventing an unratified role).
-- =============================================================================

CREATE OR REPLACE FUNCTION record_consult_ai_preparation_completed(
    p_summary_id            VARCHAR(26),
    p_tenant_id             TEXT,
    p_consult_id            VARCHAR(26),
    p_patient_id            VARCHAR(26),
    p_prepared_by_mode      TEXT,
    p_ai_provider           TEXT,
    p_model_id              TEXT,
    p_ciphertext            BYTEA,
    p_dek_id                VARCHAR(26),
    p_iv                    BYTEA,
    p_tag                   BYTEA,
    p_alg                   TEXT,
    p_alg_version           TEXT,
    p_aad                   BYTEA,
    p_encrypted_at          TIMESTAMPTZ,
    p_signals_snapshot      JSONB,
    p_recommendation        TEXT,
    p_started_transition_id VARCHAR(26),
    p_completed_transition_id VARCHAR(26),
    p_actor_id              VARCHAR(26),
    p_actor_role            TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id TEXT;
    v_current_state   TEXT;
    v_lock_key        BIGINT;
BEGIN
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_consult_ai_preparation_completed: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    v_lock_key := ('x' || substr(md5('consult_lifecycle_transition:' || p_tenant_id || ':' || p_consult_id), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    SELECT to_state INTO v_current_state
      FROM public.consult_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND consult_id = p_consult_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    IF v_current_state = 'submitted' THEN
        PERFORM record_consult_lifecycle_transition(
            p_started_transition_id, p_tenant_id, p_consult_id,
            'processing', 'ai_processing_started', p_actor_id, p_actor_role, '{}'::jsonb);
        v_current_state := 'processing';
    END IF;

    IF v_current_state IS DISTINCT FROM 'processing' THEN
        RAISE EXCEPTION 'record_consult_ai_preparation_completed: consult not in a preparation-capable state'
            USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.consult_clinical_summary (
        id, tenant_id, consult_id, patient_id, prepared_by_mode, ai_provider, model_id,
        summary_ciphertext, summary_kms_envelope_dek_id, summary_kms_envelope_iv,
        summary_kms_envelope_tag, summary_kms_envelope_alg, summary_kms_envelope_alg_version,
        summary_kms_envelope_aad, summary_kms_envelope_encrypted_at,
        interaction_signals_snapshot, recommendation
    ) VALUES (
        p_summary_id, p_tenant_id, p_consult_id, p_patient_id, p_prepared_by_mode, p_ai_provider, p_model_id,
        p_ciphertext, p_dek_id, p_iv, p_tag, p_alg, p_alg_version, p_aad, p_encrypted_at,
        p_signals_snapshot, p_recommendation
    );

    PERFORM record_consult_lifecycle_transition(
        p_completed_transition_id, p_tenant_id, p_consult_id,
        'queued', 'ai_processing_completed', p_actor_id, p_actor_role, '{}'::jsonb);
END;
$$;

ALTER FUNCTION record_consult_ai_preparation_completed(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TEXT, TEXT, TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, JSONB, TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT
) OWNER TO consult_ai_preparation_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_consult_ai_preparation_completed(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TEXT, TEXT, TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, JSONB, TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT
) FROM PUBLIC;
-- (owner-only; AI-service slice role EXECUTE lands with its handler PR)

-- =============================================================================
-- §4 — claim_consult_for_review (P-038 §3 row 6; SI-020 R5 closure pattern)
--
-- STEP 0 tenant guard; STEP 1 per-consult claim advisory lock; STEP 2
-- auto-release expired prior claim (returns its id for the handler's Cat B
-- async_consult.claim_expired_auto_released emission); STEP 3 patient_id
-- lookup; STEP 4 INSERT new claim + queued → under_review transition.
-- Structured claim_already_held rejection (ERRCODE 55006 → handler 409).
-- =============================================================================

CREATE OR REPLACE FUNCTION claim_consult_for_review(
    p_claim_id              VARCHAR(26),
    p_tenant_id             TEXT,
    p_consult_id            VARCHAR(26),
    p_clinician_account_id  VARCHAR(26),
    p_claim_expires_at      TIMESTAMPTZ,
    p_transition_id         VARCHAR(26),
    p_actor_id              VARCHAR(26),
    p_actor_role            TEXT
) RETURNS VARCHAR(26)    -- auto-released prior claim id, or NULL
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id   TEXT;
    v_claim_lock_key    BIGINT;
    v_patient_id        VARCHAR(26);
    v_active_claim_id   VARCHAR(26);
    v_active_expires_at TIMESTAMPTZ;
    v_released_claim_id VARCHAR(26) := NULL;
BEGIN
    -- STEP 0 — tenant guard + actor-identity guard (claiming clinician must
    -- be the calling actor; P-036 R3 JWT-verified-identity analogue).
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'claim_consult_for_review: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;
    IF p_clinician_account_id IS DISTINCT FROM current_actor_account_id() THEN
        RAISE EXCEPTION 'claim_consult_for_review: claiming clinician must be the calling actor'
            USING ERRCODE = '42501';
    END IF;

    -- STEP 1 — per-consult claim lock (BEFORE the transition lock per the
    -- 056/058 lock-order contract).
    v_claim_lock_key := ('x' || substr(md5('consult_review_claim:' || p_tenant_id || ':' || p_consult_id), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_claim_lock_key);

    -- STEP 2 — active-claim check + expired-claim auto-release
    SELECT id, claim_expires_at INTO v_active_claim_id, v_active_expires_at
      FROM public.consult_review_claim
     WHERE tenant_id = p_tenant_id AND consult_id = p_consult_id
       AND released_at IS NULL;

    IF v_active_claim_id IS NOT NULL THEN
        IF v_active_expires_at < now() THEN
            UPDATE public.consult_review_claim
               SET released_at = now(), release_reason = 'claim_expired'
             WHERE tenant_id = p_tenant_id AND id = v_active_claim_id;
            v_released_claim_id := v_active_claim_id;
            -- Handler MUST emit Cat B async_consult.claim_expired_auto_released
            -- (AUDIT_EVENTS v5.11 row 17) using the returned id.
        ELSE
            RAISE EXCEPTION 'claim_already_held: consult already has an active unexpired claim'
                USING ERRCODE = '55006';    -- object_in_use → handler 409
        END IF;
    END IF;

    -- STEP 3 — patient_id lookup (tenant-scoped; tenant-blind failure)
    SELECT patient_id INTO v_patient_id
      FROM public.consult
     WHERE tenant_id = p_tenant_id AND id = p_consult_id;
    IF v_patient_id IS NULL THEN
        RAISE EXCEPTION 'claim_consult_for_review: consult not found'
            USING ERRCODE = 'no_data_found';
    END IF;

    -- STEP 4 — INSERT claim + queued → under_review transition. When the
    -- prior claim was auto-released the consult is still in under_review
    -- (no un-claim transition triple exists); in that case skip the
    -- transition — the new claim row is the ownership record.
    INSERT INTO public.consult_review_claim (
        id, tenant_id, consult_id, patient_id, clinician_account_id, claim_expires_at
    ) VALUES (
        p_claim_id, p_tenant_id, p_consult_id, v_patient_id, p_clinician_account_id, p_claim_expires_at
    );

    IF v_released_claim_id IS NULL THEN
        PERFORM record_consult_lifecycle_transition(
            p_transition_id, p_tenant_id, p_consult_id,
            'under_review', 'clinician_claimed', p_actor_id, p_actor_role, '{}'::jsonb);
    END IF;

    RETURN v_released_claim_id;
END;
$$;

ALTER FUNCTION claim_consult_for_review(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), TEXT
) OWNER TO consult_claim_wrapper_owner;
REVOKE EXECUTE ON FUNCTION claim_consult_for_review(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_consult_for_review(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), TIMESTAMPTZ, VARCHAR(26), VARCHAR(26), TEXT
) TO async_consult_clinician_reviewer;

-- =============================================================================
-- §5 — reassign_consult_claim (P-038 §3 row 7)
--
-- Atomic UPDATE-release-prior + INSERT-new claim under the same advisory
-- lock (P-038 / SI-020 R4 closure). No lifecycle transition — the consult
-- remains under_review; the claim chain records the ownership change.
-- =============================================================================

CREATE OR REPLACE FUNCTION reassign_consult_claim(
    p_new_claim_id            VARCHAR(26),
    p_tenant_id               TEXT,
    p_consult_id              VARCHAR(26),
    p_from_claim_id           VARCHAR(26),
    p_to_clinician_account_id VARCHAR(26),
    p_claim_expires_at        TIMESTAMPTZ
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id TEXT;
    v_claim_lock_key  BIGINT;
    v_patient_id      VARCHAR(26);
    v_rows            INTEGER;
BEGIN
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'reassign_consult_claim: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    v_claim_lock_key := ('x' || substr(md5('consult_review_claim:' || p_tenant_id || ':' || p_consult_id), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_claim_lock_key);

    UPDATE public.consult_review_claim
       SET released_at = now(), release_reason = 'reassigned'
     WHERE tenant_id = p_tenant_id AND id = p_from_claim_id
       AND consult_id = p_consult_id AND released_at IS NULL;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
        RAISE EXCEPTION 'reassign_consult_claim: active claim not found'
            USING ERRCODE = 'no_data_found';
    END IF;

    SELECT patient_id INTO v_patient_id
      FROM public.consult
     WHERE tenant_id = p_tenant_id AND id = p_consult_id;

    INSERT INTO public.consult_review_claim (
        id, tenant_id, consult_id, patient_id, clinician_account_id, claim_expires_at
    ) VALUES (
        p_new_claim_id, p_tenant_id, p_consult_id, v_patient_id, p_to_clinician_account_id, p_claim_expires_at
    );
END;
$$;

ALTER FUNCTION reassign_consult_claim(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TIMESTAMPTZ
) OWNER TO consult_claim_wrapper_owner;
REVOKE EXECUTE ON FUNCTION reassign_consult_claim(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TIMESTAMPTZ
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reassign_consult_claim(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), TIMESTAMPTZ
) TO async_consult_clinician_reviewer, admin_basic_operator;

-- =============================================================================
-- §6 — record_consult_clinician_decision (P-038 §3 row 8; extends SI-005 P-021)
--
-- Atomic: decision INSERT FIRST (056 trigger validates claim under the
-- shared lock) → claim release (decision_recorded) → transition(s):
--   request_more_data → additional_data_requested (under_review → awaiting_data)
--   all others        → decision_recorded (under_review → decision_made)
--                       then the decision-type outcome transition.
-- Deciding-clinician == claiming-clinician enforced twice: 5-column
-- composite FK (056) + actor-identity guard here.
-- =============================================================================

CREATE OR REPLACE FUNCTION record_consult_clinician_decision(
    p_decision_id             VARCHAR(26),
    p_tenant_id               TEXT,
    p_consult_id              VARCHAR(26),
    p_patient_id              VARCHAR(26),
    p_claim_id                VARCHAR(26),
    p_clinician_account_id    VARCHAR(26),
    p_decision_type           TEXT,
    p_agreement               TEXT,
    p_ciphertext              BYTEA,
    p_dek_id                  VARCHAR(26),
    p_iv                      BYTEA,
    p_tag                     BYTEA,
    p_alg                     TEXT,
    p_alg_version             TEXT,
    p_aad                     BYTEA,
    p_encrypted_at            TIMESTAMPTZ,
    p_signals_reviewed_ids    VARCHAR(26)[],
    p_prescription_details_id VARCHAR(26),
    p_referral_target_id      VARCHAR(26),
    p_decision_transition_id  VARCHAR(26),
    p_outcome_transition_id   VARCHAR(26),
    p_actor_id                VARCHAR(26),
    p_actor_role              TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id TEXT;
    v_claim_lock_key  BIGINT;
    v_outcome_reason  TEXT;
    v_outcome_state   TEXT;
BEGIN
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_consult_clinician_decision: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;
    IF p_clinician_account_id IS DISTINCT FROM current_actor_account_id() THEN
        RAISE EXCEPTION 'record_consult_clinician_decision: deciding clinician must be the calling actor'
            USING ERRCODE = '42501';
    END IF;

    -- Claim lock FIRST (lock-order contract), then decision INSERT — the
    -- 056 validate-claim trigger re-acquires the same (re-entrant) lock.
    v_claim_lock_key := ('x' || substr(md5('consult_review_claim:' || p_tenant_id || ':' || p_consult_id), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_claim_lock_key);

    INSERT INTO public.consult_clinician_decision (
        id, tenant_id, consult_id, patient_id, claim_id, clinician_account_id,
        decision_type, agreement_with_ai_recommendation,
        decision_rationale_ciphertext, decision_rationale_kms_envelope_dek_id,
        decision_rationale_kms_envelope_iv, decision_rationale_kms_envelope_tag,
        decision_rationale_kms_envelope_alg, decision_rationale_kms_envelope_alg_version,
        decision_rationale_kms_envelope_aad, decision_rationale_kms_envelope_encrypted_at,
        interaction_signals_reviewed_ids, prescription_details_id, referral_target_id
    ) VALUES (
        p_decision_id, p_tenant_id, p_consult_id, p_patient_id, p_claim_id, p_clinician_account_id,
        p_decision_type, p_agreement,
        p_ciphertext, p_dek_id, p_iv, p_tag, p_alg, p_alg_version, p_aad, p_encrypted_at,
        p_signals_reviewed_ids, p_prescription_details_id, p_referral_target_id
    );

    -- One-way claim release (decision recorded)
    UPDATE public.consult_review_claim
       SET released_at = now(), release_reason = 'decision_recorded'
     WHERE tenant_id = p_tenant_id AND id = p_claim_id AND released_at IS NULL;

    IF p_decision_type = 'request_more_data' THEN
        PERFORM record_consult_lifecycle_transition(
            p_decision_transition_id, p_tenant_id, p_consult_id,
            'awaiting_data', 'additional_data_requested', p_actor_id, p_actor_role, '{}'::jsonb);
    ELSE
        PERFORM record_consult_lifecycle_transition(
            p_decision_transition_id, p_tenant_id, p_consult_id,
            'decision_made', 'decision_recorded', p_actor_id, p_actor_role, '{}'::jsonb);
        v_outcome_reason := CASE p_decision_type
            WHEN 'prescribe'        THEN 'prescribed_outcome'
            WHEN 'recommend'        THEN 'advised_outcome'
            WHEN 'refer'            THEN 'referred_outcome'
            WHEN 'decline'          THEN 'declined_outcome'
            WHEN 'escalate_to_sync' THEN 'escalated_to_sync_outcome'
        END;
        v_outcome_state := CASE p_decision_type
            WHEN 'prescribe'        THEN 'prescribed'
            WHEN 'recommend'        THEN 'advised'
            WHEN 'refer'            THEN 'referred'
            WHEN 'decline'          THEN 'declined'
            WHEN 'escalate_to_sync' THEN 'escalated_to_sync'
        END;
        IF v_outcome_reason IS NULL THEN
            RAISE EXCEPTION 'record_consult_clinician_decision: unknown decision_type %', p_decision_type
                USING ERRCODE = 'check_violation';
        END IF;
        PERFORM record_consult_lifecycle_transition(
            p_outcome_transition_id, p_tenant_id, p_consult_id,
            v_outcome_state, v_outcome_reason, p_actor_id, p_actor_role, '{}'::jsonb);
    END IF;
END;
$$;

ALTER FUNCTION record_consult_clinician_decision(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT, TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, VARCHAR(26)[], VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT
) OWNER TO record_consult_decision_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_consult_clinician_decision(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT, TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, VARCHAR(26)[], VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_consult_clinician_decision(
    VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT, TEXT, BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ, VARCHAR(26)[], VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), VARCHAR(26), TEXT
) TO async_consult_clinician_reviewer;

-- =============================================================================
-- §7 — Verification
-- =============================================================================

DO $$
DECLARE
    v_fn      TEXT;
    v_fns     TEXT[] := ARRAY[
        'record_consult_initiation',
        'record_consult_intake_submission',
        'record_consult_ai_preparation_completed',
        'claim_consult_for_review',
        'reassign_consult_claim',
        'record_consult_clinician_decision'
    ];
    v_owners  TEXT[] := ARRAY[
        'consult_initiation_wrapper_owner',
        'consult_intake_wrapper_owner',
        'consult_ai_preparation_wrapper_owner',
        'consult_claim_wrapper_owner',
        'consult_claim_wrapper_owner',
        'record_consult_decision_wrapper_owner'
    ];
    v_owner   TEXT;
    v_secdef  BOOLEAN;
    i         INTEGER;
BEGIN
    FOR i IN 1..array_length(v_fns, 1) LOOP
        SELECT r.rolname, p.prosecdef INTO v_owner, v_secdef
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.proname = v_fns[i]
           AND p.pronamespace = 'public'::regnamespace;
        IF v_owner IS NULL THEN
            RAISE EXCEPTION 'migration-059-verification: wrapper % not found', v_fns[i]
                USING ERRCODE = 'undefined_function';
        END IF;
        IF v_owner <> v_owners[i] THEN
            RAISE EXCEPTION 'migration-059-verification: wrapper % owner is % but MUST be %',
                v_fns[i], v_owner, v_owners[i]
                USING ERRCODE = 'check_violation';
        END IF;
        IF NOT v_secdef THEN
            RAISE EXCEPTION 'migration-059-verification: wrapper % is not SECURITY DEFINER', v_fns[i]
                USING ERRCODE = 'check_violation';
        END IF;
    END LOOP;
END $$;
