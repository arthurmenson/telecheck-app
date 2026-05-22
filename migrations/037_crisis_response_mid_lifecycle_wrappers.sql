-- =============================================================================
-- File:    migrations/037_crisis_response_mid_lifecycle_wrappers.sql
-- Purpose: Create the 3 mid-lifecycle SECURITY DEFINER wrappers per P-040
--          §3.3 + §3.4 + §3.5 + SI-022 Sub-decision 4:
--
--          - record_crisis_acknowledgement_claim() — clinician claims a
--            detected/escalated crisis event (transition reasons:
--            'clinician_acknowledgement' from detected OR escalated → acknowledged)
--          - record_crisis_response()              — clinician records first-
--            response (clinician_response: acknowledged → responded)
--          - record_crisis_resolution()            — clinician resolves
--            (clinician_resolution: responded OR escalated → resolved)
--
--          PR 5 of the Crisis Response implementation series. All 3 wrappers
--          share the same closure-of-defects pattern from PR 4:
--          - Actor identity bound from SI-010 internally; caller cannot forge
--          - SI-010 helper EXECUTE grants on wrapper-owner roles
--          - LAYER C tenant scope match
--          - SELECT FOR UPDATE on crisis_event for lifecycle-write serialization
--          - Latest-state derived under lock + validated against expected
--            from-state set (each wrapper has a specific allowed set)
--          - Natural idempotency via state-machine CHECK constraint
--            (a retry of "acknowledge" on an already-acknowledged event
--             attempts acknowledged→acknowledged which the CHECK rejects;
--             but to be retry-safe we detect this case + return early)
--
--          Per Option 2 carryforward: tenant_id TEXT; SI-010 actor helpers;
--          per-function-owner-level SI-010 helper EXECUTE grants; audit
--          emission deferred to application layer.
--
-- Spec:    - SI-022 Crisis Response Slice v1.0 Sub-decision 4
--          - CDM v1.9 → v1.10 Amendment §3.3 + §3.4 + §3.5
--          - I-035 (append-only via raw writer)
--          - State Machines v1.1 §3 transitions (11 triples enforced at
--            crisis_event_lifecycle_transition CHECK constraint)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS: migrations 032-036 applied. The 3 wrapper-owner roles
--                created at migration 032 must exist. SI-010 actor helpers
--                from migration 031 must exist.
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — record_crisis_acknowledgement_claim()
--
-- A clinician (or care-team member) claims a detected/escalated crisis event,
-- transitioning it to acknowledged. The wrapper:
-- 1. Binds actor identity from SI-010
-- 2. Validates LAYER C tenant scope
-- 3. Acquires SELECT FOR UPDATE on the crisis_event row
-- 4. Reads latest lifecycle state under lock
-- 5. If latest.to_state already = 'acknowledged' AND actor matches → idempotent replay
-- 6. Else validates latest.to_state IN ('detected', 'escalated')
-- 7. Calls raw writer to insert acknowledged transition
-- =============================================================================

