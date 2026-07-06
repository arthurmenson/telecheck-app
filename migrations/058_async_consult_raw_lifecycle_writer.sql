-- =============================================================================
-- File:    migrations/058_async_consult_raw_lifecycle_writer.sql
-- Purpose: Create the canonical raw lifecycle writer SECDEF function
--          record_consult_lifecycle_transition() — the SOLE INSERT path into
--          consult_lifecycle_transition + the anti-bypass discipline (EXECUTE
--          granted ONLY to the 5 wrapper-owner roles from migration 055 per
--          P-038 §3 R9 MED-1 closure enumeration; application roles never
--          call the raw writer directly).
--
--          PR 4 of the Async Consult Sprint-10 series (PR 1 = 055 roles,
--          PR 2 = 056 entities, PR 3 = 057 derived views). Subsequent
--          migrations: 6 wrapper procedures (PR 5) → Fastify handlers
--          (PR 6+), following the Crisis Response (035) + Admin Backend
--          (042) + Med-Interaction (049) raw-writer cadence.
--
-- Option 2 adaptations from spec (recorded divergences; carried forward
-- from migrations 035/042/049 + 056):
--   - PROCEDURE → FUNCTION RETURNS VOID (code-repo precedent; wrappers in
--     PR 5 SELECT-invoke).
--   - tenant_id_t → TEXT; ULID → VARCHAR(26); enum DOMAIN types → TEXT
--     (table CHECK constraints enforce values).
--   - p_id caller-supplied ULID (no gen_ulid() in code repo; PR 5 wrappers
--     / TypeScript layer generate via the `ulid` library).
--   - SI-024.1 JWT-binding STEP 0 → SI-010 trust anchor
--     (current_actor_account_tenant_id(); migration 031) defense-in-depth
--     tenant guard (035/042/049 pattern).
--   - transition_at is SERVER-ASSIGNED under the advisory lock as
--     GREATEST(clock_timestamp(), latest.transition_at + 1 microsecond) so
--     the migration 056 continuity trigger's STRICT-greater-than
--     monotonic-ordering check (P-038 R3 HIGH-2 reject-equal semantics)
--     always passes for legitimate writer-mediated transitions, even at
--     microsecond-resolution collisions. Direct INSERTs that bypass this
--     computation are still validated (and rejected on violation) by the
--     trigger — the trigger is the invariant; this computation is the
--     cooperative fast path.
--
-- Preconditions: 031 (SI-010 helpers) + 055 (roles) + 056 (entities +
--   continuity trigger + writer-owner INSERT/SELECT grants) applied.
--
-- Invariants: I-035 (append-only; this writer is the sole INSERT path),
--   I-023 (tenant guard at function body + trigger + RLS).
-- =============================================================================

-- =============================================================================
-- §1 — Raw lifecycle writer SECURITY DEFINER function
--
-- Body is intentionally minimal. ALL business invariants live at the table
-- layer (migration 056): 22 CHECK-enforced triples, append-only triggers,
-- continuity + strict-monotonic + terminal-state trigger under the
-- per-consult advisory lock.
-- =============================================================================

