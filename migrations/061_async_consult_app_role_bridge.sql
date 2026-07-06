-- =============================================================================
-- File:    migrations/061_async_consult_app_role_bridge.sql
-- Purpose: Bridge the 5 Async Consult application/reader roles (created at
--          migration 055) into the Option B app-role acquisition foundation
--          (migration 051) by granting telecheck_app_role NOINHERIT
--          membership in each. Without this bridge the Fastify handlers'
--          withDbRole('async_consult_*', ...) calls fail at runtime with
--          "permission denied to set role".
--
--          PR 6 of the Async Consult Sprint-10 series (055 roles → 056
--          entities → 057 views → 058 raw writer → 059 wrappers → THIS +
--          the /v1/async-consults Fastify handler surface).
--
--          This is the follow-up foundation migration prescribed by
--          src/lib/with-db-role.ts §"Why this lives in src/lib": "New SECDEF
--          slices add to the SLICE_ROLES tuple here AND grant membership in
--          their new roles to telecheck_app_role via a follow-up foundation
--          migration (analogous to 051 §2)." The GRANT mechanics below are a
--          verbatim carryforward of 051 §2 (including the PG 16 per-membership
--          INHERIT FALSE + SET TRUE normalization from the 051 R2 HIGH-1
--          closure), scoped to the 5 async-consult roles.
--
--          Roles bridged (migration 055 §1 application/reader roles ONLY —
--          wrapper-owner / view-owner / writer-owner identities are NEVER
--          bridged; handlers must not SET ROLE into SECDEF owner identities):
--            1. async_consult_patient_initiator
--            2. async_consult_delegate_initiator
--            3. async_consult_clinician_reviewer
--            4. async_consult_patient_reader
--            5. async_consult_staff_reader
--
-- Preconditions: migrations 051 (telecheck_app_role NOINHERIT foundation)
--   + 055 (the 5 roles) applied.
-- Invariants: preserves the 051 §3 anti-bypass posture — telecheck_app_role
--   gains NO direct EXECUTE/SELECT grants here; privilege flows ONLY via
--   membership + SET LOCAL ROLE.
-- =============================================================================

DO $$
DECLARE
    v_slice_roles  TEXT[] := ARRAY[
        'async_consult_patient_initiator',
        'async_consult_delegate_initiator',
        'async_consult_clinician_reviewer',
        'async_consult_patient_reader',
        'async_consult_staff_reader'
    ];
    v_role           TEXT;
    v_granted        INTEGER := 0;
    v_skipped_exists INTEGER := 0;
    v_missing_roles  TEXT[] := ARRAY[]::TEXT[];
BEGIN
    -- Recipient must exist (foundation-level invariant per 051 §2).
    IF to_regrole('telecheck_app_role') IS NULL THEN
        RAISE EXCEPTION 'migration-061-precondition-failed: '
            'telecheck_app_role does not exist; apply the migration that '
            'creates the application login role (and 051) before 061.';
    END IF;

    -- All 5 async-consult roles MUST exist (fail-closed per the 051 R1
    -- MED-1 closure posture — silently skipping missing roles would mark
    -- 061 applied while leaving the bridge incomplete).
    FOREACH v_role IN ARRAY v_slice_roles LOOP
        IF to_regrole(v_role) IS NULL THEN
            v_missing_roles := array_append(v_missing_roles, v_role);
        END IF;
    END LOOP;

    IF array_length(v_missing_roles, 1) > 0 THEN
        RAISE EXCEPTION 'migration-061-precondition-failed: % of 5 async '
            'consult application/reader roles do not exist: %. Apply '
            'migration 055_async_consult_rbac_roles.sql BEFORE 061, then '
            're-run.',
            array_length(v_missing_roles, 1),
            array_to_string(v_missing_roles, ', ');
    END IF;

    -- PG 16+: explicit per-membership INHERIT FALSE + SET TRUE (normalizes
    -- any pre-existing membership with INHERIT TRUE — 051 R2 HIGH-1
    -- closure carryforward). PG 15: plain GRANT; the role-level NOINHERIT
    -- from 051 §1 governs all memberships.
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

    RAISE NOTICE 'migration-061-summary: % grants applied (PG version %), '
        '% already-existed skipped (PG15 only); all 5 async consult roles '
        'confirmed present',
        v_granted,
        current_setting('server_version_num'),
        v_skipped_exists;
END $$;

-- -----------------------------------------------------------------------------
-- Verification — membership present + no direct-grant bypass introduced.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v_slice_roles  TEXT[] := ARRAY[
        'async_consult_patient_initiator',
        'async_consult_delegate_initiator',
        'async_consult_clinician_reviewer',
        'async_consult_patient_reader',
        'async_consult_staff_reader'
    ];
    v_role     TEXT;
    v_inherits BOOLEAN;
BEGIN
    -- (a) telecheck_app_role remains NOINHERIT (051 §1 posture untouched).
    SELECT rolinherit INTO v_inherits
      FROM pg_roles
     WHERE rolname = 'telecheck_app_role';
    IF v_inherits THEN
        RAISE EXCEPTION 'migration-061-verification: telecheck_app_role is '
            'INHERIT; the Option B foundation requires NOINHERIT (051 §1). '
            'Something reverted the foundation posture — do not proceed.';
    END IF;

    -- (b) telecheck_app_role is a member of all 5 async consult roles.
    FOREACH v_role IN ARRAY v_slice_roles LOOP
        IF NOT pg_has_role('telecheck_app_role', v_role::regrole, 'MEMBER') THEN
            RAISE EXCEPTION 'migration-061-verification: telecheck_app_role '
                'is not a member of % after the bridge; GRANT failed.', v_role;
        END IF;
    END LOOP;

    RAISE NOTICE 'migration-061-verify: clean — telecheck_app_role NOINHERIT '
        '+ member of all 5 async consult application/reader roles';
END $$;
