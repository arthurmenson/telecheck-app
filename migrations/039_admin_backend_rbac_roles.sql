-- =============================================================================
-- File:    migrations/039_admin_backend_rbac_roles.sql
-- Purpose: Create the 12 net-new RBAC roles for the Admin Backend Basics slice
--          (SI-023 v1.0 RATIFIED 2026-05-22 P-041 + CDM follow-on landing
--          P-042 2026-05-22 with R7 HIGH-2 +1 view-owner extension).
--
--          PR 1 of the Admin Backend Basics implementation series — pure RBAC
--          role creation. No table DDL / RLS / SECDEF in this migration;
--          subsequent migrations add entities (PR 1 continued: migration 040)
--          → derived views (PR 2) → raw lifecycle writer (PR 3) → 3 dashboard
--          read-wrappers (PR 4) → 2 template wrappers (PR 5) → Fastify module
--          scaffold (PR 6) following the Crisis Response cadence.
--
--          All 12 roles are NOLOGIN + non-BYPASSRLS per the spec corpus
--          canonical pattern. Application roles (2) are NOLOGIN because end-
--          user principals are bound at request time via authContextPlugin
--          (SI-010 trust anchor from migration 031). Procedure-owner roles
--          (6) + view-owner roles (4) are NOLOGIN by canonical convention —
--          owner roles scope SECDEF / view privileges, never login identities.
--
--          PER RATIFIER OPTION 2 (carryforward from Crisis Response PRs):
--          - Adapt to code-repo conventions: NOLOGIN + non-BYPASSRLS only
--          - No grants in this migration (granted in their natural phase
--            when target tables/views/procedures exist per P-042 R9 closure)
--
-- Spec:    - SI-023 Admin Backend Basics Slice v1.0 (RATIFIED 2026-05-22 P-041;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_SI_023_Admin_Backend_Basics_v1_0.md §7 RBAC)
--          - CDM v1.10 → v1.11 Amendment §6 RBAC table (RATIFIED 2026-05-22
--            P-042; +1 view-owner per R7 HIGH-2 = 12 total roles;
--            telecheckONE/Telecheck Master Bundle FINAL US REGION BASELINE/
--            Telecheck_CDM_v1_10_to_v1_11_Amendment.md §6)
--          - I-023 (three-layer tenant isolation; tenant_id on every record)
--          - I-027 (audit append-only; admin_dashboard_query_execution etc.)
--          - I-035 (append-only invariant for audit-bound state machines;
--            forms_template_admin_review_lifecycle_transition)
-- Summary: Creates 12 net-new RBAC roles:
--          - Application (2): admin_basic_operator + admin_template_reviewer
--          - Dashboard-wrapper-owner (3): one per dashboard surface
--          - Template-wrapper-owner (2): submit + decision
--          - Raw-writer-owner (1): forms_template_admin_review_transition_writer_owner
--          - View-owner (4): 3 dashboard views + 1 pending-only review view
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Application roles (2) — assigned to tenant operator staff at request time
-- by authContextPlugin (SI-010 trust anchor); DB roles scope wrapper EXECUTE +
-- view SELECT privileges, never logged into directly.
-- -----------------------------------------------------------------------------

CREATE ROLE admin_basic_operator NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE admin_basic_operator IS
    'P-042 §6 application role: tenant operator staff with dashboard-monitoring responsibility. '
    'Holds EXECUTE on the 3 dashboard SECDEF read-wrappers (Sub-decision 3.5) + EXECUTE on '
    'submit_forms_template_for_admin_review template wrapper (granted in PR 4-5).';

CREATE ROLE admin_template_reviewer NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE admin_template_reviewer IS
    'P-042 §6 application role: tenant operator staff with template-review responsibility. '
    'Holds EXECUTE on record_forms_template_admin_decision wrapper + SELECT on '
    'forms_template_admin_review_pending_v (the reviewer-scoped pending-only view per §4.NEW9, '
    'NOT direct SELECT on base table per P-042 R7 HIGH-2 data-minimization closure).';

-- -----------------------------------------------------------------------------
-- Dashboard read-wrapper-owner roles (3) — own the 3 SECDEF read-wrappers per
-- Sub-decision 3.5 (one per dashboard surface). Each is the SOLE role with
-- SELECT on its corresponding admin view per the canonical wrapper-only read
-- path discipline (R1 HIGH-1 closure: SECDEF read-wrappers are the SOLE
-- canonical dashboard read path).
-- -----------------------------------------------------------------------------

CREATE ROLE read_admin_crisis_operational_health_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE read_admin_crisis_operational_health_wrapper_owner IS
    'P-042 §6 dashboard-wrapper-owner role: owns read_admin_crisis_operational_health() SECDEF; '
    'SOLE role with SELECT on admin_crisis_operational_health_v view.';

