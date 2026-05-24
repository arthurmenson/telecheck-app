-- =============================================================================
-- File:    migrations/046_med_interaction_rbac_roles.sql
-- Purpose: Create the 12 net-new RBAC roles required by the Medication
--          Interaction & Validation Engine slice (SI-019 v1.0 → v2.0 RATIFIED
--          at P-033 + CDM/AUDIT/OpenAPI/State-Machines/RBAC follow-on landing
--          at P-034 RATIFIED 2026-05-21).
--
--          This is PR 1 of the Med-Interaction implementation series — pure
--          RBAC role creation. No table DDL, no RLS policies, no SECDEF
--          procedures, no grants. Subsequent PRs add the 4 entities + RLS +
--          append-only triggers (PR 2) → optional MV + SECURITY BARRIER view
--          (PR 3) → raw lifecycle writer (PR 4) → 6 reason-specific wrappers
--          + override wrapper (PR 5+) → Fastify module wiring (later PRs),
--          following the Crisis Response + Admin Backend cadence.
--
--          The Med-Interaction engine is the I-002 hard-rule gate: the
--          interaction engine runs BEFORE a clinician commits a
--          medication_request. This slice's signal lifecycle is what the
--          Pharmacy clinician-commit + refill-release + Mode 2 protocol gates
--          read at STRICT-FRESHNESS (P-034 §4.NEW5 read-path classification).
--          PR 1 lands no executable gate yet — only the privilege boundary
--          (DB roles) that the later procedure migrations bind EXECUTE to.
--
--          All 12 roles are NOLOGIN + non-BYPASSRLS per the spec corpus
--          canonical pattern (matches migration 032 crisis + migration 039
--          admin precedent). Application roles (4) are NOLOGIN because end-
--          user / service principals are bound at request time via the
--          application's authContextPlugin (SI-010 trust anchor from
--          migration 031); the DB roles are the privilege boundary, not
--          direct login identities. Wrapper-owner roles (6) + service-level
--          owner roles (2) are NOLOGIN by canonical convention — owner roles
--          exist solely to scope SECDEF / table-INSERT / MV-refresh
--          privileges, never to be logged into.
--
--          PER RATIFIER OPTION 2 (carryforward from Crisis Response /
--          Admin Backend PRs; docs/crisis-response-implementation-plan.md):
--          - Adapt to code-repo conventions: NOLOGIN + non-BYPASSRLS only.
--          - No grants in this migration (granted in their natural phase
--            when the target tables / views / MV / procedures exist, per the
--            P-040 §8.2 R9 HIGH-1 closure pattern Crisis Response followed).
--          - Dotted canonical role names normalized to underscores (the ONE
--            recorded Option 2 divergence for this migration — see below).
--
--          RECORDED OPTION 2 DIVERGENCE (dotted → underscore role names):
--          The P-034 §8 RBAC table names two application roles with a dot:
--          `medication_interaction.override_recorder` and
--          `medication_interaction.knowledge_base_updater`. An unquoted dotted
--          identifier is not a valid PostgreSQL role name (Postgres parses
--          `a.b` as schema-qualified object reference, not a role), and the
--          code repo has zero quoted-dotted roles — every existing slice uses
--          underscore-namespaced DB roles (crisis_*, admin_*, forms_template_*,
--          and SI-019's own `medication_interaction_engine_evaluator` /
--          `medication_interaction_signal_viewer`, which P-034 §8 already names
--          with underscores). The slice spec is itself internally inconsistent
--          on this point (Sub-decision 6 dotted vs the §6 wrapper-grant matrix
--          underscored). This migration realizes both dotted roles as their
--          underscore form:
--            `medication_interaction.override_recorder`
--                -> medication_interaction_override_recorder
--            `medication_interaction.knowledge_base_updater`
--                -> medication_interaction_knowledge_base_updater
--          This is a mechanical DB-realization of the canonical role, not a
--          new architectural decision; the role's purpose / grants / dual-
--          control posture are unchanged. To be reconciled (or ratified as the
--          canonical underscore form) in a future spec hygiene cycle.
--
--          NOT CREATED HERE — `medication_interaction_resolution_subscriber`:
--          P-034 §8 explicitly states this role is "defined elsewhere"
--          (Async Consult slice domain-event subscriber RBAC registry); it is
--          referenced in the §6.NEW1-NEW6 EXECUTE-grant table only for
--          completeness. It is NOT one of SI-019's 12 net-new roles and is
--          NOT created by this migration. The resolution-wrapper EXECUTE grant
--          to it lands when the Async Consult subscriber registry creates it.
--
-- Spec:    - Medication Interaction Engine Slice PRD v2.0 (RATIFIED 2026-05-21
--            P-033; sibling repo: telecheckONE/Telecheck Master Bundle FINAL
--            US REGION BASELINE/Telecheck_Medication_Interaction_Engine_Slice_PRD_v2_0.md
--            §Sub-decision 6 RBAC + §Sub-decision 8.5 writer-owner)
--          - CDM v1.6 → v1.7 + AUDIT_EVENTS v5.8 → v5.9 + OpenAPI v0.2 → v0.3
--            + State Machines v1.1 → v1.2 + RBAC v1.1 → v1.2 Amendment
--            (RATIFIED 2026-05-21 P-034; sibling repo: telecheckONE/
--            Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_6_to_v1_7_Amendment.md §8 RBAC table — the
--            authoritative 12-role enumeration)
--          - I-002 (interaction engine runs BEFORE clinician commits a
--            medication_request)
--          - I-015 (dual-control for knowledge-base version updates)
--          - I-023 (three-layer tenant isolation; tenant_id on every record)
--          - I-027 (audit append-only)
--          - I-035 (append-only invariant for the lifecycle-transition log)
-- Summary: Creates 12 net-new RBAC roles:
--          - Application (4): medication_interaction_engine_evaluator +
--            medication_interaction_signal_viewer +
--            medication_interaction_override_recorder +
--            medication_interaction_knowledge_base_updater
--          - Wrapper-owner (6): emission + activation + override + superseded +
--            resolution + expiry wrapper owners
--          - Service-level owner (2): lifecycle_transition_writer_owner (raw
--            transition writer) + mv_refresh_owner (MV + access function +
--            refresh/reconciliation scheduler)
--
--          All 12 roles are NOLOGIN + non-BYPASSRLS. NO grants in this
--          migration.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Application roles (4) — assigned to end-user / service principals at request
-- time by authContextPlugin (SI-010 trust anchor); DB roles scope wrapper
-- EXECUTE + table SELECT + access-function EXECUTE privileges, never logged
-- into directly. Granted via the Admin Backend role-assignment surface per
-- P-034 §8 "Granted to" column.
-- -----------------------------------------------------------------------------

