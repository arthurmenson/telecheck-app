-- =============================================================================
-- rollback/071_rollback.sql — unwind 071_crisis_sweep_wrapper_out_param_ambiguity_fix
--
-- Restores the migration 053 §7 body of
-- `execute_crisis_no_acknowledgement_sweep()` VERBATIM — including the
-- latent 42702 OUT-param/column ambiguity that 071 fixed. Rollback means
-- chain-consistency (the DB state equals "through 070"), not "keep the
-- fix": a rolled-back 071 leaves the sweep endpoint failing with 500 on
-- every call, exactly as it did before 071. Do not roll back unless you
-- are rolling the whole chain past 053's sweep semantics.
--
-- NOTE: crisis_sweep_execution rows written while 071 was live are NOT
-- touched — the table is durable per I-035 + R52 audit-trail discipline;
-- rollback of DDL never implies destruction of committed rows.
-- =============================================================================

CREATE OR REPLACE FUNCTION execute_crisis_no_acknowledgement_sweep(
    p_tenant_id                     TEXT,
    p_crisis_event_id               UUID,
    p_target_obligation_generation  INTEGER,
    p_worker_id                     TEXT,
    p_claim_ttl_seconds             INTEGER DEFAULT 60
)
RETURNS TABLE (
    sweep_execution_id   UUID,
    fencing_token        BIGINT,
    outcome              TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     TEXT;    -- SI-025 P-045: was UUID; no ::UUID cast
    v_actor_tenant_id        TEXT;
    v_latest_to_state        TEXT;
    v_to_state               TEXT;
    v_transition_reason      TEXT;
    v_sweep_row              RECORD;
    v_existing_sweep_id      UUID;
    v_returning_sweep_id     UUID;
    v_returning_fencing      BIGINT;
    v_returning_outcome      TEXT;
BEGIN
    -- LAYER B — bind actor (sweep scheduler worker).
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: no actor account bound'
            USING ERRCODE = '42501';
    END IF;
    -- SI-025 P-045: assign TEXT directly; no ::UUID cast.
    v_actor_principal_id := v_actor_account_id_text;

    -- LAYER C — tenant scope.
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: no actor tenant bound'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    IF p_claim_ttl_seconds <= 0 OR p_claim_ttl_seconds > 600 THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: p_claim_ttl_seconds % out of range [1, 600]', p_claim_ttl_seconds
            USING ERRCODE = '22023';  -- invalid_parameter_value
    END IF;

    -- Parent-row lock — serializes concurrent sweep workers + acknowledgement/
    -- response/resolution wrappers for the same crisis_event.
    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: crisis_event % not found for tenant %', p_crisis_event_id, p_tenant_id
            USING ERRCODE = '02000';
    END IF;

    -- §1.1 — Claim or take-over phase (053 §7 body verbatim).
    SELECT cse.sweep_execution_id, cse.fencing_token
      INTO v_existing_sweep_id, v_returning_fencing
      FROM public.crisis_sweep_execution cse
     WHERE cse.tenant_id = p_tenant_id
       AND cse.crisis_event_id = p_crisis_event_id
       AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
       AND cse.completed_at IS NOT NULL
     ORDER BY cse.completed_at DESC, cse.sweep_execution_id DESC
     LIMIT 1;
    IF v_existing_sweep_id IS NOT NULL THEN
        sweep_execution_id := v_existing_sweep_id;
        fencing_token      := v_returning_fencing;
        outcome            := 'already_completed';
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT sweep_execution_id, claimed_by_worker_id, claim_expires_at, fencing_token, completed_at
      INTO v_sweep_row
      FROM public.crisis_sweep_execution
     WHERE tenant_id = p_tenant_id
       AND crisis_event_id = p_crisis_event_id
       AND scheduled_for_obligation_generation = p_target_obligation_generation
       AND completed_at IS NULL    -- only open rows; partial UNIQUE index allows at most one
     FOR UPDATE;

    IF FOUND THEN
        -- Another worker may hold a valid lease.
        IF v_sweep_row.claim_expires_at IS NOT NULL
           AND v_sweep_row.claim_expires_at >= now()
           AND v_sweep_row.claimed_by_worker_id IS DISTINCT FROM p_worker_id THEN
            RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: sweep_execution_id % for crisis_event % gen % currently leased by worker % until %; retry after expiry',
                v_sweep_row.sweep_execution_id, p_crisis_event_id, p_target_obligation_generation,
                v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                USING ERRCODE = '40001';
        END IF;

        -- Take over the lease (claim expired, or same worker reclaiming).
        UPDATE public.crisis_sweep_execution
           SET claimed_by_worker_id = p_worker_id,
               claim_expires_at     = now() + (p_claim_ttl_seconds || ' seconds')::INTERVAL,
               fencing_token        = v_sweep_row.fencing_token + 1,
               heartbeat_at         = now()
         WHERE sweep_execution_id = v_sweep_row.sweep_execution_id
         RETURNING sweep_execution_id, fencing_token
              INTO v_returning_sweep_id, v_returning_fencing;
        v_returning_outcome := 'claimed_takeover';
    ELSE
        BEGIN
            INSERT INTO public.crisis_sweep_execution (
                tenant_id, crisis_event_id, scheduled_at,
                scheduled_for_obligation_generation,
                claimed_by_worker_id, claim_expires_at,
                fencing_token, heartbeat_at
            ) VALUES (
                p_tenant_id, p_crisis_event_id, now(),
                p_target_obligation_generation,
                p_worker_id, now() + (p_claim_ttl_seconds || ' seconds')::INTERVAL,
                1,    -- initial fencing_token
                now()
            )
            RETURNING crisis_sweep_execution.sweep_execution_id, crisis_sweep_execution.fencing_token
                 INTO v_returning_sweep_id, v_returning_fencing;
            v_returning_outcome := 'claimed_new';
        EXCEPTION
            WHEN unique_violation THEN
                DECLARE
                    v_constraint_name TEXT;
                BEGIN
                    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
                    IF v_constraint_name IS DISTINCT FROM 'crisis_sweep_execution_open_uk' THEN
                        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: unexpected unique_violation on constraint %; not the canonical first-claim race; preserving original failure',
                            v_constraint_name
                            USING ERRCODE = '23505';  -- canonical unique_violation
                    END IF;
                END;

                SELECT cse.sweep_execution_id, cse.fencing_token, cse.claimed_by_worker_id, cse.claim_expires_at
                  INTO v_returning_sweep_id, v_returning_fencing,
                       v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                  FROM public.crisis_sweep_execution cse
                 WHERE cse.tenant_id = p_tenant_id
                   AND cse.crisis_event_id = p_crisis_event_id
                   AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
                   AND cse.completed_at IS NULL;
                IF FOUND THEN
                    RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: concurrent first-claim race lost; sweep_execution_id % currently leased by worker % until %; retry after expiry',
                        v_returning_sweep_id, v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                        USING ERRCODE = '40001';
                END IF;

                SELECT cse.sweep_execution_id, cse.fencing_token
                  INTO v_returning_sweep_id, v_returning_fencing
                  FROM public.crisis_sweep_execution cse
                 WHERE cse.tenant_id = p_tenant_id
                   AND cse.crisis_event_id = p_crisis_event_id
                   AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
                   AND cse.completed_at IS NOT NULL
                 ORDER BY cse.completed_at DESC, cse.sweep_execution_id DESC
                 LIMIT 1;
                IF v_returning_sweep_id IS NOT NULL THEN
                    sweep_execution_id := v_returning_sweep_id;
                    fencing_token      := v_returning_fencing;
                    outcome            := 'already_completed';
                    RETURN NEXT;
                    RETURN;
                END IF;

                RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: unique_violation re-read found no colliding row — invariant violation; investigate sweep_execution data integrity'
                    USING ERRCODE = 'XX000';  -- internal_error
        END;
    END IF;

    -- §1.2 — Lifecycle emission phase.
    SELECT to_state
      INTO v_latest_to_state
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    IF v_latest_to_state = 'detected' THEN
        v_to_state := 'escalated';
        v_transition_reason := 'no_acknowledgement_timeout';
    ELSIF v_latest_to_state = 'escalated' THEN
        v_to_state := 'escalated';
        v_transition_reason := 'tier_progression_no_acknowledgement';
    ELSE
        UPDATE public.crisis_sweep_execution
           SET completed_at             = now(),
               sweep_cycle_id_committed = v_returning_fencing,    -- using fencing_token as cycle id
               heartbeat_at             = now()
         WHERE sweep_execution_id = v_returning_sweep_id
           AND fencing_token       = v_returning_fencing;          -- guard against takeover during processing

        IF NOT FOUND THEN
            RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: lease lost during processing; another worker may have taken over sweep_execution_id %',
                v_returning_sweep_id
                USING ERRCODE = '40001';
        END IF;

        sweep_execution_id := v_returning_sweep_id;
        fencing_token      := v_returning_fencing;
        outcome            := 'completed_no_op';
        RETURN NEXT;
        RETURN;
    END IF;

    -- Emit escalation transition via raw writer.
    PERFORM public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        p_crisis_event_id,
        v_latest_to_state,
        v_to_state,
        v_transition_reason,
        v_actor_principal_id,   -- TEXT per SI-025 P-045
        NULL  -- transition_payload
    );

    -- §1.3 — STEP F atomic completion.
    UPDATE public.crisis_sweep_execution
       SET completed_at             = now(),
           sweep_cycle_id_committed = v_returning_fencing,
           heartbeat_at             = now()
     WHERE sweep_execution_id = v_returning_sweep_id
       AND fencing_token       = v_returning_fencing;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: lease lost during processing; another worker may have taken over sweep_execution_id %',
            v_returning_sweep_id
            USING ERRCODE = '40001';
    END IF;

    sweep_execution_id := v_returning_sweep_id;
    fencing_token      := v_returning_fencing;
    outcome            := 'completed_escalated';
    RETURN NEXT;
    RETURN;
END;
$$;

COMMENT ON FUNCTION execute_crisis_no_acknowledgement_sweep(TEXT, UUID, INTEGER, TEXT, INTEGER) IS
    'P-040 §4.NEW3 + SI-022 sweep wrapper — migration 053 §7 body restored by '
    'rollback/071_rollback.sql (the 42702 OUT-param ambiguity is present again; '
    'sweep calls will fail until 071 is re-applied).';
