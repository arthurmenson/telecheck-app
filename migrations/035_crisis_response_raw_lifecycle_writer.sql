-- =============================================================================
-- File:    migrations/035_crisis_response_raw_lifecycle_writer.sql
-- Purpose: Create the canonical raw lifecycle writer SECURITY DEFINER procedure
--          `record_crisis_event_lifecycle_transition()` — the SOLE INSERT path
--          into crisis_event_lifecycle_transition + the anti-bypass discipline
--          (EXECUTE granted ONLY to the 5 wrapper-owner roles from migration
--          032; application roles never call the raw writer directly).
--
--          PR 3 of the Crisis Response implementation series. Following PRs
--          deploy the 5 state-changing wrapper procedures that depend on this
--          raw writer (PR 4: initiation; PR 5: acknowledgement + response +
--          resolution; PR 6: sweep wrapper).
--
--          PER RATIFIER OPTION 2 (carryforward from migrations 033-034):
--          - tenant_id parameter type is TEXT (code-repo pattern), not the
--            spec's `tenant_id_t` domain.
--          - No LAYER B JWT-principal-to-role authorization in this raw writer —
--            it is the internal-only writer called BY the 5 wrapper procedures
--            (which themselves do LAYER A+B+C authorization). The raw writer's
--            authorization boundary is purely the EXECUTE grant matrix (anti-
--            bypass per P-040 §3.1 + P-038 §3.1 + P-034 §3 pattern).
--          - Owner role needs explicit INSERT + SELECT grants on
--            crisis_event_lifecycle_transition (SELECT required by the
--            SECURITY INVOKER monotonic-ordering trigger from migration 033
--            §6, which reads MAX(transition_at) under the caller's identity =
--            writer_owner when the raw writer runs as SECDEF).
--
-- Spec:    - SI-022 Crisis Response Slice v1.0 Sub-decision 4.5 (raw canonical
--            lifecycle writer; anti-bypass discipline)
--          - CDM v1.9 → v1.10 Amendment §3.1 (canonical executable wrapper-
--            body source; RATIFIED 2026-05-21 P-040;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_9_to_v1_10_Amendment.md)
--          - I-035 (append-only invariant for audit-bound state machines;
--            enforced by per-table trigger from migration 033 + the raw
--            writer's role as SOLE INSERT path)
--          - I-027 (audit append-only; lifecycle_transition is audit-bound)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS: 032_crisis_response_rbac_roles.sql (6 procedure-owner roles)
--                + 033_crisis_response_entities.sql (lifecycle_transition table
--                + monotonic-ordering trigger function) applied.
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — Raw lifecycle writer SECURITY DEFINER procedure
--
-- Body is intentionally minimal: a single INSERT into the lifecycle_transition
-- table. ALL business invariants (11 CHECK-enforced transition triples, append-
-- only via per-table trigger, monotonic-ordering via the BEFORE INSERT trigger
-- with advisory lock) live at the table layer. The raw writer's sole purpose
-- is to be the SOLE callable INSERT path so the anti-bypass EXECUTE-grant
-- matrix can enforce that ONLY the 5 wrapper procedures perform transitions.
--
-- SECURITY DEFINER: runs with writer_owner's privileges. writer_owner has
-- INSERT + SELECT grants on the table (§2 below). Application roles do NOT
-- have grants on the table — they MUST come through the wrapper → raw writer
-- chain.
--
-- SET search_path: locks the schema lookup to pg_catalog, public so a
-- malicious caller cannot redirect via search_path injection (canonical
-- SECDEF hardening per the code-repo audit_chain pattern).
-- =============================================================================

CREATE OR REPLACE FUNCTION record_crisis_event_lifecycle_transition(
    p_tenant_id           TEXT,
    p_crisis_event_id     UUID,
    p_from_state          TEXT,
    p_to_state            TEXT,
    p_transition_reason   TEXT,
    p_actor_principal_id  UUID,
    p_transition_payload  JSONB
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_transition_id BIGINT;
BEGIN
    -- All business invariants enforced at the table layer:
    -- - CHECK constraint at §6 of migration 033 enforces the 11 valid
    --   (from_state, to_state, transition_reason) triples
    -- - monotonic-ordering trigger at §6 of migration 033 takes an advisory
    --   lock keyed by (tenant_id, crisis_event_id) hash + asserts
    --   NEW.transition_at >= MAX(prior.transition_at) under the lock
    --   (future-dating bounded by 5s clock-skew; backdating rejected)
    -- - append-only trigger at §6 of migration 033 blocks UPDATE/DELETE
    --
    -- This raw writer is the SOLE INSERT path into the table; EXECUTE on
    -- this function is granted ONLY to the 5 wrapper-owner roles (§3 below)
    -- so application roles cannot bypass the wrapper-level LAYER A+B+C
    -- authorization that each state-changing wrapper enforces.
    INSERT INTO public.crisis_event_lifecycle_transition (
        tenant_id, crisis_event_id, from_state, to_state, transition_reason,
        transition_at, actor_principal_id, transition_payload
    ) VALUES (
        p_tenant_id, p_crisis_event_id, p_from_state, p_to_state, p_transition_reason,
        now(), p_actor_principal_id, p_transition_payload
    )
    RETURNING id INTO v_transition_id;

    RETURN v_transition_id;
END;
$$;

-- =============================================================================
-- §2 — Function ownership + writer_owner role grants on lifecycle_transition
-- =============================================================================

ALTER FUNCTION record_crisis_event_lifecycle_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB
) OWNER TO crisis_event_lifecycle_transition_writer_owner;

-- writer_owner needs INSERT (the function body inserts) + SELECT (the
-- SECURITY INVOKER monotonic-ordering trigger reads MAX(transition_at)
-- under the caller's identity = writer_owner when this SECDEF runs).
GRANT INSERT ON crisis_event_lifecycle_transition TO crisis_event_lifecycle_transition_writer_owner;
GRANT SELECT ON crisis_event_lifecycle_transition TO crisis_event_lifecycle_transition_writer_owner;

-- =============================================================================
-- §3 — Anti-bypass EXECUTE grant matrix (P-040 §3.1 + P-038 §3.1 canonical
-- pattern): the raw writer is callable ONLY by the 5 wrapper-owner roles.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION record_crisis_event_lifecycle_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_crisis_event_lifecycle_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB
) TO crisis_initiation_wrapper_owner,
     crisis_acknowledgement_wrapper_owner,
     crisis_response_wrapper_owner,
     crisis_resolution_wrapper_owner,
     crisis_sweep_wrapper_owner;

COMMENT ON FUNCTION record_crisis_event_lifecycle_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB
) IS
    'P-040 §3.1 + SI-022 Sub-decision 4.5 raw canonical lifecycle writer. '
    'SECURITY DEFINER + locked search_path. SOLE INSERT path into '
    'crisis_event_lifecycle_transition. EXECUTE granted ONLY to the 5 wrapper-'
    'owner roles (anti-bypass per P-034 §3 + P-038 §3 + P-040 §3 pattern); '
    'application roles never call this directly. All business invariants '
    '(11 valid triples + monotonic-ordering + append-only) enforced at the '
    'table layer via migration 033 triggers + CHECK constraint.';

