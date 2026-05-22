-- =============================================================================
-- File:    migrations/032_crisis_response_rbac_roles.sql
-- Purpose: Create the 15 net-new RBAC roles required by the Crisis Response
--          slice (SI-022 v1.0 RATIFIED at P-039 + CDM follow-on landing at
--          P-040 RATIFIED 2026-05-21).
--
--          This is PR 1 of the Crisis Response implementation series — pure
--          RBAC role creation. No table DDL, no RLS policies, no SECDEF
--          procedures. Subsequent PRs add entities + RLS + triggers (PR 1
--          continued) → derived views (PR 2) → 6 SECDEF wrappers (PR 3+) →
--          Fastify routes + integration tests (later PRs).
--
--          All 15 roles are NOLOGIN + non-BYPASSRLS per the spec corpus
--          canonical pattern (Telecheck Master Bundle
--          Telecheck_CDM_v1_9_to_v1_10_Amendment.md §1 in-scope item 5;
--          §6 RBAC table; §8.1 class A enumeration; §8.2 Phase 1).
--          Application roles (7) are NOLOGIN at creation because end-user
--          principals are bound at request time via the application's
--          authContextPlugin (SI-010 trust anchor from migration 031);
--          the DB roles are the privilege boundary, not direct login
--          identities. Procedure-owner roles (6) and view-owner roles (2)
--          are NOLOGIN by canonical convention — owner roles exist solely
--          to scope SECDEF / view privileges, never to be logged into.
--
--          R1 HIGH-2 reader-role split per P-040 R1 HIGH-2 closure
--          2026-05-21: crisis_event_staff_reader (tenant-wide via the
--          crisis_event_current_state_v staff view) and
--          crisis_event_patient_reader (self-scoped via the
--          crisis_event_patient_summary_v predicate-restricted view) are
--          DISTINCT roles. The retired single crisis_event_reader role
--          is NOT created (matches Telecheck_CDM_v1_9_to_v1_10_Amendment.md
--          §8.1 class A allowlist enforcement).
--
-- Spec:    - SI-022 Crisis Response Slice v1.0 (RATIFIED 2026-05-21 P-039;
--            sibling repo: telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_SI_022_Crisis_Response_v1_0.md §7 RBAC)
--          - CDM v1.9 → v1.10 + AUDIT_EVENTS v5.11 → v5.12 + OpenAPI v0.4 → v0.5
--            + State Machines v1.3 → v1.4 + RBAC v1.3 → v1.4 Amendment
--            (RATIFIED 2026-05-21 P-040; sibling repo: telecheckONE/
--            Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_9_to_v1_10_Amendment.md §1 in-scope item 5;
--            §6 RBAC table; §8.2 Phase 1)
--          - I-019 (crisis-detection-always-on platform-floor)
--          - I-023 (three-layer tenant isolation; tenant_id on every PHI record)
--          - I-024 (cross-tenant access requires break-glass with audit)
--          - I-027 (audit append-only)
--          - I-035 (append-only invariant for ratification + audit-bound state
--            machines)
--          - FLOOR-020 (Cat A fail-closed audit emission discipline)
-- Summary: Creates 15 net-new RBAC roles:
--          - Application roles (7): crisis_initiator + crisis_acknowledger +
--            crisis_responder + crisis_resolver + crisis_sweep_scheduler +
--            crisis_event_staff_reader + crisis_event_patient_reader
--          - Procedure-owner roles (5): 1 raw transition writer owner + 4
--            wrapper owner roles (initiation + acknowledgement + response +
--            resolution + sweep)
--          - View-owner roles (2): staff view owner + patient view owner
--            (split per R1 HIGH-2 closure 2026-05-21)
--
--          All 15 roles are NOLOGIN + non-BYPASSRLS. NO grants in this
--          migration — grants are applied in subsequent migrations after
--          the target tables/views/procedures exist (per the spec corpus
--          P-040 §8.2 R9 HIGH-1 closure pattern: GRANT statements go in
--          their natural cutover phase, not Phase 1).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Application roles (7) — assigned to end-user principals at request time
-- by authContextPlugin (SI-010 trust anchor); DB roles scope wrapper EXECUTE
-- + view SELECT privileges, never logged into directly.
-- -----------------------------------------------------------------------------

