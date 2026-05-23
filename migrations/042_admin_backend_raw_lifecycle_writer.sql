-- =============================================================================
-- File:    migrations/042_admin_backend_raw_lifecycle_writer.sql
-- Purpose: Create the canonical raw lifecycle writer SECURITY DEFINER procedure
--          `record_forms_template_admin_review_transition()` — the SOLE INSERT
--          path into forms_template_admin_review_lifecycle_transition + the
--          anti-bypass discipline (EXECUTE granted ONLY to the 2 template
--          wrapper-owner roles from migration 039; application roles never
--          call the raw writer directly).
--
--          PR 3 of the Admin Backend Basics implementation series. Following
--          PRs deploy the 2 template wrapper procedures (PR 4: submit +
--          decision) that depend on this raw writer + the 3 dashboard
--          read-wrappers (PR 5) + the Fastify module scaffold (PR 6).
--
--          PER RATIFIER OPTION 2 (carryforward from migrations 035-038 +
--          migrations 039-041):
--          - tenant_id parameter type is TEXT (code-repo pattern), not the
--            spec's `tenant_id_t` domain.
--          - actor_principal_id parameter type is TEXT (mapped 1:1 to the
--            underlying VARCHAR(26) accounts.account_id column at INSERT
--            time; PostgreSQL accepts the implicit cast and VARCHAR(26)'s
--            length constraint enforces the canonical 26-char ULID shape).
--          - No LAYER B JWT-principal-to-role authorization in this raw
--            writer — it is the internal-only writer called BY the 2
--            template wrapper procedures (which themselves do LAYER A+B+C
--            authorization). The raw writer's authorization boundary is
--            purely the EXECUTE grant matrix (anti-bypass per P-040 §3.1 +
--            P-038 §3.1 + P-034 §3 pattern; mirrored from Crisis Response
--            migration 035).
--          - Owner role needs explicit INSERT + SELECT grants on
--            forms_template_admin_review_lifecycle_transition (SELECT
--            required by the SECURITY INVOKER unified lifecycle-invariants
--            trigger from migration 040, which reads MAX(transition_at) +
--            latest to_state under the caller's identity = writer_owner
--            when the raw writer runs as SECDEF).
--
-- Spec:    - SI-023 Admin Backend Basics Slice v1.0 Sub-decision 4.5 (raw
--            canonical lifecycle writer; anti-bypass discipline);
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_SI_023_Admin_Backend_Basics_v1_0.md §4.5
--          - CDM v1.10 → v1.11 Amendment §4.NEW8a (canonical executable
--            wrapper-body source; RATIFIED 2026-05-22 P-042;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_10_to_v1_11_Amendment.md)
--          - I-035 (append-only invariant for audit-bound state machines;
--            enforced by per-table trigger from migration 040 + the raw
--            writer's role as SOLE INSERT path)
--          - I-027 (audit append-only; lifecycle_transition is audit-bound)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   039_admin_backend_rbac_roles.sql             applied (writer-owner +
--                                                  2 template wrapper-owner roles)
--   040_admin_backend_entities.sql               applied (lifecycle_transition
--                                                  table + unified lifecycle-invariants
--                                                  trigger function + valid-transition CHECK)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — Raw lifecycle writer SECURITY DEFINER procedure
--
-- Body is intentionally minimal: a single INSERT into the lifecycle_transition
-- table. ALL business invariants live at the table layer:
--   - 5 CHECK-enforced valid (from_state, to_state, transition_reason) triples
--   - Unified lifecycle-invariants BEFORE INSERT trigger (3 invariants under
--     one advisory lock per (tenant_id, review_id): future-date bounded by 5s
--     clock skew + backdate rejected + state-continuity)
--   - Per-table append-only triggers blocking UPDATE/DELETE
--
-- The raw writer's sole purpose is to be the SOLE callable INSERT path so the
-- anti-bypass EXECUTE-grant matrix can enforce that ONLY the 2 template
-- wrapper procedures perform transitions.
--
-- SECURITY DEFINER: runs with writer_owner's privileges. writer_owner has
-- INSERT + SELECT grants on the table (§2 below). Application roles do NOT
-- have grants on the table — they MUST come through the wrapper → raw
-- writer chain.
--
-- SET search_path: locks the schema lookup to pg_catalog, public so a
-- malicious caller cannot redirect via search_path injection (canonical
-- SECDEF hardening per the code-repo audit_chain pattern + Crisis Response
-- migrations 035-038).
-- =============================================================================

CREATE OR REPLACE FUNCTION record_forms_template_admin_review_transition(
    p_tenant_id           TEXT,
    p_review_id           UUID,
    p_from_state          TEXT,
    p_to_state            TEXT,
    p_transition_reason   TEXT,
    p_actor_principal_id  TEXT,
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
    -- - CHECK constraint at §3 of migration 040 enforces the 5 valid
    --   (from_state, to_state, transition_reason) triples per SI-023 §6
    -- - Unified lifecycle-invariants trigger at §3 of migration 040 takes an
    --   advisory lock keyed by (tenant_id, review_id) hash + asserts:
    --     * NEW.transition_at <= now() + 5s (future-date bounded)
    --     * NEW.transition_at >= MAX(prior.transition_at) (backdate rejected)
    --     * NEW.from_state matches latest to_state (state-continuity)
    --     under READ COMMITTED isolation precondition
    -- - append-only trigger at §3 of migration 040 blocks UPDATE/DELETE
    --
    -- This raw writer is the SOLE INSERT path into the table; EXECUTE on
    -- this function is granted ONLY to the 2 template wrapper-owner roles
    -- (§3 below) so application roles cannot bypass the wrapper-level
    -- LAYER A+B+C authorization that each template wrapper enforces.
    INSERT INTO public.forms_template_admin_review_lifecycle_transition (
        tenant_id, review_id, from_state, to_state, transition_reason,
        transition_at, actor_principal_id, transition_payload
    ) VALUES (
        p_tenant_id, p_review_id, p_from_state, p_to_state, p_transition_reason,
        now(), p_actor_principal_id, p_transition_payload
    )
    RETURNING id INTO v_transition_id;

    RETURN v_transition_id;
END;
$$;

-- =============================================================================
-- §2 — Function ownership + writer_owner role grants on lifecycle_transition
-- =============================================================================

ALTER FUNCTION record_forms_template_admin_review_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
) OWNER TO forms_template_admin_review_transition_writer_owner;

-- writer_owner needs INSERT (the function body inserts) + SELECT (the
-- SECURITY INVOKER unified lifecycle-invariants trigger reads
-- MAX(transition_at) + latest to_state under the caller's identity =
-- writer_owner when this SECDEF runs).
GRANT INSERT ON forms_template_admin_review_lifecycle_transition
    TO forms_template_admin_review_transition_writer_owner;
GRANT SELECT ON forms_template_admin_review_lifecycle_transition
    TO forms_template_admin_review_transition_writer_owner;

-- =============================================================================
-- §3 — Anti-bypass EXECUTE grant matrix (P-040 §3.1 + P-038 §3.1 + Crisis
-- Response migration 035 canonical pattern): the raw writer is callable ONLY
-- by the 2 template wrapper-owner roles.
-- =============================================================================

REVOKE EXECUTE ON FUNCTION record_forms_template_admin_review_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_forms_template_admin_review_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
) TO forms_template_admin_review_submit_wrapper_owner,
     forms_template_admin_review_decision_wrapper_owner;

