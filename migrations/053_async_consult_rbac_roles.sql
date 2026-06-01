-- =============================================================================
-- File:    migrations/053_async_consult_rbac_roles.sql
-- Purpose: Create the 13 net-new RBAC roles required by the Async Consult slice
--          (SI-020 v0.11 RATIFIED at P-037 2026-05-21 + CDM v1.8 → v1.9 +
--          AUDIT_EVENTS v5.10 → v5.11 + OpenAPI v0.3 → v0.4 + State Machines
--          v1.2 → v1.3 + RBAC v1.2 → v1.3 follow-on amendment RATIFIED at P-038
--          2026-05-21).
--
--          This is PR 1 of the Async Consult Sprint-10 implementation series —
--          pure RBAC role creation. No table DDL, no RLS policies, no SECDEF
--          procedures, no grants. Subsequent PRs add the 7 entities + RLS +
--          append-only triggers (PR 2) → the 2 caller-class-split views +
--          optional MV + SECDEF helpers (PR 3) → raw lifecycle writer (PR 4)
--          → 6 wrapper procedures (PR 5+) → Fastify handler wiring (later PRs),
--          following the Crisis Response + Admin Backend + Med-Interaction
--          cadence.
--
--          The Async Consult slice is pilot-viable scope item 2 of 5
--          (Master Completion Plan v1.0 §A.5); SI-020 v0.11 RATIFIED P-037 +
--          P-038 CDM follow-on opens the implementation gate. PR 1 lands no
--          executable surface yet — only the privilege boundary (DB roles) that
--          the later table-INSERT / view-SELECT / procedure-EXECUTE grants
--          bind to.
--
--          All 13 roles are NOLOGIN + non-BYPASSRLS per the spec corpus
--          canonical pattern (matches migration 032 crisis + migration 039
--          admin + migration 046 med-interaction precedent). Application
--          roles (5) are NOLOGIN because end-user / service principals are
--          bound at request time via the application's authContextPlugin
--          (SI-010 trust anchor from migration 031); the DB roles are the
--          privilege boundary, not direct login identities. Wrapper-owner
--          roles (6) + view/MV owner roles (2) are NOLOGIN by canonical
--          convention — owner roles exist solely to scope SECDEF /
--          table-INSERT / view-SELECT / MV-refresh privileges, never to be
--          logged into.
--
--          PER RATIFIER OPTION 2 (carryforward from Crisis Response /
--          Admin Backend / Med-Interaction PRs;
--          docs/crisis-response-implementation-plan.md):
--          - Adapt to code-repo conventions: NOLOGIN + non-BYPASSRLS only.
--          - No grants in this migration (granted in their natural phase
--            when the target tables / views / MV / procedures exist, per the
--            P-040 §8.2 R9 HIGH-1 closure pattern Crisis Response followed
--            and Med-Interaction PR 1 mirrored).
--          - Role names taken verbatim from P-038 §8 RBAC table; no
--            normalization needed (no dotted-canonical forms in this slice's
--            RBAC table — contrast with SI-019 P-034 §8 which named two
--            dotted application roles that 046 underscore-normalized).
--
--          NOT CREATED HERE — `medication_interaction_resolution_subscriber`:
--          P-034 §8 (SI-019 Med-Interaction) named this role as "defined
--          elsewhere" — specifically by the Async Consult domain-event
--          subscriber registry per P-038 §3 resolution-wrapper EXECUTE-grant
--          target. However, the Async Consult v1.0 follow-on amendment P-038
--          does NOT enumerate `medication_interaction_resolution_subscriber`
--          in §8 RBAC; the subscriber registry that owns this role is a
--          downstream domain-event subscription concern (subscribes to
--          `medication_interaction.resolution_recorded.v1` for cross-slice
--          state propagation), not a §8 application or wrapper-owner role.
--          It is NOT one of SI-020's 13 net-new roles and is NOT created by
--          this migration. The subscriber registry that owns this role
--          (a separate sub-system per Async Consult's Mode 2 protocol
--          execution integration) will create it when wiring lands.
--
-- Spec:    - Async Consult Slice PRD v0.11 RATIFIED (2026-05-21 P-037; sibling
--            repo: telecheckONE/Telecheck Master Bundle FINAL US REGION
--            BASELINE/Telecheck_Async_Consult_Slice_PRD_v0_11.md or its v1.0
--            promotion target)
--          - CDM v1.8 → v1.9 + AUDIT_EVENTS v5.10 → v5.11 + DOMAIN_EVENTS
--            additive + OpenAPI v0.3 → v0.4 + State Machines v1.2 → v1.3 +
--            RBAC v1.2 → v1.3 Amendment (RATIFIED 2026-05-21 P-038; sibling
--            repo: telecheckONE/Telecheck Master Bundle FINAL US REGION
--            BASELINE/Telecheck_CDM_v1_8_to_v1_9_Amendment.md §8 RBAC table —
--            the authoritative 13-role enumeration)
--          - SI-005 record_consult_clinician_decision foundation (P-021 +
--            P-021a actor-identity-source supersession)
--          - I-023 (three-layer tenant isolation; tenant_id on every record)
--          - I-027 (audit append-only)
--          - I-035 (append-only invariant for the consult_lifecycle_transition
--            log; one-way release on consult_review_claim per P-037 R4
--            hybrid-persistence pattern)
-- Summary: Creates 13 net-new RBAC roles:
--          - Application (5): async_consult_patient_initiator +
--            async_consult_delegate_initiator + async_consult_clinician_reviewer
--            + async_consult_patient_reader + async_consult_staff_reader
--          - Wrapper-owner (6): consult_lifecycle_transition_writer_owner
--            (raw transition writer) + consult_initiation_wrapper_owner +
--            consult_intake_wrapper_owner + consult_ai_preparation_wrapper_owner
--            + consult_claim_wrapper_owner (owns claim + reassign procedures)
--            + record_consult_decision_wrapper_owner
--          - View/MV owner (2): async_consult_view_owner +
--            async_consult_mv_refresh_owner
--
--          All 13 roles are NOLOGIN + non-BYPASSRLS. NO grants in this
--          migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Application roles (5) — assigned to end-user / service principals at request
-- time by authContextPlugin (SI-010 trust anchor); DB roles scope wrapper
-- EXECUTE + table SELECT + view-SELECT + access-function EXECUTE privileges,
-- never logged into directly. Granted via the Admin Backend role-assignment
-- surface per P-038 §8 "Granted to" column.
-- -----------------------------------------------------------------------------