CREATE ROLE crisis_initiator NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_initiator IS
    'P-040 §6 application role: clinician + on-call clinician + ai_mode1_service. '
    'Holds EXECUTE on record_crisis_initiation() wrapper (granted in subsequent migration).';

CREATE ROLE crisis_acknowledger NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_acknowledger IS
    'P-040 §6 application role: care_team + clinical_on_call. '
    'Holds EXECUTE on record_crisis_acknowledgement_claim() wrapper.';

CREATE ROLE crisis_responder NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_responder IS
    'P-040 §6 application role: care_team + clinical_on_call + regulatory_reporter. '
    'Holds EXECUTE on record_crisis_response() wrapper.';

CREATE ROLE crisis_resolver NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_resolver IS
    'P-040 §6 application role: care_team + clinical_on_call. '
    'Holds EXECUTE on record_crisis_resolution() wrapper.';

CREATE ROLE crisis_sweep_scheduler NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_sweep_scheduler IS
    'P-040 §6 application role: scheduler service identity. '
    'Holds EXECUTE on execute_crisis_no_acknowledgement_sweep() wrapper.';

CREATE ROLE crisis_event_staff_reader NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_event_staff_reader IS
    'P-040 R1 HIGH-2 split: tenant-wide staff reader. '
    'Granted to clinician + care_team + admin roles. '
    'Holds SELECT on crisis_event_current_state_v (granted in subsequent migration). '
    'Does NOT hold SELECT on crisis_event_patient_summary_v.';

CREATE ROLE crisis_event_patient_reader NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_event_patient_reader IS
    'P-040 R1 HIGH-2 split: self-scoped patient reader. '
    'Granted to patient + delegate roles. '
    'Holds SELECT on crisis_event_patient_summary_v ONLY (predicate-restricted to caller`s own '
    'patient_id OR delegated patient_ids via the view body using SI-010 trust anchor; '
    'tenant scope enforced by RLS on underlying tables). '
    'Does NOT hold SELECT on crisis_event_current_state_v.';

-- -----------------------------------------------------------------------------
-- Procedure-owner roles (6) — own the 6 SECDEF procedures (1 raw + 5 wrappers)
-- deployed in subsequent migration. Anti-bypass: raw writer is EXECUTE-granted
-- ONLY to the 5 wrapper-owner roles; application roles do NOT hold EXECUTE on
-- the raw writer. Each wrapper-owner is owned by exactly one wrapper procedure.
-- -----------------------------------------------------------------------------

CREATE ROLE crisis_event_lifecycle_transition_writer_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_event_lifecycle_transition_writer_owner IS
    'P-040 §6 procedure-owner role: owns record_crisis_event_lifecycle_transition() '
    'raw canonical lifecycle writer. EXECUTE granted ONLY to the 5 wrapper-owner roles '
    'below (anti-bypass discipline per P-034 §3 + P-038 §3 + P-040 §3 pattern).';

CREATE ROLE crisis_initiation_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_initiation_wrapper_owner IS
    'P-040 §6 procedure-owner role: owns record_crisis_initiation() wrapper. '
    'EXECUTE granted to crisis_initiator application role.';

CREATE ROLE crisis_acknowledgement_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_acknowledgement_wrapper_owner IS
    'P-040 §6 procedure-owner role: owns record_crisis_acknowledgement_claim() wrapper. '
    'EXECUTE granted to crisis_acknowledger application role.';

CREATE ROLE crisis_response_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_response_wrapper_owner IS
    'P-040 §6 procedure-owner role: owns record_crisis_response() wrapper. '
    'EXECUTE granted to crisis_responder application role.';

