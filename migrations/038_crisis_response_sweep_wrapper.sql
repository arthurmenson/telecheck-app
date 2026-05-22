-- =============================================================================
-- File:    migrations/038_crisis_response_sweep_wrapper.sql
-- Purpose: Create the canonical no-acknowledgement sweep SECDEF wrapper
--          `execute_crisis_no_acknowledgement_sweep()` per P-040 §3.6 +
--          SI-022 Sub-decision 4 + Sub-decision 6 sweep-execution semantics.
--
--          PR 6 of the Crisis Response implementation series. Final SECDEF
--          wrapper. PR 7 is the Fastify module + routes + integration tests.
--
--          The sweep wrapper:
--          1. Claims an open crisis_sweep_execution row for the target
--             (tenant_id, crisis_event_id, obligation_generation) OR
--             takes over an expired lease.
--          2. Atomically advances the fencing_token (monotonic per-takeover).
--          3. Reads latest lifecycle state under the FOR UPDATE lock on
--             the parent crisis_event row.
--          4. Emits the appropriate escalation transition based on current
--             state:
--             - detected → escalated (no_acknowledgement_timeout)
--             - escalated → escalated (tier_progression_no_acknowledgement)
--             Other states are no-ops (acknowledged/responded/resolved
--             do not warrant no-ack escalation; sweep returns the existing
--             open sweep id without emitting a transition).
--          5. STEP F atomic completion: completed_at + sweep_cycle_id_committed
--             set in the same UPDATE; terminal-row-immutable trigger blocks
--             further mutation.
--
--          Lease takeover safety: the canonical lease pattern is "claim
--          row WHERE claim_expires_at IS NULL OR claim_expires_at < now()".
--          The atomic claim INCREMENTS fencing_token so any in-flight prior
--          worker's writes (using the old token) can be detected + rejected.
--          For v1.0 the SQL wrapper enforces the claim-then-commit invariant
--          at the row layer; the actual fencing-token verification on
--          downstream writes (provider_attempt rows, etc.) lives in the
--          application layer.
--
--          PER OPTION 2 ADAPTATION:
--          - Actor identity bound from SI-010 (same pattern as PR 4-5);
--            sweep workers must have authContextPlugin context bound to the
--            crisis_sweep_scheduler role
--          - LAYER C tenant scope match
--          - SELECT FOR UPDATE on parent crisis_event row
--          - Audit emission for Cat A crisis.no_acknowledgement_escalation
--            deferred to application layer
--
-- Spec:    - SI-022 Crisis Response Slice v1.0 Sub-decision 4 + Sub-decision 6
--          - CDM v1.9 → v1.10 Amendment §3.6 (canonical wrapper signature)
--          - State Machines v1.1 §3 transitions (triples #2 detected→escalated +
--            #3 escalated→escalated)
--          - I-019 (crisis-detection-always-on platform-floor; sweep is the
--            background mechanism that prevents undetected crisis events
--            from stagnating in detected state)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS: migrations 032-037 applied. crisis_sweep_execution table +
--                terminal-row-immutable trigger + partial UNIQUE index from
--                migration 033 §7.
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — execute_crisis_no_acknowledgement_sweep()
--
-- Signature:
--   p_tenant_id                            TEXT
--   p_crisis_event_id                      UUID
--   p_target_obligation_generation         INTEGER  (generation # the sweep
--                                                    is executing; monotonic per
--                                                    crisis_event; matches R52
--                                                    partial UNIQUE on open rows)
--   p_worker_id                            TEXT     (worker process identity;
--                                                    recorded in claimed_by_worker_id)
--   p_claim_ttl_seconds                    INTEGER  (lease duration; recorded as
--                                                    claim_expires_at = now() + p_claim_ttl_seconds)
--
-- Returns: RECORD (sweep_execution_id UUID, fencing_token BIGINT, outcome TEXT)
--   - outcome: 'claimed_new'        — first claim of a brand-new sweep row
--   - outcome: 'claimed_takeover'   — took over an expired-lease open row
--   - outcome: 'completed_no_op'    — current state is not detected/escalated; nothing to escalate
--   - outcome: 'completed_escalated' — escalation transition was emitted; sweep marked completed
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
    v_actor_principal_id     UUID;
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
    BEGIN
        v_actor_principal_id := v_actor_account_id_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: bound actor account_id % is not a valid UUID', v_actor_account_id_text
            USING ERRCODE = '42501';
    END;

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

    -- =====================================================================
    -- §1.1 — Claim or take-over phase
    --
    -- Try to find an open sweep_execution row for this (tenant, event, generation).
    -- - If exists with claim_expires_at >= now() AND claimed_by_worker_id <> p_worker_id:
    --     another worker holds a valid lease; reject this attempt (40001 retry-safe).
    -- - If exists with claim_expires_at < now() OR claim_expires_at IS NULL:
    --     take over by UPDATEing claimed_by_worker_id + claim_expires_at +
    --     incrementing fencing_token.
    -- - If no row exists: INSERT a new claim with fencing_token = 1.
    -- =====================================================================

    -- R1 HIGH-1 closure 2026-05-22: idempotent replay guard for already-
    -- completed sweep. A retry after successful completion (or a scheduler
    -- redelivery of the same generation) must NOT mint a new open row that
    -- would emit a duplicate escalation. Return the existing completed
    -- sweep's info with outcome='already_completed' instead.
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
        -- New claim: insert a fresh row.
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
    END IF;

    -- =====================================================================
    -- §1.2 — Lifecycle emission phase
    --
    -- Read latest lifecycle state under the parent FOR UPDATE lock. The
    -- sweep escalates ONLY if current state is detected or escalated.
    -- Other states (acknowledged/responded/resolved) are no-ops — the
    -- sweep simply commits with outcome 'completed_no_op'.
    -- =====================================================================

    SELECT to_state
      INTO v_latest_to_state
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    IF v_latest_to_state = 'detected' THEN
        -- Triple #2 — detected → escalated (no_acknowledgement_timeout)
        v_to_state := 'escalated';
        v_transition_reason := 'no_acknowledgement_timeout';
    ELSIF v_latest_to_state = 'escalated' THEN
        -- Triple #3 — escalated → escalated (tier_progression_no_acknowledgement)
        v_to_state := 'escalated';
        v_transition_reason := 'tier_progression_no_acknowledgement';
    ELSE
        -- Latest is acknowledged/responded/resolved (or NULL — shouldn't happen
        -- post-initiation but treat defensively). No escalation; mark sweep
        -- completed with no-op outcome.
        UPDATE public.crisis_sweep_execution
           SET completed_at             = now(),
               sweep_cycle_id_committed = v_returning_fencing,    -- using fencing_token as cycle id
               heartbeat_at             = now()
         WHERE sweep_execution_id = v_returning_sweep_id
           AND fencing_token       = v_returning_fencing;          -- guard against takeover during processing

        IF NOT FOUND THEN
            -- Another worker took over since our claim; abort.
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
        v_actor_principal_id,
        NULL  -- transition_payload
    );

    -- =====================================================================
    -- §1.3 — STEP F atomic completion
    --
    -- Set completed_at + sweep_cycle_id_committed in a single UPDATE,
    -- guarded by fencing_token to detect lease-takeover races. If the
    -- UPDATE affects zero rows, another worker took over our claim
    -- during processing and we must abort without committing.
    -- =====================================================================

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

