-- =============================================================================
-- File:    migrations/068_ai_mode1_service_writer_grants.sql
-- Purpose: Create the Mode 1 service writer DB role (`ai_service_mode1`) +
--          issue the write-path grants the Mode 1 chat handler needs to
--          persist conversations/turns into the migration-067 entities.
--
--          This is PR 3 of the Mode 1 persistence implementation series
--          (PR 1 = migration 066 RBAC roles foundation; PR 2 = migration 067
--          entities + view + RLS + append-only triggers + view-owner/reader
--          grant chain). Migration 067 deliberately issued NO INSERT grants:
--          "the write path arrives with the Mode 1 handler PRs" (067 header).
--          This migration IS that write path's grant surface.
--
-- Ratified basis (quoted verbatim; read before amending):
--   1. AI Service Mode 1 Handler Spec v0.4 RATIFIED (P-035 2026-05-21) §5.1
--      Layer 1 (DB write enforcement):
--        "the Mode 1 service runs under a dedicated DB role with
--         INSERT/UPDATE/DELETE permissions ONLY on the enumerated
--         `ai_mode1_*` tables + `i019_enqueue_ack_log` + audit tables"
--      That sentence is the P-035-ratified authority for a dedicated Mode 1
--      service DB role holding INSERT on the ai_mode1_* entities.
--   2. CDM v1.7 -> v1.8 Amendment (RATIFIED P-036 + P-036a) §6 registers ONLY
--      the view-owner + reader roles. Its R6 HIGH-1 closure prose (§10 v0.7
--      entry, mirrored in the version header) explicitly anticipates this
--      migration's grants landing OUTSIDE the amendment:
--        "`ai_mode1_reader` cannot read raw message content via direct
--         base-table access; that access requires separate roles (Mode 1
--         service account, audit tooling) granted explicitly out of scope
--         for this amendment."
--      I.e. the amendment intentionally left the Mode 1 SERVICE role's
--      base-table access to the implementation cycle. This migration is
--      that landing, bounded by the spec's §5.1 Layer 1 enumeration.
--   3. Role NAME `ai_service_mode1` is the spec-corpus RBAC name R-3
--      (referenced in the migration 064 + 066 headers as "the spec RBAC
--      names R-3 ai_service_mode1 / R-4 ai_service_mode2" -- until now only
--      in comments, never as a DB role). Taken verbatim; no normalization.
--
-- Least-privilege narrowing from the spec's §5.1 Layer 1 ceiling
-- (deliberate; same class as prior slices' Option 2 recorded divergences):
--   - INSERT only -- NO UPDATE / DELETE grants. All 5 Mode 1 entities are
--     strict append-only per I-035 (migration 067 block_update/block_delete
--     triggers); granting UPDATE/DELETE would be dead privilege that
--     contradicts the invariant. §5.1's "INSERT/UPDATE/DELETE ... ONLY on"
--     phrasing bounds the MAXIMUM surface, not a minimum.
--   - NO grants on ai_mode1_conversation_archival_event. Archival is an
--     operator-driven surface (archived_by_user_id actor; reasons
--     patient_retention_policy / patient_request / tenant_disable) that the
--     chat handler never writes. Its writer grant lands with the archival
--     surface PR, in its natural phase (P-040 s8.2 R9 HIGH-1 pattern).
--   - NO grant on i019_enqueue_ack_log (table does not exist in the code
--     repo; DEFERRED per migration 067's crisis_server_signal_id FK
--     deferral -- ratifier confirmation of the canonical I-019 enqueue-ack
--     target is still pending).
--   - SELECT on the 4 lifecycle tables IS granted: the ratified handler
--     lifecycle requires same-tx reads by the service --
--       * conversation load + patient-ownership validation (Mode 1 spec
--         §2.5 idempotency scope + §6.1 conversation envelope semantics),
--       * history_snapshot_high_water_mark = MAX(turn_result.completed_at)
--         computed at admission (spec §6.3 step 1),
--       * the §4.2 runtime detector-ordering precondition ("The `llm.invoke()`
--         call site verifies a `ai_mode1_conversation_turn_detector_result`
--         row exists for the turn_id BEFORE invoking; this is a SELECT
--         executed within the same transaction"),
--       * admission-row request_body_hash comparison on concurrent retry
--         (spec §6.2).
--     The amendment's R6/R7 data-minimization closures constrain
--     ai_mode1_reader (dashboard/portal/admin principals), NOT the Mode 1
--     service -- see ratified-basis quote 2 above. RLS (FORCE) still
--     tenant-scopes every read this role performs.
--
-- App-role acquisition: Option B bridge per migration 051 §2 / 061 / 064 --
-- telecheck_app_role (NOINHERIT) gains SET-only membership; the handler
-- elevates via `SET LOCAL ROLE ai_service_mode1` (src/lib/with-db-role.ts)
-- inside the request transaction, after Layer B authorization.
--
-- Preconditions: migrations 000-067 applied (tables + RLS + triggers +
-- roles from 066/067; telecheck_app_role from 051).
--
-- Invariants: I-023 (RLS FORCE on all granted tables; the role is
-- NOBYPASSRLS), I-035 (append-only preserved -- no UPDATE/DELETE grants +
-- 067 triggers), I-027 (audit tenancy -- handler layer), I-019 (crisis
-- floor -- handler layer).
-- =============================================================================

-- =============================================================================
-- Section 0 -- Preflight
-- =============================================================================

DO $$
DECLARE
    v_table TEXT;
    v_tables TEXT[] := ARRAY[
        'ai_mode1_conversation',
        'ai_mode1_conversation_turn_admission',
        'ai_mode1_conversation_turn_detector_result',
        'ai_mode1_conversation_turn_result'
    ];
BEGIN
    IF to_regrole('telecheck_app_role') IS NULL THEN
        RAISE EXCEPTION 'migration-068-precondition-failed: telecheck_app_role '
            'does not exist; apply migration 051 before 068.';
    END IF;
    FOREACH v_table IN ARRAY v_tables LOOP
        IF to_regclass('public.' || v_table) IS NULL THEN
            RAISE EXCEPTION 'migration-068-precondition-failed: table % missing; apply migration 067 before 068.', v_table
                USING ERRCODE = 'undefined_table';
        END IF;
    END LOOP;
END $$;

-- =============================================================================
-- Section 1 -- ai_service_mode1 writer role (spec RBAC R-3 name, verbatim)
-- =============================================================================

DO $$
BEGIN
    IF to_regrole('ai_service_mode1') IS NULL THEN
        CREATE ROLE ai_service_mode1 NOLOGIN NOBYPASSRLS;
    END IF;
END $$;

COMMENT ON ROLE ai_service_mode1 IS
    'Mode 1 Handler Spec v0.4 RATIFIED (P-035) §5.1 Layer 1 dedicated Mode 1 service DB role '
    '(spec RBAC name R-3): INSERT + SELECT ONLY on the 4 Mode 1 conversation lifecycle tables '
    '(conversation, turn_admission, turn_detector_result, turn_result). NO UPDATE/DELETE '
    '(I-035 strict append-only; migration 067 triggers enforce); NO archival_event access '
    '(operator surface; grant lands with the archival PR); NO i019_enqueue_ack_log grant '
    '(table deferred per migration 067). Distinct from ai_mode1_reader (state-view-only '
    'dashboard/portal/admin read role per the P-036 amendment R6/R7 data-minimization '
    'closures) and from ai_service_account (the SI-010 async-consult AI-preparation wrapper '
    'caller class, migration 064). NOLOGIN + NOBYPASSRLS; acquired via SET LOCAL ROLE per '
    'the migration 051 §2 Option B pattern. Created by migration 068.';

-- =============================================================================
-- Section 2 -- Write-path grants (INSERT + SELECT on the 4 lifecycle tables)
-- =============================================================================

GRANT SELECT, INSERT ON ai_mode1_conversation                      TO ai_service_mode1;
GRANT SELECT, INSERT ON ai_mode1_conversation_turn_admission       TO ai_service_mode1;
GRANT SELECT, INSERT ON ai_mode1_conversation_turn_detector_result TO ai_service_mode1;
GRANT SELECT, INSERT ON ai_mode1_conversation_turn_result          TO ai_service_mode1;

-- Explicitly NOT granted (documented negative space):
--   ai_mode1_conversation_archival_event  -- operator archival surface PR
--   ai_mode1_conversation_state           -- the state view is the
--     ai_mode1_reader surface; the service reads base tables directly.
--   UPDATE / DELETE on anything           -- I-035.

-- =============================================================================
-- Section 3 -- App-role acquisition bridge (051 §2 / 061 / 064 pattern)
-- =============================================================================

DO $$
DECLARE
    v_pg_major INTEGER := current_setting('server_version_num')::INTEGER / 10000;
    v_already  BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
          FROM pg_auth_members m
          JOIN pg_roles r   ON r.oid = m.roleid
          JOIN pg_roles mem ON mem.oid = m.member
         WHERE r.rolname = 'ai_service_mode1'
           AND mem.rolname = 'telecheck_app_role'
    ) INTO v_already;

    IF v_pg_major >= 16 THEN
        -- PG 16+: explicit per-membership INHERIT FALSE + SET TRUE
        -- (051 R2 HIGH-1 closure carryforward; normalizes pre-existing
        -- membership too).
        EXECUTE 'GRANT ai_service_mode1 TO telecheck_app_role WITH INHERIT FALSE, SET TRUE';
    ELSIF NOT v_already THEN
        -- PG 15: plain GRANT; the role-level NOINHERIT on
        -- telecheck_app_role provides the no-inherit posture.
        EXECUTE 'GRANT ai_service_mode1 TO telecheck_app_role';
    END IF;
    RAISE NOTICE 'migration-068: telecheck_app_role membership in ai_service_mode1 granted (pre-existing: %)', v_already;
END $$;

-- =============================================================================
-- Section 4 -- Verification
-- =============================================================================

DO $$
DECLARE
    v_table TEXT;
    v_granted_tables TEXT[] := ARRAY[
        'ai_mode1_conversation',
        'ai_mode1_conversation_turn_admission',
        'ai_mode1_conversation_turn_detector_result',
        'ai_mode1_conversation_turn_result'
    ];
BEGIN
    -- Role exists, non-BYPASSRLS.
    IF to_regrole('ai_service_mode1') IS NULL THEN
        RAISE EXCEPTION 'migration-068-verification: ai_service_mode1 role missing';
    END IF;
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'ai_service_mode1') THEN
        RAISE EXCEPTION 'migration-068-verification: ai_service_mode1 has BYPASSRLS; forbidden '
            '(RLS FORCE on the Mode 1 entities is the I-023 DB layer for the write path)';
    END IF;

    -- INSERT + SELECT on exactly the 4 lifecycle tables; nothing else.
    FOREACH v_table IN ARRAY v_granted_tables LOOP
        IF NOT has_table_privilege('ai_service_mode1', 'public.' || v_table, 'INSERT') THEN
            RAISE EXCEPTION 'migration-068-verification: ai_service_mode1 lacks INSERT on %', v_table;
        END IF;
        IF NOT has_table_privilege('ai_service_mode1', 'public.' || v_table, 'SELECT') THEN
            RAISE EXCEPTION 'migration-068-verification: ai_service_mode1 lacks SELECT on %', v_table;
        END IF;
        IF has_table_privilege('ai_service_mode1', 'public.' || v_table, 'UPDATE')
           OR has_table_privilege('ai_service_mode1', 'public.' || v_table, 'DELETE') THEN
            RAISE EXCEPTION 'migration-068-verification: ai_service_mode1 holds UPDATE/DELETE on % -- violates I-035 append-only posture', v_table;
        END IF;
    END LOOP;

    -- Negative space: no archival-event access; no state-view access.
    IF has_table_privilege('ai_service_mode1', 'public.ai_mode1_conversation_archival_event', 'INSERT')
       OR has_table_privilege('ai_service_mode1', 'public.ai_mode1_conversation_archival_event', 'SELECT') THEN
        RAISE EXCEPTION 'migration-068-verification: ai_service_mode1 has archival_event access -- the archival surface PR owns that grant';
    END IF;
    IF has_table_privilege('ai_service_mode1', 'public.ai_mode1_conversation_state', 'SELECT') THEN
        RAISE EXCEPTION 'migration-068-verification: ai_service_mode1 has state-view SELECT -- the view is the ai_mode1_reader surface';
    END IF;

    -- The P-036 amendment's R6/R7 boundary is untouched: ai_mode1_reader
    -- still has NO base-table access.
    FOREACH v_table IN ARRAY v_granted_tables LOOP
        IF has_table_privilege('ai_mode1_reader', 'public.' || v_table, 'SELECT') THEN
            RAISE EXCEPTION 'migration-068-verification: ai_mode1_reader gained base-table SELECT on % -- R6/R7 data-minimization boundary violated', v_table;
        END IF;
    END LOOP;

    -- Bridge membership present.
    IF NOT pg_has_role('telecheck_app_role', 'ai_service_mode1'::regrole, 'MEMBER') THEN
        RAISE EXCEPTION 'migration-068-verification: telecheck_app_role lacks ai_service_mode1 membership';
    END IF;
END $$;
