-- =============================================================================
-- File:    migrations/036_crisis_response_initiation_wrapper.sql
-- Purpose: Create the `record_crisis_initiation()` SECURITY DEFINER wrapper
--          per P-040 §3.2 + SI-022 Sub-decision 4 — the canonical write path
--          for new crisis events emitted by Mode 1 FLOOR-020 detection +
--          recorded by clinician / on-call / ai_mode1_service identities.
--
--          PR 4 of the Crisis Response implementation series. Inserts the
--          new crisis_event row + emits the `none → detected` lifecycle
--          transition via the raw writer from migration 035. Audit emission
--          for the Cat A `crisis.detected` event is deferred to the
--          application layer (see Option 2 adaptation note below).
--
--          PER RATIFIER OPTION 2 (carryforward):
--          - LAYER A authorization: EXECUTE grant boundary — wrapper EXECUTE
--            granted ONLY to crisis_initiator application role (membership
--            includes clinician + on-call clinician + ai_mode1_service per
--            SI-022 §7 — application layer manages role membership).
--          - LAYER C authorization: tenant-scope match via SI-010 helper
--            current_actor_account_tenant_id() = p_tenant_id. Rejects cross-
--            tenant initiation attempts at the SQL boundary (defense-in-depth
--            alongside authContextPlugin's request-time tenant binding).
--          - LAYER B authorization: deferred to application layer. The code-
--            repo trust model is that authContextPlugin verifies role
--            membership BEFORE invoking SECDEF wrappers; the LAYER A EXECUTE
--            grant is the SQL-side boundary for role-based access. SI-024.1
--            JWT-principal-to-role join via tenant_account_membership doesn't
--            exist in code repo (Option 2 deferral); the application-layer
--            role check is the equivalent LAYER B today.
--          - Audit emission deferred: FLOOR-020 fail-closed Cat A `crisis.detected`
--            audit emission is the application layer's responsibility — the
--            Fastify route handler MUST wrap the wrapper call + the audit
--            emission in a single DB transaction so a partial commit cannot
--            leave a crisis_event row without its audit record. PR 7+ will
--            land the Fastify route + audit emitter; until then this wrapper
--            is callable but the FLOOR-020 contract is enforced at
--            application-layer code-review time. Documented inline + in PR.
--          - Existing crisis_event UNIQUE on (tenant_id, server_signal_id)
--            provides idempotency at the DB layer: FLOOR-020 retries with the
--            same server_signal_id collide on the constraint + the wrapper
--            converts to a canonical idempotent-replay response.
--
-- Spec:    - SI-022 Crisis Response Slice v1.0 Sub-decision 4 wrapper
--            (record_crisis_initiation); §7 crisis_initiator role membership;
--            §6 lifecycle state machine `none → detected` triple #1
--          - CDM v1.9 → v1.10 Amendment §3.2 canonical wrapper signature +
--            body (RATIFIED 2026-05-21 P-040;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_9_to_v1_10_Amendment.md)
--          - I-019 (crisis-detection-always-on platform-floor)
--          - FLOOR-020 Cat A fail-closed audit emission discipline
--            (deferred to application layer per Option 2 — see PR description)
--          - I-035 (lifecycle_transition append-only; enforced at table layer
--            by triggers from migration 033)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS: 032_crisis_response_rbac_roles.sql + 033_crisis_response_entities.sql
--                + 035_crisis_response_raw_lifecycle_writer.sql all applied.
-- ---------------------------------------------------------------------------

-- =============================================================================
-- §1 — record_crisis_initiation() SECURITY DEFINER wrapper
--
-- Canonical entry point for new crisis events. Inserts the crisis_event row
-- with caller-supplied identity + classification fields + KMS envelope
-- (encrypted intake_payload per ADR-021), then calls the raw lifecycle
-- writer (migration 035) to emit the `none → detected / initial_detection`
-- transition.
--
-- Idempotency: crisis_event UNIQUE(tenant_id, server_signal_id) constraint
-- catches FLOOR-020 retries with the same server-signal envelope. The wrapper
-- catches unique_violation + returns the existing crisis_event_id (canonical
-- replay path) so the calling FLOOR-020 emitter sees consistent behavior on
-- retry.
--
-- Return value: the crisis_event.id (UUID). The caller emits Cat A
-- `crisis.detected` audit using this id as the resource_id.
-- =============================================================================

-- R1 HIGH-1 closure 2026-05-22 (PR 4 Codex review): p_actor_principal_id
-- parameter REMOVED. The actor identity for the lifecycle transition is now
-- BOUND from SI-010 trust anchor (current_actor_account_id()) internally —
-- caller cannot forge the principal_id. This is the canonical SECDEF
-- defense-in-depth pattern: wrapper trusts ONLY the verified actor context,
-- not caller-supplied identity parameters.
CREATE OR REPLACE FUNCTION record_crisis_initiation(
    p_tenant_id                    TEXT,
    p_patient_id                   UUID,
    p_server_signal_id             UUID,
    p_crisis_type                  TEXT,
    p_severity                     TEXT,
    p_regulatory_reporting_enabled BOOLEAN,
    -- KMS envelope for intake_payload PHI (all 8 columns or all NULL per
    -- the table's CHECK constraint at migration 033 §4)
    p_intake_payload_ciphertext    BYTEA   DEFAULT NULL,
    p_intake_payload_dek_id        UUID    DEFAULT NULL,
    p_intake_payload_dek_version   INTEGER DEFAULT NULL,
    p_intake_payload_iv            BYTEA   DEFAULT NULL,
    p_intake_payload_auth_tag      BYTEA   DEFAULT NULL,
    p_intake_payload_kek_id        UUID    DEFAULT NULL,
    p_intake_payload_kek_version   INTEGER DEFAULT NULL,
    p_intake_payload_algorithm     TEXT    DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_crisis_event_id        UUID;
    v_existing_event_id      UUID;
    v_actor_tenant_id        TEXT;
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     UUID;
BEGIN
    -- ---------------------------------------------------------------------
    -- LAYER B — bind actor identity from SI-010 trust anchor; caller cannot
    -- supply or forge the principal_id. current_actor_account_id() returns
    -- the verified-bound account identity for the current PG backend, or
    -- NULL if no actor context bound (fail-closed per SI-010 pattern).
    -- ---------------------------------------------------------------------
    v_actor_account_id_text := current_actor_account_id();
    IF v_actor_account_id_text IS NULL THEN
        RAISE EXCEPTION
            'record_crisis_initiation: no actor account bound for current backend; authContextPlugin must bind before SECDEF wrapper invocation'
            USING ERRCODE = '42501';
    END IF;
    -- account_id is stored as TEXT in SI-010 _session_actor_context (variable-shape
    -- identifier per code-repo convention); the lifecycle_transition.actor_principal_id
    -- column is UUID. Cast with explicit error message on malformed input.
    BEGIN
        v_actor_principal_id := v_actor_account_id_text::UUID;
    EXCEPTION
        WHEN invalid_text_representation THEN
            RAISE EXCEPTION
                'record_crisis_initiation: bound actor account_id % is not a valid UUID; cannot record as lifecycle actor_principal_id',
                v_actor_account_id_text
                USING ERRCODE = '42501';
    END;

    -- ---------------------------------------------------------------------
    -- LAYER C — tenant scope match (defense-in-depth alongside LAYER A
    -- EXECUTE grant which restricts to crisis_initiator role members).
    -- current_actor_account_tenant_id() returns NULL if no actor context
    -- is bound for the current PG backend (fails closed per SI-010
    -- trust-anchor pattern).
    -- ---------------------------------------------------------------------
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION
            'record_crisis_initiation: no actor tenant bound for current backend'
            USING ERRCODE = '42501';
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION
            'record_crisis_initiation: tenant scope mismatch — actor tenant % does not match wrapper p_tenant_id %; cross-tenant initiation rejected',
            v_actor_tenant_id, p_tenant_id
            USING ERRCODE = '42501';
    END IF;

    -- ---------------------------------------------------------------------
    -- Idempotency check: FLOOR-020 retries land on the existing crisis_event
    -- via UNIQUE(tenant_id, server_signal_id). Return existing id without
    -- inserting a duplicate or emitting a duplicate lifecycle transition.
    -- ---------------------------------------------------------------------
    SELECT id INTO v_existing_event_id
      FROM public.crisis_event
     WHERE tenant_id = p_tenant_id
       AND server_signal_id = p_server_signal_id;
    IF v_existing_event_id IS NOT NULL THEN
        RETURN v_existing_event_id;  -- canonical idempotent replay
    END IF;

    -- ---------------------------------------------------------------------
    -- Insert new crisis_event row. CHECK constraints at table layer
    -- (migration 033 §4) enforce crisis_type enum, severity enum, KMS
    -- envelope coherence (all 8 columns or all NULL).
    -- ---------------------------------------------------------------------
    BEGIN
        INSERT INTO public.crisis_event (
            tenant_id, patient_id, server_signal_id,
            crisis_type, severity, regulatory_reporting_enabled,
            intake_payload_ciphertext, intake_payload_dek_id,
            intake_payload_dek_version, intake_payload_iv,
            intake_payload_auth_tag, intake_payload_kek_id,
            intake_payload_kek_version, intake_payload_algorithm
        ) VALUES (
            p_tenant_id, p_patient_id, p_server_signal_id,
            p_crisis_type, p_severity, p_regulatory_reporting_enabled,
            p_intake_payload_ciphertext, p_intake_payload_dek_id,
            p_intake_payload_dek_version, p_intake_payload_iv,
            p_intake_payload_auth_tag, p_intake_payload_kek_id,
            p_intake_payload_kek_version, p_intake_payload_algorithm
        )
        RETURNING id INTO v_crisis_event_id;
    EXCEPTION
        WHEN unique_violation THEN
            -- Concurrent FLOOR-020 retry won the race; re-read the now-committed
            -- row + return its id (same canonical idempotent replay path as the
            -- pre-INSERT check above).
            SELECT id INTO v_crisis_event_id
              FROM public.crisis_event
             WHERE tenant_id = p_tenant_id
               AND server_signal_id = p_server_signal_id;
            RETURN v_crisis_event_id;
    END;

    -- ---------------------------------------------------------------------
    -- Emit `none → detected / initial_detection` lifecycle transition via
    -- the raw writer (migration 035). The raw writer's monotonic-ordering
    -- trigger takes an advisory lock keyed by (tenant_id, crisis_event_id)
    -- and asserts ordering invariants under it.
    -- ---------------------------------------------------------------------
    PERFORM public.record_crisis_event_lifecycle_transition(
        p_tenant_id,
        v_crisis_event_id,
        'none',
        'detected',
        'initial_detection',
        v_actor_principal_id,  -- bound from SI-010 (R1 HIGH-1 closure); caller cannot forge
        NULL  -- transition_payload — caller's audit emission carries the descriptive payload
    );

    RETURN v_crisis_event_id;
END;
$$;

-- =============================================================================
-- §2 — Function ownership + initiation_wrapper_owner role grants
-- =============================================================================

ALTER FUNCTION record_crisis_initiation(
    TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) OWNER TO crisis_initiation_wrapper_owner;

-- initiation_wrapper_owner needs:
-- - INSERT + SELECT on crisis_event (for the new-row INSERT + idempotency check)
-- - EXECUTE on record_crisis_event_lifecycle_transition (granted at migration 035 §3)
-- - EXECUTE on current_actor_account_id() + current_actor_account_tenant_id() SI-010
--   helpers (migration 031 only grants these to telecheck_app_role; wrapper-owner
--   needs explicit grants for SECURITY DEFINER execution under its own identity).
--   R2 HIGH-1 closure 2026-05-22 (PR 4 Codex review): without these grants the
--   internal-actor-binding from R1 HIGH-1 closure would fail at runtime with
--   permission_denied for function ... on every legitimate caller.
GRANT INSERT, SELECT ON crisis_event TO crisis_initiation_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_id() TO crisis_initiation_wrapper_owner;
GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO crisis_initiation_wrapper_owner;

-- =============================================================================
-- §3 — Anti-bypass EXECUTE grant matrix: ONLY crisis_initiator application role
-- =============================================================================

REVOKE EXECUTE ON FUNCTION record_crisis_initiation(
    TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_crisis_initiation(
    TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) TO crisis_initiator;

COMMENT ON FUNCTION record_crisis_initiation(
    TEXT, UUID, UUID, TEXT, TEXT, BOOLEAN,
    BYTEA, UUID, INTEGER, BYTEA, BYTEA, UUID, INTEGER, TEXT
) IS
    'P-040 §3.2 + SI-022 Sub-decision 4 record_crisis_initiation wrapper. '
    'SECURITY DEFINER + locked search_path. SOLE entry point for new crisis_event rows. '
    'EXECUTE granted ONLY to crisis_initiator role (application-layer authContextPlugin '
    'manages membership: clinician + on-call clinician + ai_mode1_service). '
    'Idempotent via crisis_event UNIQUE(tenant_id, server_signal_id) — FLOOR-020 retries '
    'return existing crisis_event_id. Audit emission for Cat A crisis.detected event '
    'deferred to application layer (PR 7+ Fastify route + emitAudit() wrap in single tx).';

-- =============================================================================
-- §4 — Verification (signature-exact via to_regprocedure per PR 3 pattern)
-- =============================================================================

DO $$
DECLARE
    v_target_oid OID := to_regprocedure(
        'public.record_crisis_initiation(text, uuid, uuid, text, text, boolean, bytea, uuid, integer, bytea, bytea, uuid, integer, text)'
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
            'migration-036-function-missing: record_crisis_initiation() not found by signature';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig
      INTO v_function_owner, v_function_security_definer, v_function_proconfig
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_target_oid;

    IF v_function_owner <> 'crisis_initiation_wrapper_owner' THEN
        RAISE EXCEPTION
            'migration-036-ownership-mismatch: record_crisis_initiation() ownership is % but MUST be crisis_initiation_wrapper_owner',
            v_function_owner;
    END IF;

    IF NOT v_function_security_definer THEN
        RAISE EXCEPTION
            'migration-036-security-definer-missing: record_crisis_initiation() MUST be SECURITY DEFINER';
    END IF;

    IF v_function_proconfig IS NULL
       OR NOT (v_function_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-036-search-path-not-locked: record_crisis_initiation() MUST have proconfig containing "search_path=pg_catalog, public"; found %',
            v_function_proconfig;
    END IF;

    SELECT p.proname || '_' || p.oid::TEXT INTO v_function_specific_name
      FROM pg_proc p WHERE p.oid = v_target_oid;

    -- EXECUTE grant matrix: exactly 1 (crisis_initiator), excluding owner-self.
    SELECT COUNT(*) INTO v_execute_grantee_count
      FROM information_schema.role_routine_grants g
     WHERE g.specific_name = v_function_specific_name
       AND g.privilege_type = 'EXECUTE'
       AND g.grantee <> 'crisis_initiation_wrapper_owner';

    IF v_execute_grantee_count <> 1 THEN
        RAISE EXCEPTION
            'migration-036-execute-grant-count: expected exactly 1 application-role EXECUTE grant (crisis_initiator), found %',
            v_execute_grantee_count;
    END IF;

    FOR v_unauthorized_grantee IN
        SELECT g.grantee
          FROM information_schema.role_routine_grants g
         WHERE g.specific_name = v_function_specific_name
           AND g.privilege_type = 'EXECUTE'
           AND g.grantee NOT IN ('crisis_initiation_wrapper_owner', 'crisis_initiator')
    LOOP
        RAISE EXCEPTION
            'migration-036-execute-grant-violation: record_crisis_initiation() EXECUTE granted to non-canonical role %; canonical grantee = crisis_initiator',
            v_unauthorized_grantee;
    END LOOP;

    PERFORM 1
      FROM information_schema.role_routine_grants
     WHERE specific_name = v_function_specific_name
       AND privilege_type = 'EXECUTE'
       AND grantee = 'PUBLIC';
    IF FOUND THEN
        RAISE EXCEPTION
            'migration-036-anti-bypass-violation: PUBLIC has EXECUTE on record_crisis_initiation()';
    END IF;

    -- R2 HIGH-1 closure 2026-05-22: assert wrapper-owner has EXECUTE on the
    -- 2 SI-010 helpers the wrapper body calls. Without these, the SECDEF
    -- function fails at runtime for every legitimate caller.
    IF NOT has_function_privilege(
        'crisis_initiation_wrapper_owner', 'public.current_actor_account_id()', 'EXECUTE'
    ) THEN
        RAISE EXCEPTION
            'migration-036-helper-grant-missing: crisis_initiation_wrapper_owner lacks EXECUTE on current_actor_account_id() — R2 HIGH-1 closure broken';
    END IF;
    IF NOT has_function_privilege(
        'crisis_initiation_wrapper_owner', 'public.current_actor_account_tenant_id()', 'EXECUTE'
    ) THEN
        RAISE EXCEPTION
            'migration-036-helper-grant-missing: crisis_initiation_wrapper_owner lacks EXECUTE on current_actor_account_tenant_id() — wrapper LAYER C check broken';
    END IF;
END $$;
