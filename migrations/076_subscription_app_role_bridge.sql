-- =============================================================================
-- File:    migrations/076_subscription_app_role_bridge.sql
-- Purpose: Bridge the 4 Subscription slice roles (migration 074) into the
--          Option B app-role acquisition foundation (migration 051) by
--          granting telecheck_app_role NOINHERIT membership in each, and
--          extend the SI-010 actor-context helper EXECUTE grants (migration
--          063 pattern) to the 4 new roles. Without the bridge, the Fastify
--          handlers' withDbRole('subscription_*', ...) calls fail at runtime
--          with "permission denied to set role"; without the helper grants,
--          any future predicate that calls current_actor_account_id() under a
--          subscription role 42501s (the 063 lesson from staging E2E step 8).
--
--          Follow-up foundation migration prescribed by
--          src/lib/with-db-role.ts §"Why this lives in src/lib" — GRANT
--          mechanics are a verbatim carryforward of 051 §2 / 061 (including
--          the PG 16 per-membership INHERIT FALSE + SET TRUE normalization
--          from the 051 R2 HIGH-1 closure), scoped to the 4 subscription
--          roles.
--
-- Preconditions: migrations 051 (telecheck_app_role NOINHERIT foundation),
--   062/063 (actor-context helpers), 074 (the 4 roles) applied.
-- Invariants: preserves the 051 §3 anti-bypass posture — telecheck_app_role
--   gains NO direct table grants here; privilege flows ONLY via membership +
--   SET LOCAL ROLE.
-- Rollback: migrations/rollback/076_rollback.sql
-- =============================================================================

DO $$
DECLARE
    v_slice_roles  TEXT[] := ARRAY[
        'subscription_patient_manager',
        'subscription_clinician_reviewer',
        'subscription_system_scheduler',
        'subscription_staff_reader'
    ];
    v_role           TEXT;
    v_granted        INTEGER := 0;
    v_skipped_exists INTEGER := 0;
    v_missing_roles  TEXT[] := ARRAY[]::TEXT[];
BEGIN
    IF to_regrole('telecheck_app_role') IS NULL THEN
        RAISE EXCEPTION 'migration-076-precondition-failed: '
            'telecheck_app_role does not exist; apply the migration that '
            'creates the application login role (and 051) before 076.';
    END IF;

    -- All 4 subscription roles MUST exist (fail-closed per 051 R1 MED-1).
    FOREACH v_role IN ARRAY v_slice_roles LOOP
        IF to_regrole(v_role) IS NULL THEN
            v_missing_roles := array_append(v_missing_roles, v_role);
        END IF;
    END LOOP;

    IF array_length(v_missing_roles, 1) > 0 THEN
        RAISE EXCEPTION 'migration-076-precondition-failed: % of 4 '
            'subscription roles do not exist: %. Apply migration '
            '074_subscription_rbac_roles.sql BEFORE 076, then re-run.',
            array_length(v_missing_roles, 1),
            array_to_string(v_missing_roles, ', ');
    END IF;

    -- PG 16+: explicit per-membership INHERIT FALSE + SET TRUE. PG 15:
    -- plain GRANT; the role-level NOINHERIT from 051 §1 governs.
    DECLARE
        v_pg_ver_num INTEGER := current_setting('server_version_num')::INTEGER;
    BEGIN
        FOREACH v_role IN ARRAY v_slice_roles LOOP
            IF v_pg_ver_num >= 160000 THEN
                EXECUTE format(
                    'GRANT %I TO telecheck_app_role WITH INHERIT FALSE, SET TRUE',
                    v_role
                );
                v_granted := v_granted + 1;
            ELSE
                IF pg_has_role('telecheck_app_role', v_role::regrole, 'MEMBER') THEN
                    v_skipped_exists := v_skipped_exists + 1;
                    CONTINUE;
                END IF;
                EXECUTE format('GRANT %I TO telecheck_app_role', v_role);
                v_granted := v_granted + 1;
            END IF;
        END LOOP;
    END;

    RAISE NOTICE 'migration-076-summary: % grants applied (PG version %), '
        '% already-existed skipped (PG15 only); all 4 subscription roles '
        'confirmed present',
        v_granted,
        current_setting('server_version_num'),
        v_skipped_exists;
END $$;

-- -----------------------------------------------------------------------------
-- SI-010 actor-context helper EXECUTE grants (063 pattern, scoped to the 4
-- new roles — the 063 live-derivation loop covered only roles bridged BEFORE
-- it ran; new bridge migrations add their own grants per the 063 header).
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v_slice_roles TEXT[] := ARRAY[
        'subscription_patient_manager',
        'subscription_clinician_reviewer',
        'subscription_system_scheduler',
        'subscription_staff_reader'
    ];
    v_role TEXT;
BEGIN
    FOREACH v_role IN ARRAY v_slice_roles LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION _current_actor_context_row() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_account_id() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_account_tenant_id() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_role() TO %I', v_role);
        EXECUTE format('GRANT EXECUTE ON FUNCTION current_actor_admin_home_tenant_id() TO %I', v_role);
        RAISE NOTICE 'migration-076-grant: helper EXECUTE granted to slice role %', v_role;
    END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Verification — membership present, NOINHERIT posture intact, helper grants
-- in place.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v_slice_roles  TEXT[] := ARRAY[
        'subscription_patient_manager',
        'subscription_clinician_reviewer',
        'subscription_system_scheduler',
        'subscription_staff_reader'
    ];
    v_role     TEXT;
    v_inherits BOOLEAN;
BEGIN
    SELECT rolinherit INTO v_inherits
      FROM pg_roles
     WHERE rolname = 'telecheck_app_role';
    IF v_inherits THEN
        RAISE EXCEPTION 'migration-076-verification: telecheck_app_role is '
            'INHERIT; the Option B foundation requires NOINHERIT (051 §1).';
    END IF;

    FOREACH v_role IN ARRAY v_slice_roles LOOP
        IF NOT pg_has_role('telecheck_app_role', v_role::regrole, 'MEMBER') THEN
            RAISE EXCEPTION 'migration-076-verification: telecheck_app_role '
                'is not a member of % after the bridge; GRANT failed.', v_role;
        END IF;
        IF NOT (
            has_function_privilege(v_role, '_current_actor_context_row()', 'EXECUTE')
            AND has_function_privilege(v_role, 'current_actor_account_id()', 'EXECUTE')
        ) THEN
            RAISE EXCEPTION 'migration-076-verification: % missing SI-010 helper EXECUTE', v_role;
        END IF;
    END LOOP;

    RAISE NOTICE 'migration-076-verify: clean — telecheck_app_role NOINHERIT '
        '+ member of all 4 subscription roles + helper grants present';
END $$;