-- =============================================================================
-- §4 — Verification
-- =============================================================================

DO $$
DECLARE
    -- R1 MED-2 closure 2026-05-22: resolve the EXACT target signature OID so
    -- all verification queries scope to record_crisis_event_lifecycle_transition
    -- (TEXT, UUID, TEXT, TEXT, TEXT, UUID, JSONB) only — no overload drift hazard.
    v_target_oid                OID := to_regprocedure(
        'public.record_crisis_event_lifecycle_transition(text, uuid, text, text, text, uuid, jsonb)'
    );
    v_function_owner            TEXT;
    v_function_security_definer BOOLEAN;
    v_function_specific_name    TEXT;
    v_function_proconfig        TEXT[];
    v_execute_grantee_count     INTEGER;
    v_unauthorized_grantee      TEXT;
BEGIN
    IF v_target_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-035-function-missing: record_crisis_event_lifecycle_transition(text, uuid, text, text, text, uuid, jsonb) not found by signature';
    END IF;

    -- Resolve owner + SECDEF flag + proconfig (search_path lock) for the EXACT OID
    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_function_owner, v_function_security_definer, v_function_proconfig
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_target_oid;

    IF v_function_owner <> 'crisis_event_lifecycle_transition_writer_owner' THEN
        RAISE EXCEPTION
            'migration-035-ownership-mismatch: record_crisis_event_lifecycle_transition() ownership is % but MUST be crisis_event_lifecycle_transition_writer_owner',
            v_function_owner;
    END IF;

    IF NOT v_function_security_definer THEN
        RAISE EXCEPTION
            'migration-035-security-definer-missing: record_crisis_event_lifecycle_transition() MUST be SECURITY DEFINER';
    END IF;

    -- R1 MED-1 closure 2026-05-22: assert proconfig contains the canonical
    -- locked search_path. A SECDEF function without a locked search_path is
    -- vulnerable to search-path injection by a caller controlling SET (or by
    -- role-default search_path drift). The migration creates the function
    -- with SET search_path = pg_catalog, public; this assertion catches any
    -- future replacement or drift that removes the SET.
    IF v_function_proconfig IS NULL
       OR NOT (v_function_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-035-search-path-not-locked: record_crisis_event_lifecycle_transition() MUST have proconfig containing "search_path=pg_catalog, public"; found %',
            v_function_proconfig;
    END IF;

    -- Resolve the function's specific_name to scope information_schema grant queries
    -- by OID-equivalent identifier (information_schema doesn't expose OID directly,
    -- but specific_name uniquely identifies the function row in routines/role_routine_grants).
    SELECT p.proname || '_' || p.oid::TEXT INTO v_function_specific_name
      FROM pg_proc p WHERE p.oid = v_target_oid;

    -- R1 MED-2 closure: signature-scoped EXECUTE grant assertions via specific_name
    -- (information_schema's canonical OID-equivalent identifier; no overload drift).
    SELECT COUNT(*) INTO v_execute_grantee_count
      FROM information_schema.role_routine_grants g
     WHERE g.specific_name = v_function_specific_name
       AND g.privilege_type = 'EXECUTE'
       AND g.grantee <> 'crisis_event_lifecycle_transition_writer_owner';

    IF v_execute_grantee_count <> 5 THEN
        RAISE EXCEPTION
            'migration-035-execute-grant-count: expected exactly 5 wrapper-owner EXECUTE grants (excluding owner-self), found %',
            v_execute_grantee_count;
    END IF;

    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_routine_grants g
         WHERE g.specific_name = v_function_specific_name
           AND g.privilege_type = 'EXECUTE'
           AND g.grantee NOT IN ('crisis_event_lifecycle_transition_writer_owner',
                                 'crisis_initiation_wrapper_owner',
                                 'crisis_acknowledgement_wrapper_owner',
                                 'crisis_response_wrapper_owner',
                                 'crisis_resolution_wrapper_owner',
                                 'crisis_sweep_wrapper_owner')
    LOOP
        RAISE EXCEPTION
            'migration-035-execute-grant-violation: record_crisis_event_lifecycle_transition() EXECUTE granted to non-canonical role %; canonical grantees = {5 wrapper-owners}',
            v_unauthorized_grantee;
    END LOOP;

    -- Negative anti-bypass: PUBLIC must NOT have EXECUTE (signature-scoped)
    PERFORM 1
      FROM information_schema.role_routine_grants
     WHERE specific_name = v_function_specific_name
       AND privilege_type = 'EXECUTE'
       AND grantee = 'PUBLIC';
    IF FOUND THEN
        RAISE EXCEPTION
            'migration-035-anti-bypass-violation: PUBLIC has EXECUTE on record_crisis_event_lifecycle_transition() — anti-bypass discipline broken';
    END IF;
END $$;