CREATE ROLE async_consult_patient_initiator NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE async_consult_patient_initiator IS
    'P-038 §8 application role: patient principal initiating an async consult. '
    'Calls record_consult_initiation() wrapper (PR 5) for the start of the consult lifecycle '
    '(INITIATED state per State Machines v1.3 consult_lifecycle DERIVED machine). '
    'Granted to the patient role via the Admin Backend role-assignment surface.';

CREATE ROLE async_consult_delegate_initiator NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE async_consult_delegate_initiator IS
    'P-038 §8 application role: delegate principal initiating an async consult on behalf of a '
    'patient IFF the delegate holds an active book-consults Consent scope. Calls '
    'record_consult_initiation() wrapper (PR 5); the wrapper validates the delegate authorization '
    'against Consent slice consent_grant at execution time.';

CREATE ROLE async_consult_clinician_reviewer NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE async_consult_clinician_reviewer IS
    'P-038 §8 application role: clinician principal claiming + reviewing + deciding on an async '
    'consult. Calls claim_consult_for_review() + reassign_consult_claim() + '
    'record_consult_clinician_decision() wrappers (PR 5). Decision-wrapper extends SI-005 P-021 '
    'with SI-024.1 JWT-verified actor identity per P-021a + P-036 R3.';

CREATE ROLE async_consult_patient_reader NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE async_consult_patient_reader IS
    'P-038 §8 application role (split from earlier-draft single `async_consult_reader` per P-038 '
    'R5 HIGH-1 data-minimization closure): patient + delegate (IFF book-consults Consent scope) '
    'read path. Granted SELECT on async_consult_patient_summary_v ONLY (PR 3); view predicate '
    'enforces caller sees only their own consults via verify_session_jwt_and_extract_claims() '
    'CTE + consent_grant EXISTS clause. NOT granted SELECT on async_consult_staff_summary_v.';

CREATE ROLE async_consult_staff_reader NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE async_consult_staff_reader IS
    'P-038 §8 application role (split from earlier-draft single `async_consult_reader` per P-038 '
    'R5 HIGH-1 data-minimization closure): clinician + pharmacy portal + admin tenant-wide '
    'queue-triage read path. Granted SELECT on async_consult_staff_summary_v ONLY (PR 3); '
    'NOT granted to patient/delegate. This split prevents the per-tenant patient-summary '
    'metadata leak that the earlier single-view design would have created.';

