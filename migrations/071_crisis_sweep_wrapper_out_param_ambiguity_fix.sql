-- =============================================================================
-- File:    migrations/071_crisis_sweep_wrapper_out_param_ambiguity_fix.sql
-- Purpose: Fix a latent PL/pgSQL 42702 (ambiguous_column) runtime defect in
--          `execute_crisis_no_acknowledgement_sweep()` that made EVERY live
--          sweep call fail with an unmapped error (HTTP 500) as soon as it
--          reached the §1.1 open-row SELECT.
--
--          Root cause: the function's RETURNS TABLE OUT parameters
--          (`sweep_execution_id`, `fencing_token`, `outcome`) collide with
--          the identically-named `crisis_sweep_execution` columns. Under
--          the PL/pgSQL default `#variable_conflict error`, any UNQUALIFIED
--          reference to those names inside an embedded SQL statement raises
--          SQLSTATE 42702 at runtime. Four sites in the migration 053 §7
--          body referenced them unqualified:
--
--            1. §1.1 open-row SELECT list
--               (`SELECT sweep_execution_id, ..., fencing_token, ...`)
--            2. §1.1 lease-takeover UPDATE
--               (`WHERE sweep_execution_id = ...` +
--                `RETURNING sweep_execution_id, fencing_token`)
--            3. §1.2 no-op completion UPDATE
--               (`WHERE sweep_execution_id = ... AND fencing_token = ...`)
--            4. §1.3 STEP F completion UPDATE (same WHERE shape as 3)
--
--          Why it survived 18 Codex APPROVE rounds + the unit suite: the
--          defect is runtime-only (function CREATE succeeds; 42702 fires on
--          first execution reaching the site), the sweep path had NEVER
--          been executed against live PostgreSQL until the Sprint 4
--          integration suite (tests/integration/crisis-response-http.test.ts
--          Group D) exercised it end-to-end, and the handler unit tests
--          mock all SQL. Same latent-defect class as the sweep handler's
--          patient_id→patient_account_id 42703 fixed app-side in the same
--          Sprint 4 branch.
--
--          Fix (belt + braces):
--            (a) `#variable_conflict use_column` pragma — inside embedded
--                SQL, unqualified name collisions resolve to the COLUMN,
--                which is the intended meaning at every collision site.
--                PL/pgSQL assignment statements (`sweep_execution_id := ...`)
--                are NOT embedded SQL and keep assigning the OUT params.
--            (b) Explicit table-alias qualification at all four sites
--                anyway, so no reader has to reason about the pragma.
--
--          Semantics are otherwise IDENTICAL to the migration 053 §7 body
--          (SI-025 P-045 TEXT actor identity preserved; all guards,
--          ERRCODEs, lease/fencing logic, and outcome vocabulary
--          unchanged). No schema objects change; signature unchanged;
--          CREATE OR REPLACE preserves ownership
--          (crisis_sweep_wrapper_owner) + the EXECUTE grant matrix
--          (crisis_sweep_scheduler only) from migrations 038 §2-§3.
--
-- Spec references:
--   - SI-022 Crisis Response Slice v1.0 (RATIFIED P-039) — sweep semantics
--   - CDM v1.9 → v1.10 Amendment (RATIFIED P-040) §4.NEW3
--   - migration 038 (original wrapper; same defect present at §1.1)
--   - migration 053 §7 (SI-025 P-045 re-shape; defect carried forward)
--   - I-019 (crisis platform-floor — a 500ing sweep endpoint is an
--     escalation-obligation outage; this fix restores it)
--
-- Rollback: rollback/071_rollback.sql (restores the 053 §7 body verbatim —
-- including the defect — for chain-consistency; see note there).
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
#variable_conflict use_column
DECLARE
    v_actor_account_id_text  TEXT;
    v_actor_principal_id     TEXT;    -- SI-025 P-045: TEXT; no ::UUID cast
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

    -- 071 fix site 1: `cse` alias added — the previous unqualified
    -- `SELECT sweep_execution_id, ..., fencing_token, ...` collided with
    -- the OUT params and raised 42702 on every execution reaching here.
    SELECT cse.sweep_execution_id, cse.claimed_by_worker_id, cse.claim_expires_at, cse.fencing_token, cse.completed_at
      INTO v_sweep_row
      FROM public.crisis_sweep_execution cse
     WHERE cse.tenant_id = p_tenant_id
       AND cse.crisis_event_id = p_crisis_event_id
       AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
       AND cse.completed_at IS NULL    -- only open rows; partial UNIQUE index allows at most one
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
        -- 071 fix site 2: WHERE + RETURNING references table-qualified.
        UPDATE public.crisis_sweep_execution cse
           SET claimed_by_worker_id = p_worker_id,
               claim_expires_at     = now() + (p_claim_ttl_seconds || ' seconds')::INTERVAL,
               fencing_token        = v_sweep_row.fencing_token + 1,
               heartbeat_at         = now()
         WHERE cse.sweep_execution_id = v_sweep_row.sweep_execution_id
         RETURNING cse.sweep_execution_id, cse.fencing_token
              INTO v_returning_sweep_id, v_returning_fencing;
        v_returning_outcome := 'claimed_takeover';
    ELSE
        -- New claim: insert a fresh row. R2 HIGH-1 closure 2026-05-22:
        -- two scheduler workers can race for the FIRST claim — both pass the
        -- completed-row guard + open-row SELECT (no rows exist yet), both
        -- reach this INSERT. The partial UNIQUE on (tenant, event, generation)
        -- WHERE completed_at IS NULL allows only one to succeed; the loser
        -- raises unique_violation. Without a handler, the loser leaks raw
        -- SQLSTATE 23505. Wrap in EXCEPTION block + re-read winning row to
        -- determine controlled outcome.
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
                -- R4 HIGH-1 closure 2026-05-22: discriminate the violated
                -- constraint. Only the partial UNIQUE index from migration 033
                -- §7 (`crisis_sweep_execution_open_uk`) represents a first-claim
                -- race; any other unique_violation indicates schema drift,
                -- corruption, or an unrelated integrity failure that MUST be
                -- re-raised to preserve the real diagnostic — silently
                -- swallowing it could mask a real bug + drop a required sweep.
                DECLARE
                    v_constraint_name TEXT;
                BEGIN
                    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
                    IF v_constraint_name IS DISTINCT FROM 'crisis_sweep_execution_open_uk' THEN
                        -- Unrelated unique violation; re-raise with diagnostic.
                        RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: unexpected unique_violation on constraint %; not the canonical first-claim race; preserving original failure',
                            v_constraint_name
                            USING ERRCODE = '23505';  -- canonical unique_violation
                    END IF;
                END;

                -- R3 HIGH-1 closure 2026-05-22: race-loser re-read. The partial
                -- UNIQUE constraint only enforces uniqueness on OPEN rows, so the
                -- winning row that just caused our unique_violation MUST be open.
                -- Re-read OPEN row FIRST + return 40001 lease-conflict if found.
                -- ONLY if no open row exists (winner finished in the gap before
                -- we caught the violation) do we fall back to the most-recent
                -- completed row + return already_completed.
                SELECT cse.sweep_execution_id, cse.fencing_token, cse.claimed_by_worker_id, cse.claim_expires_at
                  INTO v_returning_sweep_id, v_returning_fencing,
                       v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                  FROM public.crisis_sweep_execution cse
                 WHERE cse.tenant_id = p_tenant_id
                   AND cse.crisis_event_id = p_crisis_event_id
                   AND cse.scheduled_for_obligation_generation = p_target_obligation_generation
                   AND cse.completed_at IS NULL;
                IF FOUND THEN
                    -- Winner still holds the open lease — return controlled 40001.
                    RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: concurrent first-claim race lost; sweep_execution_id % currently leased by worker % until %; retry after expiry',
                        v_returning_sweep_id, v_sweep_row.claimed_by_worker_id, v_sweep_row.claim_expires_at
                        USING ERRCODE = '40001';
                END IF;

                -- No open row — winner finished completion in the gap. Find
                -- the most-recent COMPLETED row (ordered by completed_at DESC,
                -- not by sweep_execution_id which is UUID and not a recency
                -- signal) and return already_completed.
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

                -- Should be unreachable — unique_violation implies a colliding
                -- row exists, and we just searched all states.
                RAISE EXCEPTION 'execute_crisis_no_acknowledgement_sweep: unique_violation re-read found no colliding row — invariant violation; investigate sweep_execution data integrity'
                    USING ERRCODE = 'XX000';  -- internal_error
        END;
    END IF;

    -- =====================================================================
    -- §1.2 — Lifecycle emission phase
    --
    -- Read latest lifecycle state under the parent FOR UPDATE lock. The
    -- sweep escalates ONLY if current state is detected or escalated.
    -- Other states (acknowledged/responded/resolved) are no-ops — the
    -- sweep simply commits with outcome 'completed_no_op'.
    -- =====================================================================

    SELECT lt.to_state
      INTO v_latest_to_state
      FROM public.crisis_event_lifecycle_transition lt
     WHERE lt.tenant_id = p_tenant_id AND lt.crisis_event_id = p_crisis_event_id
     ORDER BY lt.transition_at DESC, lt.id DESC
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
        -- 071 fix site 3: WHERE references table-qualified.
        UPDATE public.crisis_sweep_execution cse
           SET completed_at             = now(),
               sweep_cycle_id_committed = v_returning_fencing,    -- using fencing_token as cycle id
               heartbeat_at             = now()
         WHERE cse.sweep_execution_id = v_returning_sweep_id
           AND cse.fencing_token      = v_returning_fencing;      -- guard against takeover during processing

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
        v_actor_principal_id,   -- TEXT per SI-025 P-045
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

    -- 071 fix site 4: WHERE references table-qualified.
    UPDATE public.crisis_sweep_execution cse
       SET completed_at             = now(),
           sweep_cycle_id_committed = v_returning_fencing,
           heartbeat_at             = now()
     WHERE cse.sweep_execution_id = v_returning_sweep_id
       AND cse.fencing_token      = v_returning_fencing;

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
    'P-040 §4.NEW3 + SI-022 sweep wrapper. SECURITY DEFINER + locked search_path. '
    'Migration 071: fixes latent 42702 OUT-param/column ambiguity (4 sites) that '
    'failed every live sweep call; #variable_conflict use_column + explicit '
    'qualification. Semantics identical to migration 053 §7 (SI-025 P-045 TEXT '
    'actor identity). EXECUTE granted ONLY to crisis_sweep_scheduler.';

