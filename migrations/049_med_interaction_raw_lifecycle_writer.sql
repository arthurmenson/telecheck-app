-- =============================================================================
-- File:    migrations/049_med_interaction_raw_lifecycle_writer.sql
-- Purpose: Create the canonical raw lifecycle writer SECDEF function
--          record_interaction_signal_lifecycle_transition() — the SOLE INSERT
--          path into interaction_signal_lifecycle_transition + the anti-bypass
--          discipline (EXECUTE granted ONLY to the 6 wrapper-owner roles from
--          migration 046; application roles never call the raw writer directly).
--
--          PR 4 of the Med-Interaction Engine implementation series. Subsequent
--          migrations: 6 reason-specific lifecycle wrappers (emission +
--          activation + supersession + resolution + expiry + override) (PR 5)
--          → Fastify handler implementation (PR 6+) following the Crisis
--          Response + Admin Backend Option 2 cadence.
--
--          PER RATIFIER OPTION 2 (carryforward from PR 1-3 + Crisis Response
--          migration 035 + Admin Backend migration 042):
--          - PROCEDURE → FUNCTION RETURNS VOID. Spec §6.NEW1 declares
--            PROCEDURE; code-repo precedent (Crisis Response migration 035 +
--            Admin Backend migration 042) uses FUNCTION RETURNS VOID. The
--            distinction (CALL vs SELECT; tx-control capability) doesn't
--            matter for this raw writer's body (no embedded COMMIT/ROLLBACK),
--            and FUNCTION is the established code-repo pattern. Wrappers in
--            PR 5 will SELECT-invoke instead of CALL-invoke.
--          - tenant_id_t → TEXT; ulid_t → VARCHAR(26); custom DOMAIN enum
--            types (interaction_signal_state_t, interaction_signal_transition_reason_t,
--            interaction_signal_actor_role_t) → TEXT (matches table column
--            types; CHECK constraints on the table enforce the enum values).
--          - p_id parameter (caller-supplied ULID): spec uses gen_ulid()
--            helper which doesn't exist in code repo. Caller (PR 5 wrapper +
--            ultimately TypeScript application layer via `ulid` library)
--            supplies the canonical ULID id.
--          - SI-024.1 JWT-binding code (verify_session_jwt_and_extract_claims,
--            is_jwt_required_for_entity, emit_raw_guc_fallback_audit, etc.):
--            spec uses these for STEP 0 tenant-context validation. Code repo
--            uses SI-010 trust anchor (current_actor_account_tenant_id()) per
--            migration 031. The lifecycle_transition table's BEFORE INSERT
--            trigger (migration 047 §3) already enforces
--            current_tenant_id() = NEW.tenant_id as caller-tenant guard;
--            the raw writer adds a defense-in-depth check via SI-010 helper
--            (matches Crisis Response + Admin Backend raw writer pattern).
--          - Wrapper-owner role names: prefixed with interaction_signal_*
--            per migration 046 §2 cross-slice-collision-safety convention.
--          - Writer-owner role name: interaction_signal_lifecycle_transition_writer_owner
--            (Option 2 prefix; spec uses unprefixed
--            lifecycle_transition_writer_owner).
--          - STEP 3.5 activation-blocked-by-override-evidence check
--            (SI-019 §6.NEW1 R5 HIGH-1 closure): preserved here per spec
--            even though it's reason-specific (could go in PR 5 activation
--            wrapper instead). Per "do not silently fork" discipline,
--            preserve spec placement.
--          - Owner role needs INSERT + SELECT on lifecycle_transition table
--            (Crisis Response migration 035 + Admin Backend migration 042
--            pattern; SELECT required by SECURITY INVOKER trigger reading
--            MAX(prior.transition_at)). Migration 047 §4 grant block
--            already includes both INSERT + SELECT for writer-owner.
--          - SECDEF + locked search_path = pg_catalog, public (Option 2;
--            spec uses pg_catalog, pg_temp).
--
-- Spec:    - SI-019 Medication Interaction & Validation Engine Slice PRD
--            v2.0 Sub-decision 8.5 (raw canonical lifecycle writer;
--            anti-bypass discipline)
--          - CDM v1.6 → v1.7 Amendment §6.NEW1 (canonical executable
--            wrapper-body source; RATIFIED 2026-05-21 P-034)
--          - I-035 (append-only invariant for audit-bound state machines;
--            enforced by per-table trigger from migration 047 + this raw
--            writer's role as SOLE INSERT path)
--          - I-027 (audit append-only; lifecycle_transition is audit-bound)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   031_session_actor_context.sql                applied (SI-010 helpers)
--   046_med_interaction_rbac_roles.sql           applied (12 roles incl 6
--                                                  wrapper-owners + writer-owner)
--   047_med_interaction_entities.sql             applied (lifecycle_transition
--                                                  table + monotonic-ordering
--                                                  trigger function + grants)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — Raw lifecycle writer SECURITY DEFINER function
--
-- Body is intentionally minimal. ALL business invariants live at the table
-- layer (migration 047):
--   - 6 CHECK-enforced valid (transition_reason, from_state, to_state) triples
--   - Per-table append-only trigger blocks UPDATE/DELETE
--   - Monotonic-ordering trigger (advisory lock + caller-tenant guard +
--     server-assigned strict-monotonic transition_at + state-continuity check)
--
-- The raw writer's sole purpose is to be the SOLE callable INSERT path so the
-- anti-bypass EXECUTE-grant matrix can enforce that ONLY the 6 wrapper
-- procedures perform transitions.
--
-- SECURITY DEFINER: runs with writer_owner's privileges. writer_owner has
-- INSERT + SELECT on the table per migration 047 §4 GRANT block. Application
-- roles do NOT have grants on the table — they MUST come through the
-- wrapper → raw writer chain.
--
-- SET search_path: locks to pg_catalog, public (Option 2; spec uses
-- pg_catalog, pg_temp). canonical SECDEF hardening per code-repo
-- audit_chain pattern + Crisis Response migration 035 + Admin Backend
-- migration 042.
-- =============================================================================

CREATE OR REPLACE FUNCTION record_interaction_signal_lifecycle_transition(
    p_id                  VARCHAR(26),
    p_tenant_id           TEXT,
    p_signal_id           VARCHAR(26),
    p_to_state            TEXT,
    p_transition_reason   TEXT,
    p_actor_id            VARCHAR(26),    -- nullable for system-triggered transitions
    p_actor_role          TEXT,
    p_metadata            JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_latest_to_state     TEXT;
    v_actor_tenant_id     TEXT;
    v_lock_key            BIGINT;
BEGIN
    -- ---------------------------------------------------------------------
    -- Defense-in-depth tenant guard (mirrors Crisis Response migration 035
    -- + Admin Backend migration 042 pattern; the table's BEFORE INSERT
    -- monotonic-ordering trigger ALSO performs this check, but doing it
    -- here at the SECDEF function body provides a guarantee independent of
    -- trigger correctness — a future trigger replacement that misses the
    -- check would still be caught here).
    --
    -- SI-010 trust anchor: current_actor_account_tenant_id() returns the
    -- tenant bound by authContextPlugin at request time; caller cannot
    -- forge.
    -- ---------------------------------------------------------------------
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION
            'record_interaction_signal_lifecycle_transition: no actor tenant bound for '
            'current backend; authContextPlugin must bind before SECDEF function invocation'
            USING ERRCODE = '42501';    -- insufficient_privilege
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION
            'record_interaction_signal_lifecycle_transition: tenant scope mismatch — '
            'actor tenant does not match p_tenant_id; cross-tenant lifecycle write rejected'
            USING ERRCODE = '42501';
    END IF;

    -- ---------------------------------------------------------------------
    -- R1 HIGH-1 closure 2026-05-23 (Codex R1): acquire per-(tenant, signal)
    -- advisory transaction lock BEFORE the STEP 3.5 override-evidence
    -- check. Without this lock, a concurrent override INSERT could slip
    -- between the EXISTS check + the activation INSERT, leaving an
    -- activation transition committed even though override evidence
    -- exists — corrupting the SI-019 R5 HIGH-1 invariant + impossible to
    -- repair since lifecycle rows are append-only.
    --
    -- LOCK KEY SHARED ACROSS BOTH WRITE PATHS (CONTRACT FOR PR 5):
    --   - Raw writer (this function) acquires lock BEFORE STEP 3.5
    --     activation check
    --   - PR 5 override_wrapper MUST acquire the SAME lock key BEFORE
    --     INSERT into interaction_signal_override
    --   - This serializes activation decisions with override creation
    --     for the same (tenant, signal), eliminating the race
    --
    -- Lock key uses the same md5-of-(tenant_id, signal_id) shape as the
    -- monotonic-ordering trigger on lifecycle_transition (migration 047
    -- §3), so the lock domain is consistent across all writes to a single
    -- (tenant, signal). Concurrent calls serialize; lock is auto-released
    -- at tx commit/rollback.
    -- ---------------------------------------------------------------------
    v_lock_key := ('x' || substr(md5(p_tenant_id::text || ':' || p_signal_id::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- ---------------------------------------------------------------------
    -- STEP 3.5 — activation-blocked-by-override-evidence check (SI-019
    -- §6.NEW1 R5 HIGH-1 closure preserved verbatim from spec). Now executes
    -- under the advisory lock acquired above (R1 HIGH-1 closure), so a
    -- concurrent override INSERT cannot slip between this EXISTS check and
    -- the activation INSERT below. Reason-specific check; could move to
    -- the activation wrapper (PR 5) in a future refactor but kept here
    -- per spec.
    -- ---------------------------------------------------------------------
    IF p_transition_reason = 'activation' THEN
        IF EXISTS (
            SELECT 1
              FROM public.interaction_signal_override
             WHERE tenant_id = p_tenant_id AND signal_id = p_signal_id
        ) THEN
            RAISE EXCEPTION
                'activation_blocked_by_override_evidence: signal_id=% has '
                'existing override; activation rejected per SI-019 Sub-decision 8.5',
                p_signal_id
                USING ERRCODE = '23514';    -- check_violation
        END IF;
    END IF;

    -- ---------------------------------------------------------------------
    -- Compute from_state from the latest prior transition. The table's
    -- monotonic-ordering trigger ALSO validates state-continuity (NEW.from_state
    -- matches latest prior to_state, or 'none' if no prior); this query
    -- here populates the from_state column at INSERT time. The trigger
    -- would reject inconsistent (from_state, latest.to_state) pairs.
    --
    -- Note: this read is NOT under the advisory lock that the trigger
    -- acquires. There IS a TOCTOU window between this read + the INSERT,
    -- but the trigger re-reads MAX(prior.transition_at) + latest to_state
    -- under its own advisory lock — so a concurrent insert between this
    -- raw writer's read + the trigger's lock-protected read will be
    -- caught by the trigger's state-continuity check and the trigger will
    -- raise an exception.
    -- ---------------------------------------------------------------------
    SELECT to_state INTO v_latest_to_state
      FROM public.interaction_signal_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND signal_id = p_signal_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    -- ---------------------------------------------------------------------
    -- INSERT the new transition row. CHECK constraint at table layer
    -- (migration 047 §3) enforces 6 valid transition triples. BEFORE INSERT
    -- monotonic-ordering trigger (migration 047) overrides transition_at to
    -- server-assigned strict-monotonic value, validates caller-tenant scope,
    -- and validates state-continuity. Append-only trigger blocks any future
    -- UPDATE/DELETE on this row.
    --
    -- transition_at value passed here is a placeholder; the trigger
    -- unconditionally overwrites with clock_timestamp() or
    -- GREATEST(clock_timestamp(), prior.MAX + 1us). The DEFAULT on the
    -- column (clock_timestamp()) would handle it too if we omitted the
    -- value; explicit clock_timestamp() here documents intent.
    -- ---------------------------------------------------------------------
    INSERT INTO public.interaction_signal_lifecycle_transition (
        id, tenant_id, signal_id,
        from_state, to_state, transition_reason,
        transition_at, transition_by_actor_id, transition_by_actor_role,
        metadata
    ) VALUES (
        p_id, p_tenant_id, p_signal_id,
        COALESCE(v_latest_to_state, 'none'), p_to_state, p_transition_reason,
        clock_timestamp(), p_actor_id, p_actor_role,
        p_metadata
    );
END;
$$;

-- =============================================================================
-- §2 — Function ownership (writer_owner)
--
-- Owner role already has INSERT + SELECT on lifecycle_transition table
-- (granted at migration 047 §4 GRANT block; carried forward from spec
-- §4.NEW4 GRANT block).
-- =============================================================================

ALTER FUNCTION record_interaction_signal_lifecycle_transition(
    VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
) OWNER TO interaction_signal_lifecycle_transition_writer_owner;

-- R2 HIGH-1 closure 2026-05-23 (Codex R2): grant SELECT on
-- interaction_signal_override to the writer-owner. STEP 3.5
-- activation-blocked-by-override-evidence check runs under SECDEF
-- owner privileges (writer-owner); migration 047 §3 only granted
-- SELECT on override to medication_interaction_signal_viewer +
-- interaction_signal_override_wrapper_owner. Without this grant,
-- activation transitions would fail at runtime with
-- "permission denied for relation interaction_signal_override"
-- before STEP 3.5 could produce the intended evidence-rejection
-- semantic. This grant is the minimal additional privilege needed
-- for the SECDEF read; writer-owner does NOT receive INSERT/UPDATE/
-- DELETE on the override table (override writes remain exclusive to
-- the override wrapper-owner per migration 047 §3 GRANT block).
GRANT SELECT ON interaction_signal_override
    TO interaction_signal_lifecycle_transition_writer_owner;

-- =============================================================================
-- §3 — Anti-bypass EXECUTE grant matrix (SI-019 R4 HIGH-2 closure preserved):
-- raw writer is callable ONLY by the 6 wrapper-owner roles. Application roles
-- (medication_interaction_engine_evaluator, medication_interaction_signal_viewer,
-- medication_interaction_override_recorder, medication_interaction_knowledge_base_updater)
-- have NO EXECUTE on this function — they MUST come through the reason-specific
-- wrappers (PR 5).
-- =============================================================================

REVOKE EXECUTE ON FUNCTION record_interaction_signal_lifecycle_transition(
    VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_interaction_signal_lifecycle_transition(
    VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
) TO interaction_signal_emission_wrapper_owner,
     interaction_signal_activation_wrapper_owner,
     interaction_signal_override_wrapper_owner,
     interaction_signal_supersession_wrapper_owner,
     interaction_signal_resolution_wrapper_owner,
     interaction_signal_expiry_wrapper_owner;

COMMENT ON FUNCTION record_interaction_signal_lifecycle_transition(
    VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
) IS
    'CDM v1.7 §6.NEW1 + SI-019 Sub-decision 8.5 raw canonical lifecycle writer. '
    'SECURITY DEFINER + locked search_path. SOLE INSERT path into '
    'interaction_signal_lifecycle_transition. EXECUTE granted ONLY to the 6 '
    'wrapper-owner roles (anti-bypass per SI-019 R4 HIGH-2 + Crisis Response '
    'migration 035 + Admin Backend migration 042 pattern); application roles '
    'never call this directly. All business invariants (6 valid triples + '
    'append-only + advisory-locked monotonic ordering + state continuity + '
    'caller-tenant guard) enforced at the table layer via migration 047 '
    'triggers + CHECK constraint. Defense-in-depth tenant guard at function '
    'body via SI-010 current_actor_account_tenant_id() trust anchor. STEP 3.5 '
    'activation-blocked-by-override-evidence check preserved verbatim per spec.';

-- =============================================================================
-- §4 — Verification
-- =============================================================================

DO $$
DECLARE
    v_target_oid                OID := to_regprocedure(
        'public.record_interaction_signal_lifecycle_transition('
        || 'character varying, text, character varying, text, text, '
        || 'character varying, text, jsonb)'
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
            'migration-049-function-missing: '
            'record_interaction_signal_lifecycle_transition(varchar, text, '
            'varchar, text, text, varchar, text, jsonb) not found by signature';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_function_owner, v_function_security_definer, v_function_proconfig
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_target_oid;

    IF v_function_owner <> 'interaction_signal_lifecycle_transition_writer_owner' THEN
        RAISE EXCEPTION
            'migration-049-ownership-mismatch: '
            'owner is % but MUST be interaction_signal_lifecycle_transition_writer_owner',
            v_function_owner;
    END IF;

    IF NOT v_function_security_definer THEN
        RAISE EXCEPTION
            'migration-049-security-definer-missing: '
            'record_interaction_signal_lifecycle_transition() MUST be SECURITY DEFINER';
    END IF;

    IF v_function_proconfig IS NULL
       OR NOT (v_function_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-049-search-path-not-locked: '
            'record_interaction_signal_lifecycle_transition() MUST have proconfig '
            'containing "search_path=pg_catalog, public"; found %', v_function_proconfig;
    END IF;

    SELECT p.proname || '_' || p.oid::TEXT INTO v_function_specific_name
      FROM pg_proc p WHERE p.oid = v_target_oid;

    -- EXECUTE grant count check (excluding owner-self): exactly 6 wrapper-owners.
    SELECT COUNT(*) INTO v_execute_grantee_count
      FROM information_schema.role_routine_grants g
     WHERE g.specific_name = v_function_specific_name
       AND g.privilege_type = 'EXECUTE'
       AND g.grantee <> 'interaction_signal_lifecycle_transition_writer_owner';

    IF v_execute_grantee_count <> 6 THEN
        RAISE EXCEPTION
            'migration-049-execute-grant-count: '
            'expected exactly 6 wrapper-owner EXECUTE grants (excluding owner-self), '
            'found %', v_execute_grantee_count;
    END IF;

    -- Positive whitelist: every grantee must be one of the 6 canonical wrapper-owners
    -- (or owner-self).
    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_routine_grants g
         WHERE g.specific_name = v_function_specific_name
           AND g.privilege_type = 'EXECUTE'
           AND g.grantee NOT IN (
               'interaction_signal_lifecycle_transition_writer_owner',
               'interaction_signal_emission_wrapper_owner',
               'interaction_signal_activation_wrapper_owner',
               'interaction_signal_override_wrapper_owner',
               'interaction_signal_supersession_wrapper_owner',
               'interaction_signal_resolution_wrapper_owner',
               'interaction_signal_expiry_wrapper_owner'
           )
    LOOP
        RAISE EXCEPTION
            'migration-049-execute-grant-violation: '
            'EXECUTE granted to non-canonical role %; canonical grantees = '
            '{6 wrapper-owners + owner-self}', v_unauthorized_grantee;
    END LOOP;

    -- Negative anti-bypass: PUBLIC must NOT have EXECUTE.
    PERFORM 1
      FROM information_schema.role_routine_grants
     WHERE specific_name = v_function_specific_name
       AND privilege_type = 'EXECUTE'
       AND grantee = 'PUBLIC';
    IF FOUND THEN
        RAISE EXCEPTION
            'migration-049-anti-bypass-violation: PUBLIC has EXECUTE on raw writer';
    END IF;

    -- R2 HIGH-1 closure 2026-05-23 (Codex R2): verify writer-owner has
    -- SELECT on interaction_signal_override (required by STEP 3.5
    -- override-evidence check at SECDEF function body). Without this
    -- grant, activation transitions would fail at runtime with
    -- permission_denied before STEP 3.5 could execute.
    IF NOT has_table_privilege(
        'interaction_signal_lifecycle_transition_writer_owner',
        'public.interaction_signal_override',
        'SELECT'
    ) THEN
        RAISE EXCEPTION
            'migration-049-writer-owner-missing-override-select: '
            'interaction_signal_lifecycle_transition_writer_owner does NOT '
            'have SELECT on interaction_signal_override; STEP 3.5 activation-'
            'override-evidence check would fail at runtime with permission_denied';
    END IF;
END $$;
