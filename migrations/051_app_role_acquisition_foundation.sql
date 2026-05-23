-- =============================================================================
-- File:    migrations/051_app_role_acquisition_foundation.sql
-- Purpose: Foundation migration — bridge the application login role
--          (telecheck_app_role) to the 13 slice application/reader roles
--          via NOINHERIT membership, enabling per-transaction SET LOCAL ROLE
--          elevation by Fastify handlers AFTER Layer B authorization.
--
--          Closes the long-standing migrations/003_rls_helpers.sql:164 TODO
--          ("SPEC ISSUE: Grant to telecheck_app_role when 006_roles.sql
--          lands") that has blocked Crisis Response / Admin Backend /
--          Med-Interaction handler PRs.
--
--          Ratified per the 2026-05-23 dual-recommendation consult:
--          - Claude recommendation: Option B (NOINHERIT + SET LOCAL ROLE)
--          - Codex Pass-1 (source-first independent): Option B (same)
--          - Codex Pass-2 (contrast-and-synthesize): APPROVE Option B
--          - Evans ratifier confirmation: 2026-05-23 chat-message
--            (auto-proceed gate: Claude + Pass-2 agreement)
--          - Engineering Review Request:
--              Telecheck_v1_10_PRD_Update/Engineering-Review-Request-
--              App-Role-Acquisition-SECDEF-Slice-Wrappers-2026-05-23.md
--          - Cockpit Addendum 76 (remote-cron-authored ERR) + Addendum 80
--            (this migration's close-out, post-merge).
--
--          MECHANISM (Option B per ERR §5):
--          1. ALTER ROLE telecheck_app_role NOINHERIT — without this,
--             granting any slice role to telecheck_app_role would give it
--             passive (always-on) privileges to call every slice wrapper
--             on every connection. NOINHERIT means membership EXISTS but
--             does NOT auto-bestow the slice role's privileges — they only
--             apply within a `SET LOCAL ROLE <slice_role>` block.
--          2. GRANT each of the 13 slice application/reader roles TO
--             telecheck_app_role. With NOINHERIT this is a no-op at session
--             open; SET LOCAL ROLE checks membership only.
--
--          ANTI-BYPASS DESIGN PRESERVED:
--          The wrappers' verification DO-blocks (e.g., 036 §3, 043 §3,
--          049 §4, 050 §6) RAISE if any direct grantee other than the
--          documented slice role + wrapper-owner exists. Option B's
--          membership grant is NOT a direct grant — direct-grantee
--          checks via information_schema.role_routine_grants /
--          aclexplode continue to show ONLY the wrapper-owner + the
--          canonical slice role. Verification queries below assert this
--          for a representative subset of wrappers across all 3 slices.
--
--          RLS COMPOSABILITY:
--          All 13 slice roles are NOLOGIN NOBYPASSRLS (verified by Crisis
--          032:73-105, Admin 039:51-57, Med-Int 046:114-200). A SET LOCAL
--          ROLE into a NOBYPASSRLS role does NOT bypass RLS, so tenant
--          isolation (set_tenant_context GUC + RLS policies) and actor
--          binding (SI-010 nonce GUC via current_actor_account_*) compose
--          unchanged inside the elevated transaction. Migration 003:380
--          break-glass caution targets RLS-BYPASSING role changes
--          specifically; this migration does not implicate that caution.
--
--          INVARIANT IMPLICATIONS:
--          - I-023 (three-layer tenancy): preserved. RLS layer 1 unchanged;
--            set_tenant_context GUC layer 2 unchanged; per-tenant KMS layer 3
--            unchanged. SET LOCAL ROLE only changes the effective Postgres
--            ACL identity, not RLS evaluation context.
--          - I-024 (cross-tenant break-glass): preserved. Slice roles are
--            NOBYPASSRLS so SET ROLE cannot escape tenant scope; cross-
--            tenant access still requires the documented break-glass path
--            (operator-gated, audited).
--          - I-027 (audit attribution): preserved. Audit records continue
--            to bind to the SI-010 actor (current_actor_account_id),
--            which is a session-scoped GUC unaffected by SET ROLE.
--
--          IDEMPOTENCY:
--          - ALTER ROLE NOINHERIT is unconditional; re-running is a no-op
--            (rolinherit already FALSE second time).
--          - GRANT ... TO ... IF NOT EXISTS (PG 16+) syntax is used where
--            available; for compatibility with PG 15 / 14 the gating uses
--            DO-blocks with pg_has_role() existence checks before each
--            GRANT (idempotent across re-runs + partial-prior-state).
--          - All grants gated on (a) target role exists AND (b) recipient
--            role exists, so partial-foundation states (e.g., a slice's
--            roles dropped + re-created) are tolerated without aborting
--            the migration mid-flight.
--
--          DEFERRED TO FOLLOW-UP PRS (out of scope for this foundation):
--          - withDbRole(tx, role, fn) lib helper + allowlisted RoleEnum
--            (lands in PR following this; depends on this migration).
--          - Per-slice integration tests proving:
--              * Direct wrapper call as telecheck_app_role FAILS (no SET ROLE).
--              * SET LOCAL ROLE to WRONG slice role FAILS.
--              * SET LOCAL ROLE to CORRECT slice role SUCCEEDS (or reaches
--                fail-closed for med-interaction terminal wrappers).
--              * Direct-grantee inspection still shows only owner + canonical
--                slice role (anti-bypass preserved).
--            (Will land alongside the helper PR + first real handler PR.)
--          - End-to-end 000→head migration-apply CI gate (Track 5 Infra & Ops
--            workstream item, separate from this PR).
--
--          PER-SLICE APPLICATION/READER ROLE INVENTORY (13 total):
--
--          Crisis Response (SI-022; 7 roles):
--            - crisis_initiator            (EXECUTE record_crisis_initiation; 036)
--            - crisis_acknowledger         (EXECUTE record_crisis_acknowledgement_claim; 037)
--            - crisis_responder            (EXECUTE record_crisis_response; 037)
--            - crisis_resolver             (EXECUTE record_crisis_resolution; 037)
--            - crisis_sweep_scheduler      (EXECUTE execute_crisis_no_acknowledgement_sweep; 038)
--            - crisis_event_staff_reader   (SELECT crisis_event_current_state_v + bases; 034)
--            - crisis_event_patient_reader (SELECT crisis_event_patient_summary_v; 034)
--
--          Admin Backend Basics (SI-023; 2 roles):
--            - admin_basic_operator        (EXECUTE submit_forms_template_for_admin_review
--                                          + 3 dashboard read wrappers; 043 / 044)
--            - admin_template_reviewer     (EXECUTE record_forms_template_admin_decision; 043)
--
--          Medication Interaction Engine (SI-019; 4 roles):
--            - medication_interaction_engine_evaluator
--                                          (EXECUTE record_signal_emission /
--                                          record_signal_activation /
--                                          record_signal_supersession /
--                                          record_signal_expiry [scheduler];
--                                          046 + 050)
--            - medication_interaction_signal_viewer
--                                          (EXECUTE get_interaction_signal_current_state +
--                                          SELECT interaction_signal_current_state_v;
--                                          046 + 048)
--            - medication_interaction_override_recorder
--                                          (EXECUTE record_interaction_signal_override;
--                                          046 + 050)
--            - medication_interaction_knowledge_base_updater
--                                          (administrative; future PRs; 046)
--
--          NOTE: wrapper-owner roles (e.g., crisis_initiation_wrapper_owner,
--          emission_wrapper_owner, lifecycle_transition_writer_owner,
--          mv_refresh_owner) are NOT in the grant set. They are internal
--          SECDEF identities — the wrappers RUN AS those identities under
--          SECURITY DEFINER semantics, not roles that Fastify handlers
--          SET ROLE to.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- §1. Make telecheck_app_role NOINHERIT.
--
--     Without NOINHERIT, granting the 13 slice roles below would give
--     telecheck_app_role passive (always-on) privileges to call every
--     slice wrapper on every connection — equivalent to Option A from
--     the ERR (rejected for least-privilege reasons). NOINHERIT scopes
--     privilege acquisition to explicit per-transaction SET LOCAL ROLE
--     blocks AFTER Fastify Layer B authorization.
--
--     Idempotent: ALTER ROLE on an already-NOINHERIT role is a no-op.
-- -----------------------------------------------------------------------------
ALTER ROLE telecheck_app_role NOINHERIT;

COMMENT ON ROLE telecheck_app_role IS
    'Application login role for Fastify backend. Foundation 051 (2026-05-23) '
    'set NOINHERIT so granted slice-role memberships (crisis_*, admin_*, '
    'medication_interaction_*) do NOT bestow passive privileges. Handlers '
    'must explicitly SET LOCAL ROLE <slice_role> after Layer B authorization '
    'to acquire EXECUTE/SELECT on the slice wrappers/views. Composes with '
    'set_tenant_context GUC + SI-010 actor-nonce GUC within the same tx.';

-- -----------------------------------------------------------------------------
-- §2. GRANT membership in the 13 slice application/reader roles.
--
--     With telecheck_app_role NOINHERIT, these grants establish MEMBERSHIP
--     (visible via pg_has_role) but do NOT bestow passive privileges. A
--     SET LOCAL ROLE <slice_role> succeeds because membership exists; the
--     slice role's privileges apply only within the SET LOCAL block.
--
--     Each grant is gated on (a) the slice role exists (to_regrole) AND
--     (b) the membership doesn't already exist (pg_has_role). This makes
--     the migration idempotent across re-runs and tolerant of partial
--     foundation states.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v_slice_roles  TEXT[] := ARRAY[
        -- Crisis Response (SI-022; 7 roles)
        'crisis_initiator',
        'crisis_acknowledger',
        'crisis_responder',
        'crisis_resolver',
        'crisis_sweep_scheduler',
        'crisis_event_staff_reader',
        'crisis_event_patient_reader',
        -- Admin Backend Basics (SI-023; 2 roles)
        'admin_basic_operator',
        'admin_template_reviewer',
        -- Medication Interaction Engine (SI-019; 4 roles)
        'medication_interaction_engine_evaluator',
        'medication_interaction_signal_viewer',
        'medication_interaction_override_recorder',
        'medication_interaction_knowledge_base_updater'
    ];
    v_role         TEXT;
    v_granted      INTEGER := 0;
    v_skipped_exists INTEGER := 0;
    v_missing_roles TEXT[] := ARRAY[]::TEXT[];
BEGIN
    -- Recipient must exist; this is a foundation-level invariant, RAISE if not.
    IF to_regrole('telecheck_app_role') IS NULL THEN
        RAISE EXCEPTION 'migration-051-precondition-failed: '
            'telecheck_app_role does not exist; cannot bridge slice-role '
            'membership. Apply migration 001_init.sql (or whichever migration '
            'creates the application login role) before 051.';
    END IF;

    -- R1 MED-1 closure 2026-05-23: PRECONDITION CHECK — all 13 slice roles
    -- MUST exist before 051 applies. Previously this block silently skipped
    -- missing roles (leaving the bridge incomplete while marking 051
    -- "applied" in schema_migrations), which would let withDbRole fail at
    -- runtime for an allowlisted role. The fix-closed posture is: 051
    -- aborts with a precise list of missing roles + the migrations that
    -- create them, so operators apply the prerequisites and re-run.
    --
    -- This is safe under the sequential-migration discipline: 032
    -- (Crisis RBAC), 039 (Admin RBAC), and 046 (Med-Interaction RBAC)
    -- all land BEFORE 051 by file ordering. The only way to reach 051
    -- with a missing role is a hand-curated partial-apply state — which
    -- the operator must remediate explicitly.
    FOREACH v_role IN ARRAY v_slice_roles LOOP
        IF to_regrole(v_role) IS NULL THEN
            v_missing_roles := array_append(v_missing_roles, v_role);
        END IF;
    END LOOP;

    IF array_length(v_missing_roles, 1) > 0 THEN
        RAISE EXCEPTION 'migration-051-precondition-failed: % of 13 slice '
            'application/reader roles do not exist: %. Apply the relevant '
            'slice RBAC migrations BEFORE 051: migration 032 creates the '
            '7 crisis_* roles; migration 039 creates admin_basic_operator + '
            'admin_template_reviewer; migration 046 creates the 4 '
            'medication_interaction_* roles. Re-run 051 after the missing '
            'slice RBAC migrations apply.',
            array_length(v_missing_roles, 1),
            array_to_string(v_missing_roles, ', ');
    END IF;

    -- R2 HIGH-1 closure 2026-05-23: PG 16+ introduced per-membership INHERIT
    -- options (pg_auth_members.inherit_option) that are NOT controlled by
    -- ALTER ROLE NOINHERIT. ALTER ROLE NOINHERIT only sets the DEFAULT for
    -- NEW grants — pre-existing memberships with INHERIT TRUE retain that
    -- option and would let telecheck_app_role passively inherit slice
    -- privileges even when its rolinherit is FALSE, defeating Option B.
    --
    -- Fix: always issue the GRANT with explicit `WITH INHERIT FALSE,
    -- SET TRUE` on PG 16+ — this NORMALIZES per-membership options even
    -- if a prior GRANT exists with INHERIT TRUE. For PG 15, fall back to
    -- the plain GRANT (PG 15 doesn't have per-membership options; the
    -- ALTER ROLE NOINHERIT from §1 controls all memberships).
    --
    -- "SET TRUE" preserves the ability to `SET LOCAL ROLE <slice_role>`
    -- (this is the helper's mechanism — without SET privilege the helper
    -- would fail with "permission denied to set role"). Without "SET",
    -- members can inherit but cannot become; we need become, not inherit.
    --
    -- Idempotency: GRANT ... WITH ... REPLACES the existing options for
    -- the membership. Safe to re-run.
    DECLARE
        v_pg_ver_num INTEGER := current_setting('server_version_num')::INTEGER;
    BEGIN
        FOREACH v_role IN ARRAY v_slice_roles LOOP
            IF v_pg_ver_num >= 160000 THEN
                -- PG 16+: explicit per-membership INHERIT FALSE + SET TRUE.
                -- Normalizes any pre-existing membership with INHERIT TRUE.
                EXECUTE format(
                    'GRANT %I TO telecheck_app_role WITH INHERIT FALSE, SET TRUE',
                    v_role
                );
                v_granted := v_granted + 1;
            ELSE
                -- PG 15: no per-membership options; membership inherits the
                -- role's default INHERIT (which §1 ALTER ROLE made FALSE).
                IF pg_has_role('telecheck_app_role', v_role::regrole, 'MEMBER') THEN
                    v_skipped_exists := v_skipped_exists + 1;
                    CONTINUE;
                END IF;
                EXECUTE format('GRANT %I TO telecheck_app_role', v_role);
                v_granted := v_granted + 1;
            END IF;
        END LOOP;
    END;

    RAISE NOTICE 'migration-051-summary: % grants applied (PG version %), '
        '% already-existed skipped (PG15 only; PG16+ always re-issues to '
        'normalize per-membership INHERIT/SET options); all 13 slice roles '
        'confirmed present',
        v_granted,
        current_setting('server_version_num'),
        v_skipped_exists;
END $$;

-- -----------------------------------------------------------------------------
-- §3. Verification — telecheck_app_role NOINHERIT + membership in all 13.
--
--     Asserts the foundation invariants:
--     (a) telecheck_app_role is NOINHERIT (Option B mechanism).
--     (b) telecheck_app_role is a member of all 13 slice application/reader
--         roles whose CREATE ROLE migrations have been applied.
--     (c) telecheck_app_role does NOT have direct GRANT EXECUTE/SELECT on
--         any of the slice wrappers/views — privilege flows ONLY via
--         membership + SET LOCAL ROLE. This preserves the anti-bypass
--         DO-blocks in 036, 037, 038, 043, 044, 049, 050.
--
--     If any assertion fails, RAISE EXCEPTION so the migration aborts
--     before being marked applied.
-- -----------------------------------------------------------------------------

-- §3.1: NOINHERIT.
DO $$
DECLARE
    v_inherits BOOLEAN;
BEGIN
    SELECT rolinherit INTO v_inherits
      FROM pg_roles
     WHERE rolname = 'telecheck_app_role';

    IF v_inherits IS NULL THEN
        RAISE EXCEPTION 'migration-051-verify-failed: telecheck_app_role row '
            'absent from pg_roles after ALTER ROLE — investigate.';
    END IF;

    IF v_inherits THEN
        RAISE EXCEPTION 'migration-051-verify-failed: telecheck_app_role is '
            'still INHERIT after ALTER ROLE NOINHERIT. Option B mechanism '
            'requires NOINHERIT to scope privilege acquisition to explicit '
            'SET LOCAL ROLE blocks.';
    END IF;
END $$;

-- §3.2: membership in each of the 13 slice roles. Per R1 MED-1 closure
--       2026-05-23 §2 above already aborts if any role is missing.
--
--       R2 HIGH-1 closure 2026-05-23: additionally verify per-membership
--       INHERIT option on PG 16+ via pg_auth_members.inherit_option.
--       Any membership with INHERIT TRUE on PG 16+ defeats Option B
--       (telecheck_app_role would passively inherit slice privileges
--       without SET LOCAL ROLE), so RAISE on any such gap.
DO $$
DECLARE
    v_slice_roles    TEXT[] := ARRAY[
        'crisis_initiator',
        'crisis_acknowledger',
        'crisis_responder',
        'crisis_resolver',
        'crisis_sweep_scheduler',
        'crisis_event_staff_reader',
        'crisis_event_patient_reader',
        'admin_basic_operator',
        'admin_template_reviewer',
        'medication_interaction_engine_evaluator',
        'medication_interaction_signal_viewer',
        'medication_interaction_override_recorder',
        'medication_interaction_knowledge_base_updater'
    ];
    v_role             TEXT;
    v_present_count    INTEGER := 0;
    v_pg_ver_num       INTEGER := current_setting('server_version_num')::INTEGER;
    v_inherit_opt      BOOLEAN;
    v_set_opt          BOOLEAN;
BEGIN
    FOREACH v_role IN ARRAY v_slice_roles LOOP
        -- §2 precondition already guaranteed the role exists; defense-in-
        -- depth re-check here for clean error message on impossible-state.
        IF to_regrole(v_role) IS NULL THEN
            RAISE EXCEPTION 'migration-051-verify-failed: slice role % '
                'absent at §3.2 despite §2 precondition gate. Race condition '
                'or DROP ROLE after §2 completed?', v_role;
        END IF;

        IF NOT pg_has_role('telecheck_app_role', v_role::regrole, 'MEMBER') THEN
            RAISE EXCEPTION 'migration-051-verify-failed: telecheck_app_role '
                'is NOT a member of slice role %. Membership grant in §2 may '
                'have failed silently — investigate.', v_role;
        END IF;

        -- R2 HIGH-1: on PG 16+, the per-membership INHERIT option exists
        -- and is independent of telecheck_app_role's rolinherit. Verify
        -- it is FALSE; SET option must be TRUE so the helper can elevate.
        IF v_pg_ver_num >= 160000 THEN
            SELECT am.inherit_option, am.set_option
              INTO v_inherit_opt, v_set_opt
              FROM pg_auth_members am
              JOIN pg_roles m ON am.member = m.oid
              JOIN pg_roles r ON am.roleid = r.oid
             WHERE m.rolname = 'telecheck_app_role'
               AND r.rolname = v_role;

            IF v_inherit_opt IS NULL THEN
                RAISE EXCEPTION 'migration-051-verify-failed: no '
                    'pg_auth_members row for telecheck_app_role <- %; '
                    'membership not registered on PG 16+. §2 GRANT may '
                    'have failed silently.', v_role;
            END IF;

            IF v_inherit_opt THEN
                RAISE EXCEPTION 'migration-051-verify-failed: membership '
                    'telecheck_app_role <- % has INHERIT TRUE on PG 16+. '
                    'This defeats Option B — telecheck_app_role would '
                    'passively inherit slice privileges without '
                    'SET LOCAL ROLE. §2 should have re-issued GRANT WITH '
                    'INHERIT FALSE to normalize. Investigate or re-run 051.',
                    v_role;
            END IF;

            IF NOT v_set_opt THEN
                RAISE EXCEPTION 'migration-051-verify-failed: membership '
                    'telecheck_app_role <- % has SET FALSE on PG 16+. '
                    'The withDbRole helper requires SET TRUE to issue '
                    'SET LOCAL ROLE. §2 should have granted WITH SET TRUE. '
                    'Investigate or re-run 051.', v_role;
            END IF;
        END IF;

        v_present_count := v_present_count + 1;
    END LOOP;

    IF v_present_count <> 13 THEN
        RAISE EXCEPTION 'migration-051-verify-failed: expected membership in '
            '13 slice roles; counted %. Loop logic defect.', v_present_count;
    END IF;

    IF v_pg_ver_num >= 160000 THEN
        RAISE NOTICE 'migration-051-verify: telecheck_app_role membership '
            'present in all 13/13 slice roles with per-membership '
            'INHERIT=FALSE + SET=TRUE (Option B mechanism intact on PG 16+)';
    ELSE
        RAISE NOTICE 'migration-051-verify: telecheck_app_role membership '
            'present in all 13/13 slice roles (PG 15; Option B mechanism '
            'enforced via role-default NOINHERIT from §1)';
    END IF;
END $$;

-- §3.3: anti-bypass — telecheck_app_role MUST NOT appear as a direct grantee
--       on a representative subset of wrappers + views across all 3 slices.
--       Direct-grantee inspection via information_schema continues to show
--       ONLY the wrapper-owner + the canonical slice role. (Full per-wrapper
--       verification is not done here; the per-slice anti-bypass DO-blocks
--       in 036/037/038/043/044/049/050 already enforce this on their own
--       application + would RAISE if direct grants were added. This block
--       provides a foundation-level smoke check.)
DO $$
DECLARE
    v_unexpected_direct_grants INTEGER;
BEGIN
    -- Crisis: record_crisis_initiation (from migration 036).
    SELECT COUNT(*)
      INTO v_unexpected_direct_grants
      FROM information_schema.role_routine_grants
     WHERE specific_schema = 'public'
       AND routine_name = 'record_crisis_initiation'
       AND grantee = 'telecheck_app_role'
       AND privilege_type = 'EXECUTE';
    IF v_unexpected_direct_grants > 0 THEN
        RAISE EXCEPTION 'migration-051-verify-failed: telecheck_app_role has '
            'a DIRECT EXECUTE grant on record_crisis_initiation. Option B '
            'requires privilege flow via membership + SET LOCAL ROLE ONLY. '
            'A direct grant would violate the 036 anti-bypass DO-block. '
            'Remove the direct grant.';
    END IF;

    -- Admin: submit_forms_template_for_admin_review (from migration 043).
    SELECT COUNT(*)
      INTO v_unexpected_direct_grants
      FROM information_schema.role_routine_grants
     WHERE specific_schema = 'public'
       AND routine_name = 'submit_forms_template_for_admin_review'
       AND grantee = 'telecheck_app_role'
       AND privilege_type = 'EXECUTE';
    IF v_unexpected_direct_grants > 0 THEN
        RAISE EXCEPTION 'migration-051-verify-failed: telecheck_app_role has '
            'a DIRECT EXECUTE grant on submit_forms_template_for_admin_review. '
            'Option B violation; see record_crisis_initiation check above for '
            'remediation.';
    END IF;

    -- Med-Interaction: get_interaction_signal_current_state (from migration 048).
    SELECT COUNT(*)
      INTO v_unexpected_direct_grants
      FROM information_schema.role_routine_grants
     WHERE specific_schema = 'public'
       AND routine_name = 'get_interaction_signal_current_state'
       AND grantee = 'telecheck_app_role'
       AND privilege_type = 'EXECUTE';
    IF v_unexpected_direct_grants > 0 THEN
        RAISE EXCEPTION 'migration-051-verify-failed: telecheck_app_role has '
            'a DIRECT EXECUTE grant on get_interaction_signal_current_state. '
            'Option B violation; see record_crisis_initiation check above for '
            'remediation.';
    END IF;
END $$;

-- =============================================================================
-- Migration 051 complete. telecheck_app_role is NOINHERIT + member of all
-- present slice application/reader roles. Per-handler SET LOCAL ROLE elevation
-- is now possible via the (forthcoming) withDbRole helper.
--
-- NEXT STEPS (separate PRs):
--   - withDbRole lib helper + allowlisted RoleEnum + composability with
--     withTenantContext / withActorContext / withTransaction.
--   - Per-slice integration tests proving the 4 invariants per Codex Pass-2:
--       (1) direct wrapper call as telecheck_app_role fails (no SET ROLE)
--       (2) SET LOCAL ROLE wrong slice role fails
--       (3) SET LOCAL ROLE correct slice role succeeds (or reaches fail-closed)
--       (4) direct-grantee inspection still shows only owner + canonical role
--   - Resume Crisis Sprint 2 / Admin Sprint 2 / Med-Interaction PR 7+ handlers.
-- =============================================================================