-- =============================================================================
-- §2 — Function ownership + sweep_wrapper_owner role grants
-- =============================================================================

ALTER FUNCTION execute_crisis_no_acknowledgement_sweep(TEXT, UUID, INTEGER, TEXT, INTEGER)
    OWNER TO crisis_sweep_wrapper_owner;

-- sweep_wrapper_owner needs:
-- - SELECT + UPDATE on crisis_event (SELECT FOR UPDATE parent row)
-- - INSERT + SELECT + UPDATE on crisis_sweep_execution (claim + take-over + STEP F)
-- - SELECT on crisis_event_lifecycle_transition (latest-state read)
-- - EXECUTE on SI-010 helpers
-- - EXECUTE on raw writer (granted at migration 035 §3 — verified below)
GRANT SELECT, UPDATE ON crisis_event                       TO crisis_sweep_wrapper_owner;
GRANT INSERT, SELECT, UPDATE ON crisis_sweep_execution     TO crisis_sweep_wrapper_owner;
GRANT SELECT ON crisis_event_lifecycle_transition          TO crisis_sweep_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id()        TO crisis_sweep_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO crisis_sweep_wrapper_owner;

-- =============================================================================
-- §3 — Anti-bypass: EXECUTE granted ONLY to crisis_sweep_scheduler app role
-- =============================================================================

