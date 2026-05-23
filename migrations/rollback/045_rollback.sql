-- =============================================================================
-- File:    migrations/rollback/045_rollback.sql
-- Purpose: Rollback migration 045_crisis_response_lifecycle_sequence_usage_fix.sql.
--
--          REVOKEs USAGE on crisis_event_lifecycle_transition_id_seq from
--          crisis_event_lifecycle_transition_writer_owner.
--
--          NOTE: rolling this migration back RE-INTRODUCES the migration-035
--          runtime defect (raw writer nextval() fails with "permission
--          denied for sequence"). This rollback exists for completeness +
--          symmetry with migration 045 forward, NOT because rolling back
--          is a desirable operation. If 045 is rolled back without also
--          rolling back 035-038, the next invocation of any crisis-event
--          lifecycle wrapper will fail at runtime.
--
--          Pre-rollback check (operator): if migrations 035-038 are still
--          applied, expect the crisis-event lifecycle wrapper paths to be
--          broken after this rollback. Operators rolling back 045 should
--          typically also roll back 035-038 in the same window OR be
--          intentionally taking the crisis-detection path offline.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Revoke USAGE on the BIGSERIAL implicit sequence.
--    Gate REVOKE on sequence existence + role existence so a partial-prior-
--    rollback state (sequence dropped by an earlier 033 rollback, or role
--    dropped by an earlier 032 rollback) does not abort this rollback before
--    completion. Canonical precedent: migration 042 rollback R1 MED-1 +
--    R2 MED-1 closures, which gate REVOKE on to_regprocedure / to_regclass
--    existence first.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_sequence_oid OID := to_regclass(
        'public.crisis_event_lifecycle_transition_id_seq'
    );
    v_role_exists  BOOLEAN := EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname = 'crisis_event_lifecycle_transition_writer_owner'
    );
BEGIN
    -- Only attempt REVOKE if both sides of the grant still exist. REVOKE
    -- USAGE ON SEQUENCE fails outright if the sequence does not resolve,
    -- and (less critically) fails if the role does not exist. Either of
    -- those is plausible under partial-prior-rollback / manual-repair
    -- conditions; we tolerate them by skipping the REVOKE and proceeding
    -- to post-rollback verification.
    IF v_sequence_oid IS NOT NULL AND v_role_exists THEN
        REVOKE USAGE ON SEQUENCE crisis_event_lifecycle_transition_id_seq
            FROM crisis_event_lifecycle_transition_writer_owner;
    END IF;
END $$;

-- =============================================================================
-- Post-rollback verification: USAGE grant should be absent.
--
-- If the sequence + role both still exist, the writer-owner must NOT hold a
-- direct USAGE grant on the sequence. If either was already gone before
-- this rollback ran, the verification is a no-op (the grant cannot exist).
-- =============================================================================
DO $$
DECLARE
    v_sequence_oid     OID := to_regclass(
        'public.crisis_event_lifecycle_transition_id_seq'
    );
    v_role_exists      BOOLEAN := EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname = 'crisis_event_lifecycle_transition_writer_owner'
    );
    v_grant_still_held BOOLEAN;
BEGIN
    IF v_sequence_oid IS NULL OR NOT v_role_exists THEN
        -- Nothing to verify; the grant trivially does not exist if either
        -- side has been dropped. Exit silently.
        RETURN;
    END IF;

    -- Check information_schema for the direct grant. (has_sequence_privilege
    -- would report effective privilege including inherited paths, which is
    -- the wrong shape for the rollback verification — we only care that the
    -- DIRECT grant created by migration 045 is gone.)
    SELECT EXISTS (
        SELECT 1
          FROM information_schema.role_usage_grants
         WHERE object_schema = 'public'
           AND object_name = 'crisis_event_lifecycle_transition_id_seq'
           AND object_type = 'SEQUENCE'
           AND privilege_type = 'USAGE'
           AND grantee = 'crisis_event_lifecycle_transition_writer_owner'
    ) INTO v_grant_still_held;

    IF v_grant_still_held THEN
        RAISE WARNING
            'migration-045-rollback-incomplete: '
            'crisis_event_lifecycle_transition_writer_owner still holds a '
            'direct USAGE grant on crisis_event_lifecycle_transition_id_seq. '
            'REVOKE in the DO block above should have succeeded — investigate.';
    END IF;
END $$;