-- -----------------------------------------------------------------------------
-- SECURITY DEFINER wrapper-owner roles (6) — own the raw lifecycle writer +
-- the 5 reason-specific wrapper procedures (P-038 §3 + §8). NOT granted to
-- humans. EXECUTE on the raw record_consult_lifecycle_transition() is granted
-- ONLY to the 5 reason-specific wrapper owners (anti-bypass: app roles call
-- the reason-specific wrappers, never the raw writer). Procedure ownership +
-- EXECUTE grants land with the wrapper migrations (PR 4-5); this migration
-- only creates the role principals.
--
-- Role names are taken verbatim from the canonical P-038 §8 wrapper-owner
-- table so the downstream procedure-DDL OWNER TO / GRANT EXECUTE statements
-- match the spec exactly.
-- -----------------------------------------------------------------------------

CREATE ROLE consult_lifecycle_transition_writer_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE consult_lifecycle_transition_writer_owner IS
    'P-038 §8 wrapper-owner role: owns the raw record_consult_lifecycle_transition() procedure '
    '(§3.NEW1) and is the SOLE grantee of INSERT on consult_lifecycle_transition (granted in '
    'PR 2/4). EXECUTE on the raw writer is granted ONLY to the 5 reason-specific wrapper-owner '
    'roles below (anti-bypass). Per P-038 R9 MED-1 closure: §3 prose enumerates grantees as '
    'EXACTLY consult_initiation_wrapper_owner + consult_intake_wrapper_owner + '
    'consult_ai_preparation_wrapper_owner + consult_claim_wrapper_owner + '
    'record_consult_decision_wrapper_owner — no other roles receive EXECUTE on the raw writer.';

CREATE ROLE consult_initiation_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE consult_initiation_wrapper_owner IS
    'P-038 §8 wrapper-owner role: owns record_consult_initiation() wrapper procedure. '
    'EXECUTE on the wrapper granted to async_consult_patient_initiator + '
    'async_consult_delegate_initiator (PR 5).';

CREATE ROLE consult_intake_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE consult_intake_wrapper_owner IS
    'P-038 §8 wrapper-owner role: owns record_consult_intake_submission() wrapper procedure. '
    'EXECUTE on the wrapper granted to async_consult_patient_initiator + '
    'async_consult_delegate_initiator (PR 5).';

CREATE ROLE consult_ai_preparation_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE consult_ai_preparation_wrapper_owner IS
    'P-038 §8 wrapper-owner role: owns record_consult_ai_preparation_completed() wrapper '
    'procedure. EXECUTE on the wrapper granted to the AI Mode 2 service-account role at '
    'integration time (PR 5; cross-slice with SI-021 Mode 2 protocol execution).';

CREATE ROLE consult_claim_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE consult_claim_wrapper_owner IS
    'P-038 §8 wrapper-owner role: owns BOTH claim_consult_for_review() AND '
    'reassign_consult_claim() wrapper procedures (the only wrapper-owner that owns 2 procedures, '
    'per P-038 §1.1 R9 MED-1 procedure-enumeration normalization). EXECUTE on both wrappers '
    'granted to async_consult_clinician_reviewer (PR 5). Hybrid-persistence-with-one-way-release '
    'pattern on consult_review_claim per P-037 R4 closure — wrapper enforces release/reassign '
    'serialization via per-consult advisory lock + SELECT...FOR UPDATE on the claim row '
    '(per P-038 R3 HIGH-1 closure).';

CREATE ROLE record_consult_decision_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE record_consult_decision_wrapper_owner IS
    'P-038 §8 wrapper-owner role: owns record_consult_clinician_decision() wrapper procedure '
    '(EXTENDS SI-005 P-021 foundation with SI-024.1 JWT-verified actor identity per P-021a + '
    'P-036 R3 + claim-FK 5-column composite identity lookup per P-038 R1 HIGH-1 closure). '
    'EXECUTE on the wrapper granted to async_consult_clinician_reviewer (PR 5).';

-- -----------------------------------------------------------------------------
-- View/MV owner roles (2) — own the 2 caller-class-split data-minimization
-- plain views + the optional rebuildable materialized view (P-038 §8). NOT
-- granted to humans. View/MV ownership lands with PR 3 (view + MV DDL);
-- owner-only base-table SELECT grants + non-BYPASSRLS preflight (per the
-- P-036 R7 closure precedent) apply when the views are created.
-- -----------------------------------------------------------------------------