CREATE ROLE medication_interaction_engine_evaluator NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE medication_interaction_engine_evaluator IS
    'P-034 §8 application role: engine service account + AI Mode 2 protocol execution agent. '
    'Writes interaction_engine_evaluation + interaction_signal rows; calls the emission / '
    'activation / supersession / expiry reason-specific wrappers (EXECUTE granted in PR 5+). '
    'Least-privilege: never holds EXECUTE on the raw lifecycle transition writer.';

CREATE ROLE medication_interaction_signal_viewer NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE medication_interaction_signal_viewer IS
    'P-034 §8 application role: read-only access to evaluation + signal + override + '
    'lifecycle-transition rows. Granted to clinician + pharmacist + AI Mode 1/2 + admin. '
    'Reads current-state via the interaction_signal_current_state_v SECURITY BARRIER view '
    'OR the get_interaction_signal_current_state() SECURITY DEFINER access function (SELECT / '
    'EXECUTE granted in PR 3). No override / write privilege.';

CREATE ROLE medication_interaction_override_recorder NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE medication_interaction_override_recorder IS
    'P-034 §8 application role (canonical name medication_interaction.override_recorder; '
    'dotted form normalized to underscore per this migration`s recorded Option 2 divergence). '
    'Clinician role ONLY; writes a clinician override by calling record_interaction_signal_override() '
    '(§6.NEW7 wrapper; EXECUTE granted in PR 5). Every override requires audit emission.';

CREATE ROLE medication_interaction_knowledge_base_updater NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE medication_interaction_knowledge_base_updater IS
    'P-034 §8 application role (canonical name medication_interaction.knowledge_base_updater; '
    'dotted form normalized to underscore per this migration`s recorded Option 2 divergence). '
    'Admin role for knowledge-base version updates under I-015 dual-control; granted via the '
    'Admin Backend slice role-assignment surface subject to the dual-control approval workflow.';

-- -----------------------------------------------------------------------------
-- SECURITY DEFINER wrapper-owner roles (6) — own the 6 reason-specific wrapper
-- procedures (P-034 §6.NEW2-NEW7). NOT granted to humans. These are the ONLY
-- roles whose EXECUTE on the raw transition writer (§6.NEW1) is permitted
-- (anti-bypass: app roles call the reason-specific wrappers, never the raw
-- writer). Procedure ownership + EXECUTE grants land with the wrapper
-- migrations (PR 5+); this migration only creates the role principals.
-- Role names are taken verbatim from the canonical P-034 §8 wrapper-owner
-- table so the downstream procedure-DDL OWNER TO / GRANT EXECUTE statements
-- match the spec exactly.
-- -----------------------------------------------------------------------------

CREATE ROLE emission_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE emission_wrapper_owner IS
    'P-034 §8 wrapper-owner role: owns record_signal_emission(). '
    'EXECUTE on the raw record_interaction_signal_lifecycle_transition() granted to this owner; '
    'EXECUTE on the wrapper granted to medication_interaction_engine_evaluator (PR 5+).';

CREATE ROLE activation_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE activation_wrapper_owner IS
    'P-034 §8 wrapper-owner role: owns record_signal_activation(). '
    'EXECUTE on the wrapper granted to medication_interaction_engine_evaluator (PR 5+).';