COMMENT ON FUNCTION record_forms_template_admin_review_transition(
    TEXT, UUID, TEXT, TEXT, TEXT, TEXT, JSONB
) IS
    'P-042 §4.NEW8a + SI-023 Sub-decision 4.5 raw canonical lifecycle writer. '
    'SECURITY DEFINER + locked search_path. SOLE INSERT path into '
    'forms_template_admin_review_lifecycle_transition. EXECUTE granted ONLY '
    'to the 2 template wrapper-owner roles (anti-bypass per P-034 §3 + '
    'P-038 §3 + P-040 §3 + P-042 §3 pattern); application roles never call '
    'this directly. All business invariants (5 valid triples + unified '
    'lifecycle-invariants under one advisory lock + append-only) enforced '
    'at the table layer via migration 040 triggers + CHECK constraint.';

-- =============================================================================
-- §4 — Verification
-- =============================================================================

DO $$
DECLARE
    -- Resolve the EXACT target signature OID so all verification queries scope
    -- to record_forms_template_admin_review_transition(text, uuid, text, text,
    -- text, text, jsonb) only — no overload drift hazard.
    v_target_oid                OID := to_regprocedure(
        'public.record_forms_template_admin_review_transition(text, uuid, text, text, text, text, jsonb)'
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
            'migration-042-function-missing: '
            'record_forms_template_admin_review_transition(text, uuid, text, text, text, text, jsonb) '
            'not found by signature';
    END IF;

    -- Resolve owner + SECDEF flag + proconfig (search_path lock) for the EXACT OID
    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_function_owner, v_function_security_definer, v_function_proconfig
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_target_oid;

    IF v_function_owner <> 'forms_template_admin_review_transition_writer_owner' THEN
        RAISE EXCEPTION
            'migration-042-ownership-mismatch: '
            'record_forms_template_admin_review_transition() ownership is % '
            'but MUST be forms_template_admin_review_transition_writer_owner',
            v_function_owner;
    END IF;

    IF NOT v_function_security_definer THEN
        RAISE EXCEPTION
            'migration-042-security-definer-missing: '
            'record_forms_template_admin_review_transition() MUST be SECURITY DEFINER';
    END IF;

    -- Assert proconfig contains the canonical locked search_path. A SECDEF
    -- function without a locked search_path is vulnerable to search-path
    -- injection by a caller controlling SET (or by role-default search_path
    -- drift). The migration creates the function with
    -- SET search_path = pg_catalog, public; this assertion catches any future
    -- replacement or drift that removes the SET.
    IF v_function_proconfig IS NULL
       OR NOT (v_function_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-042-search-path-not-locked: '
            'record_forms_template_admin_review_transition() MUST have proconfig '
            'containing "search_path=pg_catalog, public"; found %',
            v_function_proconfig;
    END IF;

    -- Resolve the function's specific_name to scope information_schema grant
    -- queries by OID-equivalent identifier (information_schema doesn't expose
    -- OID directly, but specific_name uniquely identifies the function row in
    -- routines/role_routine_grants).
    SELECT p.proname || '_' || p.oid::TEXT INTO v_function_specific_name
      FROM pg_proc p WHERE p.oid = v_target_oid;

    -- Signature-scoped EXECUTE grant assertions via specific_name
    -- (information_schema's canonical OID-equivalent identifier; no overload drift).
    -- Expected: exactly 2 wrapper-owner EXECUTE grants (excluding owner-self).
    SELECT COUNT(*) INTO v_execute_grantee_count
      FROM information_schema.role_routine_grants g
     WHERE g.specific_name = v_function_specific_name
       AND g.privilege_type = 'EXECUTE'
       AND g.grantee <> 'forms_template_admin_review_transition_writer_owner';

    IF v_execute_grantee_count <> 2 THEN
        RAISE EXCEPTION
            'migration-042-execute-grant-count: '
            'expected exactly 2 wrapper-owner EXECUTE grants (excluding owner-self), '
            'found %', v_execute_grantee_count;
    END IF;

    -- Positive: every grantee must be one of the canonical 2 wrapper-owners
    -- (or the owner self).
    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_routine_grants g
         WHERE g.specific_name = v_function_specific_name
           AND g.privilege_type = 'EXECUTE'
           AND g.grantee NOT IN ('forms_template_admin_review_transition_writer_owner',
                                 'forms_template_admin_review_submit_wrapper_owner',
                                 'forms_template_admin_review_decision_wrapper_owner')
    LOOP
        RAISE EXCEPTION
            'migration-042-execute-grant-violation: '
            'record_forms_template_admin_review_transition() EXECUTE granted to '
            'non-canonical role %; canonical grantees = {2 template wrapper-owners}',
            v_unauthorized_grantee;
    END LOOP;

    -- Negative anti-bypass: PUBLIC must NOT have EXECUTE (signature-scoped).
    PERFORM 1
      FROM information_schema.role_routine_grants
     WHERE specific_name = v_function_specific_name
       AND privilege_type = 'EXECUTE'
       AND grantee = 'PUBLIC';
    IF FOUND THEN
        RAISE EXCEPTION
            'migration-042-anti-bypass-violation: '
            'PUBLIC has EXECUTE on record_forms_template_admin_review_transition() '
            '— anti-bypass discipline broken';
    END IF;
END $$;
