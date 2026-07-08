-- =============================================================================
-- rollback/070_rollback.sql — unwind 070_med_interaction_override_evidence_unlock
--
-- Restores the migration 050 §6 fail-closed posture: the override wrapper
-- body goes back to the R1-closure 0A000 stub (RAISE before any write;
-- INSERT + PERFORM isolated in the R2-closure block comment), and the §2
-- evidence-read grants are revoked from the wrapper owner. The Fastify
-- handler's wrapper-rejection mappings resume surfacing the fail-closed
-- state (fail-closed by design).
--
-- NOTE: rows written while 070 was live are NOT touched —
-- interaction_signal_override + interaction_signal_lifecycle_transition
-- are strict append-only per I-035; rollback of DDL never implies
-- destruction of committed clinical evidence.
-- =============================================================================

-- §1 unwind — restore the 050 §6 fail-closed body verbatim.

CREATE OR REPLACE FUNCTION record_interaction_signal_override(
    p_override_id                                VARCHAR(26),
    p_lifecycle_transition_id                    VARCHAR(26),
    p_tenant_id                                  TEXT,
    p_signal_id                                  VARCHAR(26),
    p_clinician_account_id                       VARCHAR(26),
    p_override_rationale_kms_envelope_ciphertext BYTEA,
    p_override_rationale_kms_envelope_dek_id     VARCHAR(26),
    p_override_rationale_kms_envelope_iv         BYTEA,
    p_override_rationale_kms_envelope_tag        BYTEA,
    p_override_rationale_kms_envelope_alg        TEXT,
    p_override_rationale_kms_envelope_alg_version TEXT,
    p_override_rationale_kms_envelope_aad        BYTEA,
    p_override_rationale_kms_envelope_encrypted_at TIMESTAMPTZ,
    p_metadata                                   JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id  TEXT;
    v_lock_key         BIGINT;
    v_latest_to_state  TEXT;
BEGIN
    -- STEP 0: SI-010 tenant guard
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_interaction_signal_override: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    -- STEP 4.5: per-(tenant, signal) advisory lock (MUST match raw writer's
    -- lock key per PR 4 R1 closure contract — serializes override creation
    -- with activation decisions).
    v_lock_key := ('x' || substr(md5(p_tenant_id::text || ':' || p_signal_id::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Evidence: signal's current state is 'active' (only active signals can be overridden).
    SELECT to_state INTO v_latest_to_state
      FROM public.interaction_signal_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND signal_id = p_signal_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;
    IF v_latest_to_state IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'signal_not_active: current_state=%', COALESCE(v_latest_to_state, '<none>')
            USING ERRCODE = '23514';
    END IF;

    -- R1 HIGH-1 closure 2026-05-23 (Codex R1): FAIL-CLOSED (restored by
    -- rollback of migration 070).
    RAISE EXCEPTION
        'evidence_check_unavailable_override: '
        'SI-019 §6.NEW7 requires (a) medication-still-on-active-list '
        'check (Pharmacy active-medication-list view not yet in code '
        'repo) AND (b) LAYER B clinician role-membership check '
        '(SI-024.1 JWT-binding deferred). Wrapper fail-closed per Codex '
        'R1 closure 2026-05-23 to prevent unverified terminal override '
        'writes; PR 6+ application-layer evidence checks + LAYER B '
        'authorization re-enables this wrapper.'
        USING ERRCODE = '0A000';    -- feature_not_supported

    /*
    -- UNREACHABLE (preserved for structural completeness; the closure
    -- pattern is documented in migration 050 §6 — all three steps in the
    -- same migration):

    INSERT INTO public.interaction_signal_override (
        id, tenant_id, signal_id,
        override_by_clinician_account_id,
        override_at,
        override_rationale_kms_envelope_ciphertext,
        override_rationale_kms_envelope_dek_id,
        override_rationale_kms_envelope_iv,
        override_rationale_kms_envelope_tag,
        override_rationale_kms_envelope_alg,
        override_rationale_kms_envelope_alg_version,
        override_rationale_kms_envelope_aad,
        override_rationale_kms_envelope_encrypted_at
    ) VALUES (
        p_override_id, p_tenant_id, p_signal_id,
        p_clinician_account_id,
        clock_timestamp(),
        p_override_rationale_kms_envelope_ciphertext,
        p_override_rationale_kms_envelope_dek_id,
        p_override_rationale_kms_envelope_iv,
        p_override_rationale_kms_envelope_tag,
        p_override_rationale_kms_envelope_alg,
        p_override_rationale_kms_envelope_alg_version,
        p_override_rationale_kms_envelope_aad,
        p_override_rationale_kms_envelope_encrypted_at
    );

    PERFORM record_interaction_signal_lifecycle_transition(
        p_lifecycle_transition_id, p_tenant_id, p_signal_id,
        'overridden', 'override',
        p_clinician_account_id, 'clinician',
        p_metadata || jsonb_build_object('override_id', p_override_id)
    );
    */
END;
$$;

-- §2 unwind — evidence-read grants back to the pre-unlock posture.
REVOKE SELECT ON interaction_signal            FROM override_wrapper_owner;
REVOKE SELECT ON interaction_engine_evaluation FROM override_wrapper_owner;
REVOKE SELECT ON medication_requests           FROM override_wrapper_owner;
REVOKE SELECT ON accounts                      FROM override_wrapper_owner;