CREATE ROLE async_consult_view_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE async_consult_view_owner IS
    'P-038 §8 view-owner role: owns async_consult_patient_summary_v + '
    'async_consult_staff_summary_v (both NON-BYPASSRLS; both base-table SELECT grants are '
    'owner-only). Per P-038 §10 deployment preflight (R9 MED-1 closure from SI-024.1), this '
    'role MUST have rolbypassrls=false at view-creation time — enforced by §10''s DO-block '
    'assertion when PR 3 ships. Views are PLAIN views (not security_invoker / security_barrier) '
    'per P-036 R7 → P-037 → P-038 R6 walk-back pattern.';

CREATE ROLE async_consult_mv_refresh_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE async_consult_mv_refresh_owner IS
    'P-038 §8 MV-refresh-owner role: owns the OPTIONAL consult_current_state_mv materialized '
    'view (P-038 §4.NEW9; rebuildable from consult_lifecycle_transition append-only log per '
    'I-035). Sole grantee of direct SELECT on the MV; app roles read only via the tenant-scoped '
    'views (PR 3) or a dedicated SECDEF access function. Owns the REFRESH MATERIALIZED VIEW '
    'CONCURRENTLY scheduler + hourly reconciliation cron (divergence -> '
    'async_consult_projection_divergence_detected Cat B audit per P-038 §4).';

-- =============================================================================
-- Verification: count of net-new SI-020 roles should be exactly 13. This DO
-- block fails loudly on partial apply, extra roles, or missing roles. Mirrors
-- the migration 046 verification pattern + the migration 032 retired-role
-- sentinel discipline.
-- =============================================================================

DO $$
DECLARE
    v_created_count INTEGER;
    v_expected_count CONSTANT INTEGER := 13;
BEGIN
    SELECT COUNT(*) INTO v_created_count
      FROM pg_roles
     WHERE rolname IN (
         'async_consult_patient_initiator',
         'async_consult_delegate_initiator',
         'async_consult_clinician_reviewer',
         'async_consult_patient_reader',
         'async_consult_staff_reader',
         'consult_lifecycle_transition_writer_owner',
         'consult_initiation_wrapper_owner',
         'consult_intake_wrapper_owner',
         'consult_ai_preparation_wrapper_owner',
         'consult_claim_wrapper_owner',
         'record_consult_decision_wrapper_owner',
         'async_consult_view_owner',
         'async_consult_mv_refresh_owner'
     );

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-053-async-consult-rbac-count-mismatch: '
            'expected % SI-020 roles created, found %; '
            'P-038 §8 RBAC table requires all 13 (5 application + 6 wrapper-owner + 2 view/MV owners)',
            v_expected_count, v_created_count;
    END IF;

    -- Anti-drift: superseded single-reader role `async_consult_reader` (split per
    -- P-038 R5 HIGH-1 into patient_reader + staff_reader) MUST NOT exist as a
    -- DB role. The split is schema-enforced data-minimization, not a naming
    -- preference; an extant single-reader role would re-collapse the leak.
    IF EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname = 'async_consult_reader'
    ) THEN
        RAISE EXCEPTION
            'migration-053-superseded-single-reader-role-present: '
            '`async_consult_reader` exists. P-038 R5 HIGH-1 closure SPLIT this role into '
            '`async_consult_patient_reader` + `async_consult_staff_reader` to enforce '
            'JWT-verified patient_id predicate on the patient/delegate read path while '
            'preserving tenant-wide visibility for staff queue triage. The unsplit role MUST '
            'NOT exist — its presence would re-collapse the per-tenant patient-summary '
            'metadata leak the split was authored to prevent.';
    END IF;

    -- async_consult_view_owner non-BYPASSRLS preflight: enforced in P-038 §10
    -- as a view-creation-time gate when PR 3 ships. At PR 1 (this migration)
    -- the role is just-created with NOBYPASSRLS, so this is a belt-and-braces
    -- assertion of the canonical posture rather than the spec-mandated preflight.
    IF (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'async_consult_view_owner') THEN
        RAISE EXCEPTION
            'migration-053-async-consult-view-owner-has-bypassrls: '
            'async_consult_view_owner has BYPASSRLS at PR-1 creation time, which violates the '
            'canonical view-owner posture (P-038 §10 preflight requires rolbypassrls=false at '
            'view-creation time). The CREATE ROLE statement above declares NOBYPASSRLS — if '
            'this assertion fires, the role was modified after creation or the migration was '
            'edited.';
    END IF;
END $$;
