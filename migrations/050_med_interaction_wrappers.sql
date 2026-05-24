-- =============================================================================
-- File:    migrations/050_med_interaction_wrappers.sql
-- Purpose: Create the 6 reason-specific SECURITY DEFINER wrappers per CDM
--          v1.6 â†’ v1.7 Amendment Â§6.NEW2-NEW7 (RATIFIED 2026-05-21 P-034).
--
--          PR 5 of the Med-Interaction Engine implementation series.
--          Subsequent: Fastify handler implementation + Cat A audit emission
--          + integration tests (PR 6+).
--
--          5 LIFECYCLE WRAPPERS (Â§6.NEW2-NEW6):
--          - record_signal_emission     â€” initial signal â†’ emitted
--          - record_signal_activation   â€” emitted â†’ active
--          - record_signal_supersession â€” active â†’ superseded
--          - record_signal_resolution   â€” active â†’ resolved
--          - record_signal_expiry       â€” active â†’ expired
--
--          1 OVERRIDE WRAPPER (Â§6.NEW7):
--          - record_interaction_signal_override â€” atomically INSERTs
--            interaction_signal_override row + lifecycle transition
--            (overrideâ†’activeâ†’overridden) under per-(tenant,signal) lock
--            matching PR 4 raw-writer R1 closure contract
--
--          Each wrapper:
--          - SECURITY DEFINER + locked search_path = pg_catalog, public
--          - OWNED BY interaction_signal_<reason>_wrapper_owner
--          - REVOKE EXECUTE FROM PUBLIC + GRANT EXECUTE to ONE specific
--            app-role caller per spec Â§6 table
--          - SI-010 tenant guard via current_actor_account_tenant_id()
--          - Per-(tenant, signal) advisory lock (matches raw writer's lock
--            domain in migration 049 R1 closure + migration 047 monotonic
--            trigger; canonical per-signal serialization)
--          - Reason-specific evidence validation BEFORE calling raw writer
--          - Delegates state-machine transition INSERT to raw writer
--            (record_interaction_signal_lifecycle_transition; migration 049)
--
--          PER RATIFIER OPTION 2 (carryforward from PR 1-4 + Crisis Response
--          + Admin Backend):
--          - PROCEDURE â†’ FUNCTION RETURNS VOID (code-repo precedent)
--          - SI-024.1 JWT-binding + verify_session_jwt_and_extract_claims +
--            jwt_migration_entity_status + raw_guc_fallback_audit helpers
--            â†’ SI-010 actor binding only (current_actor_account_id +
--            current_actor_account_tenant_id). The spec's elaborate JWT-
--            phase-B-fallback authorization logic is REPLACED by SI-010
--            actor binding for the wrapper tenant guard; APP-LAYER
--            role-membership check (LAYER B) is deferred to the Fastify
--            route handler in PR 6+, mirroring the Admin Backend wrapper
--            pattern from migration 043.
--          - tenant_id_t â†’ TEXT; ulid_t â†’ VARCHAR(26); custom DOMAIN enum
--            types â†’ TEXT.
--          - p_id parameter (caller-supplied ULID) for all wrappers.
--          - Dotted spec role names normalized to underscore form per
--            migration 046 Â§2 (medication_interaction.override_recorder
--            â†’ medication_interaction_override_recorder, etc.).
--          - Wrapper-owner role names: interaction_signal_<reason>_wrapper_owner
--            per migration 046 Â§2 cross-slice-collision-safety convention.
--          - Reason-specific evidence checks that reference entities NOT
--            in code repo (engine_version config table, medication-
--            discontinuation domain-event log, replacement-evaluation
--            cross-check via patient_id which doesn't have FK, etc.) are
--            DEFERRED to PR 6+ application-layer evidence validation;
--            documented inline + flagged as TODO. The structural wrapper
--            pattern (tenant guard + advisory lock + raw writer call) is
--            complete + Codex-reviewable; evidence-check evolution
-- happens when the dependent entities/events land.
--
-- Spec:    - SI-019 Medication Interaction & Validation Engine Slice PRD
--            v2.0 Â§Sub-decision 8 (override wrapper STEP 0-8) + Â§Sub-
--            decision 8.5 (raw writer + per-reason wrapper architecture)
--          - CDM v1.6 â†’ v1.7 Amendment Â§6.NEW2-NEW7 (RATIFIED 2026-05-21
--            P-034)
--          - I-002 (interaction-before-commit; this slice's wrappers are
--            the SOLE write path into the lifecycle state machine that
--            Pharmacy + Async Consult commit-gates read)
--          - I-023, I-027, I-035
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PRECONDITIONS:
--   031_session_actor_context.sql                applied (SI-010 helpers)
--   046_med_interaction_rbac_roles.sql           applied (12 roles)
--   047_med_interaction_entities.sql             applied (4 entities + triggers)
--   048_med_interaction_view_mv_access_function.sql applied (view + MV)
--   049_med_interaction_raw_lifecycle_writer.sql applied (raw writer SECDEF +
--                                                  anti-bypass grants to 6
--                                                  wrapper-owner roles)
-- ---------------------------------------------------------------------------

-- =============================================================================
-- COMMON HELPER MACRO PATTERN (inlined into each wrapper):
--
-- Each wrapper body begins with:
--   1. SI-010 tenant guard:
--        v_actor_tenant_id := current_actor_account_tenant_id();
--        IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
--            RAISE EXCEPTION '<wrapper-name>: tenant scope mismatch' USING ERRCODE = '42501';
--        END IF;
--
--   2. Per-(tenant, signal) advisory lock:
--        v_lock_key := ('x' || substr(md5(p_tenant_id || ':' || p_signal_id), 1, 16))::bit(64)::bigint;
--        PERFORM pg_advisory_xact_lock(v_lock_key);
--      (Matches raw-writer + migration 047 monotonic-trigger lock key shape.
--       Concurrent calls for same (tenant, signal) serialize through this lock.)
--
--   3. Reason-specific evidence check (per-wrapper body below).
--
--   4. Call raw writer: PERFORM record_interaction_signal_lifecycle_transition(...).
--      (The raw writer re-acquires the same advisory lock â€” re-entrant
--       within the same transaction per pg_advisory_xact_lock semantics.
--       This is intentional belt-and-suspenders; the wrapper's lock guards
--       the evidence check, the raw writer's lock guards the trigger's
--       state-continuity + monotonic-ordering reads.)
-- =============================================================================

-- =============================================================================
-- Â§1 â€” record_signal_emission (CDM Â§6.NEW2)
--
-- Transition: none â†’ emitted / emission
-- App-role caller: medication_interaction_engine_evaluator
-- Reason-specific evidence (DEFERRED to app layer per Option 2):
--   - Paired interaction_signal row exists (validated here: SELECT EXISTS)
--   - engine_version + knowledge_base_version match active config
--     (DEFERRED: engine_version config table not in code repo)
-- =============================================================================

CREATE OR REPLACE FUNCTION record_signal_emission(
    p_id            VARCHAR(26),
    p_tenant_id     TEXT,
    p_signal_id     VARCHAR(26),
    p_actor_id      VARCHAR(26),
    p_metadata      JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id  TEXT;
    v_lock_key         BIGINT;
BEGIN
    -- SI-010 tenant guard
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_signal_emission: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    -- Per-(tenant, signal) advisory lock (matches PR 4 R1 closure + monotonic trigger key)
    v_lock_key := ('x' || substr(md5(p_tenant_id::text || ':' || p_signal_id::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Evidence check: paired interaction_signal row exists.
    IF NOT EXISTS (
        SELECT 1 FROM public.interaction_signal
         WHERE tenant_id = p_tenant_id AND id = p_signal_id
    ) THEN
        RAISE EXCEPTION 'paired_signal_not_found: signal_id=%', p_signal_id
            USING ERRCODE = '02000';    -- no_data
    END IF;

    -- TODO (Option 2 deferred): engine_version + knowledge_base_version
    -- match-active-config check (engine_version config table not in code
    -- repo at this checkpoint).

    -- Delegate to raw writer (advisory lock is re-entrant within same tx).
    PERFORM record_interaction_signal_lifecycle_transition(
        p_id, p_tenant_id, p_signal_id,
        'emitted', 'emission',
        p_actor_id, 'engine_evaluator',
        p_metadata
    );
END;
$$;

ALTER FUNCTION record_signal_emission(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB)
    OWNER TO emission_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_signal_emission(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_signal_emission(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB)
    TO medication_interaction_engine_evaluator;

-- =============================================================================
-- Â§2 â€” record_signal_activation (CDM Â§6.NEW3)
--
-- Transition: emitted â†’ active / activation
-- App-role caller: medication_interaction_engine_evaluator
-- Reason-specific evidence:
--   - Signal's current state is 'emitted' (validated here via latest-to_state query)
--   - No override recorded (defense-in-depth with raw writer STEP 3.5)
-- =============================================================================

CREATE OR REPLACE FUNCTION record_signal_activation(
    p_id            VARCHAR(26),
    p_tenant_id     TEXT,
    p_signal_id     VARCHAR(26),
    p_actor_id      VARCHAR(26),
    p_metadata      JSONB
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
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_signal_activation: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    v_lock_key := ('x' || substr(md5(p_tenant_id::text || ':' || p_signal_id::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Evidence: signal's current state is 'emitted'.
    SELECT to_state INTO v_latest_to_state
      FROM public.interaction_signal_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND signal_id = p_signal_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;
    IF v_latest_to_state IS DISTINCT FROM 'emitted' THEN
        RAISE EXCEPTION 'signal_not_emitted: current_state=%', COALESCE(v_latest_to_state, '<none>')
            USING ERRCODE = '23514';
    END IF;

    -- Defense-in-depth: no override recorded (raw writer STEP 3.5 also checks).
    -- Same advisory lock â€” override wrapper (Â§7) acquires same lock, so race is closed.
    IF EXISTS (
        SELECT 1 FROM public.interaction_signal_override
         WHERE tenant_id = p_tenant_id AND signal_id = p_signal_id
    ) THEN
        RAISE EXCEPTION 'activation_blocked_by_override: signal_id=%', p_signal_id
            USING ERRCODE = '23514';
    END IF;

    PERFORM record_interaction_signal_lifecycle_transition(
        p_id, p_tenant_id, p_signal_id,
        'active', 'activation',
        p_actor_id, 'engine_evaluator',
        p_metadata
    );
END;
$$;

ALTER FUNCTION record_signal_activation(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB)
    OWNER TO activation_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_signal_activation(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_signal_activation(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB)
    TO medication_interaction_engine_evaluator;

-- Wrapper-owner needs SELECT on lifecycle_transition (for latest-to_state read) + override (for evidence check).
GRANT SELECT ON interaction_signal_lifecycle_transition TO activation_wrapper_owner;
GRANT SELECT ON interaction_signal_override             TO activation_wrapper_owner;

-- =============================================================================
-- Â§3 â€” record_signal_supersession (CDM Â§6.NEW4)
--
-- Transition: active â†’ superseded / superseded_by_evaluation
-- App-role caller: medication_interaction_engine_evaluator
-- Reason-specific evidence (PARTIAL per Option 2):
--   - Replacement evaluation_id exists in interaction_engine_evaluation
--   - Same-tenant (composite FK enforces)
--   - DEFERRED: same patient + check_class + overlapping medications_involved
--     (requires cross-table join; structural complete; predicate refinement
--      in PR 6+ once Pharmacy + Async Consult patient model lands)
-- =============================================================================

CREATE OR REPLACE FUNCTION record_signal_supersession(
    p_id                       VARCHAR(26),
    p_tenant_id                TEXT,
    p_signal_id                VARCHAR(26),
    p_replacement_evaluation_id VARCHAR(26),
    p_actor_id                 VARCHAR(26),
    p_metadata                 JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id  TEXT;
    v_lock_key         BIGINT;
BEGIN
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_signal_supersession: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    v_lock_key := ('x' || substr(md5(p_tenant_id::text || ':' || p_signal_id::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Evidence: replacement_evaluation_id exists in same tenant.
    IF NOT EXISTS (
        SELECT 1 FROM public.interaction_engine_evaluation
         WHERE tenant_id = p_tenant_id AND id = p_replacement_evaluation_id
    ) THEN
        RAISE EXCEPTION 'replacement_evaluation_not_found: evaluation_id=%', p_replacement_evaluation_id
            USING ERRCODE = '02000';
    END IF;

    -- TODO (Option 2 deferred): same patient + check_class + overlapping
    -- medications_involved predicate refinement when Pharmacy + Async
    -- Consult patient model lands.

    PERFORM record_interaction_signal_lifecycle_transition(
        p_id, p_tenant_id, p_signal_id,
        'superseded', 'superseded_by_evaluation',
        p_actor_id, 'engine_evaluator',
        p_metadata || jsonb_build_object('superseded_by_evaluation_id', p_replacement_evaluation_id)
    );
END;
$$;

ALTER FUNCTION record_signal_supersession(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), JSONB)
    OWNER TO superseded_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_signal_supersession(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_signal_supersession(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), JSONB)
    TO medication_interaction_engine_evaluator;

GRANT SELECT ON interaction_engine_evaluation TO superseded_wrapper_owner;

-- =============================================================================
-- Â§4 â€” record_signal_resolution (CDM Â§6.NEW5)
--
-- Transition: active â†’ resolved / resolution_event
-- App-role caller: medication_interaction_resolution_subscriber (Async Consult)
-- Reason-specific evidence (DEFERRED per Option 2):
--   - Discontinuation event exists in medication-discontinuation domain-event log
--     (DEFERRED: domain-event log not in code repo; structural complete)
--   - Affects one of medications_involved
--   - Protocol-specific washout period elapsed
-- =============================================================================

CREATE OR REPLACE FUNCTION record_signal_resolution(
    p_id                       VARCHAR(26),
    p_tenant_id                TEXT,
    p_signal_id                VARCHAR(26),
    p_discontinuation_event_id VARCHAR(26),
    p_actor_id                 VARCHAR(26),
    p_metadata                 JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id  TEXT;
    v_lock_key         BIGINT;
BEGIN
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_signal_resolution: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    v_lock_key := ('x' || substr(md5(p_tenant_id::text || ':' || p_signal_id::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- R1 HIGH-1 closure 2026-05-23 (Codex R1): FAIL-CLOSED. SI-019
    -- Â§6.NEW5 normatively requires resolution-specific evidence:
    -- (a) discontinuation event exists in medication-discontinuation
    --     domain-event log,
    -- (b) affects one of medications_involved,
    -- (c) protocol-specific washout period elapsed.
    -- None of these data sources exist in code repo at this checkpoint.
    -- Per Codex R1 recommendation, the wrapper RAISES not-implemented
    -- here so a stale, malformed, cross-tenant, or unrelated event_id
    -- cannot produce a terminal `resolved` transition that downstream
    -- commit gates (Pharmacy clinician-commit per I-002; Async Consult)
    -- would read as authoritative.
    --
    -- The wrapper SIGNATURE + tenant guard + advisory lock + EXECUTE
    -- grant matrix remain in place for structural completeness +
    -- downstream-slice typed imports; production callers hit this
    -- RAISE and must be retried after the future migration that lands
    -- the medication-discontinuation domain-event log + implements the
    -- 3-evidence-check predicate.
    RAISE EXCEPTION
        'evidence_check_unavailable_resolution: '
        'SI-019 Â§6.NEW5 requires discontinuation_event existence + '
        'medication-affected + washout-elapsed evidence checks; '
        'medication-discontinuation domain-event log not yet available '
        'in code repo. Wrapper fail-closed per Codex R1 closure 2026-05-23 '
        'to prevent terminal-state-without-evidence corruption of '
        'downstream commit gates.'
        USING ERRCODE = '0A000';    -- feature_not_supported

    -- UNREACHABLE (preserved for structural completeness; PR 6+ or
    -- future hygiene migration that lands the discontinuation event log
    -- will replace the RAISE above with the 3-evidence-check predicate
    -- + then enable this PERFORM call):
    -- PERFORM record_interaction_signal_lifecycle_transition(
    --     p_id, p_tenant_id, p_signal_id,
    --     'resolved', 'resolution_event',
    --     p_actor_id, 'system',
    --     p_metadata || jsonb_build_object('discontinuation_event_id', p_discontinuation_event_id)
    -- );
END;
$$;

-- NOTE: medication_interaction_resolution_subscriber role is "defined elsewhere"
-- per CDM Â§8 (Async Consult slice domain-event subscriber registry). Migration
-- 046 Â§0 carve-out preserved that it is NOT created here. Grant deferred.
ALTER FUNCTION record_signal_resolution(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), JSONB)
    OWNER TO resolution_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_signal_resolution(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), VARCHAR(26), JSONB) FROM PUBLIC;
-- GRANT EXECUTE TO medication_interaction_resolution_subscriber  -- DEFERRED:
-- role exists only after Async Consult subscriber registry lands. Until then,
-- ONLY the owner can EXECUTE (effectively no callers). The Async Consult slice
-- migration that creates the subscriber role will also grant EXECUTE here.

-- =============================================================================
-- Â§5 â€” record_signal_expiry (CDM Â§6.NEW6)
--
-- Transition: active â†’ expired / time_expiry
-- App-role caller: medication_interaction_engine_evaluator (scheduler)
-- Reason-specific evidence:
--   - signal_payload.time_window_basis non-NULL
--   - Window end-time elapsed (now() > emission_time + time_window)
-- =============================================================================

CREATE OR REPLACE FUNCTION record_signal_expiry(
    p_id            VARCHAR(26),
    p_tenant_id     TEXT,
    p_signal_id     VARCHAR(26),
    p_actor_id      VARCHAR(26),
    p_metadata      JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_actor_tenant_id     TEXT;
    v_lock_key            BIGINT;
    v_signal_payload      JSONB;
    v_emission_time       TIMESTAMPTZ;
    v_time_window_basis   TEXT;
BEGIN
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL OR v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION 'record_signal_expiry: tenant scope mismatch'
            USING ERRCODE = '42501';
    END IF;

    v_lock_key := ('x' || substr(md5(p_tenant_id::text || ':' || p_signal_id::text), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Evidence: read signal_payload to check time_window_basis.
    SELECT signal_payload INTO v_signal_payload
      FROM public.interaction_signal
     WHERE tenant_id = p_tenant_id AND id = p_signal_id;
    IF v_signal_payload IS NULL THEN
        RAISE EXCEPTION 'signal_not_found: signal_id=%', p_signal_id
            USING ERRCODE = '02000';
    END IF;

    v_time_window_basis := v_signal_payload->>'time_window_basis';
    IF v_time_window_basis IS NULL THEN
        RAISE EXCEPTION 'expiry_premature: signal has no time_window_basis (non-expiring signal class)'
            USING ERRCODE = '23514';
    END IF;

    -- Evidence: window end-time elapsed. Read emission timestamp from the
    -- first lifecycle_transition row (transition_reason='emission').
    SELECT transition_at INTO v_emission_time
      FROM public.interaction_signal_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND signal_id = p_signal_id
       AND transition_reason = 'emission'
     ORDER BY transition_at ASC, id ASC
     LIMIT 1;
    IF v_emission_time IS NULL THEN
        RAISE EXCEPTION 'expiry_no_emission_row: signal has no emission transition'
            USING ERRCODE = '02000';
    END IF;

    -- R1 HIGH-1 closure 2026-05-23 (Codex R1): FAIL-CLOSED. SI-019
    -- Â§6.NEW6 normatively requires `now() > emission_time + time_window`
    -- where time_window is derived per-basis from signal_payload
    -- (per-basis duration formula: prescription_cycle, monitoring_interval,
    -- etc.). The per-basis formula table is not yet specified in code
    -- repo (would require a CCR-driven cadence config table). Without
    -- the formula, the wrapper cannot prove the window has elapsed â€”
    -- so it must fail-closed rather than allow premature expiry.
    --
    -- Premature expiry would let any caller with
    -- medication_interaction_engine_evaluator role mark an active signal
    -- expired as soon as it has an emission row â€” a terminal-state
    -- corruption that downstream Pharmacy clinician-commit + Async
    -- Consult commit gates would read as "interaction no longer
    -- relevant" while the underlying clinical risk persists.
    --
    -- The structural checks above (time_window_basis non-null + emission
    -- row exists) remain in place as preflight; PR 6+ or future hygiene
    -- migration that lands the per-basis cadence config table will
    -- replace the RAISE below with the actual elapsed-time predicate.
    RAISE EXCEPTION
        'evidence_check_unavailable_expiry: '
        'SI-019 Â§6.NEW6 requires time_window_basis-driven elapsed-time '
        'check (now() > emission_time + per_basis_duration); per-basis '
        'cadence config table not yet available in code repo. Wrapper '
        'fail-closed per Codex R1 closure 2026-05-23 to prevent premature '
        'expiry corruption of downstream commit gates. time_window_basis=%, '
        'emission_time=%',
        v_time_window_basis, v_emission_time
        USING ERRCODE = '0A000';    -- feature_not_supported

    -- UNREACHABLE (preserved for structural completeness):
    -- PERFORM record_interaction_signal_lifecycle_transition(
    --     p_id, p_tenant_id, p_signal_id,
    --     'expired', 'time_expiry',
    --     p_actor_id, 'scheduler',
    --     p_metadata || jsonb_build_object('time_window_basis', v_time_window_basis)
    -- );
END;
$$;

ALTER FUNCTION record_signal_expiry(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB)
    OWNER TO expiry_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_signal_expiry(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_signal_expiry(VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26), JSONB)
    TO medication_interaction_engine_evaluator;

GRANT SELECT ON interaction_signal                       TO expiry_wrapper_owner;
GRANT SELECT ON interaction_signal_lifecycle_transition  TO expiry_wrapper_owner;

-- =============================================================================
-- Â§6 â€” record_interaction_signal_override (CDM Â§6.NEW7)
--
-- Atomic INSERT-override-FIRST then lifecycle-transition pattern (per
-- SI-019 Sub-decision 8 R4 HIGH-1 closure inverted order: override
-- row written FIRST so a lifecycle-write failure cannot leave a terminal
-- transition without evidence).
--
-- Transition: active â†’ overridden / override
-- App-role caller: medication_interaction_override_recorder (clinician)
--
-- Steps (adapted from spec Â§6.NEW7 8-step pattern):
--   STEP 0 â€” SI-010 tenant guard
--   STEP 1 â€” auth via EXECUTE grant (LAYER A; LAYER B role-membership
--            check deferred to Fastify route handler in PR 6+)
--   STEP 2 â€” idempotency: caller-supplied idempotency key handled at
--            HTTP layer in PR 6+ (no separate idempotency_key table in
--            this slice; consistent with Crisis Response pattern)
--   STEP 3 â€” medication-still-on-active-list check DEFERRED per Option 2
--            (active-medication-list view not in code repo)
--   STEP 4 â€” clinician role check DEFERRED to Fastify route LAYER B
--   STEP 4.5 â€” per-(tenant, signal) advisory lock (acquired right after
--              tenant guard; spec STEP 4.5 just before INSERT here too)
--   STEP 5 â€” INSERT interaction_signal_override row
--   STEP 6 â€” call raw writer for 'override' transition
--   STEP 7 â€” unique_violation safety net (composite UNIQUE on (tenant_id, id))
--   STEP 8 â€” caller-managed COMMIT
-- =============================================================================

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
    -- lock key per PR 4 R1 closure contract â€” serializes override creation
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

    -- R1 HIGH-1 closure 2026-05-23 (Codex R1): FAIL-CLOSED. SI-019
    -- Â§6.NEW7 normatively requires evidence that:
    -- (a) the medication being overridden is STILL on the patient's
    --     active-medication list (Step 3 of spec 8-step procedure), and
    -- (b) the calling clinician is RBAC-authorized for the override
    --     action (LAYER B role-membership check, Step 4 of spec).
    -- Neither evidence source is available in code repo at this
    -- checkpoint: (a) active-medication-list view depends on Pharmacy
    -- slice's medication_request_state derivation not yet implemented,
    -- and (b) LAYER B role-membership check requires the SI-024.1
    -- JWT-binding model that is deferred (Option 2 carryforward â€”
    -- LAYER B lands at Fastify route handler in PR 6+).
    --
    -- Override is a TERMINAL lifecycle state. Without the evidence
    -- checks, the DB-level SECURITY DEFINER wrapper can be invoked
    -- by anyone holding the EXECUTE grant (which the spec grants to
    -- the clinician application role for the WRAPPER, but the spec
    -- relies on LAYER B + medication-list evidence to make the
    -- wrapper actually safe). Deferring those checks to Fastify
    -- means a compromised route + the right EXECUTE grant would
    -- bypass both, creating an authorized-on-paper-but-unverifiable
    -- terminal override.
    --
    -- Per Codex R1 recommendation, the wrapper fail-closes here. PR 6+
    -- (Fastify handler) + future Pharmacy + SI-024.1 work removes the
    -- RAISE below + adds the evidence checks.
    RAISE EXCEPTION
        'evidence_check_unavailable_override: '
        'SI-019 Â§6.NEW7 requires (a) medication-still-on-active-list '
        'check (Pharmacy active-medication-list view not yet in code '
        'repo) AND (b) LAYER B clinician role-membership check '
        '(SI-024.1 JWT-binding deferred). Wrapper fail-closed per Codex '
        'R1 closure 2026-05-23 to prevent unverified terminal override '
        'writes; PR 6+ application-layer evidence checks + LAYER B '
        'authorization re-enables this wrapper.'
        USING ERRCODE = '0A000';    -- feature_not_supported

    /*
    -- R2 CRITICAL closure 2026-05-23 (Codex R2): UNREACHABLE block wrapped
    -- in PostgreSQL block comment so that the surrounding RAISE EXCEPTION
    -- is the only executable statement after the active-state check. The
    -- prior commit (R1 closure) accidentally left this block as live SQL,
    -- which (a) PostgreSQL parses at CREATE FUNCTION time + would have
    -- blocked migration application, AND (b) would silently become live
    -- if a future PR removes the RAISE without first replacing the
    -- evidence-deferred TODO sources. Block-comment isolates the code
    -- so neither hazard applies.
    --
    -- When PR 6+ work + Pharmacy active-medication-list view +
    -- SI-024.1 LAYER B work lands, the closure pattern is:
    --   1. Remove the RAISE EXCEPTION above
    --   2. Add the 2 evidence checks where the RAISE was
    --   3. Remove THIS block comment wrapper to re-enable the INSERT +
    --      PERFORM below
    -- All three steps MUST happen in the same migration; partial uncomment
    -- (just removing the RAISE) would re-introduce the R1 finding.

    -- STEP 5: INSERT override row FIRST (per R4 HIGH-1 closure: write
    -- evidence before terminal transition so a wrapper failure can't
    -- leave a terminal lifecycle row without its evidence).
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

    -- STEP 6: call raw writer for 'override' transition; metadata carries
    -- the override_id so audit + domain-event downstream can correlate.
    PERFORM record_interaction_signal_lifecycle_transition(
        p_lifecycle_transition_id, p_tenant_id, p_signal_id,
        'overridden', 'override',
        p_clinician_account_id, 'clinician',
        p_metadata || jsonb_build_object('override_id', p_override_id)
    );

    -- TODO (Option 2 deferred): STEP 3 medication-still-on-active-list
    -- check (active-medication-list view not in code repo); STEP 4 LAYER B
    -- clinician role-membership check (deferred to Fastify route handler).
    */
END;
$$;

ALTER FUNCTION record_interaction_signal_override(
    VARCHAR(26), VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26),
    BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ,
    JSONB
) OWNER TO override_wrapper_owner;
REVOKE EXECUTE ON FUNCTION record_interaction_signal_override(
    VARCHAR(26), VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26),
    BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ,
    JSONB
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_interaction_signal_override(
    VARCHAR(26), VARCHAR(26), TEXT, VARCHAR(26), VARCHAR(26),
    BYTEA, VARCHAR(26), BYTEA, BYTEA, TEXT, TEXT, BYTEA, TIMESTAMPTZ,
    JSONB
) TO medication_interaction_override_recorder;

-- Override wrapper-owner needs INSERT on override table (migration 047 Â§3
-- already granted this) + SELECT on lifecycle_transition (for current-state check).
GRANT SELECT ON interaction_signal_lifecycle_transition TO override_wrapper_owner;

-- =============================================================================
-- Â§7 â€” Verification: 6 wrappers exist with correct ownership + SECDEF + grants
-- =============================================================================

DO $$
DECLARE
    v_wrapper RECORD;
    v_oid OID;
    v_owner TEXT;
    v_secdef BOOLEAN;
    v_proconfig TEXT[];
BEGIN
    FOR v_wrapper IN
        SELECT * FROM (VALUES
            ('record_signal_emission(character varying, text, character varying, character varying, jsonb)',
             'emission_wrapper_owner'),
            ('record_signal_activation(character varying, text, character varying, character varying, jsonb)',
             'activation_wrapper_owner'),
            ('record_signal_supersession(character varying, text, character varying, character varying, character varying, jsonb)',
             'superseded_wrapper_owner'),
            ('record_signal_resolution(character varying, text, character varying, character varying, character varying, jsonb)',
             'resolution_wrapper_owner'),
            ('record_signal_expiry(character varying, text, character varying, character varying, jsonb)',
             'expiry_wrapper_owner'),
            ('record_interaction_signal_override(character varying, character varying, text, character varying, character varying, bytea, character varying, bytea, bytea, text, text, bytea, timestamp with time zone, jsonb)',
             'override_wrapper_owner')
        ) AS t(sig, expected_owner)
    LOOP
        v_oid := to_regprocedure('public.' || v_wrapper.sig);
        IF v_oid IS NULL THEN
            RAISE EXCEPTION 'migration-050-wrapper-missing: %', v_wrapper.sig;
        END IF;

        SELECT r.rolname, p.prosecdef, p.proconfig
          INTO v_owner, v_secdef, v_proconfig
          FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.oid = v_oid;

        IF v_owner <> v_wrapper.expected_owner THEN
            RAISE EXCEPTION 'migration-050-wrapper-ownership-mismatch: % owner=%, expected=%',
                v_wrapper.sig, v_owner, v_wrapper.expected_owner;
        END IF;
        IF NOT v_secdef THEN
            RAISE EXCEPTION 'migration-050-wrapper-secdef-missing: %', v_wrapper.sig;
        END IF;
        IF v_proconfig IS NULL OR NOT (v_proconfig @> ARRAY['search_path=pg_catalog, public']) THEN
            RAISE EXCEPTION 'migration-050-wrapper-search-path-not-locked: %; proconfig=%',
                v_wrapper.sig, v_proconfig;
        END IF;
    END LOOP;
END $$;