CREATE ROLE crisis_resolution_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_resolution_wrapper_owner IS
    'P-040 §6 procedure-owner role: owns record_crisis_resolution() wrapper. '
    'EXECUTE granted to crisis_resolver application role.';

CREATE ROLE crisis_sweep_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_sweep_wrapper_owner IS
    'P-040 §6 procedure-owner role: owns execute_crisis_no_acknowledgement_sweep() wrapper. '
    'EXECUTE granted to crisis_sweep_scheduler application role.';

-- -----------------------------------------------------------------------------
-- View-owner roles (2) — own the 2 derived views per P-040 R1 HIGH-2 reader-
-- role split. Each view is owned by a distinct role + grants SELECT to EXACTLY
-- ONE reader role per the canonical wrapper-only / split-reader pattern.
-- -----------------------------------------------------------------------------

CREATE ROLE crisis_event_current_state_view_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_event_current_state_view_owner IS
    'P-040 §6 view-owner role: owns crisis_event_current_state_v staff view '
    '(tenant-wide; security_invoker=true + security_barrier=true). '
    'SOLE role with SELECT on crisis_event_current_state_v alongside the '
    'crisis_event_staff_reader grantee.';

CREATE ROLE crisis_event_patient_summary_view_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE crisis_event_patient_summary_view_owner IS
    'P-040 §6 view-owner role: owns crisis_event_patient_summary_v patient view '
    '(self-scoped via verify_session_jwt-equivalent predicate using SI-010 trust anchor '
    '+ consent_grant predicate; security_invoker=true + security_barrier=true). '
    'SOLE role with SELECT on crisis_event_patient_summary_v alongside the '
    'crisis_event_patient_reader grantee.';

-- -----------------------------------------------------------------------------
-- Retired-role sentinel (per P-040 §8.1 class A enforcement): the single
-- crisis_event_reader role MUST NOT exist (it was retired at P-040 R1 HIGH-2
-- in favor of the staff/patient split above). This migration does NOT create
-- it; downstream preflight in PR 2 (when views land + grants apply) will
-- enforce that the role is absent.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Verification: count of net-new crisis_* roles should be exactly 15.
-- This DO block is a self-check at apply time; it will fail loudly if the
-- migration is partially applied or accidentally creates extra roles.
-- =============================================================================

DO $$
DECLARE
    v_created_count INTEGER;
    v_expected_count CONSTANT INTEGER := 15;
BEGIN
    SELECT COUNT(*) INTO v_created_count
      FROM pg_roles
     WHERE rolname IN (
         'crisis_initiator',
         'crisis_acknowledger',
         'crisis_responder',
         'crisis_resolver',
         'crisis_sweep_scheduler',
         'crisis_event_staff_reader',
         'crisis_event_patient_reader',
         'crisis_event_lifecycle_transition_writer_owner',
         'crisis_initiation_wrapper_owner',
         'crisis_acknowledgement_wrapper_owner',
         'crisis_response_wrapper_owner',
         'crisis_resolution_wrapper_owner',
         'crisis_sweep_wrapper_owner',
         'crisis_event_current_state_view_owner',
         'crisis_event_patient_summary_view_owner'
     );

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-032-crisis-rbac-count-mismatch: '
            'expected % crisis_* roles created, found %; '
            'P-040 §6 RBAC table + §8.1 class A enumeration require all 15',
            v_expected_count, v_created_count;
    END IF;

    -- Verify retired single-reader role is absent (P-040 R1 HIGH-2 closure)
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crisis_event_reader') THEN
        RAISE EXCEPTION
            'migration-032-retired-role-present: '
            'crisis_event_reader is the retired pre-R1-HIGH-2 single-reader role '
            'and MUST NOT exist per P-040 §6 + §8.1 class A allowlist enforcement; '
            'split into crisis_event_staff_reader + crisis_event_patient_reader.';
    END IF;
END $$;