CREATE OR REPLACE FUNCTION record_crisis_acknowledgement_claim(
    p_tenant_id           TEXT,
    p_crisis_event_id     UUID,
    p_transition_payload  JSONB DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     UUID;
    v_actor_tenant_id        TEXT;
    v_latest_to_state        TEXT;
    v_latest_actor           UUID;
    v_transition_id          BIGINT;
BEGIN
    -- LAYER B — bind actor identity from SI-010 (caller cannot forge).
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: no actor account bound'
            USING ERRCODE = '42501';
    END IF;
    BEGIN
        v_actor_principal_id := v_actor_account_id_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: bound actor account_id % is not a valid UUID', v_actor_account_id_text
            USING ERRCODE = '42501';
    END;

    -- LAYER C — tenant scope match.
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: no actor tenant bound'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: tenant scope mismatch — actor tenant % vs wrapper p_tenant_id %',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    -- SELECT FOR UPDATE on parent crisis_event row — serializes concurrent
    -- mid-lifecycle wrapper calls for the same crisis_event. The advisory
    -- lock at the lifecycle_transition monotonic-ordering trigger is a
    -- second layer (per-event hash-key); the row lock here is the primary
    -- serialization point + matches the canonical P-040 pattern.
    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: crisis_event % not found for tenant %', p_crisis_event_id, p_tenant_id
            USING ERRCODE = '02000';  -- no_data
    END IF;

    -- Read latest lifecycle state under lock.
    SELECT to_state, actor_principal_id
      INTO v_latest_to_state, v_latest_actor
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    -- Idempotent replay: if latest is already acknowledged BY THIS ACTOR,
    -- treat as canonical replay + return the latest transition id without
    -- inserting a duplicate. Latest acknowledged by ANOTHER actor is a
    -- race condition where another claimer won — surface as serialization
    -- conflict for the loser.
    IF v_latest_to_state = 'acknowledged' THEN
        IF v_latest_actor = v_actor_principal_id THEN
            SELECT id INTO v_transition_id
              FROM public.crisis_event_lifecycle_transition
             WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
               AND to_state = 'acknowledged'
             ORDER BY transition_at DESC, id DESC
             LIMIT 1;
            RETURN v_transition_id;
        ELSE
            RAISE EXCEPTION 'record_crisis_acknowledgement_claim: crisis_event % already acknowledged by another actor %; concurrent-claim race lost',
                p_crisis_event_id, v_latest_actor
                USING ERRCODE = '40001';  -- serialization_failure (retry-safe semantic; another caller won)
        END IF;
    END IF;

    -- Validate latest is in the allowed from-state set for acknowledgement.
    IF v_latest_to_state IS NULL OR v_latest_to_state NOT IN ('detected', 'escalated') THEN
        RAISE EXCEPTION 'record_crisis_acknowledgement_claim: cannot acknowledge crisis_event % from state %; allowed from-states are detected, escalated',
            p_crisis_event_id, COALESCE(v_latest_to_state, '<NULL/none>')
            USING ERRCODE = '40001';
    END IF;

    -- Emit the transition.
    v_transition_id := public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        p_crisis_event_id,
        v_latest_to_state,                    -- from_state (detected OR escalated)
        'acknowledged',                       -- to_state
        'clinician_acknowledgement',          -- transition_reason
        v_actor_principal_id,                 -- bound from SI-010
        p_transition_payload
    );

    RETURN v_transition_id;
END;
$$;

ALTER FUNCTION record_crisis_acknowledgement_claim(TEXT, UUID, JSONB)
    OWNER TO crisis_acknowledgement_wrapper_owner;