CREATE OR REPLACE FUNCTION record_consult_lifecycle_transition(
    p_id                  VARCHAR(26),
    p_tenant_id           TEXT,
    p_consult_id          VARCHAR(26),
    p_to_state            TEXT,
    p_transition_reason   TEXT,
    p_actor_id            VARCHAR(26),    -- nullable for system/scheduler transitions
    p_actor_role          TEXT,
    p_metadata            JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_latest_to_state       TEXT;
    v_latest_transition_at  TIMESTAMPTZ;
    v_actor_tenant_id       TEXT;
    v_lock_key              BIGINT;
    v_transition_at         TIMESTAMPTZ;
BEGIN
    -- ---------------------------------------------------------------------
    -- Defense-in-depth tenant guard (035/042/049 pattern). The migration
    -- 056 continuity trigger + RLS WITH CHECK also enforce tenancy; doing
    -- it here provides a guarantee independent of trigger correctness.
    -- SI-010 trust anchor: caller cannot forge.
    -- ---------------------------------------------------------------------
    v_actor_tenant_id := current_actor_account_tenant_id();
    IF v_actor_tenant_id IS NULL THEN
        RAISE EXCEPTION
            'record_consult_lifecycle_transition: no actor tenant bound for '
            'current backend; authContextPlugin must bind before SECDEF function invocation'
            USING ERRCODE = '42501';    -- insufficient_privilege
    END IF;
    IF v_actor_tenant_id IS DISTINCT FROM p_tenant_id THEN
        RAISE EXCEPTION
            'record_consult_lifecycle_transition: tenant scope mismatch — '
            'actor tenant does not match p_tenant_id; cross-tenant lifecycle write rejected'
            USING ERRCODE = '42501';
    END IF;

    -- ---------------------------------------------------------------------
    -- Acquire the SAME per-consult advisory lock the migration 056
    -- continuity trigger uses, so the latest-row read below + the
    -- server-assigned transition_at computation + the INSERT (whose trigger
    -- re-acquires the already-held lock — advisory xact locks are
    -- reentrant within a transaction) form one serialized unit per
    -- (tenant, consult).
    --
    -- LOCK-ORDER CONTRACT (PR 5 wrappers): when a wrapper transaction also
    -- touches consult_review_claim, it MUST acquire
    -- 'consult_review_claim:<tenant>:<consult>' BEFORE this lock (write
    -- order: claim/decision rows first, transition row second — matches
    -- P-038 §3 record_consult_clinician_decision ordering).
    -- ---------------------------------------------------------------------
    v_lock_key := ('x' || substr(md5('consult_lifecycle_transition:' || p_tenant_id || ':' || p_consult_id), 1, 16))::bit(64)::bigint;
    PERFORM pg_advisory_xact_lock(v_lock_key);

    -- Latest prior transition (under the lock) → from_state + monotonic base
    SELECT to_state, transition_at
      INTO v_latest_to_state, v_latest_transition_at
      FROM public.consult_lifecycle_transition
     WHERE tenant_id = p_tenant_id AND consult_id = p_consult_id
     ORDER BY transition_at DESC, id DESC
     LIMIT 1;

    -- Server-assigned strict-monotonic transition_at (cooperative fast path
    -- for the trigger's reject-equal semantics; see header).
    IF v_latest_transition_at IS NULL THEN
        v_transition_at := clock_timestamp();
    ELSE
        v_transition_at := GREATEST(clock_timestamp(), v_latest_transition_at + INTERVAL '1 microsecond');
    END IF;

    -- INSERT the new transition row. The table layer (migration 056)
    -- enforces: 22 valid triples (CHECK), continuity + terminal-state +
    -- strict-monotonic + 5s future-bound (BEFORE INSERT trigger, under the
    -- same advisory lock), append-only (block triggers), tenancy (RLS
    -- WITH CHECK).
    INSERT INTO public.consult_lifecycle_transition (
        id, tenant_id, consult_id,
        from_state, to_state, transition_reason,
        transition_at, transition_by_actor_id, transition_by_actor_role,
        metadata
    ) VALUES (
        p_id, p_tenant_id, p_consult_id,
        COALESCE(v_latest_to_state, 'none'), p_to_state, p_transition_reason,
        v_transition_at, p_actor_id, p_actor_role,
        COALESCE(p_metadata, '{}'::jsonb)
    );
END;
$$;

-- =============================================================================
-- §2 — Function ownership (writer owner)
--
-- Owner role already has INSERT + SELECT on consult_lifecycle_transition
-- (granted at migration 056 §6).
-- =============================================================================

ALTER FUNCTION record_consult_lifecycle_transition(
    VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
) OWNER TO consult_lifecycle_transition_writer_owner;

-- =============================================================================
-- §3 — Anti-bypass EXECUTE grant matrix (P-038 §3 R9 MED-1 closure):
-- raw writer is callable ONLY by the 5 wrapper-owner roles. "No other roles
-- receive EXECUTE on the raw writer." Application roles come through the
-- reason-specific wrappers (PR 5).
-- =============================================================================

REVOKE EXECUTE ON FUNCTION record_consult_lifecycle_transition(
    VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_consult_lifecycle_transition(
    VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
) TO consult_initiation_wrapper_owner,
     consult_intake_wrapper_owner,
     consult_ai_preparation_wrapper_owner,
     consult_claim_wrapper_owner,
     record_consult_decision_wrapper_owner;

COMMENT ON FUNCTION record_consult_lifecycle_transition(
    VARCHAR(26), TEXT, VARCHAR(26), TEXT, TEXT, VARCHAR(26), TEXT, JSONB
) IS
    'P-038 §3 raw canonical consult lifecycle writer. SECURITY DEFINER + locked '
    'search_path. SOLE INSERT path into consult_lifecycle_transition. EXECUTE '
    'granted ONLY to the 5 wrapper-owner roles (P-038 §3 R9 MED-1 closure: '
    'consult_initiation + consult_intake + consult_ai_preparation + consult_claim '
    '+ record_consult_decision wrapper owners; no other roles). All business '
    'invariants (22 valid triples + append-only + advisory-locked continuity + '
    'strict-monotonic ordering + terminal-state rejection + caller-tenant guard) '
    'enforced at the table layer via migration 056 triggers + CHECK constraints. '
    'Defense-in-depth tenant guard via SI-010 current_actor_account_tenant_id(). '
    'transition_at server-assigned under the shared per-consult advisory lock as '
    'GREATEST(clock_timestamp(), latest + 1us).';

-- =============================================================================
-- §4 — Verification
-- =============================================================================

DO $$
DECLARE
    v_oid          OID := to_regprocedure(
        'record_consult_lifecycle_transition(VARCHAR, TEXT, VARCHAR, TEXT, TEXT, VARCHAR, TEXT, JSONB)');
    v_owner        TEXT;
    v_secdef       BOOLEAN;
    v_grantee      TEXT;
    v_bad_grantees TEXT := '';
BEGIN
    IF v_oid IS NULL THEN
        RAISE EXCEPTION 'migration-058-verification: record_consult_lifecycle_transition not found'
            USING ERRCODE = 'undefined_function';
    END IF;

    SELECT r.rolname, p.prosecdef INTO v_owner, v_secdef
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
     WHERE p.oid = v_oid;
    IF v_owner <> 'consult_lifecycle_transition_writer_owner' THEN
        RAISE EXCEPTION 'migration-058-verification: writer owner is % but MUST be consult_lifecycle_transition_writer_owner', v_owner
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT v_secdef THEN
        RAISE EXCEPTION 'migration-058-verification: writer is not SECURITY DEFINER'
            USING ERRCODE = 'check_violation';
    END IF;

    -- EXECUTE grantees must be exactly the owner + the 5 wrapper owners.
    FOR v_grantee IN
        SELECT r.rolname
          FROM pg_proc p,
               LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
          JOIN pg_roles r ON r.oid = a.grantee
         WHERE p.oid = v_oid AND a.privilege_type = 'EXECUTE'
    LOOP
        IF v_grantee NOT IN (
            'consult_lifecycle_transition_writer_owner',
            'consult_initiation_wrapper_owner',
            'consult_intake_wrapper_owner',
            'consult_ai_preparation_wrapper_owner',
            'consult_claim_wrapper_owner',
            'record_consult_decision_wrapper_owner'
        ) THEN
            v_bad_grantees := v_bad_grantees || v_grantee || ', ';
        END IF;
    END LOOP;
    IF length(v_bad_grantees) > 0 THEN
        RAISE EXCEPTION 'migration-058-verification: unexpected EXECUTE grantees on raw writer: % — violates P-038 §3 anti-bypass matrix',
            rtrim(v_bad_grantees, ', ')
            USING ERRCODE = 'check_violation';
    END IF;
END $$;