CREATE ROLE read_admin_consult_queue_health_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE read_admin_consult_queue_health_wrapper_owner IS
    'P-042 §6 dashboard-wrapper-owner role: owns read_admin_consult_queue_health() SECDEF; '
    'SOLE role with SELECT on admin_consult_queue_health_v view (deferred per Option 2 — '
    'view body depends on async-consult lifecycle_transition shape not in code repo).';

CREATE ROLE read_admin_mode1_volume_health_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE read_admin_mode1_volume_health_wrapper_owner IS
    'P-042 §6 dashboard-wrapper-owner role: owns read_admin_mode1_volume_health() SECDEF; '
    'SOLE role with SELECT on admin_mode1_volume_health_v view (deferred per Option 2 — '
    'Mode 1 entities + state derivation not yet in code repo).';

-- -----------------------------------------------------------------------------
-- Template-wrapper-owner roles (2) — own the 2 template-review SECDEF wrappers
-- per Sub-decision 4 (submit + decision).
-- -----------------------------------------------------------------------------

CREATE ROLE forms_template_admin_review_submit_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE forms_template_admin_review_submit_wrapper_owner IS
    'P-042 §6 template-wrapper-owner role: owns submit_forms_template_for_admin_review() SECDEF.';

CREATE ROLE forms_template_admin_review_decision_wrapper_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE forms_template_admin_review_decision_wrapper_owner IS
    'P-042 §6 template-wrapper-owner role: owns record_forms_template_admin_decision() SECDEF.';

-- -----------------------------------------------------------------------------
-- Raw lifecycle writer-owner role (1) — owns the raw INSERT path into
-- forms_template_admin_review_lifecycle_transition per Sub-decision 4.5.
-- EXECUTE granted to EXACTLY the 2 template wrapper-owner roles (anti-bypass).
-- -----------------------------------------------------------------------------

CREATE ROLE forms_template_admin_review_transition_writer_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE forms_template_admin_review_transition_writer_owner IS
    'P-042 §6 raw-writer-owner role: owns record_forms_template_admin_review_transition() SECDEF. '
    'EXECUTE granted to EXACTLY the 2 template wrapper-owner roles per Sub-decision 5 anti-bypass.';

-- -----------------------------------------------------------------------------
-- View-owner roles (4 — R7 HIGH-2 added the 4th for pending-only review view).
-- -----------------------------------------------------------------------------

CREATE ROLE admin_crisis_operational_health_view_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE admin_crisis_operational_health_view_owner IS
    'P-042 §6 view-owner role: owns admin_crisis_operational_health_v.';

CREATE ROLE admin_consult_queue_health_view_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE admin_consult_queue_health_view_owner IS
    'P-042 §6 view-owner role: owns admin_consult_queue_health_v.';

CREATE ROLE admin_mode1_volume_health_view_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE admin_mode1_volume_health_view_owner IS
    'P-042 §6 view-owner role: owns admin_mode1_volume_health_v.';

CREATE ROLE forms_template_admin_review_pending_view_owner NOLOGIN NOBYPASSRLS;
COMMENT ON ROLE forms_template_admin_review_pending_view_owner IS
    'P-042 §6 view-owner role (R7 HIGH-2 +1 addition): owns forms_template_admin_review_pending_v. '
    'View body uses security_invoker=false + security_barrier=true; view-owner has SELECT on '
    'underlying base table for the view body to execute under owner privileges.';

-- =============================================================================
-- Verification: count of net-new admin_* / read_admin_* / forms_template_admin_* roles = 12
-- =============================================================================

DO $$
DECLARE
    v_created_count INTEGER;
    v_expected_count CONSTANT INTEGER := 12;
BEGIN
    SELECT COUNT(*) INTO v_created_count
      FROM pg_roles
     WHERE rolname IN (
         'admin_basic_operator',
         'admin_template_reviewer',
         'read_admin_crisis_operational_health_wrapper_owner',
         'read_admin_consult_queue_health_wrapper_owner',
         'read_admin_mode1_volume_health_wrapper_owner',
         'forms_template_admin_review_submit_wrapper_owner',
         'forms_template_admin_review_decision_wrapper_owner',
         'forms_template_admin_review_transition_writer_owner',
         'admin_crisis_operational_health_view_owner',
         'admin_consult_queue_health_view_owner',
         'admin_mode1_volume_health_view_owner',
         'forms_template_admin_review_pending_view_owner'
     );

    IF v_created_count <> v_expected_count THEN
        RAISE EXCEPTION
            'migration-039-admin-rbac-count-mismatch: expected % admin roles created, found %; '
            'P-042 §6 RBAC table requires all 12 (2 app + 3 dashboard-wrapper + 2 template-wrapper + 1 raw-writer + 4 view-owner)',
            v_expected_count, v_created_count;
    END IF;
END $$;