-- =============================================================================
-- Verification — the wrapper must still be SECDEF, owned by
-- crisis_sweep_wrapper_owner, with EXECUTE locked to crisis_sweep_scheduler
-- (CREATE OR REPLACE preserves owner + ACL; assert anyway per the
-- migration 036 §4 verification pattern).
-- =============================================================================

DO $$
DECLARE
    v_target_oid OID := to_regprocedure(
        'public.execute_crisis_no_acknowledgement_sweep(text, uuid, integer, text, integer)'
    );
    v_owner   TEXT;
    v_secdef  BOOLEAN;
    v_config  TEXT[];
    v_prosrc  TEXT;
BEGIN
    IF v_target_oid IS NULL THEN
        RAISE EXCEPTION
            'migration-071-function-missing: execute_crisis_no_acknowledgement_sweep() not found by signature';
    END IF;

    SELECT r.rolname, p.prosecdef, p.proconfig, p.prosrc
      INTO v_owner, v_secdef, v_config, v_prosrc
      FROM pg_proc p
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_target_oid;

    IF v_owner <> 'crisis_sweep_wrapper_owner' THEN
        RAISE EXCEPTION
            'migration-071-ownership-mismatch: wrapper owner is % but MUST be crisis_sweep_wrapper_owner (CREATE OR REPLACE should have preserved it)',
            v_owner;
    END IF;

    IF NOT v_secdef THEN
        RAISE EXCEPTION 'migration-071-security-definer-missing: wrapper MUST be SECURITY DEFINER';
    END IF;

    IF v_config IS NULL
       OR NOT (v_config @> ARRAY['search_path=pg_catalog, public']) THEN
        RAISE EXCEPTION
            'migration-071-search-path-not-locked: wrapper MUST have proconfig containing "search_path=pg_catalog, public"; found %',
            v_config;
    END IF;

    -- The fix marker: the pragma MUST be present in the installed body.
    IF v_prosrc NOT LIKE '%#variable_conflict use_column%' THEN
        RAISE EXCEPTION
            'migration-071-fix-not-applied: installed wrapper body lacks the #variable_conflict use_column pragma';
    END IF;
END $$;