CREATE ROLE override_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE override_wrapper_owner IS
    'P-034 §8 wrapper-owner role: owns record_interaction_signal_override() (§6.NEW7). '
    'Sole grantee of INSERT on interaction_signal_override (granted in PR 2/5); '
    'EXECUTE on the wrapper granted to medication_interaction_override_recorder (PR 5+).';

CREATE ROLE superseded_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE superseded_wrapper_owner IS
    'P-034 §8 wrapper-owner role: owns record_signal_supersession(). '
    'EXECUTE on the wrapper granted to medication_interaction_engine_evaluator (PR 5+).';

CREATE ROLE resolution_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE resolution_wrapper_owner IS
    'P-034 §8 wrapper-owner role: owns record_signal_resolution(). '
    'EXECUTE on the wrapper granted to medication_interaction_resolution_subscriber — a role '
    'defined by the Async Consult domain-event subscriber registry, NOT created here (PR 5+).';

CREATE ROLE expiry_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE expiry_wrapper_owner IS
    'P-034 §8 wrapper-owner role: owns record_signal_expiry(). '
    'EXECUTE on the wrapper granted to medication_interaction_engine_evaluator (scheduler) (PR 5+).';

-- -----------------------------------------------------------------------------
-- Service-level owner roles (2) — own the raw transition writer + the optional
-- materialized-view read-path projection (P-034 §8 service-level owner table).
-- -----------------------------------------------------------------------------

CREATE ROLE lifecycle_transition_writer_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE lifecycle_transition_writer_owner IS
    'P-034 §8 service-level owner role: owns the raw '
    'record_interaction_signal_lifecycle_transition() procedure (§6.NEW1) and is the SOLE grantee '
    'of INSERT on interaction_signal_lifecycle_transition (granted in PR 2/4). EXECUTE on the raw '
    'writer is granted ONLY to the 6 wrapper-owner roles above (anti-bypass).';

CREATE ROLE mv_refresh_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE mv_refresh_owner IS
    'P-034 §8 service-level owner role: owns interaction_signal_current_state_mv + the '
    'get_interaction_signal_current_state() SECURITY DEFINER access function; runs the '
    'REFRESH MATERIALIZED VIEW CONCURRENTLY scheduler + the hourly reconciliation cron '
    '(divergence -> interaction_engine_projection_divergence_detected Cat B audit). Sole grantee '
    'of SELECT on the MV; app roles read only via the tenant-scoped view / access function.';

-- =============================================================================
-- Verification: count of net-new SI-019 roles should be exactly 12, and the
-- two dotted canonical forms MUST NOT exist (anti-drift guard mirroring the
-- migration 032 retired-role sentinel). This DO block fails loudly on partial
-- apply, extra roles, or an accidental quoted-dotted role creation.
-- =============================================================================

DO $$
DECLARE
    v_created_count INTEGER;
    v_expected_count CONSTANT INTEGER := 12;
BEGIN
    SELECT COUNT(*) INTO v_created_count
      FROM pg_roles
     WHERE rolname IN (
         'medication_interaction_engine_evaluator',
         'medication_interaction_signal_viewer',
         'medication_interaction_override_recorder',
         'medication_interaction_knowledge_base_updater',
         'emission_wrapper_owner',
         'activation_wrapper_owner',
         'override_wrapper_owner',
         'superseded_wrapper_owner',
         'resolution_wrapper_owner',
         'expiry_wrapper_owner',
         'lifecycle_transition_writer_owner',
         'mv_refresh_owner'
     );

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-046-med-interaction-rbac-count-mismatch: '
            'expected % SI-019 roles created, found %; '
            'P-034 §8 RBAC table requires all 12 (4 application + 6 wrapper-owner + 2 service-level owner)',
            v_expected_count, v_created_count;
    END IF;

    -- Anti-drift: the dotted canonical forms must NOT have been created as
    -- quoted-dotted roles. Only the underscore-normalized forms are canonical
    -- in the code repo (recorded Option 2 divergence above).
    IF EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname IN (
             'medication_interaction.override_recorder',
             'medication_interaction.knowledge_base_updater'
         )
    ) THEN
        RAISE EXCEPTION
            'migration-046-dotted-role-present: a quoted-dotted SI-019 role exists. '
            'The code repo realizes medication_interaction.override_recorder / '
            'medication_interaction.knowledge_base_updater as their underscore forms only '
            '(recorded Option 2 divergence); the dotted forms MUST NOT exist.';
    END IF;

    -- Anti-drift: medication_interaction_resolution_subscriber is owned by the
    -- Async Consult subscriber registry, NOT this slice. This migration must
    -- not create it (it is referenced only in the wrapper EXECUTE-grant table).
    IF EXISTS (
        SELECT 1 FROM pg_roles
         WHERE rolname = 'medication_interaction_resolution_subscriber'
    ) THEN
        RAISE NOTICE
            'migration-046-note: medication_interaction_resolution_subscriber already exists '
            '(created by the Async Consult subscriber registry). That is expected if Async '
            'Consult subscriber RBAC has already landed; this migration does not own it.';
    END IF;
END $$;