REVOKE EXECUTE ON FUNCTION execute_crisis_no_acknowledgement_sweep(TEXT, UUID, INTEGER, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION execute_crisis_no_acknowledgement_sweep(TEXT, UUID, INTEGER, TEXT, INTEGER) TO crisis_sweep_scheduler;

COMMENT ON FUNCTION execute_crisis_no_acknowledgement_sweep(TEXT, UUID, INTEGER, TEXT, INTEGER) IS
    'P-040 §3.6 + SI-022 Sub-decision 4 + Sub-decision 6 no-acknowledgement sweep wrapper. '
    'SECDEF + lease-takeover semantics + fencing-token + STEP F atomic completion. '
    'Application-layer sweep scheduler invokes this with target obligation generation; '
    'wrapper claims/takes-over the sweep row, emits escalation if current state warrants, '
    'and commits completion guarded by fencing_token race detection. Audit emission for '
    'Cat A crisis.no_acknowledgement_escalation deferred to application layer.';

-- =============================================================================
-- §4 — Verification
-- =============================================================================

DO $$
DECLARE
    v_target_oid OID := to_regprocedure(
        'public.execute_crisis_no_acknowledgement_sweep(text, uuid, integer, text, integer)'
    );
    v_owner TEXT;
    v_secdef BOOLEAN;
    v_proconfig TEXT[];
    v_specific TEXT;
    v_grant_count INTEGER;
BEGIN
    IF v_target_oid IS NULL THEN
        RAISE EXCEPTION 'migration-038-function-missing: execute_crisis_no_acknowledgement_sweep() not found by signature';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig, p.proname || '_' || p.oid::TEXT
      INTO v_owner, v_secdef, v_proconfig, v_specific
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_target_oid;

    IF v_owner <> 'crisis_sweep_wrapper_owner' THEN
        RAISE EXCEPTION 'migration-038-ownership-mismatch: owner is % but MUST be crisis_sweep_wrapper_owner', v_owner;
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION 'migration-038-security-definer-missing';
    END IF;
    IF v_proconfig IS NULL OR NOT (v_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION 'migration-038-search-path-not-locked: proconfig=%', v_proconfig;
    END IF;

    -- EXECUTE: exactly 1 application-role grantee (crisis_sweep_scheduler), excluding owner-self
    SELECT COUNT(*) INTO v_grant_count
      FROM information_schema.role_routine_grants
     WHERE specific_name = v_specific AND privilege_type = 'EXECUTE' AND grantee <> 'crisis_sweep_wrapper_owner';
    IF v_grant_count <> 1 THEN
        RAISE EXCEPTION 'migration-038-execute-grant-count: expected 1, found %', v_grant_count;
    END IF;
    PERFORM 1 FROM information_schema.role_routine_grants
     WHERE specific_name = v_specific AND privilege_type = 'EXECUTE' AND grantee = 'crisis_sweep_scheduler';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration-038-grant-missing: crisis_sweep_scheduler EXECUTE';
    END IF;
    PERFORM 1 FROM information_schema.role_routine_grants
     WHERE specific_name = v_specific AND privilege_type = 'EXECUTE' AND grantee = 'PUBLIC';
    IF FOUND THEN
        RAISE EXCEPTION 'migration-038-anti-bypass: PUBLIC has EXECUTE';
    END IF;

    -- Wrapper-owner privilege assertions
    IF NOT has_table_privilege('crisis_sweep_wrapper_owner', 'public.crisis_event', 'SELECT') THEN
        RAISE EXCEPTION 'migration-038-table-grant-missing: SELECT on crisis_event';
    END IF;
    IF NOT has_table_privilege('crisis_sweep_wrapper_owner', 'public.crisis_event', 'UPDATE') THEN
        RAISE EXCEPTION 'migration-038-table-grant-missing: UPDATE on crisis_event (for FOR UPDATE lock)';
    END IF;
    IF NOT has_table_privilege('crisis_sweep_wrapper_owner', 'public.crisis_sweep_execution', 'INSERT')
       OR NOT has_table_privilege('crisis_sweep_wrapper_owner', 'public.crisis_sweep_execution', 'SELECT')
       OR NOT has_table_privilege('crisis_sweep_wrapper_owner', 'public.crisis_sweep_execution', 'UPDATE') THEN
        RAISE EXCEPTION 'migration-038-table-grant-missing: INSERT/SELECT/UPDATE on crisis_sweep_execution';
    END IF;
    IF NOT has_table_privilege('crisis_sweep_wrapper_owner', 'public.crisis_event_lifecycle_transition', 'SELECT') THEN
        RAISE EXCEPTION 'migration-038-table-grant-missing: SELECT on crisis_event_lifecycle_transition';
    END IF;
    IF NOT has_function_privilege('crisis_sweep_wrapper_owner', 'public.current_actor_account_id()', 'EXECUTE')
       OR NOT has_function_privilege('crisis_sweep_wrapper_owner', 'public.current_actor_account_tenant_id()', 'EXECUTE') THEN
        RAISE EXCEPTION 'migration-038-helper-grant-missing';
    END IF;
    -- Defensive cross-migration: raw writer EXECUTE
    IF NOT has_function_privilege(
        'crisis_sweep_wrapper_owner',
        'public.record_crisis_event_lifecycle_transition(text, uuid, text, text, text, uuid, jsonb)',
        'EXECUTE'
    ) THEN
        RAISE EXCEPTION 'migration-038-raw-writer-grant-missing: migration 035 §3 grant matrix may have drifted';
    END IF;
END $$;