-- R1 HIGH-1 closure 2026-05-22 (PR 5 Codex review): SELECT + UPDATE on crisis_event.
-- PostgreSQL SELECT ... FOR UPDATE requires UPDATE privilege on the locked table
-- (even if the append-only trigger from migration 033 blocks any actual UPDATE at
-- runtime — the GRANT prerequisite is checked separately). Without UPDATE, every
-- wrapper call fails at runtime with permission_denied on the row-lock acquisition.
-- Matches the canonical P-042 R8 HIGH-1 closure pattern from the spec corpus.
GRANT SELECT, UPDATE ON crisis_event               TO crisis_acknowledgement_wrapper_owner;
GRANT SELECT ON crisis_event_lifecycle_transition  TO crisis_acknowledgement_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id()         TO crisis_acknowledgement_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()  TO crisis_acknowledgement_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_crisis_acknowledgement_claim(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_crisis_acknowledgement_claim(TEXT, UUID, JSONB) TO crisis_acknowledger;

COMMENT ON FUNCTION record_crisis_acknowledgement_claim(TEXT, UUID, JSONB) IS
    'P-040 §3.3 record_crisis_acknowledgement_claim — clinician/care-team claims '
    'detected/escalated crisis. SECDEF + actor bound from SI-010 + SELECT FOR UPDATE '
    'on parent row + latest-state validation + natural idempotency on same-actor replay. '
    'Audit emission for Cat A crisis.acknowledged deferred to application layer.';

-- =============================================================================
-- §2 — record_crisis_response()
--
-- Clinician records first-response after acknowledgement. Single allowed
-- from-state: acknowledged → responded (clinician_response).
-- =============================================================================

CREATE OR REPLACE FUNCTION record_crisis_response(
    p_tenant_id           TEXT,
    p_crisis_event_id     UUID,
    p_transition_payload  JSONB DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     UUID;
    v_actor_tenant_id        TEXT;
    v_latest_to_state        TEXT;
    v_latest_actor           UUID;
    v_transition_id          BIGINT;
BEGIN
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'record_crisis_response: no actor account bound' USING ERRCODE = '42501';
    END IF;
    BEGIN v_actor_principal_id := v_actor_account_id_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'record_crisis_response: bound actor account_id % is not a valid UUID', v_actor_account_id_text
            USING ERRCODE = '42501';
    END;

    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'record_crisis_response: no actor tenant bound' USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_crisis_response: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_crisis_response: crisis_event % not found', p_crisis_event_id
            USING ERRCODE = '02000';
    END IF;

    SELECT to_state, actor_principal_id
      INTO v_latest_to_state, v_latest_actor
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    -- Idempotent replay for same actor.
    IF v_latest_to_state = 'responded' THEN
        IF v_latest_actor = v_actor_principal_id THEN
            SELECT id INTO v_transition_id
              FROM public.crisis_event_lifecycle_transition
             WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
               AND to_state = 'responded'
             ORDER BY transition_at DESC, id DESC
             LIMIT 1;
            RETURN v_transition_id;
        ELSE
            RAISE EXCEPTION 'record_crisis_response: crisis_event % already responded by another actor; race lost', p_crisis_event_id
                USING ERRCODE = '40001';
        END IF;
    END IF;

    -- Only acknowledged → responded allowed per spec §6 triple #9.
    IF v_latest_to_state IS DISTINCT FROM 'acknowledged' THEN
        RAISE EXCEPTION 'record_crisis_response: cannot respond from state %; must be acknowledged',
            COALESCE(v_latest_to_state, '<NULL/none>')
            USING ERRCODE = '40001';
    END IF;

    v_transition_id := public.record_crisis_event_lifecycle_transition(
        p_tenant_id, p_crisis_event_id,
        'acknowledged', 'responded', 'clinician_response',
        v_actor_principal_id, p_transition_payload
    );

    RETURN v_transition_id;
END;
$$;

ALTER FUNCTION record_crisis_response(TEXT, UUID, JSONB)
    OWNER TO crisis_response_wrapper_owner;
GRANT SELECT, UPDATE ON crisis_event               TO crisis_response_wrapper_owner;  -- UPDATE required for SELECT FOR UPDATE (R1 HIGH-1)
GRANT SELECT ON crisis_event_lifecycle_transition  TO crisis_response_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id()         TO crisis_response_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()  TO crisis_response_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_crisis_response(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_crisis_response(TEXT, UUID, JSONB) TO crisis_responder;

COMMENT ON FUNCTION record_crisis_response(TEXT, UUID, JSONB) IS
    'P-040 §3.4 record_crisis_response — clinician records first-response. '
    'SECDEF + same closure-of-defects pattern as acknowledgement wrapper. '
    'Audit emission for Cat A crisis.responded deferred to application layer.';

-- =============================================================================
-- §3 — record_crisis_resolution()
--
-- Clinician resolves the crisis. Two allowed from-states:
-- responded → resolved (clinician_resolution; triple #10)
-- escalated → resolved (clinician_resolution; triple #11)
-- =============================================================================

CREATE OR REPLACE FUNCTION record_crisis_resolution(
    p_tenant_id           TEXT,
    p_crisis_event_id     UUID,
    p_transition_payload  JSONB DEFAULT NULL
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     UUID;
    v_actor_tenant_id        TEXT;
    v_latest_to_state        TEXT;
    v_latest_actor           UUID;
    v_transition_id          BIGINT;
BEGIN
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION 'record_crisis_resolution: no actor account bound' USING ERRCODE = '42501';
    END IF;
    BEGIN v_actor_principal_id := v_actor_account_id_text::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'record_crisis_resolution: bound actor account_id % is not a valid UUID', v_actor_account_id_text
            USING ERRCODE = '42501';
    END;

    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION 'record_crisis_resolution: no actor tenant bound' USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_crisis_resolution: tenant scope mismatch' USING ERRCODE = '42501';
    END IF;

    PERFORM 1 FROM public.crisis_event
     WHERE tenant_id = p_tenant_id AND id = p_crisis_event_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'record_crisis_resolution: crisis_event % not found', p_crisis_event_id
            USING ERRCODE = '02000';
    END IF;

    SELECT to_state, actor_principal_id
      INTO v_latest_to_state, v_latest_actor
      FROM public.crisis_event_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    -- Idempotent replay for same actor (resolved is terminal — any further
    -- mutation is rejected by state-machine CHECK; same-actor retry returns
    -- the existing row).
    IF v_latest_to_state = 'resolved' THEN
        IF v_latest_actor = v_actor_principal_id THEN
            SELECT id INTO v_transition_id
              FROM public.crisis_event_lifecycle_transition
             WHERE tenant_id = p_tenant_id AND crisis_event_id = p_crisis_event_id
               AND to_state = 'resolved'
             ORDER BY transition_at DESC, id DESC
             LIMIT 1;
            RETURN v_transition_id;
        ELSE
            RAISE EXCEPTION 'record_crisis_resolution: crisis_event % already resolved by another actor; race lost', p_crisis_event_id
                USING ERRCODE = '40001';
        END IF;
    END IF;

    -- Two allowed from-states: responded OR escalated.
    IF v_latest_to_state IS NULL OR v_latest_to_state NOT IN ('responded', 'escalated') THEN
        RAISE EXCEPTION 'record_crisis_resolution: cannot resolve from state %; allowed from-states are responded, escalated',
            COALESCE(v_latest_to_state, '<NULL/none>')
            USING ERRCODE = '40001';
    END IF;

    v_transition_id := public.record_crisis_event_lifecycle_transition(
        p_tenant_id, p_crisis_event_id,
        v_latest_to_state, 'resolved', 'clinician_resolution',
        v_actor_principal_id, p_transition_payload
    );

    RETURN v_transition_id;
END;
$$;

ALTER FUNCTION record_crisis_resolution(TEXT, UUID, JSONB)
    OWNER TO crisis_resolution_wrapper_owner;
GRANT SELECT, UPDATE ON crisis_event               TO crisis_resolution_wrapper_owner;  -- UPDATE required for SELECT FOR UPDATE (R1 HIGH-1)
GRANT SELECT ON crisis_event_lifecycle_transition  TO crisis_resolution_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id()         TO crisis_resolution_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id()  TO crisis_resolution_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_crisis_resolution(TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_crisis_resolution(TEXT, UUID, JSONB) TO crisis_resolver;

COMMENT ON FUNCTION record_crisis_resolution(TEXT, UUID, JSONB) IS
    'P-040 §3.5 record_crisis_resolution — clinician resolves crisis from '
    'responded OR escalated. SECDEF + same closure-of-defects pattern. '
    'Audit emission for Cat A crisis.resolved deferred to application layer.';

-- =============================================================================
-- §4 — Verification (signature-exact via to_regprocedure per PR 3 pattern)
-- =============================================================================

DO $$
DECLARE
    v_target_oid OID;
    v_owner TEXT;
    v_secdef BOOLEAN;
    v_proconfig TEXT[];
    v_specific TEXT;
    v_grant_count INTEGER;
    -- Per-function expectations
    v_target RECORD;
BEGIN
    FOR v_target IN
        VALUES
            ('public.record_crisis_acknowledgement_claim(text, uuid, jsonb)'::TEXT,
             'crisis_acknowledgement_wrapper_owner'::TEXT,
             'crisis_acknowledger'::TEXT),
            ('public.record_crisis_response(text, uuid, jsonb)',
             'crisis_response_wrapper_owner',
             'crisis_responder'),
            ('public.record_crisis_resolution(text, uuid, jsonb)',
             'crisis_resolution_wrapper_owner',
             'crisis_resolver')
    LOOP
        v_target_oid := to_regprocedure(v_target.column1);
        IF v_target_oid IS NULL THEN
            RAISE EXCEPTION 'migration-037-function-missing: % not found by signature', v_target.column1;
        END IF;

        SELECT r.rolname, p.prosecdef, p.proconfig, p.proname || '_' || p.oid::TEXT
          INTO v_owner, v_secdef, v_proconfig, v_specific
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.oid = v_target_oid;

        IF v_owner <> v_target.column2 THEN
            RAISE EXCEPTION 'migration-037-ownership-mismatch: % ownership is % but MUST be %',
                v_target.column1, v_owner, v_target.column2;
        END IF;
        IF NOT v_secdef THEN
            RAISE EXCEPTION 'migration-037-security-definer-missing: % MUST be SECURITY DEFINER', v_target.column1;
        END IF;
        IF v_proconfig IS NULL OR NOT (v_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
            RAISE EXCEPTION 'migration-037-search-path-not-locked: % proconfig=%', v_target.column1, v_proconfig;
        END IF;

        -- EXECUTE grant matrix: exactly 1 application-role grantee (excluding owner-self)
        SELECT COUNT(*) INTO v_grant_count
          FROM information_schema.role_routine_grants
         WHERE specific_name = v_specific AND privilege_type = 'EXECUTE' AND grantee <> v_target.column2;
        IF v_grant_count <> 1 THEN
            RAISE EXCEPTION 'migration-037-execute-grant-count: % expected 1 application-role grant, found %', v_target.column1, v_grant_count;
        END IF;

        -- The single grantee must match expected application role
        PERFORM 1 FROM information_schema.role_routine_grants
         WHERE specific_name = v_specific AND privilege_type = 'EXECUTE'
           AND grantee = v_target.column3;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'migration-037-grant-missing: % missing EXECUTE for %', v_target.column1, v_target.column3;
        END IF;

        -- No PUBLIC
        PERFORM 1 FROM information_schema.role_routine_grants
         WHERE specific_name = v_specific AND privilege_type = 'EXECUTE' AND grantee = 'PUBLIC';
        IF FOUND THEN
            RAISE EXCEPTION 'migration-037-anti-bypass: PUBLIC has EXECUTE on %', v_target.column1;
        END IF;

        -- SI-010 helper grants on wrapper-owner
        IF NOT has_function_privilege(v_target.column2, 'public.current_actor_account_id()', 'EXECUTE') THEN
            RAISE EXCEPTION 'migration-037-helper-grant-missing: % lacks EXECUTE on current_actor_account_id()', v_target.column2;
        END IF;
        IF NOT has_function_privilege(v_target.column2, 'public.current_actor_account_tenant_id()', 'EXECUTE') THEN
            RAISE EXCEPTION 'migration-037-helper-grant-missing: % lacks EXECUTE on current_actor_account_tenant_id()', v_target.column2;
        END IF;

        -- R1 HIGH-1 closure 2026-05-22: SELECT + UPDATE on crisis_event for SELECT FOR UPDATE row-lock
        IF NOT has_table_privilege(v_target.column2, 'public.crisis_event', 'SELECT') THEN
            RAISE EXCEPTION 'migration-037-table-grant-missing: % lacks SELECT on crisis_event', v_target.column2;
        END IF;
        IF NOT has_table_privilege(v_target.column2, 'public.crisis_event', 'UPDATE') THEN
            RAISE EXCEPTION 'migration-037-table-grant-missing: % lacks UPDATE on crisis_event (required for SELECT FOR UPDATE row-lock)', v_target.column2;
        END IF;
        IF NOT has_table_privilege(v_target.column2, 'public.crisis_event_lifecycle_transition', 'SELECT') THEN
            RAISE EXCEPTION 'migration-037-table-grant-missing: % lacks SELECT on crisis_event_lifecycle_transition', v_target.column2;
        END IF;
    END LOOP;
END $$;
